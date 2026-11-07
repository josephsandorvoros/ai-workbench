import base64
import contextlib
import http.client
import io
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import dashboard_server


class DashboardContractServer:
    def __init__(self, env):
        self.env = env
        self.old_env = {}
        self.server = None
        self.thread = None
        self.base_url = ""

    def __enter__(self):
        for key, value in self.env.items():
            self.old_env[key] = os.environ.get(key)
            os.environ[key] = value

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard_server.DashboardHandler)
        self.server.state = dashboard_server.DashboardState()
        port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)

        for key, old_value in self.old_env.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value

    def get_json(self, path, query=None, headers=None):
        suffix = path
        if query:
            suffix = f"{path}?{urlencode(query)}"
        req = Request(f"{self.base_url}{suffix}", headers=headers or {})
        with urlopen(req, timeout=4) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def get_raw(self, path, query=None, headers=None):
        suffix = path
        if query:
            suffix = f"{path}?{urlencode(query)}"
        req = Request(f"{self.base_url}{suffix}", headers=headers or {})
        with urlopen(req, timeout=4) as response:
            return response.status, dict(response.headers), response.read()

    def post_json(self, path, payload=None, headers=None):
        data = json.dumps(payload or {}).encode("utf-8")
        req = Request(
            f"{self.base_url}{path}",
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        with urlopen(req, timeout=4) as response:
            return response.status, json.loads(response.read().decode("utf-8"))


@contextlib.contextmanager
def contract_server(extra_env=None, legacy_backups=False):
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        wiki_root = root / "wiki"
        artifact_root = root / "artifacts"
        hermes_root = root / "hermes"
        workspace_root = root / "workspace"
        wiki_root.mkdir()
        artifact_root.mkdir()
        hermes_root.mkdir()
        workspace_root.mkdir()
        if legacy_backups:
            for old in (wiki_root, workspace_root):
                backup_dir = old / ".dashboard-backups"
                backup_dir.mkdir()
                (backup_dir / "old-note.md.20260927.bak").write_text("original", encoding="utf-8")

        env = {
            "AI_NODE_SSH_TARGET": "tester@192.0.2.10",
            "AI_NODE_STATS_URL": "",
            "HERMES_WORKDIR": str(hermes_root),
            "WIKI_ROOT": str(wiki_root),
            "WORKSPACE_ROOT": str(workspace_root),
            "WORKBENCH_BACKUP_DIR": str(root / "backups"),
            "TERMINAL_API_TOKEN": "",
            "JOBS_DB": str(root / "jobs.db"),
        }
        env.update(extra_env or {})
        home_override = (extra_env or {}).get("HERMES_HOME") or (
            str(hermes_root) if dashboard_server.HERMES_HOME == Path(os.getenv("HERMES_HOME", str(dashboard_server.HERMES_HOME))) else str(dashboard_server.HERMES_HOME)
        )
        home_patch = patch.object(dashboard_server, "HERMES_HOME", Path(home_override))
        with home_patch, DashboardContractServer(env) as server:
            server.temp_root = root
            server.wiki_root = wiki_root
            server.artifact_root = artifact_root
            server.workspace_root = workspace_root
            yield server


class ApiContractTests(unittest.TestCase):
    def test_herdr_worker_input_uses_existing_auth_and_keeps_keys_explicit(self):
        with contract_server({"TERMINAL_API_TOKEN": "unit-test-token", "WORKBENCH_AUTH": "token"}) as server:
            with self.assertRaises(HTTPError) as unauthorized:
                server.post_json("/api/jobs/example/subtasks/0/input", {"text": "Continue"})
            self.assertEqual(unauthorized.exception.code, 401)
            with patch.object(server.server.state.jobs, "message_worker", return_value={"id": "example"}) as message:
                status, _ = server.post_json("/api/jobs/example/subtasks/0/input", {"text": "Continue", "key": "true"},
                                             headers={"X-Terminal-Token": "unit-test-token"})
                self.assertEqual(status, 200)
                message.assert_called_once_with("example", 0, "Continue", key=False)

    def test_workbench_chat_delete_persists_and_preserves_artifact_state(self):
        with contract_server() as server:
            state = server.server.state
            server.post_json("/api/workbench/state", {
                "artifact": {"name": "current", "html": "<h1>kept</h1>", "updatedAt": 1},
                "chat_sessions": [{"id": "chat-1"}, {"id": "chat-2"}],
            })
            hermes_db = state._agent_roots()["hermes_state_db"]
            hermes_db.parent.mkdir(parents=True, exist_ok=True)
            import sqlite3
            with sqlite3.connect(hermes_db) as connection:
                connection.executescript(
                    "CREATE TABLE sessions (id TEXT PRIMARY KEY);"
                    "CREATE TABLE messages (session_id TEXT);"
                    "INSERT INTO sessions VALUES ('hermes-session-1');"
                    "INSERT INTO messages VALUES ('hermes-session-1');"
                )
            state.remember_gateway_session_id("chat-1", "hermes-session-1")

            _, result = server.post_json("/api/workbench/chat-session/delete", {"id": "chat-1"})
            _, state = server.get_json("/api/workbench/state")

            self.assertTrue(result["ok"])
            self.assertEqual(result["deleted"], 1)
            self.assertTrue(result["agent_session_deleted"])
            self.assertEqual([session["id"] for session in state["chat_sessions"]], ["chat-2"])
            self.assertEqual(state["artifact"]["html"], "<h1>kept</h1>")
            with sqlite3.connect(hermes_db) as connection:
                self.assertEqual(connection.execute("SELECT id FROM sessions").fetchall(), [])
                self.assertEqual(connection.execute("SELECT session_id FROM messages").fetchall(), [])

    def test_gateway_session_mapping_persists_and_marks_agent_history(self):
        with contract_server() as server:
            state = server.server.state
            state.remember_gateway_session_id("chat-1", "hermes-session-1")
            restarted = dashboard_server.DashboardState()
            self.assertEqual(restarted.gateway_session_id_for("chat-1"), "hermes-session-1")

            with patch.object(restarted, "_read_sqlite", side_effect=[
                [("hermes-session-1", "A saved chat", "api", "model", 2, 1, 2, None, 0)],
                None,
            ]):
                sessions = restarted.agent_sessions()["sessions"]

            self.assertEqual(sessions[0]["workbench_chat_id"], "chat-1")

    def test_app_preview_start_requires_terminal_token_when_configured(self):
        with contract_server(extra_env={"TERMINAL_API_TOKEN": "preview-test-token"}) as server:
            project = server.workspace_root / "demo"
            project.mkdir()
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            payload = {"path": "demo", "command": "exec sleep 30", "port": port}

            with self.assertRaises(HTTPError) as unauthorized:
                server.post_json("/api/app-preview/start", payload)
            self.assertEqual(unauthorized.exception.code, 401)
            self.assertEqual(server.server.state.app_previews.sessions, {})

            _, preview = server.post_json("/api/app-preview/start", payload, headers={
                "X-Terminal-Token": "preview-test-token",
            })
            self.assertTrue(server.server.state.app_previews.stop(preview["session_id"]))

    def test_app_preview_starts_proxies_html_and_assets_then_stops(self):
        with contract_server() as server:
            project = server.workspace_root / "demo"
            (project / "assets").mkdir(parents=True)
            (project / "preview_app.py").write_text(
                "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
                "import json, os\n"
                "class Handler(BaseHTTPRequestHandler):\n"
                " def do_GET(self):\n"
                "  body = b\"<html><head></head><body><img src='/assets/logo.png'><script>fetch('/api/time')</script>preview page</body></html>\" if self.path == '/' else b'window.previewLoaded = true;'\n"
                "  self.send_response(200); self.send_header('Content-Type', 'text/html' if self.path == '/' else 'application/javascript'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)\n"
                " def do_POST(self):\n"
                "  body = self.rfile.read(int(self.headers.get('Content-Length', '0')))\n"
                "  result = json.dumps({'authorization': self.headers.get('Authorization'), 'cookie': self.headers.get('Cookie'), 'body': body.decode()}).encode()\n"
                "  self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(result))); self.end_headers(); self.wfile.write(result)\n"
                "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()\n",
                encoding="utf-8",
            )
            (project / "assets" / "app.js").write_text("window.previewLoaded = true;", encoding="utf-8")
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]

            _, preview = server.post_json("/api/app-preview/start", {
                "path": "demo",
                "command": "python3 preview_app.py",
                "port": port,
            })
            session_id = preview["session_id"]
            self.assertEqual(preview["path"], "demo")

            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                _, status = server.get_json("/api/app-preview/status", {"session_id": session_id})
                if status["ready"]:
                    break
                time.sleep(0.05)
            self.assertTrue(status["ready"])

            _, headers, body = server.get_raw(f"/api/app-preview/view/{session_id}/")
            self.assertIn("text/html", headers["Content-Type"])
            self.assertIn(f'<base href="/api/app-preview/view/{session_id}/">'.encode(), body)
            self.assertIn(f"fetch('/api/app-preview/view/{session_id}/api/time')".encode(), body)
            self.assertIn(f"src='/api/app-preview/view/{session_id}/assets/logo.png'".encode(), body)
            _, _, asset = server.get_raw(f"/api/app-preview/view/{session_id}/assets/app.js")
            self.assertEqual(asset, b"window.previewLoaded = true;")

            req = Request(
                f"{server.base_url}/api/app-preview/view/{session_id}/api/echo",
                data=b'{"value":"ok"}',
                method="POST",
                headers={"Content-Type": "application/json", "Authorization": "Bearer do-not-forward", "Cookie": "session=do-not-forward"},
            )
            with urlopen(req, timeout=4) as response:
                posted = json.loads(response.read().decode("utf-8"))
            self.assertEqual(posted, {"authorization": None, "cookie": None, "body": '{"value":"ok"}'})

            _, stopped = server.post_json("/api/app-preview/stop", {"session_id": session_id})
            self.assertTrue(stopped["ok"])
            _, status = server.get_json("/api/app-preview/status", {"session_id": session_id})
            self.assertFalse(status["running"])

    def test_runtime_catalog_returns_connected_providers_and_current_model_without_secrets(self):
        with contract_server() as server:
            responses = [{"all": [{"id": "github-copilot", "name": "GitHub Copilot", "options": {"token": "hidden-token"},
                                      "models": {"org/model": {"name": "My model"}}}],
                          "connected": ["github-copilot"], "default": {"github-copilot": "org/model"}},
                         {"model": "github-copilot/org/model", "provider": {"github-copilot": {"options": {"apiKey": "hidden-key"}}}}]
            with patch.object(dashboard_server.provider_catalog, "read_catalog_json", side_effect=responses) as fetch:
                _, catalog = server.get_json("/api/model-catalog", {"engine": "opencode"})
                self.assertTrue(catalog["providers"][0]["connected"])
                self.assertEqual(catalog["current"], {"provider": "github-copilot", "model": "org/model"})
                self.assertEqual(catalog["auth_scope"], "main")
                self.assertNotIn("hidden", json.dumps(catalog))
                server.get_json("/api/model-catalog", {"engine": "opencode"})
                self.assertEqual(fetch.call_count, 2)

    def test_runtime_catalog_failure_preserves_manual_options_and_rejects_unknown_engine(self):
        with contract_server() as server:
            with patch.object(dashboard_server.provider_catalog, "read_catalog_json", side_effect=OSError("private-error-with-secret")):
                _, catalog = server.get_json("/api/model-catalog", {"engine": "hermes"})
            self.assertFalse(catalog["available"])
            self.assertEqual(catalog["providers"], [])
            self.assertNotIn("private-error", json.dumps(catalog))
            with self.assertRaises(HTTPError) as failure:
                server.get_json("/api/model-catalog", {"engine": "arbitrary-url"})
            self.assertEqual(failure.exception.code, 400)

    def test_opencode_provider_switch_does_not_override_native_login_with_old_key(self):
        with contract_server() as server:
            server.post_json("/api/opencode-settings", {"main": {"model": "private-model", "base_url": "http://private.example/v1", "api_key": "private-key"}})
            _, switched = server.post_json("/api/opencode-settings", {"main": {"model": "github-copilot/claude-sonnet", "base_url": ""}})
            self.assertFalse(switched["main"]["api_key_set"])
            config = json.loads((dashboard_server.HERMES_HOME / ".config/opencode/opencode.json").read_text())
            self.assertNotIn("apiKey", config.get("provider", {}).get("github-copilot", {}).get("options", {}))
            _, restored = server.post_json("/api/opencode-settings", {"main": {"model": "private-model", "base_url": "http://private.example/v1"}})
            self.assertTrue(restored["main"]["api_key_set"])
            self.assertNotIn("private-key", json.dumps(restored))

    def test_hermes_settings_are_persistent_write_only_and_resettable(self):
        with contract_server({"LLM_BASE_URL": "http://default.example/v1", "LLM_MODEL": "default-model"}) as server:
            _, defaults = server.get_json("/api/hermes-settings")
            self.assertEqual(defaults["connection"]["model"], "default-model")
            _, result = server.post_json("/api/hermes-settings", {"provider": "custom", "model": "new-model",
                "base_url": "http://new.example/v1", "api_key": "hermes-private-key"})
            self.assertTrue(result["api_key_set"])
            self.assertTrue(result["restart_required"])
            self.assertNotIn("hermes-private-key", json.dumps(result))
            _, saved = server.get_json("/api/hermes-settings")
            self.assertEqual(saved["connection"]["model"], "new-model")
            self.assertTrue(saved["connection"]["override_set"])
            server.post_json("/api/hermes-settings", {"provider": "custom", "model": "new-model", "base_url": "http://new.example/v1"})
            self.assertTrue(server.get_json("/api/hermes-settings")[1]["api_key_set"])
            server.post_json("/api/hermes-settings", {"provider": "custom", "model": "other-model", "base_url": "http://other.example/v1"})
            self.assertFalse(server.get_json("/api/hermes-settings")[1]["api_key_set"])
            _, reset = server.post_json("/api/hermes-settings", {"reset": True})
            self.assertEqual(reset["connection"]["model"], "default-model")
            self.assertFalse(reset["connection"]["override_set"])

    def test_hermes_settings_mutations_require_terminal_auth(self):
        with contract_server({"TERMINAL_API_TOKEN": "test-private-token"}) as server:
            with self.assertRaises(HTTPError) as failure:
                server.post_json("/api/hermes-settings", {"reset": True})
            self.assertEqual(failure.exception.code, 401)

    def test_hermes_runtime_api_requires_auth_confirmation_and_supported_image(self):
        with contract_server({"TERMINAL_API_TOKEN": "test-private-token", "WORKBENCH_HERMES_MANAGED": "0"}) as server:
            _, runtime = server.get_json("/api/hermes-runtime")
            self.assertFalse(runtime["supported"])
            with self.assertRaises(HTTPError) as failure:
                server.post_json("/api/hermes-runtime", {"action": "update", "version": "v1.2.3", "confirm": True})
            self.assertEqual(failure.exception.code, 401)
            headers = {"X-Terminal-Token": "test-private-token"}
            for payload in ({"action": "apply"}, {"action": "apply", "confirm": True}):
                with self.assertRaises(HTTPError) as failure:
                    server.post_json("/api/hermes-runtime", payload, headers=headers)
                self.assertEqual(failure.exception.code, 400)

    def test_hermes_settings_blank_key_preserves_existing_connection_credentials(self):
        with contract_server({"LLM_BASE_URL": "http://default.example/v1", "LLM_MODEL": "default-model", "LLM_API_KEY": "existing-key"}) as server:
            _, saved = server.post_json("/api/hermes-settings", {"provider": "custom", "model": "updated-model", "base_url": "http://default.example/v1"})
            self.assertTrue(saved["api_key_set"])
            self.assertNotIn("existing-key", json.dumps(saved))

    def test_speech_urls_are_instance_settings_and_tokens_remain_write_only(self):
        stt_token = "stt-instance-secret"
        tts_token = "tts-instance-secret"
        with contract_server({
            "SPEECH_STT_URL": "http://192.0.2.20:8081",
            "SPEECH_TTS_URL": "http://192.0.2.20:8082",
        }) as server:
            _, defaults = server.get_json("/api/settings")
            self.assertEqual(defaults["speech"]["stt_url"], "http://192.0.2.20:8081")
            self.assertFalse(defaults["speech"]["stt_url_override_set"])
            self.assertFalse(defaults["speech"]["stt_token_set"])

            server.post_json("/api/settings", {"speech": {
                "stt_url": "http://192.0.2.30:8081", "tts_url": "http://192.0.2.30:8082",
            }})
            _, saved = server.get_json("/api/settings")
            self.assertEqual(saved["speech"]["stt_url"], "http://192.0.2.30:8081")
            self.assertTrue(saved["speech"]["stt_url_override_set"])
            server.post_json("/api/settings/secret", {"name": "speech:stt", "value": stt_token})
            server.post_json("/api/settings/secret", {"name": "speech:tts", "value": tts_token})
            _, configured = server.get_json("/api/settings")
            self.assertTrue(configured["speech"]["stt_token_set"])
            self.assertTrue(configured["speech"]["tts_token_set"])
            self.assertNotIn(stt_token, json.dumps(configured))
            self.assertNotIn(tts_token, json.dumps(configured))
            self.assertEqual(server.server.state.speech_service_config("stt"), ("http://192.0.2.30:8081", stt_token))

            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/settings", {"speech": {"stt_url": "file:///etc/passwd"}})
            self.assertEqual(error.exception.code, 400)
            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/settings", {"speech": {"stt_token": "not-allowed"}})
            self.assertEqual(error.exception.code, 400)

            server.post_json("/api/settings", {"speech": {"stt_url": None, "tts_url": None}})
            _, reset = server.get_json("/api/settings")
            self.assertEqual(reset["speech"]["stt_url"], "http://192.0.2.20:8081")
            self.assertFalse(reset["speech"]["stt_url_override_set"])
            self.assertTrue(reset["speech"]["stt_token_set"])
            server.post_json("/api/settings/secret", {"name": "speech:stt", "value": None})
            _, cleared = server.get_json("/api/settings")
            self.assertFalse(cleared["speech"]["stt_token_set"])
            self.assertTrue(cleared["speech"]["tts_token_set"])
            self.assertEqual(server.server.state.speech_service_config("stt")[0], "http://192.0.2.20:8081")

    def test_speech_secrets_are_write_only_and_speech_routes_use_them_server_side(self):
        stt_token = "speech-stt-test-secret"
        tts_token = "speech-tts-test-secret"
        wav = b"RIFF" + (len(b"WAVE") + 4).to_bytes(4, "little") + b"WAVEdata"
        with contract_server({
            "SPEECH_STT_URL": "http://192.0.2.20:8081",
            "SPEECH_TTS_URL": "http://192.0.2.20:8082",
        }) as server:
            server.post_json("/api/settings/secret", {"name": "speech:stt", "value": stt_token})
            server.post_json("/api/settings/secret", {"name": "speech:tts", "value": tts_token})
            _, settings = server.get_json("/api/settings")
            self.assertNotIn(stt_token, json.dumps(settings))
            self.assertNotIn(tts_token, json.dumps(settings))
            secrets = server.server.state._read_settings()["secrets"]
            self.assertEqual(secrets["speech:stt"], stt_token)
            self.assertEqual(secrets["speech:tts"], tts_token)

            with patch.object(dashboard_server.speech_services, "list_voices", return_value={"ok": True, "voices": [{"id": "af_heart", "label": "af_heart"}], "warning": ""}) as voices:
                status, voice_result = server.get_json("/api/speech/voices")
            self.assertEqual(status, 200)
            self.assertEqual(voice_result["voices"][0]["id"], "af_heart")
            voices.assert_called_once_with("http://192.0.2.20:8082", tts_token)

            audio_request = Request(
                f"{server.base_url}/api/speech/transcriptions", data=b"webm-audio",
                method="POST", headers={"Content-Type": "audio/webm"},
            )
            with patch.object(dashboard_server.speech_services, "transcribe", return_value={"ok": True, "text": "hello"}) as transcribe:
                with urlopen(audio_request, timeout=4) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["text"], "hello")
            transcribe.assert_called_once_with(b"webm-audio", "audio/webm", "http://192.0.2.20:8081", stt_token)

            with patch.object(dashboard_server.speech_services, "synthesize", return_value=wav) as synthesize:
                request = Request(
                    f"{server.base_url}/api/speech/synthesize", data=json.dumps({"text": "Hello.", "voice": "af_heart", "speed": 1}).encode(),
                    method="POST", headers={"Content-Type": "application/json"},
                )
                with urlopen(request, timeout=4) as response:
                    status, headers, response_body = response.status, dict(response.headers), response.read()
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "audio/wav")
            self.assertEqual(headers["Cache-Control"], "no-store, private")
            self.assertEqual(response_body, wav)
            synthesize.assert_called_once_with("Hello.", "af_heart", 1, "http://192.0.2.20:8082", tts_token)

    def test_speech_routes_require_server_side_secrets_and_audio_limits(self):
        with contract_server({
            "SPEECH_STT_URL": "http://192.0.2.20:8081",
            "SPEECH_TTS_URL": "http://192.0.2.20:8082",
        }) as server, patch("speech_services.urlopen") as open_url:
            with self.assertRaises(HTTPError) as error:
                server.get_json("/api/speech/voices")
            self.assertEqual(error.exception.code, 503)
            request = Request(
                f"{server.base_url}/api/speech/transcriptions", data=b"audio",
                method="POST", headers={"Content-Type": "audio/webm"},
            )
            with self.assertRaises(HTTPError) as error:
                with urlopen(request, timeout=4):
                    pass
            self.assertEqual(error.exception.code, 503)
            open_url.assert_not_called()

            address = server.server.server_address
            connection = http.client.HTTPConnection(address[0], address[1], timeout=4)
            connection.putrequest("POST", "/api/speech/transcriptions")
            connection.putheader("Content-Type", "audio/webm")
            connection.putheader("Content-Length", str(dashboard_server.speech_services.MAX_SPEECH_UPLOAD_BYTES + 1))
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
            connection.close()
            open_url.assert_not_called()

    def test_free_model_catalogue_route_and_forced_refresh(self):
        payload = {"ok": True, "sections": {"zen": {"models": []}, "api": {"models": []}}, "refresh_seconds": 86400}
        with contract_server() as server, patch.object(dashboard_server.free_model_tracker, "get", return_value=payload) as get_models:
            status, result = server.get_json("/api/free-models")
            self.assertEqual(status, 200)
            self.assertEqual(result, payload)
            get_models.assert_called_once_with(force=False)
            server.get_json("/api/free-models", query={"refresh": "1"})
            get_models.assert_called_with(force=True)

    def test_hermes_chat_routes_delegate_to_live_hub(self):
        with contract_server() as server:
            hub = server.server.state.hermes_live
            with patch.object(hub, "prompt", return_value={"cursor": 4, "status": "streaming"}) as prompt, \
                    patch.object(hub, "events", return_value={"events": [], "cursor": 4, "running": True,
                                                             "closed": False, "truncated": False}) as events, \
                    patch.object(hub, "respond") as respond:
                status, payload = server.post_json("/api/hermes/chat/prompt", {
                    "chat_id": "chat-1", "text": "hello", "images": ["data:image/png;base64,AAAA"]})
                self.assertEqual((status, payload), (200, {"ok": True, "cursor": 4, "status": "streaming"}))
                prompt.assert_called_once_with("chat-1", "hello", ["data:image/png;base64,AAAA"])

                status, payload = server.get_json("/api/hermes/chat/events",
                                                  query={"chat_id": "chat-1", "after": "4", "wait": "0"})
                self.assertEqual(status, 200)
                self.assertTrue(payload["running"])
                events.assert_called_once_with("chat-1", 4, 0.0)

                status, payload = server.post_json("/api/hermes/chat/respond", {
                    "chat_id": "chat-1", "request_id": "srq-1", "choice": "deny"})
                self.assertEqual((status, payload), (200, {"ok": True}))
                respond.assert_called_once_with("chat-1", "srq-1", "deny", False)

            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/hermes/chat/nope", {"chat_id": "chat-1"})
            self.assertEqual(error.exception.code, 404)

    def test_hermes_chat_usage_command_appends_persisted_totals(self):
        with contract_server() as server, patch.object(
            dashboard_server.DashboardState, "gateway_session_totals", return_value="Chat Totals",
        ) as totals:
            hub = server.server.state.hermes_live
            live = type("Live", (), {"stored_session_id": "workbench-chat-1"})()
            with patch.object(hub, "command", return_value={"command": "/usage", "type": "output", "output": "Usage"}), \
                    patch.object(hub, "chat", return_value=live):
                status, payload = server.post_json("/api/hermes/chat/command", {"chat_id": "chat-1", "command": "/usage"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["output"], "Usage\n\nChat Totals")
        totals.assert_called_once_with("workbench-chat-1")

    def test_hermes_chat_errors_are_safe_400s(self):
        with contract_server() as server, self.assertRaises(HTTPError) as error:
            server.post_json("/api/hermes/chat/open", {"chat_id": "../bad"})
        self.assertEqual(error.exception.code, 400)
        self.assertEqual(json.loads(error.exception.read())["message"], "Invalid Workbench chat id")

    def test_hermes_proxy_preserves_valid_session_id_headers(self):
        captured = {}

        class FakeUpstream:
            status = 200
            headers = {
                "Content-Type": "application/json",
                "X-Hermes-Session-Id": "api-session-returned",
            }

            def __init__(self):
                self.sent = False

            def read1(self, _size):
                if self.sent:
                    return b""
                self.sent = True
                return b'{"ok":true}'

            def read(self, _size=-1):
                return self.read1(_size)

            def getcode(self):
                return self.status

            def close(self):
                pass

        def fake_urlopen(request, timeout):
            captured["request_session_id"] = request.get_header("X-hermes-session-id")
            captured["authorization"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return FakeUpstream()

        with contract_server() as server, \
                patch.object(server.server.state, "proxy_target", return_value=("http://127.0.0.1:9000/v1", "private-key")), \
                patch.object(dashboard_server, "urlopen", side_effect=fake_urlopen):
            request = Request(
                f"{server.base_url}/api/proxy/hermes/chat/completions",
                data=b"{}",
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Hermes-Session-Id": "api-session-existing",
                    "X-Workbench-Chat-Id": "workbench-chat-1",
                },
            )
            with urlopen(request, timeout=4) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("X-Hermes-Session-Id"), "api-session-returned")
                self.assertEqual(response.read(), b'{"ok":true}')

        self.assertEqual(captured["request_session_id"], "api-session-existing")
        self.assertEqual(captured["authorization"], "Bearer private-key")
        self.assertEqual(
            server.server.state.gateway_session_id_for("workbench-chat-1"),
            "api-session-returned",
        )

    def test_pending_api_key_is_saved_atomically_when_selecting_gateway(self):
        with contract_server() as server:
            openai = {"kind": "api", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}
            gateway = {"kind": "api", "baseUrl": "/hermes-gw", "model": "hermes-agent"}
            server.post_json("/api/settings", {"provider": openai})
            _, selected = server.post_json("/api/settings", {
                "provider": gateway, "provider_key": {"endpoint": openai["baseUrl"], "value": "pending-openai-key"},
            })
            self.assertFalse(selected["apiKeySet"])
            self.assertNotIn("pending-openai-key", json.dumps(selected))
            _, public = server.get_json("/api/settings")
            self.assertNotIn("pending-openai-key", json.dumps(public))
            self.assertNotIn("provider", server.server.state._read_settings()["secrets"])
            _, restored = server.post_json("/api/settings", {"provider": openai})
            self.assertTrue(restored["apiKeySet"])
            self.assertEqual(server.server.state._read_settings()["secrets"]["provider"], "pending-openai-key")

    def test_chat_provider_keys_follow_endpoints_not_gateway_selection(self):
        with contract_server() as server:
            openai = {"kind": "api", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}
            gateway = {"kind": "api", "baseUrl": "/hermes-gw", "model": "hermes-agent"}
            server.post_json("/api/settings", {"provider": openai})
            server.post_json("/api/settings/secret", {"name": "provider", "value": "openai-secret", "endpoint": openai["baseUrl"]})
            _, saved = server.get_json("/api/settings")
            self.assertTrue(saved["provider"]["apiKeySet"])
            _, selected = server.post_json("/api/settings", {"provider": gateway})
            self.assertFalse(selected["apiKeySet"])
            self.assertFalse(server.server.state.get_settings()["provider"]["apiKeySet"])
            self.assertNotIn("provider", server.server.state._read_settings()["secrets"])
            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/settings/secret", {"name": "provider", "value": "late-key", "endpoint": openai["baseUrl"]})
            self.assertEqual(error.exception.code, 400)
            _, restored = server.post_json("/api/settings", {"provider": openai})
            self.assertTrue(restored["apiKeySet"])
            self.assertEqual(server.server.state._read_settings()["secrets"]["provider"], "openai-secret")
            _, public = server.get_json("/api/settings")
            self.assertNotIn("openai-secret", json.dumps(public))
            other = {**openai, "baseUrl": "https://other.example/v1"}
            server.post_json("/api/settings", {"provider": other})
            self.assertNotIn("provider", server.server.state._read_settings()["secrets"])
            server.post_json("/api/settings", {"provider": openai})
            server.post_json("/api/settings/secret", {"name": "provider", "value": "", "endpoint": openai["baseUrl"]})
            server.post_json("/api/settings", {"provider": gateway})
            _, cleared = server.post_json("/api/settings", {"provider": openai})
            self.assertFalse(cleared["apiKeySet"])

    def test_opencode_settings_persist_and_keys_are_write_only(self):
        with contract_server({"OPENCODE_MODEL": "opencode/big-pickle", "WORKER_MODEL": "opencode/big-pickle"}) as server:
            status, result = server.post_json("/api/opencode-settings", {
                "main": {"model": "org/main", "base_url": "http://main.example/v1", "api_key": "main-secret"},
                "worker": {"model": "org/worker", "base_url": "http://worker.example/v1", "api_key": "worker-secret"},
                "keys": {"WORKER_RESEARCH_API_KEY": "research-secret"},
            })
            self.assertEqual(status, 200)
            self.assertTrue(result["main"]["api_key_set"])
            self.assertTrue(result["worker"]["api_key_set"])
            for secret in ("main-secret", "worker-secret", "research-secret"):
                self.assertNotIn(secret, json.dumps(result))
            self.assertIn("WORKER_RESEARCH_API_KEY", result["key_variables"])
            home = dashboard_server.HERMES_HOME
            config = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
            self.assertEqual(config["model"], "custom/org/main")
            self.assertEqual(config["small_model"], "custom/org/main")
            self.assertNotIn("enabled_providers", config)
            self.assertNotIn("main-secret", json.dumps(config))
            self.assertEqual((home / "spatial-workbench" / "opencode-main.key").stat().st_mode & 0o777, 0o600)
            args = server.server.state.jobs._worker_args("j1", {"idx": 0, "instructions": "go"})
            self.assertIn("custom/org/worker", args)
            self.assertIn("WORKER_ENDPOINT_API_KEY=worker-secret", args)
            fresh = dashboard_server.DashboardState()
            self.assertEqual(fresh.get_opencode_settings()["worker"]["model"], "org/worker")
            self.assertEqual(fresh.jobs.public_settings()["worker_model"], "org/worker")
            from opencode_config import write_opencode_config
            config["enabled_providers"] = ["custom"]
            config["provider"]["user-provider"] = {"name": "User provider", "models": {"user-model": {}}}
            (home / ".config" / "opencode" / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
            write_opencode_config({"OPENCODE_MODEL": "opencode/big-pickle"}, home)
            regenerated = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
            self.assertEqual(regenerated["model"], "custom/org/main")
            self.assertEqual(regenerated["small_model"], "custom/org/main")
            self.assertNotIn("enabled_providers", regenerated)
            self.assertEqual(regenerated["provider"]["user-provider"], config["provider"]["user-provider"])
            _, cleared = server.post_json("/api/opencode-settings", {
                "worker": {"model": "org/worker", "base_url": "http://worker.example/v1", "api_key": ""},
            })
            self.assertFalse(cleared["worker"]["api_key_set"])
            _, public = server.get_json("/api/settings")
            self.assertNotIn("main-secret", json.dumps(public))
            _, reset = server.post_json("/api/opencode-settings", {"reset": ["main", "worker"]})
            self.assertEqual(reset["main"]["model"], "opencode/big-pickle")
            self.assertEqual(reset["worker"]["model"], "opencode/big-pickle")
            reset_config = json.loads((home / ".config" / "opencode" / "opencode.json").read_text())
            self.assertEqual(reset_config["model"], "opencode/big-pickle")
            self.assertNotIn("enabled_providers", reset_config)

    def test_main_server_reload_is_explicit_and_uses_global_config_api(self):
        with contract_server() as server:
            state = server.server.state
            main = {"main": {"model": "private-model", "base_url": "http://private.example/v1"}}
            with patch.object(dashboard_server, "urlopen") as upstream:
                state.save_opencode_settings(main)
                upstream.assert_not_called()
                result = state.save_opencode_settings({**main, "reload_main": True})
                self.assertTrue(result["main_reloaded"])
                request = upstream.call_args.args[0]
                self.assertEqual(request.get_method(), "PATCH")
                self.assertTrue(request.full_url.endswith("/global/config"))
                self.assertEqual(json.loads(request.data)["model"], "custom/private-model")

    def test_invalid_opencode_settings_do_not_change_saved_defaults(self):
        with contract_server() as server:
            for payload in ({"main": {"model": "model", "base_url": "file:///tmp/model"}},
                            {"worker": {"model": "model", "base_url": ""}},
                            {"keys": {"API_SERVER_KEY": "secret"}}):
                with self.subTest(payload=payload), self.assertRaises(HTTPError) as error:
                    server.post_json("/api/opencode-settings", payload)
                self.assertEqual(error.exception.code, 400)
            self.assertNotIn("opencode", server.server.state._read_settings())

    def test_opencode_settings_writes_require_terminal_auth_in_token_mode(self):
        with contract_server({"WORKBENCH_AUTH": "token", "TERMINAL_API_TOKEN": "test-token"}) as server:
            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/opencode-settings", {"worker": {"model": "opencode/big-pickle"}})
            self.assertEqual(error.exception.code, 401)
            status, _ = server.post_json("/api/opencode-settings", {"worker": {"model": "opencode/big-pickle"}},
                                         headers={"X-Terminal-Token": "test-token"})
            self.assertEqual(status, 200)

    def test_legacy_backups_move_out_of_shared_workspace(self):
        with contract_server(legacy_backups=True) as server:
            for root, name in ((server.wiki_root, "wiki"), (server.workspace_root, "workspace")):
                moved = server.temp_root / "backups" / name / "old-note.md.20260927.bak"
                self.assertEqual(moved.read_text(encoding="utf-8"), "original")
                self.assertFalse((root / ".dashboard-backups").exists())

    def test_soul_appears_in_memory_and_can_be_saved(self):
        with tempfile.TemporaryDirectory() as home, patch.object(dashboard_server, "HERMES_HOME", Path(home)):
            soul = Path(home) / "SOUL.md"
            soul.write_text("# Persona\n", encoding="utf-8")
            with contract_server({"HERMES_HOME": home}) as server:
                status, memory = server.get_json("/api/agent/memory")
                self.assertEqual(status, 200)
                self.assertIn(str(soul), [file["path"] for file in memory["files"]])

                _, opened = server.get_json("/api/workspace/read", {"path": str(soul)})
                self.assertEqual(opened["content"], "# Persona\n")
                status, saved = server.post_json("/api/workspace/write", {
                    "path": str(soul), "content": "# Updated persona\n",
                    "expected_modified_ts": opened["modified_ts"],
                    "expected_size_bytes": opened["size_bytes"],
                })
                self.assertEqual(status, 200)
                self.assertTrue(saved["ok"])
                self.assertEqual(soul.read_text(encoding="utf-8"), "# Updated persona\n")

    def test_jobs_contracts(self):
        with contract_server() as server:
            status, listing = server.get_json("/api/jobs")
            self.assertEqual(status, 200)
            self.assertEqual(listing["jobs"], [])
            self.assertIn("plan_gate", listing["settings"])

            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/api/jobs", {"title": "  "})
            self.assertEqual(ctx.exception.code, 409)

            status, created = server.post_json("/api/jobs", {"title": "Write a haiku", "description": "about VLANs"})
            self.assertEqual(status, 201)
            job_id = created["job"]["id"]
            self.assertEqual(created["job"]["stage"], "inbox")

            status, job = server.get_json(f"/api/jobs/{job_id}")
            self.assertEqual(job["job"]["title"], "Write a haiku")

            status, comms = server.get_json(f"/api/jobs/{job_id}/comms")
            self.assertEqual(status, 200)
            self.assertTrue(comms["ok"])
            self.assertEqual(comms["job_id"], job_id)
            self.assertEqual(comms["threads"], [])

            with self.assertRaises(HTTPError) as ctx:
                server.get_json("/api/jobs/nope/comms")
            self.assertEqual(ctx.exception.code, 404)

            with self.assertRaises(HTTPError) as ctx:
                server.post_json(f"/api/jobs/{job_id}/approve")
            self.assertEqual(ctx.exception.code, 409)  # not planned yet

            status, stopped = server.post_json(f"/api/jobs/{job_id}/stop")
            self.assertEqual(stopped["job"]["stage"], "stopped")
            status, _ = server.post_json(f"/api/jobs/{job_id}/archive")
            self.assertEqual(server.get_json("/api/jobs")[1]["jobs"], [])

            # Delete a finished job: rows and files go away.
            status, created2 = server.post_json("/api/jobs", {"title": "Delete me", "description": "test"})
            self.assertEqual(status, 201)
            job_id2 = created2["job"]["id"]
            server.post_json(f"/api/jobs/{job_id2}/stop")
            job_dir = server.workspace_root / "jobs" / job_id2
            job_dir.mkdir(parents=True, exist_ok=True)
            (job_dir / "Delete me.txt").write_text("title: Delete me\n", encoding="utf-8")

            status, deleted = server.post_json(f"/api/jobs/{job_id2}/delete")
            self.assertEqual(status, 200)
            self.assertTrue(deleted["ok"])
            self.assertEqual(deleted["deleted"], job_id2)

            with self.assertRaises(HTTPError) as ctx:
                server.get_json(f"/api/jobs/{job_id2}")
            self.assertEqual(ctx.exception.code, 404)
            self.assertFalse(job_dir.exists())

            # Deleting an unknown job → 404.
            with self.assertRaises(HTTPError) as ctx:
                server.post_json(f"/api/jobs/nope/delete")
            self.assertEqual(ctx.exception.code, 404)

            for path in ("/api/jobs/nope", "/api/jobs/nope/subtasks/0/log"):
                with self.assertRaises(HTTPError) as ctx:
                    server.get_json(path)
                self.assertEqual(ctx.exception.code, 404)

    def test_worker_profiles_are_distinct_and_snapshotted(self):
        with contract_server() as server:
            status, saved = server.post_json("/api/worker-profiles", {
                "name": "Documentation writer",
                "instructions": "Write concise, sourced documentation.",
                "runtime": "opencode",
                "model": "opencode/big-pickle",
                "skills": [],
                "permission_preset": "guarded",
            })
            self.assertEqual(status, 200)
            profile = saved["profile"]
            self.assertNotIn("chat_providers", server.get_json("/api/worker-profiles")[1])
            self.assertEqual(server.get_json("/api/worker-profiles")[1]["profiles"][0]["id"], profile["id"])

            _, created = server.post_json("/api/jobs", {
                "title": "Write docs", "description": "Document the API", "profile_id": profile["id"],
            })
            job_id = created["job"]["id"]
            self.assertEqual(created["job"]["profile_snapshot"]["name"], "Documentation writer")

            server.post_json(f"/api/worker-profiles/{profile['id']}/delete")
            _, detail = server.get_json(f"/api/jobs/{job_id}")
            self.assertEqual(detail["job"]["profile_snapshot"]["model"], "opencode/big-pickle")

    def test_job_create_missing_project_returns_validation_error(self):
        with contract_server() as server:
            with self.assertRaises(HTTPError) as error:
                server.post_json("/api/jobs", {
                    "title": "Smoke test",
                    "description": "Create a file in a test project",
                    "project_path": "projects/board-smoke",
                    "base_branch": "main",
                })
            self.assertEqual(error.exception.code, 409)
            self.assertIn("Project path does not exist", error.exception.read().decode("utf-8"))

    def test_board_state_and_commands(self):
        with contract_server() as server:
            status, initial = server.get_json("/api/board")
            self.assertEqual(status, 200)
            self.assertIsNone(initial["board"])

            status, added = server.post_json("/api/board/command", {
                "command": "add_node", "node": {"type": "diamond", "text": "Sandbox"},
            })
            self.assertEqual(status, 200)
            elements = added["board"]["elements"]
            self.assertEqual([element["type"] for element in elements], ["diamond", "text"])
            self.assertEqual(elements[1]["containerId"], elements[0]["id"])

            status, added_arrow = server.post_json("/api/board/command", {
                "command": "add_arrow", "arrow": {"text": "runs in"},
            })
            self.assertEqual(status, 200)
            self.assertEqual(added_arrow["board"]["elements"][-1]["type"], "arrow")
            arrow = added_arrow["board"]["elements"][-1]
            for key in ("groupIds", "boundElements", "fillStyle", "backgroundColor", "points", "endArrowhead"):
                self.assertIn(key, arrow)
            self.assertEqual(arrow["groupIds"], [])

            status, persisted = server.get_json("/api/board")
            self.assertEqual(len(persisted["board"]["elements"]), 3)

            status, cleared = server.post_json("/api/board/command", {"command": "clear"})
            self.assertEqual(status, 200)
            self.assertEqual(len(cleared["board"]["elements"]), 3)
            self.assertTrue(all(element["isDeleted"] for element in cleared["board"]["elements"]))

            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/api/board/command", {"command": "add_node", "node": {"text": ""}})
            self.assertEqual(ctx.exception.code, 400)

    def test_agent_layout_elements_get_required_excalidraw_fields(self):
        with contract_server() as server:
            status, laid = server.post_json("/api/board/command", {"command": "set_layout", "elements": [
                {"id": "bare-arrow", "type": "arrow", "x": 0, "y": 0, "width": 50, "height": 0},
                {"id": "bare-text", "type": "text", "x": 0, "y": 0, "width": 50, "height": 20, "text": "hi"},
            ]})
        self.assertEqual(status, 200)
        bare = {e["id"]: e for e in laid["board"]["elements"]}
        self.assertEqual(bare["bare-arrow"]["groupIds"], [])
        self.assertEqual(bare["bare-arrow"]["boundElements"], [])
        self.assertEqual(bare["bare-arrow"]["points"], [[0, 0], [50.0, 0.0]])
        self.assertEqual(bare["bare-text"]["originalText"], "hi")

    def test_agent_board_edits_survive_stale_browser_saves(self):
        ahead = 10**13  # a browser whose clock runs far ahead of the server
        stale = {"elements": [
            {"id": "a", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "updated": ahead, "version": 3},
            {"id": "b", "type": "rectangle", "x": 50, "y": 0, "width": 10, "height": 10, "updated": ahead, "version": 3},
            {"id": "b-label", "type": "text", "containerId": "b", "text": "B", "x": 52, "y": 2,
             "width": 5, "height": 5, "updated": ahead, "version": 3},
        ], "appState": {}, "files": {}}

        def browser_save(server):
            status, _ = server.post_json("/api/board", {"board": stale, "merge": True})
            self.assertEqual(status, 200)
            return {e["id"]: e for e in server.get_json("/api/board")[1]["board"]["elements"]}

        with contract_server() as server:
            browser_save(server)
            server.post_json("/api/board/command", {"command": "update_element", "element": {"id": "a", "x": 300}})
            server.post_json("/api/board/command", {"command": "delete_element", "id": "b"})
            by_id = browser_save(server)
            self.assertEqual(by_id["a"]["x"], 300)
            self.assertGreater(by_id["a"]["version"], 3)
            self.assertTrue(by_id["b"]["isDeleted"])
            self.assertTrue(by_id["b-label"]["isDeleted"])

            server.post_json("/api/board/command", {"command": "set_layout", "elements": [
                {"id": "a", "type": "rectangle", "x": 999, "y": 0, "width": 10, "height": 10, "updated": 1}]})
            by_id = browser_save(server)
            self.assertEqual(by_id["a"]["x"], 999)
            self.assertFalse(by_id["a"].get("isDeleted"))

            server.post_json("/api/board/command", {"command": "clear"})
            by_id = browser_save(server)
            self.assertTrue(all(element["isDeleted"] for element in by_id.values()))

    def test_board_rich_commands_and_merge_conflict(self):
        with contract_server() as server:
            # Seed a board via the browser-style merge save.
            status, saved = server.post_json("/api/board", {
                "board": {"elements": [
                    {"id": "n1", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "updated": 100},
                    {"id": "t1", "type": "text", "x": 2, "y": 2, "width": 10, "height": 10, "text": "hello", "updated": 100},
                ], "appState": {}, "files": {}},
                "merge": True,
            })
            self.assertEqual(status, 200)
            self.assertEqual(saved["revision"], 1)

            _, unchanged = server.post_json("/api/board", {
                "board": {"elements": [
                    {"id": "n1", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "updated": 100},
                    {"id": "t1", "type": "text", "x": 2, "y": 2, "width": 10, "height": 10, "text": "hello", "updated": 100},
                ], "appState": {}, "files": {}},
                "merge": True,
            })
            self.assertEqual(unchanged["revision"], 1)

            # read_full returns the full board + revision.
            status, full = server.post_json("/api/board/command", {"command": "read_full"})
            self.assertEqual(status, 200)
            self.assertEqual(full["revision"], 1)
            self.assertEqual(len(full["board"]["elements"]), 2)

            # update_element merges provided fields onto the existing element.
            status, updated = server.post_json("/api/board/command", {
                "command": "update_element",
                "element": {"id": "t1", "text": "updated", "x": 99},
            })
            self.assertEqual(status, 200)
            t1 = next(e for e in updated["board"]["elements"] if e["id"] == "t1")
            self.assertEqual(t1["text"], "updated")
            self.assertEqual(t1["x"], 99)
            self.assertEqual(t1["type"], "text")  # untouched field preserved
            self.assertEqual(updated["revision"], 2)

            # delete_element marks the element deleted (isDeleted) rather than removing it.
            status, deleted = server.post_json("/api/board/command", {
                "command": "delete_element", "id": "n1",
            })
            self.assertEqual(status, 200)
            n1 = next(e for e in deleted["board"]["elements"] if e["id"] == "n1")
            self.assertTrue(n1["isDeleted"])
            self.assertEqual(deleted["revision"], 3)

            # A browser merge save from a stale view (no n1) must not resurrect the
            # deleted element, and must preserve the browser's own new element.
            status, merged = server.post_json("/api/board", {
                "board": {"elements": [
                    {"id": "t1", "type": "text", "x": 2, "y": 2, "width": 10, "height": 10, "text": "updated", "updated": 150},
                    {"id": "browser-only", "type": "text", "x": 0, "y": 0, "width": 5, "height": 5, "text": "b", "updated": 600},
                ], "appState": {}, "files": {}},
                "merge": True,
            })
            self.assertEqual(status, 200)
            self.assertEqual(merged["revision"], 4)
            status, after = server.get_json("/api/board")
            self.assertEqual(status, 200)
            by_id = {e["id"]: e for e in after["board"]["elements"]}
            self.assertIn("browser-only", by_id)  # browser element preserved
            self.assertIn("n1", by_id)
            self.assertTrue(by_id["n1"]["isDeleted"])  # deletion not resurrected by browser save

            # set_layout replaces the live elements; everything else becomes a deletion tombstone.
            status, laid = server.post_json("/api/board/command", {
                "command": "set_layout",
                "elements": [{"id": "fresh", "type": "rectangle", "x": 1, "y": 1, "width": 5, "height": 5, "updated": 500}],
            })
            self.assertEqual(status, 200)
            live = [e["id"] for e in laid["board"]["elements"] if not e.get("isDeleted")]
            self.assertEqual(live, ["fresh"])
            self.assertEqual(laid["revision"], 5)

            # A stale base_revision with merge=false is a conflict (409).
            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/api/board", {
                    "board": {"elements": [], "appState": {}, "files": {}},
                    "base_revision": 1,
                    "merge": False,
                })
            self.assertEqual(ctx.exception.code, 409)

    def test_job_upload_and_output_handoff(self):
        with contract_server() as server:
            _, upload = server.post_json("/api/workspace/upload", {
                "filename": "spec.md", "content_base64": "IyBTcGVjCg==",
            })
            _, created = server.post_json("/api/jobs", {
                "title": "Use the spec", "description": "Write a report", "attachments": [upload["path"]],
            })
            job = created["job"]
            job_id = job["id"]
            self.assertEqual(job["attachments"], [Path(upload["path"]).name])
            self.assertEqual((server.workspace_root / "jobs" / job_id / "inputs" / job["attachments"][0]).read_text(), "# Spec\n")

            engine = server.server.state.jobs
            prompts = []
            engine.hermes = lambda prompt: prompts.append(prompt) or json.dumps({
                "clear": True, "plan": {"summary": "one worker", "subtasks": [{"title": "Write", "instructions": "Write report.md"}]},
            })
            # Mirror production: _dispatch_hermes moves inbox -> review before _review runs.
            with engine._db() as db:
                engine._move(db, job_id, "review", "Hermes is reviewing", detail="Hermes is reviewing")
            engine._review(engine.get_job(job_id))
            self.assertIn(f"../inputs/{job['attachments'][0]}", prompts[0])
            self.assertIn("# Spec", prompts[0])
            engine.approve(job_id)
            output = server.workspace_root / "jobs" / job_id / "subtask-1" / "artifacts" / "report.md"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("# Result\n", encoding="utf-8")

            _, listing = server.get_json(f"/api/jobs/{job_id}/files")
            self.assertEqual(listing["files"], [{"path": "subtask-1/artifacts/report.md", "size": 9}])
            with urlopen(f"{server.base_url}/api/jobs/{job_id}/files/subtask-1/artifacts/report.md") as response:
                self.assertEqual(response.read(), b"# Result\n")
                self.assertIn("attachment", response.headers["Content-Disposition"])
            with self.assertRaises(HTTPError) as ctx:
                server.get_json(f"/api/jobs/{job_id}/files/%2e%2e%2finputs%2f{job['attachments'][0]}")
            self.assertEqual(ctx.exception.code, 404)

    def test_config_chat_providers_events_and_workflows_contracts(self):
        with contract_server() as server:
            status, config = server.get_json("/api/config")
            self.assertEqual(status, 200)
            self.assertEqual(config["ai_node_ssh_target"], "tester@192.0.2.10")
            self.assertFalse(config["terminal_auth_required"])
            self.assertEqual(config["wiki_root"], str(server.wiki_root.resolve()))
            self.assertEqual(config["workspace_root"], str(server.workspace_root.resolve()))
            self.assertNotIn("terminal_api_token", config)

            status, providers = server.get_json("/api/chat-providers")
            self.assertEqual(status, 200)
            self.assertTrue(providers["ok"])
            self.assertEqual(providers["items"][0]["id"], "hermes")

            status, chat = server.post_json("/api/chat/session", {"provider": "hermes"})
            self.assertEqual(status, 200)
            self.assertTrue(chat["ok"])
            self.assertEqual(chat["session"]["provider"], "hermes")

            status, events = server.get_json("/api/events/recent", {"limit": "10"})
            self.assertEqual(status, 200)
            self.assertTrue(events["ok"])
            self.assertGreaterEqual(len(events["items"]), 1)
            self.assertIn("type", events["items"][0])

            status, workflows = server.get_json("/api/workflows")
            self.assertEqual(status, 200)
            self.assertIn("items", workflows)
            self.assertEqual(workflows["items"], [])

    def test_stats_error_contract_is_stable_when_ai_node_unavailable(self):
        with contract_server({"AI_NODE_STATS_URL": "http://127.0.0.1:1/stats"}) as server:
            status, stats = server.get_json("/api/stats")
            self.assertEqual(status, 200)
            self.assertEqual(stats["status"], "error")
            self.assertEqual(stats["source"], "ai_node_unavailable")
            self.assertIn("message", stats)
            self.assertIn("timestamp", stats)

    def test_stats_source_can_switch_and_persists(self):
        with contract_server({
            "STATS_SOURCE": "http",
            "AI_NODE_STATS_URL": "http://127.0.0.1:1/stats",
        }) as server:
            status, source = server.get_json("/api/stats/source")
            self.assertEqual(status, 200)
            self.assertEqual(source["selected"], "configured")
            self.assertEqual([option["value"] for option in source["options"]], ["host", "configured"])
            self.assertNotIn("127.0.0.1", source["source_label"])

            status, source = server.post_json("/api/stats/source", {"source": "host"})
            self.assertEqual(status, 200)
            self.assertEqual(source["selected"], "host")
            self.assertEqual(source["source_label"], "AI Workbench host")

            restarted_state = dashboard_server.DashboardState()
            self.assertEqual(restarted_state.stats_source_options()["selected"], "host")
            status, source = server.post_json("/api/stats/source", {"source": "configured"})
            self.assertEqual(status, 200)
            self.assertEqual(source["selected"], "configured")

    def test_wiki_contracts_preserve_containment_backup_and_search(self):
        with contract_server() as server:
            (server.wiki_root / "index.md").write_text("# Home\nHermes wiki note\n", encoding="utf-8")
            (server.wiki_root / "notes").mkdir()
            (server.wiki_root / "notes" / "system.txt").write_text("AI node details", encoding="utf-8")
            (server.wiki_root / ".hidden.md").write_text("secret", encoding="utf-8")
            (server.wiki_root / "image.png").write_text("not text", encoding="utf-8")

            status, listing = server.get_json("/api/wiki/list", {"path": ""})
            self.assertEqual(status, 200)
            self.assertTrue(listing["ok"])
            names = [item["name"] for item in listing["items"]]
            self.assertIn("index.md", names)
            self.assertIn("notes", names)
            self.assertIn("image.png", names)
            self.assertNotIn(".hidden.md", names)

            status, document = server.get_json("/api/wiki/read", {"path": "index.md"})
            self.assertEqual(status, 200)
            self.assertEqual(document["path"], "index.md")
            self.assertIn("Hermes wiki note", document["content"])

            time.sleep(0.01)
            status, write_result = server.post_json(
                "/api/wiki/write",
                {"path": "index.md", "content": "# Home\nUpdated Hermes note\n"},
            )
            self.assertEqual(status, 200)
            self.assertTrue(write_result["ok"])
            self.assertEqual(write_result["path"], "index.md")
            backups = list((server.temp_root / "backups" / "wiki").glob("index.md.*.bak"))
            self.assertEqual(len(backups), 1)

            status, search = server.get_json("/api/wiki/search", {"q": "updated", "limit": "10"})
            self.assertEqual(status, 200)
            self.assertTrue(search["ok"])
            self.assertEqual(search["items"][0]["path"], "index.md")

            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/wiki/read", {"path": "../outside.md"})
            self.assertEqual(raised.exception.code, 400)

    def test_retired_artifact_workflow_returns_empty_collection(self):
        with contract_server() as server:
            status, artifacts = server.get_json("/api/workflows/artifacts", {"limit": "5"})
            self.assertEqual(status, 200)
            self.assertTrue(artifacts["ok"])
            self.assertEqual(artifacts["items"], [])

    def test_terminal_auth_and_validation_contracts_without_spawning_shell(self):
        with contract_server({"TERMINAL_API_TOKEN": "contract-token"}) as server:
            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/terminal/active")
            self.assertEqual(raised.exception.code, 401)

            status, active = server.get_json(
                "/api/terminal/active",
                headers={"X-Terminal-Token": "contract-token"},
            )
            self.assertEqual(status, 200)
            self.assertTrue(active["ok"])
            self.assertIsNone(active["active"])

            with self.assertRaises(HTTPError) as raised:
                server.post_json(
                    "/api/terminal/start",
                    {"mode": "invalid"},
                    headers={"X-Terminal-Token": "contract-token"},
                )
            self.assertEqual(raised.exception.code, 400)

    def test_herdr_terminal_mode_routes_through_the_existing_pty_api(self):
        with contract_server() as server:
            with patch.object(server.server.state, "start_terminal", return_value="herdr-client") as start:
                status, result = server.post_json("/api/terminal/start", {"mode": "herdr", "cols": 140, "rows": 40})
                self.assertEqual(status, 200)
                self.assertEqual(result["session_id"], "herdr-client")
                start.assert_called_once_with(mode="herdr", cols=140, rows=40)

    def test_herdr_terminal_fails_without_starting_another_server(self):
        with contract_server() as server:
            with patch.object(server.server.state.jobs.herdr, "ready", return_value=False), patch("dashboard_server.subprocess.Popen") as launch:
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/terminal/start", {"mode": "herdr"})
                self.assertEqual(raised.exception.code, 503)
                launch.assert_not_called()

    def test_herdr_client_uses_named_session_without_inheriting_provider_secrets(self):
        with contract_server() as server:
            state = server.server.state
            with patch.object(state.jobs.herdr, "ready", return_value=True), \
                    patch("dashboard_server.pty.openpty", return_value=(100, 101)), \
                    patch("dashboard_server.fcntl.ioctl"), patch("dashboard_server.os.close"), \
                    patch("dashboard_server.threading.Thread"), patch("dashboard_server.subprocess.Popen") as launch, \
                    patch.dict(os.environ, {"LLM_API_KEY": "private-provider-key", "TERM": "dumb"}):
                sid = state.start_terminal("herdr", 140, 40)
                self.assertEqual(launch.call_args.args[0], [state.jobs.herdr.binary, "--session", state.jobs.herdr.session])
                self.assertEqual(launch.call_args.kwargs["env"]["TERM"], "xterm-256color")
                self.assertNotIn("LLM_API_KEY", launch.call_args.kwargs["env"])
                self.assertEqual(state.terminal_sessions[sid].mode, "herdr")
                state.terminal_sessions.clear()

    def test_herdr_tui_requires_the_existing_terminal_token(self):
        with contract_server({"WORKBENCH_AUTH": "token", "TERMINAL_API_TOKEN": "herdr-test-token"}) as server:
            with patch.object(server.server.state, "start_terminal") as launch:
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/terminal/start", {"mode": "herdr"})
                self.assertEqual(raised.exception.code, 401)
                launch.assert_not_called()

    def test_workflow_status_and_unknown_workflow_errors_are_structured(self):
        with contract_server() as server:
            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/workflows/status", {"workflow_id": "missing"})
            self.assertEqual(raised.exception.code, 404)

            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/workflows/unknown", {"requested_by": "contract-test"})
            self.assertEqual(raised.exception.code, 400)

    def test_workspace_contracts_preserve_containment_and_text_file_reads(self):
        with contract_server() as server:
            (server.workspace_root / "src").mkdir()
            (server.workspace_root / "src" / "App.tsx").write_text("export function App() { return null; }\n", encoding="utf-8")
            (server.workspace_root / "notes.md").write_text("# Workspace note\n", encoding="utf-8")
            (server.workspace_root / ".hidden.ts").write_text("hidden", encoding="utf-8")
            (server.workspace_root / "node_modules").mkdir()
            (server.workspace_root / ".git").mkdir()
            (server.workspace_root / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00")
            (server.workspace_root / "archive.zip").write_bytes(b"PK\x00")
            (server.workspace_root / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
            (server.workspace_root / "node_modules" / "asset.png").write_bytes(b"\x89PNG\x00")

            status, listing = server.get_json("/api/workspace/list", {"path": ""})
            self.assertEqual(status, 200)
            self.assertTrue(listing["ok"])
            names = [item["name"] for item in listing["items"]]
            self.assertIn("src", names)
            self.assertIn("notes.md", names)
            self.assertIn(".hidden.ts", names)
            self.assertIn("node_modules", names)
            self.assertIn(".git", names)
            self.assertIn("image.png", names)
            self.assertIn("archive.zip", names)
            self.assertIn("Dockerfile", names)
            directory_names = [item["name"] for item in listing["items"] if item["is_dir"]]
            self.assertEqual(names[:len(directory_names)], sorted(directory_names, key=str.lower))
            image = next(item for item in listing["items"] if item["name"] == "image.png")
            self.assertFalse(image["is_dir"])
            self.assertEqual(image["path"], "image.png")
            self.assertEqual(image["size_bytes"], 9)

            status, nested = server.get_json("/api/workspace/list", {"path": "node_modules"})
            self.assertEqual(status, 200)
            self.assertEqual([item["name"] for item in nested["items"]], ["asset.png"])

            status, document = server.get_json("/api/workspace/read", {"path": "src/App.tsx"})
            self.assertEqual(status, 200)
            self.assertTrue(document["ok"])
            self.assertEqual(document["path"], "src/App.tsx")
            self.assertIn("export function App", document["content"])

            status, file_status = server.get_json("/api/workspace/status", {"path": "src/App.tsx"})
            self.assertEqual(status, 200)
            self.assertTrue(file_status["ok"])
            self.assertEqual(file_status["path"], "src/App.tsx")
            self.assertEqual(file_status["size_bytes"], document["size_bytes"])
            self.assertEqual(file_status["modified_ts"], document["modified_ts"])

            status, write_result = server.post_json(
                "/api/workspace/write",
                {
                    "path": "src/App.tsx",
                    "content": "export function App() { return 'updated'; }\n",
                    "expected_modified_ts": document["modified_ts"],
                    "expected_size_bytes": document["size_bytes"],
                },
            )
            self.assertEqual(status, 200)
            self.assertTrue(write_result["ok"])
            self.assertEqual(write_result["path"], "src/App.tsx")
            self.assertIn("updated", (server.workspace_root / "src" / "App.tsx").read_text(encoding="utf-8"))
            backups = list((server.temp_root / "backups" / "workspace").glob("src_App.tsx.*.bak"))
            self.assertEqual(len(backups), 1)

            with self.assertRaises(HTTPError) as raised:
                server.post_json(
                    "/api/workspace/write",
                    {
                        "path": "src/App.tsx",
                        "content": "stale write\n",
                        "expected_modified_ts": document["modified_ts"],
                        "expected_size_bytes": document["size_bytes"],
                    },
                )
            self.assertEqual(raised.exception.code, 409)

            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/workspace/read", {"path": "../outside.ts"})
            self.assertEqual(raised.exception.code, 400)

            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/workspace/read", {"path": "image.png"})
            self.assertEqual(raised.exception.code, 400)

    def test_workspace_import_preserves_binary_data_names_and_existing_files(self):
        with contract_server() as server:
            image = b"\x89PNG\r\n\x1a\n\x00\xff"
            status, imported = server.post_json("/api/workspace/upload", {
                "filename": "image.png", "content_base64": base64.b64encode(image).decode("ascii"), "directory": "",
            })
            self.assertEqual(status, 200)
            self.assertEqual(imported["path"], "image.png")
            self.assertEqual((server.workspace_root / "image.png").read_bytes(), image)
            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/workspace/upload", {"filename": "image.png", "content_base64": "bmV3", "directory": ""})
            self.assertEqual(raised.exception.code, 400)
            self.assertEqual((server.workspace_root / "image.png").read_bytes(), image)
            self.assertEqual(sorted(path.name for path in server.workspace_root.iterdir()), ["artifacts", "image.png"])
            server.post_json("/api/workspace/upload", {"filename": ".env", "content_base64": "aGVsbG8=", "directory": ""})
            self.assertEqual((server.workspace_root / ".env").read_bytes(), b"hello")
            for filename, directory in (("../escape.png", ""), ("image.png", ".."), ("image.png", "image.png")):
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/upload", {"filename": filename, "content_base64": "aGVsbG8=", "directory": directory})
                self.assertEqual(raised.exception.code, 400)
            status, attachment = server.post_json("/api/workspace/upload", {"filename": "image.png", "content_base64": base64.b64encode(image).decode("ascii")})
            self.assertEqual(status, 200)
            self.assertEqual(Path(attachment["path"]).parent, server.workspace_root / "uploads")
            self.assertEqual(Path(attachment["path"]).read_bytes(), image)

    def test_workspace_folder_delete_requires_confirmation_and_keeps_complete_backup(self):
        with contract_server() as server:
            folder = server.workspace_root / "project"
            (folder / "nested").mkdir(parents=True)
            (folder / ".git").mkdir()
            (folder / "nested" / "image.png").write_bytes(b"\x89PNG\x00")
            (folder / ".git" / "config").write_text("repository config", encoding="utf-8")
            (folder / ".env").write_text("private setting", encoding="utf-8")
            outside = server.temp_root / "outside.txt"
            outside.write_text("untouched", encoding="utf-8")
            (folder / "external-link").symlink_to(outside)
            for recursive in (None, False, "true"):
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/delete", {"path": "project", "recursive": recursive})
                self.assertEqual(raised.exception.code, 400)
                self.assertTrue(folder.exists())
            status, deleted = server.post_json("/api/workspace/delete", {"path": "project", "recursive": True})
            self.assertEqual(status, 200)
            self.assertTrue(deleted["deleted"])
            self.assertTrue(deleted["is_dir"])
            self.assertFalse(folder.exists())
            backup = Path(deleted["backup_path"])
            self.assertEqual(backup.parent, server.temp_root / "backups" / "workspace")
            self.assertEqual((backup / "nested" / "image.png").read_bytes(), b"\x89PNG\x00")
            self.assertEqual((backup / ".git" / "config").read_text(), "repository config")
            self.assertEqual((backup / ".env").read_text(), "private setting")
            self.assertTrue((backup / "external-link").is_symlink())
            self.assertEqual(outside.read_text(), "untouched")

    def test_workspace_delete_protects_roots_links_and_preserves_files_on_backup_failure(self):
        with contract_server() as server:
            state = server.server.state
            state.workspace_backup_dir.mkdir(parents=True, exist_ok=True)
            for root in (server.workspace_root, *state.workspace_extra_roots, state.workspace_backup_dir):
                if not root.exists():
                    continue
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/delete", {"path": str(root), "recursive": True})
                self.assertEqual(raised.exception.code, 400)
                self.assertTrue(root.exists())
            folder = server.workspace_root / "project"
            folder.mkdir()
            (folder / "notes.md").write_text("keep me", encoding="utf-8")
            link = server.workspace_root / "project-link"
            link.symlink_to(folder, target_is_directory=True)
            for path in ("project-link", "../outside"):
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/delete", {"path": path, "recursive": True})
                self.assertEqual(raised.exception.code, 400)
            with patch.object(dashboard_server.shutil, "move", side_effect=OSError("backup unavailable")):
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/delete", {"path": "project", "recursive": True})
                self.assertEqual(raised.exception.code, 400)
            with patch.object(dashboard_server.shutil, "copy2", side_effect=OSError("backup unavailable")):
                with self.assertRaises(HTTPError) as raised:
                    server.post_json("/api/workspace/delete", {"path": "project/notes.md"})
                self.assertEqual(raised.exception.code, 400)
            self.assertEqual((folder / "notes.md").read_text(), "keep me")
            status, deleted = server.post_json("/api/workspace/delete", {"path": "project/notes.md"})
            self.assertEqual(status, 200)
            self.assertFalse(deleted["is_dir"])
            self.assertEqual(Path(deleted["backup_path"]).read_text(), "keep me")
            self.assertFalse((folder / "notes.md").exists())

    def test_workspace_create_directory_is_contained_and_rejects_existing_paths(self):
        with contract_server() as server:
            status, created = server.post_json("/api/workspace/mkdir", {"path": "projects/board-smoke"})
            self.assertEqual(status, 200)
            self.assertEqual(created["path"], "projects/board-smoke")
            self.assertTrue((server.workspace_root / "projects" / "board-smoke").is_dir())
            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/workspace/mkdir", {"path": "projects/board-smoke"})
            self.assertEqual(raised.exception.code, 400)
            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/workspace/mkdir", {"path": "../outside"})
            self.assertEqual(raised.exception.code, 400)

    def test_workspace_git_init_previews_and_requires_confirmation_for_existing_files(self):
        with contract_server() as server:
            path = server.workspace_root / "projects" / "board-smoke"
            path.mkdir(parents=True)
            (path / "README.md").write_text("# Smoke\n", encoding="utf-8")
            (path / ".env").write_text("TOKEN=do-not-share\n", encoding="utf-8")

            _, previewed = server.post_json("/api/workspace/git/preview", {
                "path": "projects/board-smoke", "branch": "main",
            })
            preview = previewed["preview"]
            self.assertEqual(preview["files"], [".env", "README.md"])
            self.assertEqual(preview["sensitive_files"], [".env"])

            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/workspace/git/initialize", {
                    "path": "projects/board-smoke", "branch": "main",
                    "inventory_hash": preview["inventory_hash"],
                })
            self.assertEqual(raised.exception.code, 409)

            _, initialized = server.post_json("/api/workspace/git/initialize", {
                "path": "projects/board-smoke", "branch": "main",
                "inventory_hash": preview["inventory_hash"], "confirm_existing": True,
            })
            self.assertTrue(initialized["ok"])
            self.assertIn("chore: initialize repository", initialized["commit"])
            branch = subprocess.run(["git", "-C", str(path), "branch", "--show-current"],
                                    capture_output=True, text=True, check=True)
            self.assertEqual(branch.stdout.strip(), "main")
            committed = subprocess.run(["git", "-C", str(path), "ls-tree", "--name-only", "HEAD"],
                                        capture_output=True, text=True, check=True)
            self.assertEqual(committed.stdout.splitlines(), [".env", "README.md"])

    def test_workspace_git_init_creates_starter_commit_in_empty_folder(self):
        with contract_server() as server:
            path = server.workspace_root / "projects" / "empty-smoke"
            path.mkdir(parents=True)
            _, previewed = server.post_json("/api/workspace/git/preview", {"path": "projects/empty-smoke"})
            preview = previewed["preview"]
            self.assertEqual(preview["files"], [])
            _, initialized = server.post_json("/api/workspace/git/initialize", {
                "path": "projects/empty-smoke", "inventory_hash": preview["inventory_hash"],
            })
            self.assertTrue(initialized["ok"])
            self.assertTrue((path / "README.md").is_file())

    def test_workspace_git_init_ignores_excluded_files_but_creates_commit(self):
        with contract_server() as server:
            path = server.workspace_root / "projects" / "ignored-smoke"
            path.mkdir(parents=True)
            (path / ".gitignore").write_text("*\n", encoding="utf-8")
            (path / ".env").write_text("TOKEN=private\n", encoding="utf-8")
            _, previewed = server.post_json("/api/workspace/git/preview", {"path": "projects/ignored-smoke"})
            preview = previewed["preview"]
            self.assertEqual(preview["files"], [])
            self.assertEqual(preview["ignored_file_count"], 2)
            _, initialized = server.post_json("/api/workspace/git/initialize", {
                "path": "projects/ignored-smoke", "inventory_hash": preview["inventory_hash"],
                "confirm_existing": True,
            })
            self.assertTrue(initialized["ok"])
            committed = subprocess.run(["git", "-C", str(path), "ls-tree", "--name-only", "HEAD"],
                                        capture_output=True, text=True, check=True)
            self.assertEqual(committed.stdout.splitlines(), ["README.md"])

    def test_workspace_download_serves_files_and_zips_folders(self):
        with contract_server() as server:
            (server.workspace_root / "src").mkdir()
            (server.workspace_root / "src" / "App.tsx").write_text("export function App() { return null; }\n", encoding="utf-8")
            (server.workspace_root / "src" / "data.bin").write_bytes(b"\x00\x01\x02binary")
            (server.workspace_root / "src" / ".hidden.txt").write_text("hidden", encoding="utf-8")
            (server.workspace_root / "src" / "node_modules").mkdir()
            (server.workspace_root / "src" / "node_modules" / "junk.js").write_text("junk", encoding="utf-8")
            (server.workspace_root / "notes.md").write_text("# Workspace note\n", encoding="utf-8")

            # Single file: raw bytes, correct content type and disposition.
            status, headers, body = server.get_raw("/api/workspace/download", {"path": "notes.md"})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "text/markdown")
            self.assertIn('filename="notes.md"', headers.get("Content-Disposition", ""))
            self.assertEqual(body, b"# Workspace note\n")

            # Binary files are downloadable even though the text reader rejects them.
            status, headers, body = server.get_raw("/api/workspace/download", {"path": "src/data.bin"})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "application/octet-stream")
            self.assertEqual(body, b"\x00\x01\x02binary")

            # Folder: zipped, honoring the explorer's hidden/ignored rules.
            status, headers, body = server.get_raw("/api/workspace/download", {"path": "src"})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "application/zip")
            self.assertIn('filename="src.zip"', headers.get("Content-Disposition", ""))
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                names = set(archive.namelist())
                self.assertIn("App.tsx", names)
                self.assertIn("data.bin", names)
                self.assertNotIn(".hidden.txt", names)
                self.assertNotIn("node_modules/junk.js", names)
                self.assertEqual(archive.read("App.tsx"), b"export function App() { return null; }\n")

            # Path escapes are rejected.
            with self.assertRaises(HTTPError) as raised:
                server.get_raw("/api/workspace/download", {"path": "../outside.txt"})
            self.assertEqual(raised.exception.code, 400)

            # Missing paths 404.
            with self.assertRaises(HTTPError) as raised:
                server.get_raw("/api/workspace/download", {"path": "nope.txt"})
            self.assertEqual(raised.exception.code, 404)

    def test_wiki_download_serves_files_and_zips_folders(self):
        with contract_server() as server:
            (server.wiki_root / "notes").mkdir()
            (server.wiki_root / "notes" / "system.txt").write_text("AI node details\n", encoding="utf-8")
            (server.wiki_root / "notes" / ".hidden.txt").write_text("hidden", encoding="utf-8")
            (server.wiki_root / "notes" / "node_modules").mkdir()
            (server.wiki_root / "notes" / "node_modules" / "junk.js").write_text("junk", encoding="utf-8")
            (server.wiki_root / "index.md").write_text("# Home\nHermes wiki note\n", encoding="utf-8")

            # Single file: raw bytes, correct content type and disposition.
            status, headers, body = server.get_raw("/api/wiki/download", {"path": "index.md"})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "text/markdown")
            self.assertIn('filename="index.md"', headers.get("Content-Disposition", ""))
            self.assertEqual(body, b"# Home\nHermes wiki note\n")

            # Folder: zipped, honoring the explorer's hidden/ignored rules.
            status, headers, body = server.get_raw("/api/wiki/download", {"path": "notes"})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "application/zip")
            self.assertIn('filename="notes.zip"', headers.get("Content-Disposition", ""))
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                names = set(archive.namelist())
                self.assertIn("system.txt", names)
                self.assertNotIn(".hidden.txt", names)
                self.assertNotIn("node_modules/junk.js", names)
                self.assertEqual(archive.read("system.txt"), b"AI node details\n")

            # Path escapes are rejected.
            with self.assertRaises(HTTPError) as raised:
                server.get_raw("/api/wiki/download", {"path": "../outside.txt"})
            self.assertEqual(raised.exception.code, 400)

            # Missing paths 404.
            with self.assertRaises(HTTPError) as raised:
                server.get_raw("/api/wiki/download", {"path": "nope.txt"})
            self.assertEqual(raised.exception.code, 404)

    def test_wiki_upload_writes_binary_files_and_backs_up_overwrites(self):
        with contract_server() as server:
            payload = b"\x89PNG\r\n\x1a\nfake-image-bytes"
            encoded = base64.b64encode(payload).decode("ascii")

            # New binary file lands on disk and is listed.
            status, result = server.post_json(
                "/api/wiki/upload",
                {"path": "assets/logo.png", "content_base64": encoded},
            )
            self.assertEqual(status, 200)
            self.assertTrue(result["ok"])
            self.assertEqual(result["path"], "assets/logo.png")
            self.assertEqual(result["size_bytes"], len(payload))
            self.assertEqual((server.wiki_root / "assets" / "logo.png").read_bytes(), payload)

            status, listing = server.get_json("/api/wiki/list", {"path": "assets"})
            self.assertEqual(status, 200)
            self.assertIn("logo.png", [item["name"] for item in listing["items"]])

            # Overwriting an existing file keeps a backup.
            time.sleep(0.01)
            status, result = server.post_json(
                "/api/wiki/upload",
                {"path": "assets/logo.png", "content_base64": base64.b64encode(b"v2").decode("ascii")},
            )
            self.assertEqual(status, 200)
            self.assertTrue(result["ok"])
            self.assertEqual((server.wiki_root / "assets" / "logo.png").read_bytes(), b"v2")
            backups = list((server.temp_root / "backups" / "wiki").glob("assets_logo.png.*.bak"))
            self.assertEqual(len(backups), 1)

            # Path escapes are rejected.
            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/wiki/upload", {"path": "../outside.png", "content_base64": encoded})
            self.assertEqual(raised.exception.code, 400)

            # Invalid base64 is rejected.
            with self.assertRaises(HTTPError) as raised:
                server.post_json("/api/wiki/upload", {"path": "bad.png", "content_base64": "not-base64!!!"})
            self.assertEqual(raised.exception.code, 400)

    def test_web_fetch_contract_validates_urls_and_structures_errors(self):
        with contract_server() as server:
            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/web/fetch", {})
            self.assertEqual(raised.exception.code, 400)

            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/web/fetch", {"url": "file:///etc/passwd"})
            self.assertEqual(raised.exception.code, 400)

            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/web/fetch", {"url": "ftp://example.com/file.txt"})
            self.assertEqual(raised.exception.code, 400)

            # Closed local port: connection refused must surface as a
            # structured 400 with a message, not a 500 or a hang.
            with self.assertRaises(HTTPError) as raised:
                server.get_json("/api/web/fetch", {"url": "http://127.0.0.1:1/"})
            self.assertEqual(raised.exception.code, 400)

    def test_web_fetch_strips_html_to_readable_text(self):
        with contract_server() as server:
            html_dir = server.temp_root / "html"
            html_dir.mkdir()
            (html_dir / "page.html").write_text(
                "<html><head><title>Hidden</title>"
                "<script>var secret = 'nope';</script>"
                "<style>.x{color:red}</style></head>"
                "<body><h1>Visible heading</h1><p>First paragraph.</p>"
                "<p>Second paragraph.</p></body></html>",
                encoding="utf-8",
            )
            class HtmlHandler(SimpleHTTPRequestHandler):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, directory=str(html_dir), **kwargs)

            origin = ("127.0.0.1", 0)
            site = ThreadingHTTPServer(origin, HtmlHandler)
            site_port = site.server_address[1]
            thread = threading.Thread(target=site.serve_forever, daemon=True)
            thread.start()
            try:
                status, payload = server.get_json(
                    "/api/web/fetch", {"url": f"http://127.0.0.1:{site_port}/page.html"}
                )
                self.assertEqual(status, 200)
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["status"], 200)
                self.assertEqual(payload["content_type"], "text/html")
                self.assertIn("Visible heading", payload["content"])
                self.assertIn("First paragraph.", payload["content"])
                self.assertNotIn("<script>", payload["content"])
                self.assertNotIn("secret", payload["content"])
                self.assertNotIn("color:red", payload["content"])
                self.assertNotIn("<h1>", payload["content"])
            finally:
                site.shutdown()
                site.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()