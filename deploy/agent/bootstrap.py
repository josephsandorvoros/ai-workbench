#!/usr/bin/env python3
"""First-boot / every-boot bootstrap for the AI Workbench agent container.

Runs as root from s6 cont-init (after the upstream Hermes setup hooks).
Idempotent: generates secrets once, then re-applies env-declared settings.
"""

import json
import os
import pwd
import secrets
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

if Path(__file__).parent.name == "agent":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from opencode_config import opencode_settings, write_opencode_config
from hermes_config import write_config as write_hermes_config
from hermes_runtime import RuntimeManager

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspace"))
WIKI_ROOT = Path(os.environ.get("WIKI_ROOT", str(WORKSPACE_ROOT / "wiki")))
HERMES_ENV = HERMES_HOME / ".env"
WORKBENCH_ENV = Path(os.environ.get("WORKBENCH_ENV_FILE", str(HERMES_HOME / "workbench.env")))

try:
    _pw = pwd.getpwnam("hermes")
    UID, GID = _pw.pw_uid, _pw.pw_gid
except KeyError:
    UID = GID = None


def log(msg):
    print(f"[workbench-bootstrap] {msg}", flush=True)


def chown(path):
    if UID is not None:
        os.chown(path, UID, GID)


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def upsert_env(path, updates):
    """Set KEY=VALUE pairs in an env file, preserving unrelated lines."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(updates)
    out = []
    for line in lines:
        key = line.partition("=")[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in pending:
            out.append(f"{key}={pending.pop(key)}")
        else:
            out.append(line)
    out.extend(f"{k}={v}" for k, v in pending.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    chown(path)


def ensure_managed_hermes_cli_path(profile_path=None):
    """Keep the image's recovery-aware Hermes launcher ahead of persistent local shims."""
    profile = Path(profile_path) if profile_path else HERMES_HOME / ".profile"
    if profile.is_symlink():
        log(f"not changing symlinked login profile {profile}")
        return
    original = profile.read_text(encoding="utf-8") if profile.exists() else ""
    marker = "# spatial-workbench managed Hermes CLI path"
    if marker in original:
        return
    snippet = (
        f"{marker}\n"
        "case \"$PATH\" in\n"
        "    /opt/workbench/bin|/opt/workbench/bin:*) ;;\n"
        "    *) PATH=\"/opt/workbench/bin:$PATH\" ;;\n"
        "esac\n"
        "export PATH\n"
    )
    content = original.rstrip() + ("\n\n" if original.strip() else "") + snippet
    mode = stat.S_IMODE(profile.stat().st_mode) if profile.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix=".profile-", dir=profile.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        chown(Path(temporary))
        os.replace(temporary, profile)
        chown(profile)
    finally:
        Path(temporary).unlink(missing_ok=True)
    log("managed Hermes CLI launcher added first in the login-shell PATH")


def resolve_secret(name, existing):
    """Env var wins; otherwise keep the persisted value; otherwise generate."""
    return os.environ.get(name, "").strip() or existing.get(name, "") or secrets.token_urlsafe(32)


def as_hermes(*argv):
    env = dict(os.environ, HOME=str(HERMES_HOME), HERMES_HOME=str(HERMES_HOME))
    cmd = ["s6-setuidgid", "hermes", *argv] if UID is not None and os.getuid() == 0 else list(argv)
    return subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)


def ensure_secrets():
    hermes_env = read_env(HERMES_ENV)
    upsert_env(
        HERMES_ENV,
        {
            "API_SERVER_ENABLED": "true",
            "API_SERVER_KEY": resolve_secret("API_SERVER_KEY", hermes_env),
            "API_SERVER_PORT": os.environ.get("API_SERVER_PORT", "8642"),
            "WIKI_PATH": str(WIKI_ROOT),
        },
    )
    wb_env = read_env(WORKBENCH_ENV)
    upsert_env(WORKBENCH_ENV, {
        "TERMINAL_API_TOKEN": resolve_secret("TERMINAL_API_TOKEN", wb_env),
        "HERMES_DASHBOARD_SESSION_TOKEN": resolve_secret("HERMES_DASHBOARD_SESSION_TOKEN", wb_env),
    })
    log(f"secrets ready ({HERMES_ENV}, {WORKBENCH_ENV})")


def configure_hermes_model():
    write_hermes_config(os.environ, HERMES_HOME)
    if (HERMES_HOME / "config.yaml").exists():
        chown(HERMES_HOME / "config.yaml")
    log("Hermes inference settings ready (saved overrides take precedence)")


def _opencode_version(binary):
    try:
        out = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    parts = [int(p) for p in out.strip().split(".")[:3] if p.isdigit()]
    return tuple(parts) if len(parts) == 3 else None


def prune_stale_opencode():
    """Drop an in-place OpenCode update once the image ships the same or newer version."""
    prefix = Path(os.environ.get("NPM_CONFIG_PREFIX", str(HERMES_HOME / ".local")))
    local_bin, image_bin = prefix / "bin" / "opencode", Path("/usr/local/bin/opencode")
    if not local_bin.exists() or not image_bin.exists():
        return
    local_v, image_v = _opencode_version(local_bin), _opencode_version(image_bin)
    if local_v and image_v and image_v >= local_v:
        subprocess.run(["npm", "uninstall", "-g", "--prefix", str(prefix), "opencode-ai"], capture_output=True, check=False)
        log(f"removed in-place OpenCode {local_v} (image has {image_v})")


