"""Manage explicitly started project preview processes."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import uuid


MAX_COMMAND_LENGTH = 2000
MAX_LOG_CHARS = 128 * 1024
MAX_ACTIVE_PREVIEWS = 4
PREVIEW_IDLE_TTL_SECONDS = 2 * 60 * 60
PREVIEW_EXITED_TTL_SECONDS = 15 * 60


class PreviewError(ValueError):
    pass


@dataclass
class PreviewSession:
    session_id: str
    project_path: Path
    command: str
    port: int
    process: subprocess.Popen
    started_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    log_lock: threading.Lock = field(default_factory=threading.Lock)
    log: str = ""
    log_base_offset: int = 0
    reader: threading.Thread | None = None


class AppPreviewManager:
    def __init__(self, workspace_root: Path):
        self.workspace_root = Path(workspace_root).resolve()
        self.lock = threading.RLock()
        self.sessions: dict[str, PreviewSession] = {}
        self.stop_event = threading.Event()
        self.sweeper: threading.Thread | None = None

    def _project_path(self, path: str) -> Path:
        raw = str(path or "").strip()
        if not raw or Path(raw).is_absolute():
            raise PreviewError("Choose a project directory inside the workspace")
        try:
            target = (self.workspace_root / raw).resolve(strict=True)
            target.relative_to(self.workspace_root)
        except (OSError, ValueError) as exc:
            raise PreviewError("Project path must stay inside the workspace") from exc
        if not target.is_dir():
            raise PreviewError("Project path is not a directory")
        return target

    @staticmethod
    def _port(value: int) -> int:
        try:
            port = int(value)
        except (TypeError, ValueError) as exc:
            raise PreviewError("Enter a valid local port") from exc
        if port < 1024 or port > 65535:
            raise PreviewError("Port must be between 1024 and 65535")
        return port

    def start(self, path: str, command: str, port: int) -> dict:
        project_path = self._project_path(path)
        command = str(command or "").strip()
        if not command or len(command) > MAX_COMMAND_LENGTH:
            raise PreviewError(f"Command must be between 1 and {MAX_COMMAND_LENGTH} characters")
        port = self._port(port)

        with self.lock:
            active = [session for session in self.sessions.values() if session.process.poll() is None]
            if len(active) >= MAX_ACTIVE_PREVIEWS:
                raise PreviewError(f"At most {MAX_ACTIVE_PREVIEWS} previews can run at once")
            if any(session.port == port for session in active):
                raise PreviewError(f"Port {port} is already assigned to a running preview")
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.bind(("127.0.0.1", port))
            except OSError as exc:
                raise PreviewError(f"Port {port} is already in use") from exc

            session_id = str(uuid.uuid4())
            env = {
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "HOME": str(project_path),
                "PWD": str(project_path),
                "HOST": "127.0.0.1",
                "PORT": str(port),
                "PREVIEW_BASE": f"/api/app-preview/view/{session_id}/",
                "TERM": "dumb",
                "CI": "1",
            }
            for name in ("LANG", "LC_ALL", "NODE_ENV"):
                if os.environ.get(name):
                    env[name] = os.environ[name]
            try:
                process = subprocess.Popen(
                    ["/bin/bash", "-c", command],
                    cwd=project_path,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    close_fds=True,
                )
            except OSError as exc:
                raise PreviewError(f"Could not start preview command: {exc}") from exc

            session = PreviewSession(session_id, project_path, command, port, process)
            session.reader = threading.Thread(target=self._read_output, args=(session,), daemon=True)
            self.sessions[session_id] = session
            session.reader.start()
            return self._snapshot(session)

    @staticmethod
    def _read_output(session: PreviewSession) -> None:
        if session.process.stdout is None:
            return
        while True:
            chunk = session.process.stdout.read1(4096)
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace")
            with session.log_lock:
                session.log += text
                if len(session.log) > MAX_LOG_CHARS:
                    trim = len(session.log) - MAX_LOG_CHARS
                    session.log = session.log[trim:]
                    session.log_base_offset += trim

    def _snapshot(self, session: PreviewSession) -> dict:
        exit_code = session.process.poll()
        running = exit_code is None
        ready = False
        if running:
            try:
                with socket.create_connection(("127.0.0.1", session.port), timeout=0.15):
                    ready = True
            except OSError:
                pass
        return {
            "session_id": session.session_id,
            "path": str(session.project_path.relative_to(self.workspace_root)),
            "command": session.command,
            "port": session.port,
            "running": running,
            "ready": ready,
            "exit_code": exit_code,
            "started_at": session.started_at,
        }

    def status(self, session_id: str) -> dict | None:
        with self.lock:
            session = self.sessions.get(str(session_id))
            if session:
                session.last_active = time.time()
        return self._snapshot(session) if session else None

    def get_session(self, session_id: str) -> PreviewSession | None:
        with self.lock:
            session = self.sessions.get(str(session_id))
            if session:
                session.last_active = time.time()
            return session

    def logs(self, session_id: str, offset: int = 0) -> dict | None:
        with self.lock:
            session = self.sessions.get(str(session_id))
        if not session:
            return None
        with self.lock:
            session.last_active = time.time()
        with session.log_lock:
            base = session.log_base_offset
            start = max(0, int(offset))
            if start < base:
                start = base
            index = min(len(session.log), start - base)
            text = session.log[index:]
            next_offset = base + len(session.log)
        return {"session_id": session.session_id, "data": text, "next_offset": next_offset,
                "base_offset": base, "running": session.process.poll() is None}

    def stop(self, session_id: str) -> bool:
        with self.lock:
            session = self.sessions.get(str(session_id))
        if not session:
            return False
        if session.process.poll() is None:
            try:
                os.killpg(session.process.pid, signal.SIGTERM)
                session.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(session.process.pid, signal.SIGKILL)
                except OSError:
                    pass
                session.process.wait(timeout=2)
            except OSError:
                pass
        if session.reader:
            session.reader.join(timeout=1)
        if session.process.stdout:
            session.process.stdout.close()
        return True

    def start_sweeper(self) -> None:
        if self.sweeper and self.sweeper.is_alive():
            return

        def sweep() -> None:
            while not self.stop_event.wait(30):
                now = time.time()
                with self.lock:
                    expired = [
                        session.session_id
                        for session in self.sessions.values()
                        if (session.process.poll() is None and now - session.last_active > PREVIEW_IDLE_TTL_SECONDS)
                        or (session.process.poll() is not None and now - session.started_at > PREVIEW_EXITED_TTL_SECONDS)
                    ]
                for session_id in expired:
                    self.stop(session_id)
                    with self.lock:
                        self.sessions.pop(session_id, None)

        self.sweeper = threading.Thread(target=sweep, name="app-preview-sweeper", daemon=True)
        self.sweeper.start()

    def close_all(self) -> None:
        self.stop_event.set()
        if self.sweeper and self.sweeper is not threading.current_thread():
            self.sweeper.join(timeout=1)
        with self.lock:
            session_ids = list(self.sessions)
        for session_id in session_ids:
            self.stop(session_id)