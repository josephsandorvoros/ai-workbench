import json
import os
import queue
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

import hermes_live


class FakeHermes:
    """Scriptable stand-in for the hermes serve WebSocket."""

    def __init__(self, handlers=None):
        self.inbox = queue.Queue()
        self.requests = []
        self.replies = []
        self.closed = False
        self.handlers = {
            "client.capabilities": lambda p: {"server_requests": ["approval"]},
            "session.resume": lambda p: {"session_id": "rt-1", "session_key": p["session_id"], "info": {"model": "m1"}},
            "approval.pending": lambda p: {"approvals": []},
            "prompt.submit": lambda p: {"status": "streaming"},
            "image.attach_bytes": lambda p: {"attached": True},
            "slash.exec": lambda p: {"output": f"ran {p['command']}"},
            "session.close": lambda p: {"closed": True},
            **(handlers or {}),
        }

    def send(self, text):
        frame = json.loads(text)
        if "method" not in frame:
            self.replies.append(frame)
            return
        self.requests.append(frame)
        handler = self.handlers.get(frame["method"])
        if handler is None:
            self.inbox.put({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "no"}})
            return
        try:
            result = handler(frame["params"])
        except hermes_live.HermesLiveError as exc:
            self.inbox.put({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": exc.code, "message": str(exc)}})
            return
        self.inbox.put({"jsonrpc": "2.0", "id": frame["id"], "result": result})

    def push_event(self, event_type, payload=None, sid="rt-1"):
        self.inbox.put({"jsonrpc": "2.0", "method": "event",
                        "params": {"type": event_type, "session_id": sid, "payload": payload or {}}})

    def recv(self):
        item = self.inbox.get()
        if item is None:
            raise ConnectionError("closed")
        return json.dumps(item)

    def close(self):
        self.closed = True
        self.inbox.put(None)

    def methods(self):
        return [frame["method"] for frame in self.requests]


class HermesLiveHubTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.map_path = Path(self.tmp.name) / "sessions.json"
        self.fakes = []

    def tearDown(self):
        for fake in self.fakes:
            fake.close()
        self.tmp.cleanup()

    def hub(self, fake, **kwargs):
        self.fakes.append(fake)
        return hermes_live.HermesLiveHub(self.map_path, connect=lambda url: fake, ws_url=lambda: "ws://x", **kwargs)

    def test_open_resumes_existing_workbench_session_and_advertises_requests(self):
        fake = FakeHermes()
        result = self.hub(fake).open("chat-1")
        self.assertEqual(fake.methods(), ["client.capabilities", "session.resume"])
        self.assertEqual(fake.requests[0]["params"], {"server_requests": True})
        self.assertEqual(fake.requests[1]["params"], {"session_id": "workbench-chat-1"})
        self.assertEqual(result["session_id"], "workbench-chat-1")
        self.assertEqual(result["info"], {"model": "m1"})

    def test_runtime_reset_closes_cached_sessions_without_stopping_sweeper(self):
        fake = FakeHermes()
        hub = self.hub(fake)
        hub.open("chat-1")
        hub.reset_sessions()
        self.assertTrue(fake.closed)
        self.assertFalse(hub._stop.is_set())
        replacement = FakeHermes()
        self.fakes.append(replacement)
        hub._connect = lambda _url: replacement
        result = hub.open("chat-1")
        self.assertEqual(result["session_id"], "workbench-chat-1")

    def test_new_chat_creates_a_session_and_remembers_it(self):
        def missing(params):
            raise hermes_live.HermesLiveError("session not found", 4007)

        fake = FakeHermes({
            "session.resume": missing,
            "session.create": lambda p: {"session_id": "rt-9", "stored_session_id": "20261008_abc"},
        })
        hub = self.hub(fake)
        hub.open("chat-2")
        self.assertEqual(json.loads(self.map_path.read_text()), {"chat-2": "20261008_abc"})
        self.assertEqual(hub.stored_session_for("chat-2"), "20261008_abc")
        self.assertEqual(oct(self.map_path.stat().st_mode & 0o777), "0o600")

    def test_turns_and_commands_share_one_live_session(self):
        fake = FakeHermes()
        hub = self.hub(fake)
        submitted = hub.prompt("chat-1", "hello", ["data:image/png;base64,iVBORw0KGgo="])
        self.assertEqual(submitted["cursor"], 0)
        fake.push_event("message.start")
        fake.push_event("message.delta", {"text": "Hi"})
        fake.push_event("tool.start", {"tool_id": "t1", "name": "terminal", "args": {"command": "ls"}})
        fake.push_event("skin.changed", {"x": 1})
        fake.push_event("message.complete", {"text": "Hi", "status": "complete", "usage": {"total": 9}})
        deadline = time.time() + 2
        events = []
        while time.time() < deadline and len(events) < 4:
            events += hub.events("chat-1", events[-1]["seq"] if events else 0, 0.5)["events"]
        self.assertEqual([e["type"] for e in events], ["message.start", "message.delta", "tool.start", "message.complete"])

        result = hub.command("chat-1", "/model fav --global")
        self.assertEqual(result, {"command": "/model fav --global", "type": "output", "output": "ran model fav --global",
                                  "warning": ""})
        self.assertEqual(fake.methods().count("session.resume"), 1)
        attach = next(f for f in fake.requests if f["method"] == "image.attach_bytes")
        self.assertEqual(attach["params"]["filename"], "workbench-1.png")
        self.assertEqual(fake.requests[-1]["params"]["session_id"], "rt-1")

    def test_skill_commands_fall_back_to_command_dispatch(self):
        def refuse(params):
            raise hermes_live.HermesLiveError("skill command: use command.dispatch", 4018)

        fake = FakeHermes({
            "slash.exec": refuse,
            "command.dispatch": lambda p: {"type": "skill", "message": "<skill> fix it", "notice": "Loading"},
        })
        result = self.hub(fake).command("chat-1", "/frontend-design fix it")
        self.assertEqual(result["type"], "send")
        self.assertEqual(result["message"], "<skill> fix it")
        dispatch = next(f for f in fake.requests if f["method"] == "command.dispatch")
        self.assertEqual(dispatch["params"], {"session_id": "rt-1", "name": "frontend-design", "arg": "fix it"})

    def test_approval_requests_surface_as_events_and_answers_go_back(self):
        fake = FakeHermes()
        hub = self.hub(fake)
        hub.open("chat-1")
        fake.inbox.put({"jsonrpc": "2.0", "id": "srq-1", "method": "approval",
                        "params": {"session_id": "rt-1", "request_id": "r1", "command": "rm -rf x"}})
        fake.inbox.put({"jsonrpc": "2.0", "id": "srq-2", "method": "clarify",
                        "params": {"session_id": "rt-1", "questions": []}})
        events = hub.events("chat-1", 0, 2)["events"]
        self.assertEqual(events[0]["type"], "approval.request")
        self.assertEqual(events[0]["payload"]["id"], "srq-1")
        hub.respond("chat-1", "srq-1", "once")
        deadline = time.time() + 2
        while time.time() < deadline and len(fake.replies) < 2:
            time.sleep(0.01)
        by_id = {reply["id"]: reply for reply in fake.replies}
        self.assertEqual(by_id["srq-1"]["result"], {"choice": "once", "all": False})
        self.assertEqual(by_id["srq-2"]["error"]["code"], -32601)
        with self.assertRaises(hermes_live.HermesLiveError):
            hub.respond("chat-1", "srq-1", "once")
        with self.assertRaises(hermes_live.HermesLiveError):
            hub.respond("chat-1", "srq-9", "maybe")

    def test_idle_chats_are_evicted_and_closed(self):
        fake = FakeHermes()
        hub = self.hub(fake, idle_seconds=0)
        hub.open("chat-1")
        hub._chats["chat-1"].last_activity -= 5
        self.assertEqual(hub.sweep_idle(), 1)
        self.assertIn("session.close", fake.methods())
        self.assertTrue(fake.closed)

    def test_dropped_connection_reports_error_to_running_turn(self):
        fake = FakeHermes()
        hub = self.hub(fake)
        hub.prompt("chat-1", "hello")
        fake.inbox.put(None)
        result = hub.events("chat-1", 0, 2)
        deadline = time.time() + 2
        while time.time() < deadline and not result["closed"]:
            result = hub.events("chat-1", 0, 0.2)
        self.assertTrue(result["closed"])
        self.assertEqual([e["type"] for e in result["events"]], ["error", "connection.closed"])

    def test_validation_happens_before_connecting(self):
        connect_calls = []
        hub = hermes_live.HermesLiveHub(self.map_path, connect=lambda url: connect_calls.append(url),
                                        ws_url=lambda: "ws://x")
        for bad in ("usage", "/", "/../etc", "/x" + "y" * 4000):
            with self.assertRaises(hermes_live.HermesLiveError):
                hub.command("chat-1", bad)
        with self.assertRaises(hermes_live.HermesLiveError):
            hub.open("../escape")
        self.assertEqual(connect_calls, [])

    def test_requires_token_and_loopback_url(self):
        with unittest.mock.patch.dict(os.environ, {"HERMES_DASHBOARD_SESSION_TOKEN": ""}):
            with self.assertRaisesRegex(hermes_live.HermesLiveError, "not configured"):
                hermes_live.resolve_ws_url()
        with unittest.mock.patch.dict(os.environ, {"HERMES_DASHBOARD_SESSION_TOKEN": "t",
                                                   "HERMES_TUI_GATEWAY_WS_URL": "ws://remote:9119/api/ws"}):
            with self.assertRaisesRegex(hermes_live.HermesLiveError, "loopback"):
                hermes_live.resolve_ws_url()
        with unittest.mock.patch.dict(os.environ, {"HERMES_DASHBOARD_SESSION_TOKEN": "t"}, clear=False):
            os.environ.pop("HERMES_TUI_GATEWAY_WS_URL", None)
            self.assertEqual(hermes_live.resolve_ws_url(), "ws://127.0.0.1:9119/api/ws?token=t")


if __name__ == "__main__":
    unittest.main()