def configure_opencode():
    try:
        config_path, secret_path, model = write_opencode_config(os.environ, HERMES_HOME)
    except (OSError, json.JSONDecodeError) as exc:
        log(f"leaving unparseable OpenCode config untouched: {exc}")
        return
    for path in (config_path, config_path.parent, config_path.parent.parent, secret_path, secret_path.parent):
        chown(path)
    log(f"OpenCode model -> {model}")


def seed_workspace():
    for directory in (WORKSPACE_ROOT, WORKSPACE_ROOT / "projects", WIKI_ROOT):
        directory.mkdir(parents=True, exist_ok=True)
        chown(directory)
    index = WIKI_ROOT / "index.md"
    if not any(WIKI_ROOT.glob("*.md")):
        index.write_text(
            "# Wiki\n\nPlain markdown knowledge base. Link pages with [[page-name]].\n",
            encoding="utf-8",
        )
        chown(index)
        log(f"seeded wiki at {WIKI_ROOT}")


def configure_terminal_backend():
    """Point Hermes' terminal tool at the sandbox daemon (AGENT_SANDBOX=1) or back to local."""
    enabled = os.environ.get("AGENT_SANDBOX", "0").strip().lower() in {"1", "true", "yes", "docker"}
    if not enabled:
        # Only undo our own switch; leave any other backend the user picked alone.
        try:
            current = as_hermes("hermes", "config", "get", "terminal.backend").stdout.strip()
        except OSError:
            return
        if current != "docker":
            return
    settings = {"terminal.backend": "docker" if enabled else "local"}
    if enabled:
        # Hermes treats a cwd under /workspace as container-side and would give each worker a private
        # workspace, so bind the shared one explicitly (same path in the sandbox daemon).
        settings.update({
            "terminal.cwd": str(WORKSPACE_ROOT),
            "terminal.docker_mount_cwd_to_workspace": "false",
            "terminal.docker_volumes": json.dumps([f"{WORKSPACE_ROOT}:/workspace"]),
        })
        for env_name, key in (
            ("SANDBOX_IMAGE", "terminal.docker_image"),
            ("SANDBOX_CPU", "terminal.container_cpu"),
            ("SANDBOX_MEMORY_MB", "terminal.container_memory"),
        ):
            if os.environ.get(env_name, "").strip():
                settings[key] = os.environ[env_name].strip()
    for key, value in settings.items():
        try:
            result = as_hermes("hermes", "config", "set", key, value)
        except OSError as exc:
            log(f"hermes config set {key} failed: {exc}")
            return
        if result.returncode != 0:
            log(f"hermes config set {key} failed: {result.stderr.strip()[:200]}")
    log(f"Hermes terminal backend -> {settings['terminal.backend']}")


def configure_hermes_mcp():
    """Register the AI Workbench stdio MCP server with Hermes.

    Gives the gateway agent native access to the workbench file/wiki/artifact/board
    tools. The server is a stdio child spawned by Hermes (not a separate s6 service).
    Idempotent: re-applies the mcp_servers.workbench entry on every boot.
    """
    python_path = os.environ.get("HERMES_PYTHON", "/opt/hermes/.venv/bin/python")
    server_path = "/opt/workbench/workbench_mcp.py"
    if not Path(server_path).exists():
        log(f"MCP server {server_path} not found; skipping Hermes MCP registration")
        return
    api_port = os.environ.get("WORKBENCH_API_PORT", "8080")
    token = read_env(WORKBENCH_ENV).get("TERMINAL_API_TOKEN", "")
    auth = os.environ.get("WORKBENCH_AUTH", "proxy").strip() or "proxy"
    config = {
        "command": python_path,
        "args": [server_path],
        "env": {
            "WORKBENCH_API_BASE": f"http://127.0.0.1:{api_port}",
            "TERMINAL_API_TOKEN": token,
            "WORKBENCH_AUTH": auth,
        },
    }
    try:
        result = as_hermes("hermes", "config", "set", "mcp_servers.workbench", json.dumps(config))
    except OSError as exc:
        log(f"hermes config set mcp_servers.workbench failed: {exc}")
        return
    if result.returncode != 0:
        log(f"hermes config set mcp_servers.workbench failed: {result.stderr.strip()[:200]}")
        return
    log(f"Hermes MCP server 'workbench' registered ({python_path} {server_path})")


def main():
    HERMES_HOME.mkdir(parents=True, exist_ok=True)
    manager = RuntimeManager(HERMES_HOME)
    if manager.supported:
        manager.root.mkdir(parents=True, exist_ok=True)
        manager.recover_interrupted_activation()
        chown(manager.root)
        for path in manager.root.iterdir():
            chown(path)
    ensure_secrets()
    ensure_managed_hermes_cli_path()
    configure_hermes_mcp()
    seed_workspace()
    configure_hermes_model()
    configure_terminal_backend()
    prune_stale_opencode()
    configure_opencode()


if __name__ == "__main__":
    main()
