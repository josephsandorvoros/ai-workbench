"""Live Hermes sessions for Workbench chats over the private ``hermes serve`` WebSocket.

Each Workbench chat keeps one long-lived Hermes session (and agent) open here, the way the
messaging gateway keeps a Discord channel's agent cached: turns, slash commands, approvals and
interrupts all reach the same in-memory agent. The browser talks to this hub over plain HTTP
(long-polled events); the WebSocket token never leaves the companion.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

_DEFAULT_WS_URL = "ws://127.0.0.1:9119/api/ws"
_CHAT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$")
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_COMMAND_RE = re.compile(r"^/([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})(?:\s+(.*))?$", re.DOTALL)
_DATA_URL_RE = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)
_MAX_COMMAND_CHARS = 4000
_MAX_PROMPT_CHARS = 200_000
_MAX_IMAGES = 8
_MAX_EVENTS = 4000
_SESSION_NOT_FOUND = 4007
_USE_COMMAND_DISPATCH = 4018
_APPROVAL_CHOICES = {"once", "session", "always", "deny"}
# Hermes events the Workbench renders; everything else (skins, pets, subagent rows, ...) is dropped.
_FORWARDED_EVENTS = {
    "message.start", "message.delta", "message.interim", "message.complete",
    "reasoning.delta", "reasoning.available", "thinking.delta",
    "tool.start", "tool.complete", "tool.generating",
    "status.update", "session.usage", "session.info", "session.title", "error", "request.cancel",
}


class HermesLiveError(ValueError):
    """A safe, user-facing failure from the live Hermes bridge."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def _default_connect(ws_url: str):
    from websockets.sync.client import connect

    return connect(ws_url, open_timeout=5, close_timeout=2, max_size=16 * 1024 * 1024)


