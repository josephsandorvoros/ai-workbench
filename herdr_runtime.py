import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path


class HerdrError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(f"Herdr request failed: {code}")


class HerdrRuntime:
    def __init__(self, root, binary=None, session=None, runner=None):
        self.root = Path(root).resolve()
        self.binary = binary or os.environ.get("HERDR_BIN") or shutil.which("herdr") or str(Path.home() / ".local/bin/herdr")
        self.session = session or os.environ.get("JOB_HERDR_SESSION", "workbench-jobs")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", self.session):
            raise ValueError("Invalid Jobs Herdr session name")
        self.runner = runner or subprocess.run
        self.lock = threading.RLock()

    def _call(self, *args, raw=False, timeout=35):
        environment = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "HOME", "LANG", "LC_ALL", "TERM"}}
        environment["HERDR_SESSION"] = self.session
        process = self.runner([self.binary, "--session", self.session, *args],
                              capture_output=True, text=True, timeout=timeout, env=environment)
        if raw and process.returncode == 0:
            return process.stdout
        try:
            payload = json.loads(process.stdout if process.returncode == 0 else process.stderr)
        except (ValueError, TypeError):
            raise HerdrError("unavailable" if process.returncode else "invalid_response") from None
        if process.returncode or payload.get("error"):
            raise HerdrError(str((payload.get("error") or {}).get("code", "unavailable")))
        result = payload.get("result")
        if not isinstance(result, dict):
            raise HerdrError("invalid_response")
        return result

    def ready(self):
        try:
            return isinstance(self._call("agent", "list", timeout=5).get("agents"), list)
        except (HerdrError, OSError, subprocess.TimeoutExpired):
            return False

    def _write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as temporary:
            json.dump(value, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, path)

    def _record(self, reference):
        if not re.fullmatch(r"[a-f0-9]{32}", reference or ""):
            raise ValueError("Invalid Herdr worker reference")
        return json.loads((self.root / reference / "run.json").read_text(encoding="utf-8"))

    def _save(self, record):
        self._write(self.root / record["run_id"] / "run.json", record)

    def _agent(self, record):
        agent = self._call("agent", "get", record["name"])["agent"]
        if agent.get("name") != record["name"] or agent.get("pane_id") != record["pane_id"]:
            raise HerdrError("worker_replaced")
        return agent

    def run_detached(self, args):
        environment = {}
        for index, argument in enumerate(args[:-1]):
            if argument == "-e":
                key, separator, value = args[index + 1].partition("=")
                if separator:
                    environment[key] = value
        workdir = Path(args[args.index("-w") + 1]).resolve()
        model = args[args.index("-m") + 1]
        config = json.loads(environment.pop("OPENCODE_CONFIG_CONTENT"))
        reference = uuid.uuid4().hex
        home = self.root / reference / "home"
        home.mkdir(parents=True, mode=0o700)
        for key, value in environment.items():
            if key.endswith("API_KEY"):
                secret_path = home / key
                with open(secret_path, "w", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as secret:
                    secret.write(value)
                def replace_reference(node):
                    if isinstance(node, dict):
                        return {name: replace_reference(child) for name, child in node.items()}
                    if isinstance(node, list):
                        return [replace_reference(child) for child in node]
                    return f"{{file:{secret_path}}}" if node == f"{{env:{key}}}" else node
                config = replace_reference(config)
                if key != "WORKER_ENDPOINT_API_KEY":
                    config.setdefault("provider", {}).setdefault(model.split("/", 1)[0], {}).setdefault("options", {})["apiKey"] = f"{{file:{secret_path}}}"
        config_path = home / "opencode.json"
        self._write(config_path, config)
        result_path = workdir / "comms" / f"completion-{reference}.json"
        name = "worker-" + reference[:24]
        launch_environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                              "XDG_DATA_HOME": str(home / ".local/share"), "XDG_STATE_HOME": str(home / ".local/state"),
                              "OPENCODE_CONFIG": str(config_path), "OPENCODE_DISABLE_AUTOUPDATE": "1"}
        launch_environment.update({key: value for key, value in environment.items() if key.startswith("GIT_")})
        env_args = [argument for key, value in launch_environment.items() for argument in ("--env", f"{key}={value}")]
        workspace = self._call("workspace", "create", "--cwd", str(workdir), "--label", name, "--no-focus", *env_args)
        pane_id = workspace["root_pane"]["pane_id"]
        record = {"run_id": reference, "pane_id": pane_id, "workspace_id": workspace["workspace"]["workspace_id"],
                  "name": name, "workdir": str(workdir), "result_path": str(result_path), "agent_state": "starting",
                  "activity_seen": False, "completion_seq": None, "closed": False}
        self._save(record)
        try:
            agent = self._call("agent", "start", name, "--kind", "opencode", "--pane", pane_id,
                               "--", "--model", model)["agent"]
            record["completion_seq"] = agent.get("completion_seq")
            self._save(record)
            prompt = args[-1] + (
                "\nYou are a persistent job agent. Ask questions in this conversation and wait for the user's reply. "
                "Do not exit to obtain an answer. You may use the herdr CLI to inspect and coordinate with other job agents. "
                "When finished, write the completion record using the file tool only after checking your work: "
                f"{result_path}. Required JSON: "
                + json.dumps({"run_id": reference, "status": "done", "summary": "Your result", "verification": "Checks performed and their results"})
                + '. Use status "failed" when the work could not be completed. Becoming idle does not complete this job.'
            )
            self._call("agent", "prompt", name, prompt)
        except (HerdrError, OSError, KeyError, subprocess.TimeoutExpired):
            self.remove(reference)
            raise
        return reference

    def completion(self, reference):
        record = self._record(reference)
        path = Path(record["result_path"])
        if not path.exists():
            return None
        if path.is_symlink() or not path.resolve().is_relative_to(Path(record["workdir"]).resolve()) or path.stat().st_size > 65536:
            raise ValueError("Invalid worker completion file")
        result = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(result, dict) or result.get("run_id") != reference or result.get("status") not in {"done", "failed"}
                or not isinstance(result.get("summary"), str) or not result["summary"].strip()
                or not isinstance(result.get("verification"), str) or not result["verification"].strip()):
            raise ValueError("Invalid worker completion record")
        return result

    def state(self, reference):
        with self.lock:
            record = self._record(reference)
            if record["closed"]:
                return "missing", None
            try:
                agent = self._agent(record)
            except HerdrError as exc:
                if exc.code in {"not_found", "agent_not_running"}:
                    return "missing", None
                raise
            state = agent.get("status", agent.get("agent_status", "unknown"))
            record["agent_state"] = state
            record["activity_seen"] = record["activity_seen"] or state == "working"
            completed_turn = agent.get("completion_seq") is not None and agent["completion_seq"] != record["completion_seq"]
            self._save(record)
            completion = self.completion(reference)
            if completion and state in {"idle", "done"}:
                return "exited", 0 if completion["status"] == "done" else 1
            if state == "blocked" or (state in {"idle", "done"} and (record["activity_seen"] or completed_turn)):
                return "blocked", None
            return "running", None

    def logs(self, reference, tail=None):
        record = self._record(reference)
        completion = self.completion(reference)
        if completion:
            return json.dumps({"type": "text", "part": {"text": completion["summary"] + "\n\nVerification: " + completion["verification"]}})
        self._agent(record)
        text = self._call("pane", "read", record["pane_id"], "--source", "visible", "--lines", str(min(tail or 120, 400)), raw=True)
        return json.dumps({"type": "text", "part": {"text": text}})

    def message(self, reference, text, key=False):
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise ValueError("Worker input must contain between 1 and 20000 characters")
        record = self._record(reference)
        if record["closed"]:
            raise ValueError("Worker session is closed")
        agent = self._agent(record)
        if key:
            if text not in {"enter", "esc", "up", "down", "tab", "ctrl+c", "y", "n"}:
                raise ValueError("Unsupported worker key")
            return self._call("agent", "send-keys", record["name"], text)
        if agent.get("interactive_ready") is False or agent.get("status", agent.get("agent_status")) in {"working", "unknown", "blocked"}:
            raise ValueError("Inspect the worker's terminal before sending input; it is not ready for a prompt")
        result = self._call("agent", "prompt", record["name"], text)
        record["activity_seen"] = False
        record["completion_seq"] = agent.get("completion_seq")
        self._save(record)
        return result

    def remove(self, reference):
        record = self._record(reference)
        if not record["closed"]:
            try:
                workspace = self._call("workspace", "get", record["workspace_id"])["workspace"]
            except HerdrError as exc:
                if exc.code != "not_found":
                    raise
                record["closed"] = True
                self._save(record)
                return
            if workspace.get("label") != record["name"] or workspace.get("workspace_id") != record["workspace_id"]:
                raise ValueError("Refusing to close a workspace not owned by this worker")
            self._call("workspace", "close", record["workspace_id"])
            record["closed"] = True
            self._save(record)