"""Staged Hermes releases and an unprivileged, file-controlled service launcher."""

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

UPSTREAM = "https://github.com/NousResearch/hermes-agent.git"
TAG_PATTERN = re.compile(r"v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9][A-Za-z0-9.-]{0,60})?")


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".runtime-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


class RuntimeManager:
    def __init__(self, home, env=None):
        self.home = Path(home)
        self.env = dict(os.environ if env is None else env)
        self.root = self.home / "spatial-workbench" / "hermes-runtime"
        self.state_path = self.root / "selection.json"
        self.progress_path = self.root / "operation.json"

    @property
    def supported(self):
        return self.env.get("WORKBENCH_HERMES_MANAGED") == "1"

    def selection(self):
        return read_json(self.state_path, {"current": "image", "previous": None, "generation": "initial"})

    def runtime_path(self, selected=None):
        selected = self.selection()["current"] if selected is None else selected
        if selected == "image":
            return Path(self.env.get("HERMES_IMAGE_DIR", "/opt/hermes"))
        if not isinstance(selected, str) or not re.fullmatch(r"release-[a-f0-9]{32}", selected):
            raise ValueError("Invalid managed runtime selection")
        return self.root / "releases" / selected

    def runtime_available(self, selected):
        if selected == "image":
            return True
        try:
            binaries = self.runtime_path(selected) / ".venv" / "bin"
        except (ValueError, TypeError):
            return False
        python = binaries / "python"
        hermes = binaries / "hermes"
        if not all(path.is_file() and os.access(path, os.X_OK) for path in (python, hermes)):
            return False
        environment = dict(self.env)
        environment.update(
            HERMES_AGENT_DIR=str(binaries.parent.parent),
            HERMES_PYTHON=str(python),
            HERMES_INSTALL_DIR=str(binaries.parent.parent),
            HERMES_INSTALL_ROOT=str(binaries.parent.parent),
            VIRTUAL_ENV=str(binaries.parent.parent),
            HERMES_HOME=str(self.home),
        )
        environment["PATH"] = str(binaries) + os.pathsep + environment.get("PATH", "")
        for command in ([str(python), "-c", "pass"], [str(hermes), "--version"]):
            try:
                subprocess.run(command, cwd=self.home, env=environment, check=True,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5)
            except (OSError, subprocess.SubprocessError):
                return False
        return True

    def status(self):
        selected = self.selection()
        operation = read_json(self.progress_path, {"state": "idle", "step": ""})
        if operation.get("state") == "running" and not self.busy():
            operation = {"state": "interrupted", "step": "The previous operation was interrupted; check service health before retrying."}
        if (operation.get("state") == "failed"
                and operation.get("step", "").startswith("Selected Hermes runtime ")
                and " at startup" in operation.get("step", "")
                and "; recovered to " in operation.get("step", "")):
            operation = {**operation, "state": "recovered"}
        return {"supported": self.supported, "current": selected["current"],
                "release": read_json(self.runtime_path() / "workbench-release.json", {}).get("tag", "Image version"),
                "rollback_available": selected.get("previous") is not None, "operation": operation,
                "services": {role: read_json(self.root / f"{role}.json", {}) for role in ("gateway", "serve")}}

    def busy(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "operation.lock").open("a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            return False

    @contextmanager
    def lock(self):
        if not self.supported:
            raise ValueError("Managed Hermes requires the updated Workbench agent image")
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "operation.lock").open("a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another Hermes operation is already running") from None
            yield

    def progress(self, state, step):
        atomic_json(self.progress_path, {"state": state, "step": step, "updated_at": time.time()})

    def _run(self, command, cwd=None, timeout=180):
        build_home = self.root / "build-home"
        build_home.mkdir(parents=True, exist_ok=True)
        environment = {name: value for name, value in self.env.items()
                       if name in {"PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
                                   "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"}}
        environment.update(HOME=str(build_home), HERMES_HOME=str(build_home), GIT_TERMINAL_PROMPT="0",
                           UV_NO_PROGRESS="1", UV_PYTHON_DOWNLOADS="never")
        subprocess.run(command, cwd=cwd, env=environment, check=True, timeout=timeout,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def prepare(self, tag):
        if not isinstance(tag, str) or not TAG_PATTERN.fullmatch(tag):
            raise ValueError("Choose an upstream version tag such as v0.9.0")
        release_name = "release-" + uuid.uuid4().hex
        target = self.root / "releases" / release_name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.progress("running", "Downloading the selected upstream tag")
            self._run(["git", "clone", "--depth", "1", "--branch", tag, "--single-branch", UPSTREAM, str(target)], timeout=600)
            self._run(["git", "fetch", "--depth", "1", "origin", f"refs/tags/{tag}"], cwd=target, timeout=600)
            self._run(["git", "checkout", "--detach", "FETCH_HEAD"], cwd=target)
            self.progress("running", "Installing the release's locked Python dependencies")
            if not (target / "uv.lock").is_file():
                raise ValueError("This release has no dependency lock; it cannot be installed safely")
            image_python = self.env.get("HERMES_IMAGE_PYTHON", "/opt/hermes/.venv/bin/python")
            self._run(["uv", "sync", "--frozen", "--no-dev", "--extra", "all", "--python", image_python], cwd=target, timeout=1800)
            commit = (target / ".git/HEAD").read_text().strip()
            if not re.fullmatch(r"[a-f0-9]{40,64}", commit):
                raise ValueError("The staged release did not resolve to a pinned commit")
            stamp_writer = target / "scripts/write_install_stamp.py"
            if stamp_writer.is_file():
                self._run([str(target / ".venv/bin/python"), str(stamp_writer),
                           "--output", str(target / "install-stamp.json"),
                           "--commit", commit, "--base-version", tag.removeprefix("v"),
                           "--distance", "0", "--distribution", "docker",
                           "--update-mechanism", "external"], cwd=target)
            self.progress("running", "Checking the staged Hermes runtime")
            self._run([str(target / ".venv/bin/python"), "-c", "import hermes_cli.main; import gateway.run"], cwd=target)
            self._run([str(target / ".venv/bin/hermes"), "--version"], cwd=target)
            atomic_json(target / "workbench-release.json", {"tag": tag, "commit": commit, "installed_at": time.time()})
            return release_name
        except BaseException:
            shutil.rmtree(target, ignore_errors=True)
            raise

    def _select(self, current, previous):
        selection = {"current": current, "previous": previous, "generation": uuid.uuid4().hex}
        atomic_json(self.state_path, selection)
        return selection

    def healthy(self, generation):
        services = {}
        for role in ("gateway", "serve"):
            service = read_json(self.root / f"{role}.json", {})
            if service.get("generation") != generation or service.get("state") != "running" or time.time() - service.get("updated_at", 0) > 10:
                return False
            services[role] = service
        gateway = read_json(self.home / "gateway_state.json", {})
        if (gateway.get("gateway_state") != "running" or not services["gateway"].get("pid")
                or gateway.get("pid") != services["gateway"]["pid"]):
            return False
        try:
            port = int(self.env.get("API_SERVER_PORT", "8642"))
            with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                if response.status != 200:
                    return False
            token = self.env.get("HERMES_DASHBOARD_SESSION_TOKEN", "")
            if not token:
                return False
            from websockets.sync.client import connect
            query = urlencode({"token": token})
            with connect(f"ws://127.0.0.1:9119/api/ws?{query}", open_timeout=2, close_timeout=1) as connection:
                connection.send(json.dumps({"jsonrpc": "2.0", "id": "workbench-health", "method": "client.capabilities", "params": {"server_requests": False}}))
                for _attempt in range(10):
                    frame = json.loads(connection.recv(timeout=2))
                    if frame.get("id") == "workbench-health":
                        return "result" in frame and "error" not in frame
        except Exception:
            return False
        return False

    def _wait_healthy(self, generation, timeout=90):
        deadline = time.monotonic() + timeout
        consecutive = 0
        while time.monotonic() < deadline:
            consecutive = consecutive + 1 if self.healthy(generation) else 0
            if consecutive >= 3:
                return
            threading.Event().wait(1)
        raise ValueError("Hermes services did not become healthy")

    def _pause_for_recovery(self):
        atomic_json(self.root / "paused.json", {"reason": "activation recovery"})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            services = [read_json(self.root / f"{role}.json", {}) for role in ("gateway", "serve")]
            if all(service.get("state") != "running" for service in services):
                return
            threading.Event().wait(1)
        raise ValueError("Hermes could not stop for recovery; operator attention is required")

    def activate(self, current, before_restart=None):
        old = self.selection()
        config_backup = {name: (self.home / name).read_bytes() if (self.home / name).exists() else None
                         for name in ("config.yaml", ".env")}
        if before_restart:
            before_restart()
        atomic_json(self.root / "activation.json", {"selection": old,
                    "config": {name: content.hex() if content is not None else None for name, content in config_backup.items()}})
        selection = self._select(current, old["current"] if current != old["current"] else old.get("previous"))
        self.progress("running", "Restarting Hermes and checking both services")
        try:
            self._wait_healthy(selection["generation"])
        except Exception:
            self._pause_for_recovery()
            for name, content in config_backup.items():
                path = self.home / name
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    descriptor, temporary = tempfile.mkstemp(prefix=".restore-", dir=self.home)
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(content)
                    os.replace(temporary, path)
            restored = self._select(old["current"], old.get("previous"))
            (self.root / "paused.json").unlink(missing_ok=True)
            self.progress("running", "New runtime failed; restoring the previous runtime")
            try:
                self._wait_healthy(restored["generation"])
            except Exception:
                raise ValueError("Hermes activation failed and recovery needs operator attention") from None
            (self.root / "activation.json").unlink(missing_ok=True)
            raise ValueError("Hermes activation failed; the previous runtime was restored") from None
        (self.root / "activation.json").unlink(missing_ok=True)

    def recover_interrupted_activation(self):
        pending = read_json(self.root / "activation.json", None)
        if pending is not None:
            for name in ("config.yaml", ".env"):
                content = pending["config"][name]
                path = self.home / name
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    descriptor, temporary = tempfile.mkstemp(prefix=".recover-", dir=self.home)
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(bytes.fromhex(content))
                    os.replace(temporary, path)
            previous = pending["selection"]
            self._select(previous["current"], previous.get("previous"))
            (self.root / "paused.json").unlink(missing_ok=True)
            self.progress("failed", "An interrupted activation was recovered to the previous runtime at startup")
            (self.root / "activation.json").unlink()

        selected = self.selection()
        current = selected.get("current", "image")
        if self.runtime_available(current):
            return

        previous = selected.get("previous")
        fallback = previous if self.runtime_available(previous) else "image"
        fallback_previous = "image" if fallback != "image" else None
        self._select(fallback, fallback_previous)
        (self.root / "paused.json").unlink(missing_ok=True)
        self.progress(
            "recovered",
            f"Selected Hermes runtime {current!r} is missing or incomplete; recovered to {fallback!r} at startup",
        )

    def start(self, action, tag=None, before_restart=None):
        if not isinstance(action, str) or action not in {"update", "rollback", "apply"}:
            raise ValueError("Unknown Hermes action")
        if action == "update" and (not isinstance(tag, str) or not TAG_PATTERN.fullmatch(tag)):
            raise ValueError("A valid upstream release tag is required")
        guard = self.lock()
        guard.__enter__()
        try:
            if action == "rollback" and self.selection().get("previous") is None:
                raise ValueError("No previous Hermes runtime is available")
            self.progress("running", "Preparing Hermes operation")
        except BaseException:
            guard.__exit__(*sys.exc_info())
            raise

        def operate():
            try:
                selected = self.selection()
                target = self.prepare(tag) if action == "update" else selected["previous"] if action == "rollback" else selected["current"]
                self.activate(target, before_restart)
                self.progress("succeeded", "Hermes is running and both services passed health checks")
            except Exception as failure:
                message = str(failure) if isinstance(failure, ValueError) else "Hermes operation failed during preparation; the selected runtime was not changed"
                self.progress("failed", message)
            finally:
                guard.__exit__(None, None, None)

        thread = threading.Thread(target=operate, daemon=True)
        try:
            thread.start()
        except BaseException:
            guard.__exit__(*sys.exc_info())
            raise
        return {"ok": True, **self.status()}


def supervise(role):
    manager = RuntimeManager(os.getenv("HERMES_HOME", "/opt/data"))
    manager.recover_interrupted_activation()
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_args: stopping.set())
    while not stopping.is_set():
        if (manager.root / "paused.json").exists():
            stopping.wait(1)
            continue
        selected = manager.selection()
        runtime = manager.runtime_path(selected["current"])
        environment = dict(os.environ, HERMES_AGENT_DIR=str(runtime), HERMES_PYTHON=str(runtime / ".venv/bin/python"),
                   HERMES_INSTALL_DIR=str(runtime), HERMES_INSTALL_ROOT=str(runtime), VIRTUAL_ENV=str(runtime / ".venv"),
                   HERMES_GATEWAY_NO_SUPERVISE="1")
        environment["PATH"] = str(runtime / ".venv/bin") + os.pathsep + environment.get("PATH", "")
        command = [str(runtime / ".venv/bin/hermes")]
        command += ["gateway", "run"] if role == "gateway" else ["serve", "--host", "127.0.0.1", "--port", "9119", "--no-open"]
        child = subprocess.Popen(command, cwd=manager.home, env=environment, start_new_session=True)
        try:
            while child.poll() is None and not stopping.is_set():
                atomic_json(manager.root / f"{role}.json", {"generation": selected["generation"], "state": "running",
                            "pid": child.pid, "updated_at": time.time()})
                if manager.selection()["generation"] != selected["generation"] or (manager.root / "paused.json").exists():
                    break
                stopping.wait(1)
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                except ProcessLookupError:
                    child.wait()
            atomic_json(manager.root / f"{role}.json", {"generation": selected["generation"], "state": "stopped", "updated_at": time.time()})
        stopping.wait(1)


def exec_cli(arguments):
    manager = RuntimeManager(os.getenv("HERMES_HOME", "/opt/data"))
    manager.recover_interrupted_activation()
    runtime = manager.runtime_path()
    environment = dict(os.environ, HERMES_AGENT_DIR=str(runtime), HERMES_PYTHON=str(runtime / ".venv/bin/python"),
                       HERMES_INSTALL_DIR=str(runtime), HERMES_INSTALL_ROOT=str(runtime), VIRTUAL_ENV=str(runtime / ".venv"))
    environment["PATH"] = str(runtime / ".venv/bin") + os.pathsep + environment.get("PATH", "")
    binary = str(runtime / ".venv/bin/hermes")
    os.execve(binary, [binary, *arguments], environment)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "exec":
    exec_cli(sys.argv[2:])
elif __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["supervise"])
    parser.add_argument("role", choices=["gateway", "serve"])
    arguments = parser.parse_args()
    supervise(arguments.role)