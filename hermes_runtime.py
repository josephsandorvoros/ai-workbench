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

PM_METADATA = """
import json, os, sys, sysconfig
from pathlib import Path
runtime = Path(sys.prefix)
site = Path(sysconfig.get_path("purelib"))
(runtime / "pm-runtime.json").write_text(json.dumps({
    "python": os.path.relpath(Path(sys.executable).resolve(), runtime),
    "sitePackages": os.path.relpath(site, runtime),
}))
"""

DISCORD_CHECK = "import discord; from discord import Message, Intents; from discord.ext import commands"

PM_CHECK = """
from pathlib import Path
import subprocess
from pm.runtime import runtime_command, runtime_environment
command = runtime_command(Path.cwd() / 'pm/launch.py', ['--help'], bootstrap=False)
subprocess.run(command, env=runtime_environment(), check=True)
"""

PM_INSTALL_DISCORD = """
import sys
from pm.runtime import run_cli
sys.exit(run_cli(['install', '--extra', 'discord']))
"""

SELECTED_PYTHON = """
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from pm.environments import selected_venv, venv_python
print(json.dumps(str(venv_python(selected_venv(root)))))
"""


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

    def runtime_environment(self, runtime, base=None, python=None):
        environment = dict(self.env if base is None else base)
        binaries = Path(python).parent if python else runtime / ".venv/bin"
        environment.update(
            HOME=str(self.home), HERMES_HOME=str(self.home),
            HERMES_AGENT_DIR=str(runtime), HERMES_INSTALL_DIR=str(runtime),
            HERMES_INSTALL_ROOT=str(runtime), HERMES_PYTHON=str(python or binaries / "python"),
            VIRTUAL_ENV=str(binaries.parent), PYTHONPATH=str(runtime),
        )
        environment["PATH"] = str(binaries) + os.pathsep + environment.get("PATH", "")
        return environment

    def runtime_command(self, runtime, arguments):
        if not (runtime / "pm/environments.py").is_file():
            return [str(runtime / ".venv/bin/hermes"), *arguments]
        # PM can replace the bootstrap .venv with a committed dependency generation.
        python = self.env.get("HERMES_IMAGE_PYTHON", str(self.runtime_path("image") / ".venv/bin/python"))
        result = subprocess.run(
            [python, "-I", "-S", "-c", SELECTED_PYTHON, str(runtime)],
            cwd=self.home, env=self.runtime_environment(runtime),
            check=True, capture_output=True, text=True, timeout=10,
        )
        selected = Path(json.loads(result.stdout))
        if not selected.is_absolute() or not selected.is_file():
            raise ValueError("Selected Hermes dependency interpreter is missing")
        return [str(selected), "-m", "hermes_cli.main", *arguments]

    def discord_enabled(self):
        from hermes_config import read_config

        config = read_config(self.home)
        discord = (config.get("platforms") or {}).get("discord") or {}
        if "enabled" in discord:
            return discord["enabled"] is True
        if self.env.get("DISCORD_BOT_TOKEN", "").strip():
            return True
        env_file = self.home / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                key, separator, value = line.strip().removeprefix("export ").partition("=")
                if separator and key.strip() == "DISCORD_BOT_TOKEN" and value.strip().strip("\"'"):
                    return True
        return False

    def discord_ready(self, gateway):
        if not self.discord_enabled():
            return True
        discord = gateway.get("platforms", {}).get("discord", {})
        return discord.get("state") == "connected" and discord.get("writer_pid") == gateway.get("pid")

    def validate_pm_runtime(self, runtime):
        marker = read_json(runtime / "pm-runtime.json", {})
        if not all(isinstance(marker.get(key), str) and marker[key] for key in ("python", "sitePackages")):
            raise ValueError("Packaged PM runtime metadata is missing or invalid")
        python = (runtime / marker["python"]).resolve()
        site = (runtime / marker["sitePackages"]).resolve()
        if not python.is_file() or not os.access(python, os.X_OK) or not site.is_dir():
            raise ValueError("Packaged PM interpreter or dependencies are missing")
        self._run([str(python), "-I", "-S", "-c",
                   "import sys; sys.path.insert(0, sys.argv[1]); "
                   "import packaging, tomli_w, truststore; from ruamel.yaml import YAML",
                   str(site)])

    def prepare_pm_runtime(self, target, image_python):
        project = target / "pm"
        if not all((project / name).is_file() for name in ("pyproject.toml", "uv.lock")):
            raise ValueError("This release has no locked PM runtime project")
        image = self.runtime_path("image")
        matching = all((image / "pm" / name).is_file()
                       and (image / "pm" / name).read_bytes() == (project / name).read_bytes()
                       for name in ("pyproject.toml", "uv.lock"))
        packaged = read_json(image / "install-stamp.json", {}).get("pmRuntime")
        if matching and isinstance(packaged, str) and Path(packaged).is_absolute():
            runtime = Path(packaged)
            self.validate_pm_runtime(runtime)
        else:
            self._run(["uv", "sync", "--frozen", "--no-dev", "--project", str(project),
                       "--python", image_python], cwd=target, timeout=1800)
            runtime = project / ".venv"
            self._run([str(runtime / "bin/python"), "-c", PM_METADATA], cwd=target)
            self.validate_pm_runtime(runtime)
        stamp_path = target / "install-stamp.json"
        stamp = read_json(stamp_path, {})
        if stamp.get("distribution") != "docker":
            raise ValueError("The staged release is missing its Docker install stamp")
        atomic_json(stamp_path, {**stamp, "pmRuntime": str(runtime.resolve())})
        self._run([str(target / ".venv/bin/python"), "-c", PM_CHECK], cwd=target, runtime=target)

    def runtime_available(self, selected):
        if selected == "image" and not (self.runtime_path("image") / "pm/runtime.py").is_file():
            return True
        try:
            binaries = self.runtime_path(selected) / ".venv" / "bin"
        except (ValueError, TypeError):
            return False
        runtime = binaries.parent.parent
        try:
            command = self.runtime_command(runtime, ["--version"])
        except (OSError, ValueError, subprocess.SubprocessError):
            return False
        if not (runtime / "pm/environments.py").is_file() and not all(
                path.is_file() and os.access(path, os.X_OK) for path in (binaries / "python", binaries / "hermes")):
            return False
        commands = [command]
        if (runtime / "pm/runtime.py").is_file():
            try:
                stamp = read_json(runtime / "install-stamp.json", {})
            except (OSError, ValueError):
                return False
            packaged = stamp.get("pmRuntime")
            if not isinstance(packaged, str) or not Path(packaged).is_absolute():
                return False
            commands.append([command[0], "-c", PM_CHECK])
            if self.discord_enabled():
                commands.append([command[0], "-c", DISCORD_CHECK])
        for command in commands:
            try:
                python = command[0] if (runtime / "pm/environments.py").is_file() else None
                subprocess.run(command, cwd=runtime, env=self.runtime_environment(runtime, python=python), check=True,
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

    def _run(self, command, cwd=None, timeout=180, runtime=None):
        build_home = self.root / "build-home"
        build_home.mkdir(parents=True, exist_ok=True)
        environment = {name: value for name, value in self.env.items()
                       if name in {"PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
                                   "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"}}
        environment.update(HOME=str(build_home), HERMES_HOME=str(build_home), GIT_TERMINAL_PROMPT="0",
                           UV_NO_PROGRESS="1", UV_PYTHON_DOWNLOADS="never")
        if runtime is not None:
            python = command[0] if Path(command[0]).name.startswith("python") else None
            environment = self.runtime_environment(runtime, environment, python=python)
        log_path = self.root / "preparation.log"
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a") as log:
            subprocess.run(command, cwd=cwd, env=environment, check=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, stdout=log, stderr=log)

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
            image_python = self.env.get("HERMES_IMAGE_PYTHON", str(self.runtime_path("image") / ".venv/bin/python"))
            # Upstream's "all" extra excludes opt-in messaging SDKs.
            self._run(["uv", "sync", "--frozen", "--no-dev", "--extra", "all",
                       "--extra", "discord", "--python", image_python], cwd=target, timeout=1800)
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
            if (target / "pm/runtime.py").is_file():
                self.progress("running", "Validating the packaged PM runtime before dependency installation")
                self.prepare_pm_runtime(target, image_python)
                if self.discord_enabled():
                    self.progress("running", "Installing Discord in the gateway's managed dependency environment")
                    self._run([str(target / ".venv/bin/python"), "-c", PM_INSTALL_DISCORD],
                              cwd=target, runtime=target, timeout=1800)
            self.progress("running", "Checking the staged Hermes runtime")
            launch = self.runtime_command(target, ["--version"])
            python = launch[0] if (target / "pm/environments.py").is_file() else str(target / ".venv/bin/python")
            self._run([python, "-c", "import hermes_cli.main; import gateway.run"], cwd=target, runtime=target)
            self._run([python, "-c", DISCORD_CHECK], cwd=target, runtime=target)
            self._run(launch, cwd=target, runtime=target)
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
        if not self.discord_ready(gateway):
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
        detail = " (including enabled Discord)" if self.discord_enabled() else ""
        raise ValueError(f"Hermes services did not become healthy{detail}")

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
        if current != old["current"] and not self.runtime_available(current):
            raise ValueError("The requested Hermes runtime is incomplete; activation was not attempted")
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
        except Exception as failure:
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
            raise ValueError(f"Hermes activation failed: {failure}; the previous runtime was restored") from None
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
        if not self.runtime_available(fallback):
            raise ValueError("No valid Hermes runtime is available; operator attention is required")
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
                message = str(failure) if isinstance(failure, ValueError) else (
                    "Hermes preparation failed; the selected runtime was not changed. "
                    f"See {self.root / 'preparation.log'} for dependency/import errors."
                )
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

    def restart_gateway(self, detach=False):
        with self.lock():
            service = read_json(self.root / "gateway.json", {})
            if service.get("state") != "running" or time.time() - service.get("updated_at", 0) > 10:
                raise ValueError("The Workbench gateway supervisor is not running")
            request_id = uuid.uuid4().hex
            atomic_json(self.root / "gateway-restart.json", {"id": request_id})
        if detach:
            print("Gateway restart requested through the Workbench supervisor")
            return
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            replacement = read_json(self.root / "gateway.json", {})
            gateway = read_json(self.home / "gateway_state.json", {})
            if (replacement.get("restart_id") == request_id
                    and replacement.get("state") == "running"
                    and gateway.get("gateway_state") == "running"
                    and gateway.get("pid") == replacement.get("pid")
                    and self.discord_ready(gateway)):
                print("Gateway restarted through the Workbench supervisor")
                return
            threading.Event().wait(1)
        raise ValueError("Gateway restart did not become ready; check the gateway log")


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
        restart_id = read_json(manager.root / "gateway-restart.json", {}).get("id")
        runtime = manager.runtime_path(selected["current"])
        arguments = ["gateway", "run"] if role == "gateway" else ["serve", "--host", "127.0.0.1", "--port", "9119", "--no-open"]
        command = manager.runtime_command(runtime, arguments)
        python = command[0] if (runtime / "pm/environments.py").is_file() else None
        environment = manager.runtime_environment(runtime, python=python)
        environment["HERMES_GATEWAY_NO_SUPERVISE"] = "1"
        child = subprocess.Popen(command, cwd=manager.home, env=environment, start_new_session=True)
        try:
            while child.poll() is None and not stopping.is_set():
                atomic_json(manager.root / f"{role}.json", {"generation": selected["generation"], "state": "running",
                            "pid": child.pid, "updated_at": time.time(), "restart_id": restart_id})
                if manager.selection()["generation"] != selected["generation"] or (manager.root / "paused.json").exists():
                    break
                if role == "gateway" and read_json(manager.root / "gateway-restart.json", {}).get("id") != restart_id:
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
    if manager.supported and arguments in (["gateway", "restart"], ["gateway", "restart", "--detach"]):
        manager.restart_gateway(detach="--detach" in arguments)
        return
    runtime = manager.runtime_path()
    command = manager.runtime_command(runtime, arguments)
    python = command[0] if (runtime / "pm/environments.py").is_file() else None
    environment = manager.runtime_environment(runtime, python=python)
    os.execve(command[0], command, environment)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "exec":
    exec_cli(sys.argv[2:])
elif __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["supervise"])
    parser.add_argument("role", choices=["gateway", "serve"])
    arguments = parser.parse_args()
    supervise(arguments.role)