def resolve_ws_url() -> str:
    token = os.getenv("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()
    if not token:
        raise HermesLiveError("Native Hermes gateway is not configured (HERMES_DASHBOARD_SESSION_TOKEN)")
    ws_url = os.getenv("HERMES_TUI_GATEWAY_WS_URL", _DEFAULT_WS_URL).strip()
    parsed = urlsplit(ws_url)
    if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HermesLiveError("Native Hermes gateway must use a loopback WebSocket")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["token"] = token
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/api/ws", urlencode(query), ""))


def parse_command(command: str) -> tuple[str, str]:
    text = str(command or "").strip()
    if not text or len(text) > _MAX_COMMAND_CHARS or "\x00" in text:
        raise HermesLiveError("Commands must be 1-4000 characters")
    match = _COMMAND_RE.fullmatch(text)
    if not match:
        raise HermesLiveError("Commands look like /name [arguments]")
    name, arg = match.groups()
    return name.lower(), (arg or "").strip()


def normalize_command_result(result: dict) -> dict:
    """Map Hermes' slash.exec / command.dispatch payloads onto what the Workbench renders."""
    kind = str(result.get("type") or "")
    notice = str(result.get("notice") or "").strip()
    if kind in {"send", "skill"}:
        message = str(result.get("message") or "")
        if not message.strip():
            raise HermesLiveError("Hermes returned an empty prompt for this command")
        return {"type": "send", "message": message, "notice": notice,
                "display": str(result.get("display") or "").strip()}
    if kind == "prefill":
        return {"type": "prefill", "message": str(result.get("message") or ""), "notice": notice}
    output = str(result.get("output") or "").strip()
    warning = str(result.get("warning") or "").strip()
    return {"type": "output", "output": output or notice or "(no output)", "warning": warning}


class LiveChat:
    """One WebSocket + one live Hermes session for a single Workbench chat."""

    def __init__(self, chat_id: str, connection):
        self.chat_id = chat_id
        self.connection = connection
        self.session_id = ""
        self.stored_session_id = ""
        self.info: dict = {}
        self.running = False
        self.closed = False
        self.last_activity = time.monotonic()
        self._send_lock = threading.Lock()
        self._cond = threading.Condition()
        self._events: list[dict] = []
        self._next_seq = 1
        self._next_rpc = 1
        self._pending: dict[int, dict] = {}
        self._open_requests: dict[str, dict] = {}
        self._reader = threading.Thread(target=self._read_loop, name=f"hermes-live-{chat_id[:24]}", daemon=True)
        self._reader.start()

    # -- transport --------------------------------------------------------------------------

    def _send(self, frame: dict) -> None:
        with self._send_lock:
            self.connection.send(json.dumps(frame, separators=(",", ":")))

    def call(self, method: str, params: dict, timeout: float = 30) -> dict:
        if self.closed:
            raise HermesLiveError("Hermes connection closed")
        waiter = {"event": threading.Event(), "frame": None}
        with self._cond:
            rpc_id = self._next_rpc
            self._next_rpc += 1
            self._pending[rpc_id] = waiter
        try:
            self._send({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params})
            if not waiter["event"].wait(timeout):
                raise HermesLiveError(f"Hermes did not answer {method} in time")
        finally:
            with self._cond:
                self._pending.pop(rpc_id, None)
        frame = waiter["frame"] or {}
        if frame.get("closed"):
            raise HermesLiveError("Hermes connection closed")
        error = frame.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            raise HermesLiveError(str(error.get("message") or f"Hermes {method} failed"),
                                  code if isinstance(code, int) else None)
        result = frame.get("result")
        return result if isinstance(result, dict) else {}

    def _read_loop(self) -> None:
        try:
            while True:
                raw = self.connection.recv()
                try:
                    frame = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(frame, dict):
                    self._handle_frame(frame)
        except Exception:
            logger.debug("hermes live reader for %s ended", self.chat_id, exc_info=True)
        finally:
            self._mark_closed()

    def _mark_closed(self) -> None:
        with self._cond:
            if self.closed:
                return
            self.closed = True
            for waiter in self._pending.values():
                waiter["frame"] = {"closed": True}
                waiter["event"].set()
            was_running = self.running
            self.running = False
        if was_running:
            self._append("error", {"message": "Lost connection to Hermes during this turn."})
        self._append("connection.closed", {})

    def _handle_frame(self, frame: dict) -> None:
        method = frame.get("method")
        if method == "event":
            params = frame.get("params") or {}
            event_type = str(params.get("type") or "")
            sid = str(params.get("session_id") or "")
            if event_type not in _FORWARDED_EVENTS or (sid and self.session_id and sid != self.session_id
                                                       and event_type != "session.title"):
                return
            payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
            if event_type == "message.start":
                self.running = True
            elif event_type == "message.complete":
                self.running = False
            elif event_type == "request.cancel":
                self._open_requests.pop(str(payload.get("id") or ""), None)
            elif event_type == "session.info":
                self.info = payload
            self._append(event_type, payload)
            return
        if isinstance(method, str) and "id" in frame:
            self._handle_server_request(frame)
            return
        rpc_id = frame.get("id")
        if isinstance(rpc_id, int):
            with self._cond:
                waiter = self._pending.get(rpc_id)
            if waiter is not None:
                waiter["frame"] = frame
                waiter["event"].set()

    def _handle_server_request(self, frame: dict) -> None:
        request_id = str(frame.get("id") or "")
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        if frame.get("method") == "approval" and request_id:
            self._open_requests[request_id] = params
            self._append("approval.request", {"id": request_id, **params})
            return
        # Clarify/sudo/secret/window bridges have no Workbench UI yet: fail fast instead of stalling the agent.
        try:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": -32601, "message": "AI Workbench cannot answer this request"}})
        except Exception:
            logger.debug("hermes live: declining %s failed", frame.get("method"), exc_info=True)

    def _append(self, event_type: str, payload: dict) -> None:
        with self._cond:
            self._events.append({"seq": self._next_seq, "type": event_type, "payload": payload})
            self._next_seq += 1
            if len(self._events) > _MAX_EVENTS:
                del self._events[: len(self._events) - _MAX_EVENTS]
            self._cond.notify_all()

    # -- public API -------------------------------------------------------------------------

    @property
    def cursor(self) -> int:
        with self._cond:
            return self._next_seq - 1

    def events_after(self, after: int, wait: float) -> dict:
        deadline = time.monotonic() + max(0.0, wait)
        with self._cond:
            while True:
                fresh = [event for event in self._events if event["seq"] > after]
                if fresh or self.closed:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            truncated = bool(self._events) and after < self._events[0]["seq"] - 1
            return {"events": fresh, "cursor": self._next_seq - 1, "running": self.running,
                    "closed": self.closed, "truncated": truncated}

    def respond(self, request_id: str, result: dict) -> None:
        if request_id not in self._open_requests:
            raise HermesLiveError("That approval is no longer pending")
        self._open_requests.pop(request_id, None)
        self._send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def close(self) -> None:
        if not self.closed and self.session_id:
            try:
                self.call("session.close", {"session_id": self.session_id}, timeout=5)
            except HermesLiveError:
                pass
        try:
            self.connection.close()
        except Exception:
            pass
        self._mark_closed()


class HermesLiveHub:
    """Keeps one live Hermes session per Workbench chat, evicting idle ones."""

    def __init__(self, map_path: Path, idle_seconds: float = 1800,
                 connect: Callable[[str], Any] | None = None, ws_url: Callable[[], str] = resolve_ws_url,
                 cwd: str = ""):
        self.map_path = Path(map_path)
        self.idle_seconds = idle_seconds
        self.cwd = cwd
        self._connect = connect or _default_connect
        self._ws_url = ws_url
        self._lock = threading.Lock()
        self._chats: dict[str, LiveChat] = {}
        self._opening: dict[str, threading.Lock] = {}
        self._stop = threading.Event()

    # -- stored session mapping --------------------------------------------------------------

    def _load_map(self) -> dict:
        try:
            data = json.loads(self.map_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _remember(self, chat_id: str, stored_session_id: str) -> None:
        with self._lock:
            data = self._load_map()
            data[chat_id] = stored_session_id
            self.map_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.map_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(self.map_path)

    def stored_session_for(self, chat_id: str) -> str:
        return str(self._load_map().get(chat_id) or f"workbench-{chat_id}")

    # -- lifecycle ---------------------------------------------------------------------------

    def chat(self, chat_id: str) -> LiveChat:
        chat_id = str(chat_id or "").strip()
        if not _CHAT_ID_RE.fullmatch(chat_id):
            raise HermesLiveError("Invalid Workbench chat id")
        with self._lock:
            live = self._chats.get(chat_id)
            if live is not None and not live.closed:
                live.last_activity = time.monotonic()
                return live
            opening = self._opening.setdefault(chat_id, threading.Lock())
        with opening:
            with self._lock:
                live = self._chats.get(chat_id)
                if live is not None and not live.closed:
                    return live
            live = self._open(chat_id)
            with self._lock:
                self._chats[chat_id] = live
            return live

    def _open(self, chat_id: str) -> LiveChat:
        try:
            connection = self._connect(self._ws_url())
        except HermesLiveError:
            raise
        except Exception as exc:
            raise HermesLiveError("Could not reach Hermes (hermes serve)") from exc
        live = LiveChat(chat_id, connection)
        try:
            live.call("client.capabilities", {"server_requests": True}, timeout=10)
            stored = self.stored_session_for(chat_id)
            if not _SESSION_ID_RE.fullmatch(stored):
                stored = f"workbench-{chat_id}"
            try:
                resumed = live.call("session.resume", {"session_id": stored}, timeout=60)
                live.stored_session_id = str(resumed.get("session_key") or resumed.get("resumed") or stored)
            except HermesLiveError as exc:
                if exc.code != _SESSION_NOT_FOUND:
                    raise
                resumed = live.call("session.create", {"cwd": self.cwd} if self.cwd else {}, timeout=60)
                live.stored_session_id = str(resumed.get("stored_session_id") or "")
                if live.stored_session_id:
                    self._remember(chat_id, live.stored_session_id)
            live.session_id = str(resumed.get("session_id") or "")
            if not live.session_id:
                raise HermesLiveError("Hermes did not open a session for this chat")
            live.info = resumed.get("info") if isinstance(resumed.get("info"), dict) else {}
            live.running = bool(resumed.get("running"))
            return live
        except Exception:
            live.close()
            raise

    def close_chat(self, chat_id: str) -> None:
        with self._lock:
            live = self._chats.pop(chat_id, None)
        if live is not None:
            live.close()

    def sweep_idle(self) -> int:
        now = time.monotonic()
        with self._lock:
            stale = [chat_id for chat_id, live in self._chats.items()
                     if live.closed or (not live.running and now - live.last_activity > self.idle_seconds)]
            evicted = [self._chats.pop(chat_id) for chat_id in stale]
        for live in evicted:
            live.close()
        return len(evicted)

    def start_sweeper(self) -> threading.Event:
        def loop():
            while not self._stop.wait(60):
                try:
                    self.sweep_idle()
                except Exception:
                    logger.debug("hermes live sweep failed", exc_info=True)
        threading.Thread(target=loop, name="hermes-live-sweeper", daemon=True).start()
        return self._stop

    def close_all(self) -> None:
        self._stop.set()
        self.reset_sessions()

    def reset_sessions(self) -> None:
        with self._lock:
            chats = list(self._chats.values())
            self._chats.clear()
        for live in chats:
            live.close()

    # -- operations --------------------------------------------------------------------------

    def open(self, chat_id: str) -> dict:
        live = self.chat(chat_id)
        return {"session_id": live.stored_session_id, "cursor": live.cursor, "running": live.running,
                "info": _public_info(live.info)}

    def prompt(self, chat_id: str, text: str, images: list | None = None) -> dict:
        text = str(text or "")
        if not text.strip() or len(text) > _MAX_PROMPT_CHARS:
            raise HermesLiveError("Message must be between 1 and 200000 characters")
        images = list(images or [])
        if len(images) > _MAX_IMAGES:
            raise HermesLiveError(f"At most {_MAX_IMAGES} images per message")
        live = self.chat(chat_id)
        if live.running:
            raise HermesLiveError("Hermes is still working on the previous turn; use Stop or Steer")
        cursor = live.cursor
        for index, image in enumerate(images):
            match = _DATA_URL_RE.match(str(image or ""))
            if not match:
                raise HermesLiveError("Images must be base64 data URLs")
            extension = match.group(1).split("/", 1)[1].split("+", 1)[0]
            content = re.sub(r"\s+", "", match.group(2))
            try:
                base64.b64decode(content, validate=True)
            except ValueError as exc:
                raise HermesLiveError("An attached image is not valid base64") from exc
            live.call("image.attach_bytes", {"session_id": live.session_id, "content_base64": content,
                                             "filename": f"workbench-{index + 1}.{extension}"}, timeout=30)
        result = live.call("prompt.submit", {"session_id": live.session_id, "text": text}, timeout=60)
        live.running = True
        live.last_activity = time.monotonic()
        return {"cursor": cursor, "status": str(result.get("status") or "streaming")}

    def command(self, chat_id: str, command: str) -> dict:
        name, arg = parse_command(command)
        live = self.chat(chat_id)
        # Blocks until the session's agent is built; read-only.
        live.call("approval.pending", {"session_id": live.session_id}, timeout=90)
        result = self._run_command(live, name, arg, depth=0)
        live.last_activity = time.monotonic()
        return {"command": f"/{name}" + (f" {arg}" if arg else ""), **result}

    def _run_command(self, live: LiveChat, name: str, arg: str, depth: int) -> dict:
        try:
            result = live.call("slash.exec", {"session_id": live.session_id,
                                              "command": f"{name} {arg}".strip()}, timeout=180)
        except HermesLiveError as exc:
            # Skills, bundles and pending-input built-ins are only served by command.dispatch.
            if exc.code != _USE_COMMAND_DISPATCH:
                raise
            result = live.call("command.dispatch", {"session_id": live.session_id, "name": name, "arg": arg},
                               timeout=120)
        if result.get("type") == "alias" and depth == 0:
            target_name, target_arg = parse_command(str(result.get("target") or ""))
            return self._run_command(live, target_name, " ".join(filter(None, [target_arg, arg])), 1)
        return normalize_command_result(result)

    def interrupt(self, chat_id: str) -> dict:
        live = self.chat(chat_id)
        return live.call("session.interrupt", {"session_id": live.session_id}, timeout=15)

    def steer(self, chat_id: str, text: str) -> dict:
        text = str(text or "").strip()
        if not text or len(text) > 8000:
            raise HermesLiveError("Steer text must be between 1 and 8000 characters")
        live = self.chat(chat_id)
        return live.call("session.steer", {"session_id": live.session_id, "text": text}, timeout=15)

    def respond(self, chat_id: str, request_id: str, choice: str, all_pending: bool = False) -> None:
        if choice not in _APPROVAL_CHOICES:
            raise HermesLiveError("Approval choice must be once, session, always or deny")
        live = self.chat(chat_id)
        live.respond(str(request_id or ""), {"choice": choice, "all": bool(all_pending)})

    def events(self, chat_id: str, after: int, wait: float) -> dict:
        with self._lock:
            live = self._chats.get(str(chat_id or ""))
        # A dropped connection keeps its buffered tail (error, connection.closed) until the next turn reopens it.
        if live is None:
            live = self.chat(chat_id)
        live.last_activity = time.monotonic()
        result = live.events_after(after, min(max(wait, 0.0), 25.0))
        if after > result["cursor"]:
            result["truncated"] = True
        return result


def _public_info(info: dict) -> dict:
    keys = ("model", "provider", "cwd", "title", "profile_name", "reasoning_effort", "service_tier")
    return {key: info[key] for key in keys if key in info and isinstance(info[key], (str, int, float, bool))}
