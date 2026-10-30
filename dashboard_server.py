#!/usr/bin/env python3
"""AI tools dashboard server with workflow and stats APIs."""

import argparse
import copy
from contextlib import nullcontext
import hashlib
import hashlib
import hmac
import http.client
import io
import json
import mimetypes
import os
import sys
import pty
import shlex
import shutil
import signal
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import re
import fcntl
import termios
import zipfile
from urllib.parse import parse_qs, unquote, urlparse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from jobs_engine import HermesClient, JobEngine
from hermes_live import HermesLiveError, HermesLiveHub
from opencode_config import connection_key_scope, connection_settings, validate_endpoint, write_opencode_config
import hermes_config
import provider_catalog
from hermes_runtime import RuntimeManager
from free_models import tracker as free_model_tracker
import speech_services
import app_preview

BASE_DIR = Path(__file__).resolve().parent


def _load_env_file(path):
    """Load KEY=VALUE lines into os.environ without overriding real env vars."""
    try:
        lines = Path(path).expanduser().read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip().removeprefix("export ").strip()
        # Compose passes unset vars as empty strings; treat those as unset too.
        if name and not os.environ.get(name):
            os.environ[name] = value.strip().strip('"').strip("'")


# Host-specific overrides live OUTSIDE BASE_DIR (which is served statically).
_load_env_file(os.getenv("WORKBENCH_ENV_FILE", "~/.config/spatial-workbench/dashboard.env"))

HERMES_HOME = Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
# Hermes source checkout (bundled skills + model_tools). Container image: /opt/hermes.
HERMES_AGENT_DIR = Path(os.getenv("HERMES_AGENT_DIR", str(HERMES_HOME / "hermes-agent"))).expanduser()

PORT = 8080
HOST = "0.0.0.0"
# Max size (bytes) for a single workspace file read/write. The workspace is
# un-scoped (any file on the host), so this is the only size guard.
WORKSPACE_MAX_FILE_BYTES = 2 * 1024 * 1024
# Chat attachments (files/images uploaded from the browser).
UPLOAD_MAX_BYTES = 10 * 1024 * 1024
# Folder downloads are zipped server-side; cap the total so a huge tree
# (e.g. a venv) cannot exhaust disk or hang the browser.
WORKSPACE_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024

# web_fetch tool guards: only http(s), bounded download size, bounded output.
WEB_FETCH_TIMEOUT_SECONDS = 15
WEB_FETCH_MAX_BYTES = 256 * 1024
WEB_FETCH_MAX_OUTPUT_CHARS = 12000
WEB_FETCH_USER_AGENT = "spatial-workbench-web-fetch/1.0"

# Conservative fallback context window (tokens) used when the llama.cpp
# /props probe is unreachable. Qwen3.8-27B runs at 98,304 tokens; 32k keeps
# the agent well inside the window even if the real value is unavailable.
DEFAULT_MODEL_CONTEXT = int(os.getenv("MODEL_CONTEXT_FALLBACK", "32768") or 32768)


class Colors:
    RESET = "\033[0m"
    GREEN = "\033[92m"
    CYAN = "\033[96m"
    YELLOW = "\033[93m"


WORKFLOW_CONFIG = {}


CHAT_PROVIDER_CONFIG = {
    "hermes": {
        "id": "hermes",
        "name": "Hermes",
        "description": "Research and personal assistant with workflow context.",
        "kind": "native",
        "url": "",
        "default": True,
    },
    "openwebui": {
        "id": "openwebui",
        "name": "OpenWebUI",
        "description": "Polished chat interface for general model usage.",
        "kind": "external",
        "url": os.getenv("OPENWEBUI_URL", "").strip(),
        "default": False,
    },
}


REMOTE_STATS_SCRIPT = r"""
import json
import os
import shutil
import subprocess
import time


def _cpu_snapshot():
    with open('/proc/stat', 'r', encoding='utf-8') as f:
        parts = f.readline().split()[1:]
    values = [int(x) for x in parts]
    total = sum(values)
    idle = values[3] + values[4]
    return total, idle


def cpu_percent():
    t1, i1 = _cpu_snapshot()
    time.sleep(0.2)
    t2, i2 = _cpu_snapshot()
    dt = max(t2 - t1, 1)
    didle = i2 - i1
    return round((1.0 - (didle / dt)) * 100.0, 2)


def meminfo():
    data = {}
    with open('/proc/meminfo', 'r', encoding='utf-8') as f:
        for line in f:
            key, value = line.split(':', 1)
            data[key] = int(value.strip().split()[0]) * 1024
    total = data.get('MemTotal', 0)
    available = data.get('MemAvailable', 0)
    used = max(total - available, 0)
    pct = round((used / total) * 100.0, 2) if total else 0.0
    return {
        'percentage': pct,
        'used_gb': round(used / (1024 ** 3), 2),
        'total_gb': round(total / (1024 ** 3), 2),
        'available_gb': round(available / (1024 ** 3), 2),
    }


def diskinfo():
    usage = shutil.disk_usage('/')
    return {
        'percentage': round((usage.used / usage.total) * 100.0, 2) if usage.total else 0.0,
        'used_gb': round(usage.used / (1024 ** 3), 2),
        'total_gb': round(usage.total / (1024 ** 3), 2),
        'free_gb': round(usage.free / (1024 ** 3), 2),
    }


def gpuinfo():
    try:
        result = subprocess.run(
            [
                'nvidia-smi',
                '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
                '--format=csv,noheader,nounits',
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        first = result.stdout.strip().splitlines()[0]
        parts = [p.strip() for p in first.split(',')]
        if len(parts) < 4:
            return None
        return {
            'utilization_gpu': float(parts[0]),
            'memory_used_gb': round(float(parts[1]) / 1024.0, 2),
            'memory_total_gb': round(float(parts[2]) / 1024.0, 2),
            'temperature_gpu': float(parts[3]),
        }
    except Exception:
        return None


def temps():
    out = {}
    for zone in ('thermal_zone0', 'thermal_zone1'):
        path = f'/sys/class/thermal/{zone}/temp'
        try:
            with open(path, 'r', encoding='utf-8') as f:
                out[zone] = round(float(f.read().strip()) / 1000.0, 1)
        except Exception:
            continue
    return out


stats = {
    'timestamp': time.time(),
    'cpu': {
        'usage_percent': cpu_percent(),
        'core_count': os.cpu_count() or 0,
    },
    'memory': meminfo(),
    'disk': diskinfo(),
    'gpu': gpuinfo(),
    'temperatures': temps(),
    'process_count': len([p for p in os.listdir('/proc') if p.isdigit()]),
}

print(json.dumps(stats))
"""


def _try_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _try_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _strip_html(html):
    """Reduce HTML to readable plain text (no external deps)."""
    text = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|section|article|li|tr|h[1-6]|table|pre|blockquote|header|footer|ul|ol|dl)>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


class DashboardState:
    """Shared server state for cached stats and workflow config."""

    def __init__(self):
        self.gateway_session_lock = threading.Lock()
        self.gateway_session_ids = {}
        self.stats_lock = threading.Lock()
        self.stats_cache = {"status": "warming", "message": "Gathering first sample..."}
        self.stats_cache_ts = 0.0
        self.stats_ttl_seconds = 3.0
        self.workflow_lock = threading.Lock()
        self.workflow_jobs = {}
        self.ai_node_ssh_target = os.getenv("AI_NODE_SSH_TARGET", "").strip()
        self.ai_node_stats_url = os.getenv("AI_NODE_STATS_URL", "").strip()
        # local | http | ssh — inferred from whichever remote target is configured.
        self.glances_url = os.getenv("GLANCES_URL", "").strip().rstrip("/")
        self._glances_api = None  # "4" or "3", detected on first use
        self.stats_source = (
            os.getenv("STATS_SOURCE", "").strip().lower()
            or (
                "glances" if self.glances_url
                else "http" if self.ai_node_stats_url
                else "ssh" if self.ai_node_ssh_target
                else "local"
            )
        )
        self.configured_stats_source = self.stats_source
        self.workflow_urls = {
            key: os.getenv(cfg["env_var"], "").strip()
            for key, cfg in WORKFLOW_CONFIG.items()
        }
        self.terminal_sessions = {}
        self.terminal_lock = threading.Lock()
        self.terminal_idle_ttl_seconds = int(os.getenv("TERMINAL_IDLE_TTL_SECONDS", "7200"))
        self.terminal_api_token = os.getenv("TERMINAL_API_TOKEN", "").strip()
        self.hermes_cli = (
            os.getenv("HERMES_CLI_PATH", "").strip()
            or shutil.which("hermes")
            or str(HERMES_AGENT_DIR / "venv" / "bin" / "hermes")
        )
        self.hermes_workdir = Path(os.getenv("HERMES_WORKDIR", "").strip() or str(HERMES_HOME))
        self.wiki_root = Path(
            os.getenv("WIKI_ROOT", "").strip() or str(Path.home() / "wiki")
        ).expanduser().resolve()
        self.workspace_root = Path(
            os.getenv("WORKSPACE_ROOT", "").strip() or str(Path.home() / "workspace")
        ).expanduser().resolve()
        backup_root = Path(os.getenv("WORKBENCH_BACKUP_DIR", str(HERMES_HOME / "spatial-workbench" / "backups"))).expanduser().resolve()
        self.wiki_backup_dir = backup_root / "wiki"
        # Extra roots the workspace file API may touch. Skills/memory live under
        # ~/.hermes (and opencode skill dirs), which are OUTSIDE workspace_root —
        # without these, editing a skill from the Agent tab 400s with
        # "Path escapes workspace root".
        self.workspace_extra_roots = [
            Path(p).expanduser().resolve()
            for p in (
                HERMES_HOME,
                Path.home() / ".config" / "opencode",
                Path.home() / ".opencode",
            )
        ]
        self.workspace_backup_dir = backup_root / "workspace"
        # Directories the workspace explorer (and folder downloads) skip.
        self.workspace_ignored_dirs = {".git", "__pycache__", "node_modules", "dist", "target", ".venv", "venv"}
        self.workbench_state_path = HERMES_HOME / "spatial-workbench" / "state.json"
        self.workbench_state_lock = threading.Lock()
        with self.workbench_state_lock:
            stats_choice = self._read_settings().get("stats_source_choice")
        if stats_choice == "host":
            self.stats_source = "local"
        elif stats_choice == "configured":
            self.stats_source = self.configured_stats_source
        # HTML artifact body lives in the workspace as a real file so the
        # browser and the agent (MCP tools) read/write the same artifact.
        # state.json keeps only a pointer {name, updatedAt}.
        self.artifacts_dir = self.workspace_root / "artifacts"
        self.app_previews = app_preview.AppPreviewManager(self.workspace_root)
        self.board_state_path = HERMES_HOME / "spatial-workbench" / "board.json"
        self.board_state_lock = threading.Lock()
        jobs_db = os.getenv("JOBS_DB", "").strip() or HERMES_HOME / "spatial-workbench" / "jobs.db"
        self.jobs = JobEngine(jobs_db, self.workspace_root, self._hermes_job_call, skills_root=HERMES_HOME / "skills",
                      worker_config=lambda: connection_settings(os.environ, HERMES_HOME, "worker"))
        self.event_lock = threading.Lock()
        self.events = []
        self.max_events = 500
        self.hermes_live = HermesLiveHub(
            HERMES_HOME / "spatial-workbench" / "hermes_sessions.json",
            idle_seconds=float(os.getenv("HERMES_LIVE_IDLE_SECONDS", "1800") or 1800),
            cwd=str(self.workspace_root),
        )

        for old, new in ((self.wiki_root / ".dashboard-backups", self.wiki_backup_dir),
                         (self.workspace_root / ".dashboard-backups", self.workspace_backup_dir)):
            new.mkdir(parents=True, exist_ok=True)
            if old.is_dir() and not old.is_symlink():
                for source in old.iterdir():
                    if not source.is_file() or source.is_symlink():
                        continue
                    destination = new / source.name
                    if destination.exists():
                        destination = new / f"{source.name}.{uuid.uuid4().hex[:8]}"
                    shutil.move(str(source), str(destination))
                if not any(old.iterdir()):
                    old.rmdir()
        self.workbench_state_path.parent.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

        self.record_event(
            "server_start",
            "Dashboard server started",
            {
                "wiki_root": str(self.wiki_root),
                "workspace_root": str(self.workspace_root),
                "stats_source": self._stats_source_label(),
            },
        )

    def _stats_source_label(self, source=None):
        source = source or self.stats_source
        if source == "glances":
            return "AI node (Glances)"
        if source == "http":
            return "AI node (HTTP monitor)"
        if source == "ssh":
            return "AI node (SSH monitor)"
        return "AI Workbench host"

    def stats_source_options(self):
        options = [{"value": "host", "label": "AI Workbench host"}]
        if self.configured_stats_source != "local":
            options.append({"value": "configured", "label": self._stats_source_label(self.configured_stats_source)})
        selected = "host" if self.stats_source == "local" else "configured"
        return {"ok": True, "selected": selected, "options": options, "source_label": self._stats_source_label()}

    def set_stats_source(self, choice):
        choice = str(choice or "").strip().lower()
        if choice not in ("host", "configured"):
            raise ValueError("Stats source must be host or configured")
        if choice == "configured" and self.configured_stats_source == "local":
            raise ValueError("No remote stats source is configured")
        with self.workbench_state_lock:
            settings = self._read_settings()
            settings["stats_source_choice"] = choice
            self._write_settings(settings)
        with self.stats_lock:
            self.stats_source = "local" if choice == "host" else self.configured_stats_source
            self.stats_cache = {"status": "warming", "message": "Loading selected stats source..."}
            self.stats_cache_ts = 0.0
        self.record_event("stats_source", "Stats source changed", {"source": choice, "label": self._stats_source_label()})
        return self.stats_source_options()

    @staticmethod
    def _artifact_filename(name):
        """Sanitize an artifact name into a safe file name (no .html suffix)."""
        base = Path(str(name or "")).name.strip()
        base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip(" .") or "artifact"
        return base

    def _write_artifact_file(self, name, html):
        """Atomically write the artifact HTML to artifacts/<name>.html.

        Returns the file path. Caller must hold workbench_state_lock.
        """
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        target = self.artifacts_dir / f"{self._artifact_filename(name)}.html"
        temp_path = self.artifacts_dir / f".{target.name}.tmp"
        temp_path.write_text(html, encoding="utf-8")
        temp_path.replace(target)
        return target

    def _migrate_legacy_artifact(self, artifact, chat_sessions):
        """One-time migration: move an inline artifact (with html) out of
        state.json into a workspace file, returning the pointer dict.
        Preserves the existing chat_sessions. Caller must hold
        workbench_state_lock."""
        name = str(artifact.get("name") or "New artifact")
        html = str(artifact.get("html") or "")
        target = self._write_artifact_file(name, html)
        pointer = {
            "name": name,
            "updatedAt": int(artifact.get("updatedAt") or time.time() * 1000),
        }
        self._write_workbench_state_file(
            {"artifact": pointer, "chat_sessions": chat_sessions or []}
        )
        self.record_event(
            "workbench_artifact_migrated",
            "Migrated inline HTML artifact to workspace file",
            {"path": str(target), "name": name},
        )
        return pointer

    def _write_workbench_state_file(self, state):
        """Atomically write state.json. Caller must hold workbench_state_lock."""
        temp_path = self.workbench_state_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        temp_path.replace(self.workbench_state_path)

    def _read_workbench_state_file(self):
        """Read state.json (or {} if missing/invalid). Caller must hold
        workbench_state_lock."""
        try:
            if not self.workbench_state_path.exists():
                return {}
            payload = json.loads(self.workbench_state_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _reconcile_artifacts(self, index):
        """Reconcile the artifact index with the artifacts directory.

        Keeps index entries whose file still exists, adds directory files that
        are not yet indexed (using the file stem as the display name), and
        sorts by updatedAt descending. This is the source of truth for the
        "all artifacts" list, so it works across browsers/machines. Caller
        must hold workbench_state_lock.
        """
        known = {}
        if isinstance(index, list):
            for entry in index:
                if not isinstance(entry, dict) or not entry.get("name"):
                    continue
                name = str(entry["name"])
                key = self._artifact_filename(name)
                target = self.artifacts_dir / f"{key}.html"
                if target.exists():
                    known[key] = {
                        "name": name,
                        "updatedAt": int(entry.get("updatedAt") or target.stat().st_mtime * 1000),
                    }
        try:
            for path in self.artifacts_dir.glob("*.html"):
                key = path.name[: -len(".html")]
                if key not in known:
                    known[key] = {
                        "name": key,
                        "updatedAt": int(path.stat().st_mtime * 1000),
                    }
        except OSError:
            pass
        return sorted(known.values(), key=lambda item: item.get("updatedAt") or 0, reverse=True)

    def load_workbench_state(self):
        with self.workbench_state_lock:
            try:
                payload = {}
                if self.workbench_state_path.exists():
                    payload = json.loads(self.workbench_state_path.read_text(encoding="utf-8"))
                artifact = payload.get("artifact")
                chat_sessions = payload.get("chat_sessions", [])
                if isinstance(artifact, dict) and artifact.get("html"):
                    # Legacy inline artifact: migrate to a workspace file.
                    artifact = self._migrate_legacy_artifact(artifact, chat_sessions)
                if isinstance(artifact, dict) and artifact.get("name"):
                    target = self.artifacts_dir / f"{self._artifact_filename(artifact['name'])}.html"
                    if target.exists():
                        html = target.read_text(encoding="utf-8")
                        artifact = {
                            "name": artifact["name"],
                            "html": html,
                            "updatedAt": int(artifact.get("updatedAt") or target.stat().st_mtime * 1000),
                        }
                    else:
                        artifact = None
                else:
                    artifact = None
                return {
                    "ok": True,
                    "artifact": artifact,
                    "artifacts": self._reconcile_artifacts(payload.get("artifacts", [])),
                    "chat_sessions": payload.get("chat_sessions", []),
                }
            except (OSError, json.JSONDecodeError) as exc:
                return {"ok": False, "message": f"Workbench state unavailable: {exc}"}

    def load_workbench_artifact(self, name):
        """Read a single artifact's full HTML by name (any artifact, not just
        the current one). Caller does not need the lock for a read, but we take
        it to keep the file read consistent with a concurrent save."""
        with self.workbench_state_lock:
            try:
                name = str(name or "").strip()
                if not name:
                    return {"ok": False, "message": "Artifact name is required"}
                target = self.artifacts_dir / f"{self._artifact_filename(name)}.html"
                if not target.exists():
                    return {"ok": False, "message": f"Artifact not found: {name}"}
                html = target.read_text(encoding="utf-8")
                return {
                    "ok": True,
                    "artifact": {
                        "name": name,
                        "html": html,
                        "updatedAt": int(target.stat().st_mtime * 1000),
                    },
                }
            except OSError as exc:
                return {"ok": False, "message": f"Artifact read failed: {exc}"}

    def save_workbench_state(self, payload):
        with self.workbench_state_lock:
            try:
                existing = self._read_workbench_state_file()
                artifact = payload.get("artifact")
                if isinstance(artifact, dict) and artifact.get("html") is not None:
                    name = str(artifact.get("name") or "New artifact")
                    html = str(artifact.get("html") or "")
                    self._write_artifact_file(name, html)
                    pointer = {
                        "name": name,
                        "updatedAt": int(artifact.get("updatedAt") or time.time() * 1000),
                    }
                    # Multi-artifact mode: every save keeps its own file. We do
                    # not delete the previous artifact's file on rename — the
                    # artifacts directory is the source of truth and
                    # _reconcile_artifacts prunes index entries whose file is
                    # gone.
                    artifact = pointer
                # Keep the "all artifacts" index in sync with the directory so
                # files created by the agent (MCP) also appear in the list.
                # Seed from the existing state.json index (the client usually
                # does not echo the list back), merged with any the client did
                # send, then reconciled against the artifacts directory.
                merged = list(existing.get("artifacts") or [])
                for entry in payload.get("artifacts") or []:
                    if isinstance(entry, dict) and entry.get("name"):
                        key = self._artifact_filename(entry["name"])
                        merged = [e for e in merged if self._artifact_filename(e.get("name")) != key]
                        merged.append(entry)
                index = self._reconcile_artifacts(merged)
                if isinstance(artifact, dict) and artifact.get("name"):
                    key = self._artifact_filename(artifact["name"])
                    index = [entry for entry in index if self._artifact_filename(entry.get("name")) != key]
                    index.insert(0, artifact)
                state = {
                    "artifact": artifact,
                    "artifacts": index,
                    "chat_sessions": payload.get("chat_sessions", []),
                }
                self._write_workbench_state_file(state)
                return {"ok": True}
            except OSError as exc:
                return {"ok": False, "message": f"Workbench state save failed: {exc}"}

    @staticmethod
    def _board_element_key(element):
        if not isinstance(element, dict):
            return None
        element_id = element.get("id")
        return str(element_id) if element_id else None

    @staticmethod
    def _board_element_updated(element):
        if not isinstance(element, dict):
            return 0
        try:
            return int(element.get("updated") or 0)
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _stamp_board_element(cls, element, floor=0, **changes):
        """Return an agent-edited copy that wins every timestamp/version merge (browser clocks may run ahead)."""
        import random

        stamped = {**element, **changes}
        stamped["updated"] = max(int(time.time() * 1000), cls._board_element_updated(element) + 1, floor)
        try:
            stamped["version"] = int(element.get("version") or 0) + 1
        except (TypeError, ValueError):
            stamped["version"] = 1
        stamped["versionNonce"] = random.randrange(2**31)
        return stamped

    @classmethod
    def _merge_board_elements(cls, server_elements, incoming_elements):
        """Merge two element lists by id; the newest ``updated`` timestamp wins.

        Excalidraw marks deletions with ``isDeleted: true`` and bumps ``updated``,
        so a deleted element naturally wins over an older live copy. This lets the
        browser and the agent (Hermes) edit the same board concurrently without
        clobbering each other's changes.
        """
        merged = {}
        for element in list(server_elements) + list(incoming_elements):
            key = cls._board_element_key(element)
            if key is None:
                continue
            existing = merged.get(key)
            if existing is None or cls._board_element_updated(element) >= cls._board_element_updated(existing):
                merged[key] = element
        return list(merged.values())

    def load_board_state(self):
        with self.board_state_lock:
            try:
                if not self.board_state_path.exists():
                    return {"ok": True, "board": None, "revision": 0}
                board = json.loads(self.board_state_path.read_text(encoding="utf-8"))
                if not isinstance(board, dict) or not isinstance(board.get("elements"), list):
                    return {"ok": False, "message": "Stored board state is invalid"}
                try:
                    revision = int(board.get("revision") or 0)
                except (TypeError, ValueError):
                    revision = 0
                return {"ok": True, "board": board, "revision": revision}
            except (OSError, json.JSONDecodeError) as exc:
                return {"ok": False, "message": f"Board state unavailable: {exc}"}

    def save_board_state(self, board, base_revision=None, merge=False):
        if not isinstance(board, dict) or not isinstance(board.get("elements"), list):
            return {"ok": False, "message": "Board must contain an elements array"}
        if len(board["elements"]) > 10000:
            return {"ok": False, "message": "Board has too many elements"}
        with self.board_state_lock:
            try:
                current = None
                if self.board_state_path.exists():
                    current = json.loads(self.board_state_path.read_text(encoding="utf-8"))
                    if not isinstance(current, dict) or not isinstance(current.get("elements"), list):
                        current = None
                current_revision = int((current or {}).get("revision") or 0) if current else 0
                if base_revision is not None and not merge:
                    try:
                        base_revision = int(base_revision)
                    except (TypeError, ValueError):
                        return {"ok": False, "message": "Invalid base_revision", "status": "conflict"}
                    if base_revision != current_revision:
                        return {
                            "ok": False,
                            "status": "conflict",
                            "message": "Board changed since you loaded it; reload and retry.",
                            "board": current,
                            "revision": current_revision,
                        }
                if merge and current is not None:
                    board = {
                        **board,
                        "elements": self._merge_board_elements(
                            current.get("elements") or [], board.get("elements") or []
                        ),
                    }
                if current is not None and {k: v for k, v in board.items() if k != "revision"} == {
                    k: v for k, v in current.items() if k != "revision"
                }:
                    return {"ok": True, "revision": current_revision}
                board = {**board, "revision": current_revision + 1}
                self.board_state_path.parent.mkdir(parents=True, exist_ok=True)
                temp_path = self.board_state_path.with_suffix(".tmp")
                temp_path.write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
                temp_path.replace(self.board_state_path)
                return {"ok": True, "revision": board["revision"]}
            except OSError as exc:
                return {"ok": False, "message": f"Board state save failed: {exc}"}

    @staticmethod
    def board_element_defaults(element):
        """Fill fields Excalidraw reads unconditionally (e.g. groupIds.length) so agent elements can't crash the board."""
        import random

        element = dict(element)
        defaults = {
            "angle": 0, "strokeColor": "#7c3aed", "backgroundColor": "transparent", "fillStyle": "solid",
            "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [],
            "frameId": None, "roundness": None, "boundElements": [], "link": None, "locked": False,
            "isDeleted": False, "version": 1,
        }
        for key, value in defaults.items():
            if element.get(key) is None and value is not None or key not in element:
                element[key] = value
        element.setdefault("seed", random.randrange(2**31))
        element.setdefault("versionNonce", random.randrange(2**31))
        if element.get("type") in ("arrow", "line", "freedraw"):
            width = float(element.get("width") or 0)
            height = float(element.get("height") or 0)
            if not isinstance(element.get("points"), list) or len(element["points"]) < 2:
                element["points"] = [[0, 0], [width, height]]
            if element["type"] == "arrow":
                for key, value in (("startBinding", None), ("endBinding", None),
                                   ("startArrowhead", None), ("endArrowhead", "arrow"), ("elbowed", False)):
                    element.setdefault(key, value)
        if element.get("type") == "text":
            text = str(element.get("text") or "")
            element["text"] = text
            for key, value in (("originalText", text), ("fontSize", 20), ("fontFamily", 1),
                               ("textAlign", "left"), ("verticalAlign", "top"), ("containerId", None),
                               ("autoResize", True), ("lineHeight", 1.25)):
                if element.get(key) is None and value is not None or key not in element:
                    element[key] = value
        return element

    @staticmethod
    def board_elements(command, payload):
        import random

        def new_id(prefix):
            return f"{prefix}-{uuid.uuid4().hex[:12]}"

        now = int(time.time() * 1000)
        if command == "add_arrow":
            width = float(payload.get("width", 180))
            height = float(payload.get("height", 0))
            return [DashboardState.board_element_defaults({
                "id": new_id("agent-arrow"), "type": "arrow",
                "x": float(payload.get("x", 240)), "y": float(payload.get("y", 170)),
                "width": width, "height": height, "points": [[0, 0], [width, height]],
                "text": str(payload.get("text", "")), "strokeColor": "#ff6bb5",
                "backgroundColor": "transparent", "roundness": {"type": 2},
                "seed": random.randrange(2**31), "version": 1,
                "versionNonce": random.randrange(2**31), "updated": now,
            })]
        text = str(payload.get("text", ""))
        x, y = float(payload.get("x", 120)), float(payload.get("y", 120))
        width, height = float(payload.get("width", 240)), float(payload.get("height", 100))
        element_type = payload.get("type", "rectangle")
        if element_type not in ("rectangle", "ellipse", "diamond", "text"):
            element_type = "rectangle"
        shape_id, label_id = new_id("agent-shape"), new_id("agent-label")
        base = {
            "angle": 0, "strokeColor": "#7c3aed", "backgroundColor": "#211b3d",
            "fillStyle": "solid", "strokeWidth": 2, "roughness": 1, "opacity": 100,
            "groupIds": [], "frameId": None, "index": None, "roundness": None,
            "seed": random.randrange(2**31), "version": 1,
            "versionNonce": random.randrange(2**31), "isDeleted": False,
            "boundElements": [], "updated": now, "link": None, "locked": False,
        }
        if element_type == "text":
            return [{**base, "id": shape_id, "type": "text", "x": x, "y": y,
                     "width": width, "height": height, "text": text,
                     "originalText": text, "rawText": text, "fontSize": 20,
                     "fontFamily": 1, "textAlign": "left", "verticalAlign": "top",
                     "containerId": None, "autoResize": True, "lineHeight": 1.25}]
        shape = {**base, "id": shape_id, "type": element_type, "x": x, "y": y,
                 "width": width, "height": height, "boundElements": [{"type": "text", "id": label_id}]}
        label_width = max(80, min(width - 24, len(text) * 10))
        label = {**base, "id": label_id, "type": "text", "x": x + (width - label_width) / 2,
                 "y": y + height / 2 - 12, "width": label_width, "height": 24,
                 "text": text, "originalText": text, "rawText": text, "fontSize": 20,
                 "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle",
                 "containerId": shape_id, "autoResize": True, "lineHeight": 1.25}
        return [shape, label]

    def list_recent_artifacts(self, limit=5):
        return []

    def record_event(self, event_type, message, details=None):
        event = {
            "id": str(uuid.uuid4()),
            "type": str(event_type),
            "message": str(message),
            "timestamp": time.time(),
            "details": details or {},
        }
        with self.event_lock:
            self.events.append(event)
            if len(self.events) > self.max_events:
                self.events = self.events[-self.max_events :]

    def list_events(self, limit=30):
        safe_limit = max(1, min(int(limit), 200))
        with self.event_lock:
            return list(reversed(self.events[-safe_limit:]))

    def list_chat_providers(self):
        providers = []
        for provider in CHAT_PROVIDER_CONFIG.values():
            providers.append(dict(provider))
        providers.sort(key=lambda p: (0 if p.get("default") else 1, p.get("name", "")))
        return providers

    # ------------------------------------------------------------------
    # Agent data (hermes / opencode local state)
    # ------------------------------------------------------------------

    def _agent_roots(self):
        home = Path.home()
        return {
            "hermes_root": HERMES_HOME,
            "hermes_skills_user": HERMES_HOME / "skills",
            "hermes_skills_bundled": (RuntimeManager(HERMES_HOME).runtime_path() if os.getenv("WORKBENCH_HERMES_MANAGED") == "1" else HERMES_AGENT_DIR) / "skills",
            "hermes_memories": HERMES_HOME / "memories",
            "hermes_memory": HERMES_HOME / "memory",
            "hermes_state_db": HERMES_HOME / "state.db",
            "hermes_gateway_state": HERMES_HOME / "gateway_state.json",
            "opencode_skills": [
                home / ".config" / "opencode" / "skills",
                home / ".opencode" / "skills",
            ],
            "opencode_db": home / ".local" / "share" / "opencode" / "opencode.db",
        }

    @staticmethod
    def _process_running(marker):
        """Scan /proc for a process whose cmdline contains `marker`."""
        try:
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    cmdline = (entry / "cmdline").read_bytes().replace(b"\x00", b" ")
                except (OSError, PermissionError):
                    continue
                if marker.encode() in cmdline:
                    return int(entry.name)
        except OSError:
            pass
        return None

    @staticmethod
    def _read_sqlite(path, sql, params=()):
        """Read-only sqlite query. Returns list of rows, or None if unavailable."""
        import sqlite3

        if not path.exists():
            return None
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
            try:
                cur = con.execute(sql, params)
                return cur.fetchall()
            finally:
                con.close()
        except Exception:
            return None

    @staticmethod
    def _parse_skill_file(path):
        """Extract name/description from a SKILL.md frontmatter block."""
        try:
            text = path.read_text(errors="replace")
        except OSError:
            return None
        name = path.parent.name
        description = ""
        lines = text.splitlines()
        if lines and lines[0].strip() == "---":
            for line in lines[1:]:
                if line.strip() == "---":
                    break
                if line.startswith("name:"):
                    name = line.split(":", 1)[1].strip().strip("'\"")
                elif line.startswith("description:"):
                    description = line.split(":", 1)[1].strip().strip("'\"")
        if not description:
            for line in lines:
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and not stripped.startswith("---"):
                    description = stripped[:200]
                    break
        return {"name": name, "description": description, "path": str(path)}

    _UPDATES_CACHE_TTL = 6 * 3600.0
    _UPDATES_SNAPSHOT = None  # (fetched_at, payload)

    @staticmethod
    def _semver(text):
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", str(text or ""))
        return tuple(int(part) for part in match.groups()) if match else None

    @staticmethod
    def _fetch_json(url):
        request = Request(url, headers={"Accept": "application/json", "User-Agent": WEB_FETCH_USER_AGENT})
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))

    def _component(self, current, fetch_latest):
        entry = {"current": current or None, "latest": None, "update_available": False}
        try:
            entry["latest"] = fetch_latest()
        except (URLError, HTTPError, TimeoutError, OSError, ValueError, KeyError, TypeError) as exc:
            entry["error"] = str(exc)[:200]
            return entry
        cur, new = self._semver(current), self._semver(entry["latest"])
        entry["update_available"] = bool(cur and new and new > cur)
        return entry

    def updates_status(self, force=False):
        """Compare running versions with the latest published ones (cached)."""
        if os.getenv("UPDATE_CHECK", "1").strip().lower() in {"0", "false", "no"}:
            return {"ok": True, "enabled": False}
        now = time.time()
        snapshot = DashboardState._UPDATES_SNAPSHOT
        if not force and snapshot and now - snapshot[0] < self._UPDATES_CACHE_TTL:
            return snapshot[1]

        tags_url = os.getenv("WORKBENCH_UPDATE_URL", "").strip()

        def latest_workbench():
            if not tags_url:
                raise ValueError("WORKBENCH_UPDATE_URL not set")
            names = [tag.get("name", "") for tag in self._fetch_json(tags_url)]
            versions = sorted((v, n) for n in names if (v := self._semver(n)))
            return versions[-1][1] if versions else None

        hermes_tag = None

        def latest_hermes():
            nonlocal hermes_tag
            release = self._fetch_json("https://api.github.com/repos/NousResearch/hermes-agent/releases/latest")
            hermes_tag = release.get("tag_name")
            name = release.get("name") or ""
            match = re.search(r"v(\d+\.\d+\.\d+)", name)
            return match.group(1) if match else release.get("tag_name")

        def installed_opencode():
            binary = shutil.which("opencode") or str(Path.home() / ".opencode" / "bin" / "opencode")
            try:
                proc = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15)
                return proc.stdout.strip().splitlines()[-1] if proc.returncode == 0 and proc.stdout.strip() else None
            except (OSError, subprocess.TimeoutExpired):
                return None

        hermes_version = self.agent_status()["hermes"].get("version")
        payload = {
            "ok": True,
            "enabled": True,
            "checked_at": now,
            "workbench": self._component(os.getenv("WORKBENCH_VERSION", "").strip(), latest_workbench) if tags_url else None,
            "hermes": self._component(hermes_version, latest_hermes),
            "opencode": self._component(
                installed_opencode(), lambda: self._fetch_json("https://registry.npmjs.org/opencode-ai/latest")["version"]
            ),
        }
        # Hermes and the workbench ship in the image (re-pull); OpenCode updates in place.
        payload["hermes"]["action"] = "managed" if os.getenv("WORKBENCH_HERMES_MANAGED") == "1" else "repull"
        payload["hermes"]["tag"] = hermes_tag
        if payload["workbench"]:
            payload["workbench"]["action"] = "repull"
        payload["opencode"]["action"] = "in-place"
        DashboardState._UPDATES_SNAPSHOT = (now, payload)
        return payload

    @staticmethod
    def sandbox_status():
        """Reachability and usage of the sandbox daemon for Hermes and/or Jobs."""
        agent_enabled = os.getenv("AGENT_SANDBOX", "0").strip().lower() in {"1", "true", "yes", "docker"}
        jobs_enabled = os.getenv("JOBS_SANDBOX", "0").strip().lower() in {"1", "true", "yes", "on"}
        if not agent_enabled and not jobs_enabled:
            return {"enabled": False, "agent_enabled": False, "jobs_enabled": False}
        status = {
            "enabled": True,
            "agent_enabled": agent_enabled,
            "jobs_enabled": jobs_enabled,
            "reachable": False,
            "host": os.getenv("JOBS_DOCKER_HOST", os.getenv("DOCKER_HOST", "")),
        }
        try:
            env = os.environ.copy()
            env["DOCKER_HOST"] = os.getenv("JOBS_DOCKER_HOST", os.getenv("DOCKER_HOST", ""))
            env["DOCKER_TLS_VERIFY"] = os.getenv("JOBS_DOCKER_TLS_VERIFY", os.getenv("DOCKER_TLS_VERIFY", "1"))
            env["DOCKER_CERT_PATH"] = os.getenv("JOBS_DOCKER_CERT_PATH", os.getenv("DOCKER_CERT_PATH", "/certs/client"))
            proc = subprocess.run(
                ["docker", "info", "--format", "{{json .}}"], capture_output=True, text=True, timeout=8, env=env
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            status["error"] = str(exc)[:200]
            return status
        if proc.returncode != 0:
            status["error"] = (proc.stderr.strip() or proc.stdout.strip())[:200]
            return status
        try:
            info = json.loads(proc.stdout)
        except json.JSONDecodeError:
            status["error"] = "unparseable docker info"
            return status
        status.update(
            reachable=True,
            containers=info.get("Containers"),
            running=info.get("ContainersRunning"),
            images=info.get("Images"),
            server_version=info.get("ServerVersion"),
        )
        return status

    def agent_status(self):
        roots = self._agent_roots()
        hermes = {"running": False, "pid": None, "version": None, "gateway": None, "platforms": {}}
        try:
            state = json.loads(roots["hermes_gateway_state"].read_text())
            hermes["running"] = state.get("gateway_state") == "running"
            hermes["pid"] = state.get("pid")
            hermes["version"] = state.get("code_version")
            hermes["gateway"] = state.get("gateway_state")
            hermes["platforms"] = {
                k: v.get("state") for k, v in (state.get("platforms") or {}).items()
            }
        except (OSError, json.JSONDecodeError):
            pass
        opencode_pid = self._process_running("opencode")
        return {
            "ok": True,
            "hermes": hermes,
            "opencode": {
                "running": opencode_pid is not None,
                "pid": opencode_pid,
                "db_exists": roots["opencode_db"].exists(),
            },
        }

    def gateway_api_info(self):
        """Report whether the Hermes gateway key is configured (the key itself stays server-side)."""
        values = self._hermes_env_values()
        return {
            "ok": True,
            "configured": bool(values.get("API_SERVER_KEY")),
            "chat_configured": bool(os.getenv("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()),
            "port": values.get("API_SERVER_PORT", ""),
        }

    @staticmethod
    def _hermes_env_values():
        values = {}
        try:
            for line in (HERMES_HOME / ".env").read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    name, _, value = line.partition("=")
                    values[name.strip()] = value.strip().strip('"').strip("'")
        except OSError:
            pass
        return values

    # ------------------------------------------------------------------
    # Server-side settings (provider, profiles, tools) + write-only secrets
    # ------------------------------------------------------------------

    _SECRET_FIELDS = ("apiKey", "terminalToken", "apiKeySet")
    _SECRET_NAME = re.compile(r"^(provider|profile:[A-Za-z0-9._-]{1,80}|speech:(stt|tts))$")

    def _settings_path(self):
        return HERMES_HOME / "spatial-workbench" / "settings.json"

    def speech_service_config(self, service):
        if service not in ("stt", "tts"):
            raise ValueError("Unknown speech service")
        with self.workbench_state_lock:
            data = self._read_settings()
            speech = data.get("speech") or {}
            if not isinstance(speech, dict):
                speech = {}
            secrets = data.get("secrets") or {}
            base_url = str(speech.get(f"{service}_url") or os.getenv(f"SPEECH_{service.upper()}_URL", "")).strip()
            token = secrets.get(f"speech:{service}", "")
        return base_url, token

    def get_hermes_settings(self):
        with self.workbench_state_lock:
            connection = hermes_config.connection_settings(os.environ, HERMES_HOME)
        return {"ok": True, "connection": {name: connection[name] for name in ("provider", "model", "base_url", "override_set")},
                "api_key_set": bool(connection["api_key"])}

    def save_hermes_settings(self, patch):
        if not isinstance(patch, dict) or not isinstance(patch.get("reset", False), bool):
            raise ValueError("Hermes settings must be an object with a boolean reset flag")
        connection = None if patch.get("reset") else hermes_config.validate_connection(patch)
        manager = RuntimeManager(HERMES_HOME)
        with manager.lock() if manager.supported else nullcontext(), self.workbench_state_lock:
            data = self._read_settings()
            original_data = copy.deepcopy(data)
            config = hermes_config.read_config(HERMES_HOME)
            original_config = copy.deepcopy(config)
            previous = hermes_config.connection_settings(os.environ, HERMES_HOME)
            if patch.get("reset"):
                baseline = data.pop("hermes_baseline", None)
                if baseline is not None:
                    for field in ("model", "providers"):
                        if field in baseline:
                            config[field] = baseline[field]
                        else:
                            config.pop(field, None)
                    hermes_config.save_config(HERMES_HOME, config)
                data.pop("hermes", None)
                data["secrets"] = {name: value for name, value in (data.get("secrets") or {}).items() if not name.startswith("hermes:")}
            else:
                if "hermes_baseline" not in data:
                    data["hermes_baseline"] = {field: config[field] for field in ("model", "providers") if field in config}
                data["hermes"] = connection
                scope = hermes_config.key_scope(connection["provider"], connection["base_url"])
                if scope not in (data.get("secrets") or {}) and (previous["provider"], previous["base_url"].rstrip("/")) == (connection["provider"], connection["base_url"].rstrip("/")) and previous["api_key"] is not None:
                    data.setdefault("secrets", {})[scope] = previous["api_key"]
                if "api_key" in patch:
                    data.setdefault("secrets", {})[scope] = patch["api_key"]
            try:
                self._write_settings(data)
                hermes_config.write_config(os.environ, HERMES_HOME)
            except Exception:
                self._write_settings(original_data)
                hermes_config.save_config(HERMES_HOME, original_config)
                raise
        return {**self.get_hermes_settings(), "restart_required": True}

    def change_hermes_runtime(self, patch):
        if not isinstance(patch, dict) or patch.get("confirm") is not True:
            raise ValueError("Confirm that active Hermes chats and gateway integrations may be interrupted")

        def before_restart():
            self.hermes_live.reset_sessions()
            self._HERMES_TOOLS_SNAPSHOT = None
            DashboardState._UPDATES_SNAPSHOT = None

        return RuntimeManager(HERMES_HOME).start(patch.get("action"), patch.get("version"), before_restart)

    def get_model_catalog(self, engine, refresh=False):
        if engine not in ("hermes", "opencode"):
            raise ValueError("Catalog engine must be hermes or opencode")
        with self.workbench_state_lock:
            cache = getattr(self, "_model_catalog_cache", {})
            cached = cache.get(engine)
        if not refresh and cached and time.monotonic() - cached[0] < 60:
            return cached[1]
        try:
            if engine == "opencode":
                port = int(os.getenv("OPENCODE_SERVER_PORT", "4096"))
                base = f"http://127.0.0.1:{port}"
                headers = {}
                if os.getenv("OPENCODE_SERVER_PASSWORD"):
                    import base64
                    credential = f"{os.getenv('OPENCODE_SERVER_USERNAME', 'opencode')}:{os.environ['OPENCODE_SERVER_PASSWORD']}"
                    headers["Authorization"] = "Basic " + base64.b64encode(credential.encode()).decode()
                headless = True
                try:
                    result = provider_catalog.opencode_catalog(provider_catalog.read_catalog_json(base + "/provider", headers))
                except (OSError, ValueError):
                    result = provider_catalog.opencode_cli_catalog(dict(os.environ), str(self.hermes_workdir))
                    headless = False
                result["current"] = {"provider": "", "model": ""}
                try:
                    config = provider_catalog.read_catalog_json(base + "/config", headers) if headless else {}
                    model = config.get("model")
                    if isinstance(model, str) and "/" in model:
                        provider, _, identifier = model.partition("/")
                        result["current"] = {"provider": provider, "model": identifier}
                except (OSError, ValueError):
                    result["warning"] = "Provider catalog loaded, but the running OpenCode default could not be read."
                result["auth_scope"] = "main"
            else:
                base, key = self.proxy_target("hermes")
                base = base.removesuffix("/v1")
                headers = {"Authorization": f"Bearer {key}"} if key else {}
                result = provider_catalog.hermes_catalog(provider_catalog.read_catalog_json(base + "/api/model/options" + ("?refresh=1" if refresh else ""), headers))
                result["auth_scope"] = "hermes"
            payload = {"ok": True, "engine": engine, "available": True, "stale": False, "source": f"{engine} runtime", **result}
        except (OSError, ValueError, subprocess.SubprocessError):
            message = f"The {engine} runtime provider catalog is unavailable. Manual models and custom endpoints remain available."
            payload = {**(cached[1] if cached else {"providers": [], "current": {"provider": "", "model": ""}}),
                       "ok": True, "engine": engine, "available": False, "stale": bool(cached), "warning": message}
        with self.workbench_state_lock:
            cache = getattr(self, "_model_catalog_cache", {})
            if payload["available"]:
                cache[engine] = (time.monotonic(), payload)
                self._model_catalog_cache = cache
        return payload

    def get_opencode_settings(self):
        payload = {"ok": True}
        with self.workbench_state_lock:
            for role in ("main", "worker"):
                connection = connection_settings(os.environ, HERMES_HOME, role)
                payload[role] = {"model": connection["model"], "base_url": connection["base_url"],
                                 "api_key_set": bool(connection["api_key"])}
            secrets = self._read_settings().get("secrets") or {}
            payload["key_variables"] = sorted({name.removeprefix("worker-key:") for name in secrets if name.startswith("worker-key:")}
                                              | {name for name in os.environ if re.fullmatch(r"WORKER_[A-Z0-9_]*API_KEY", name) and os.environ[name]})
        return payload

    def save_opencode_settings(self, patch):
        if not isinstance(patch, dict):
            raise ValueError("Settings must be an object")
        reset = patch.get("reset", [])
        if not isinstance(reset, list) or any(role not in ("main", "worker") for role in reset):
            raise ValueError("Reset must contain main or worker")
        reload_main = patch.get("reload_main", False)
        if not isinstance(reload_main, bool):
            raise ValueError("Reload flag must be a boolean")
        updates = {}
        for role in ("main", "worker"):
            if role not in patch:
                continue
            config = patch[role]
            if not isinstance(config, dict):
                raise ValueError("Connection settings must be an object")
            model = str(config.get("model") or "").strip()
            if not model or len(model) > 200 or any(character.isspace() for character in model):
                raise ValueError("A model identifier is required")
            base_url = validate_endpoint(config.get("base_url", ""))
            if not base_url and "/" not in model:
                raise ValueError("Hosted models must use provider/model format")
            if model.startswith("local/") and not base_url and not os.environ.get("LLM_BASE_URL", "").strip():
                raise ValueError("The local provider requires LLM_BASE_URL")
            if role == "worker" and model.startswith("local/") and not base_url:
                raise ValueError("Workers need an explicit endpoint URL for local models")
            if "api_key" in config and not isinstance(config["api_key"], str):
                raise ValueError("API key must be a string")
            updates[role] = {"model": model, "base_url": base_url}
        keys = patch.get("keys", {})
        if not isinstance(keys, dict) or any(not re.fullmatch(r"WORKER_[A-Z0-9_]*API_KEY", str(name))
                                             or not isinstance(value, str) for name, value in keys.items()):
            raise ValueError("Worker key variables must match WORKER_*API_KEY and contain string values")
        with self.workbench_state_lock:
            data = self._read_settings()
            previous_connections = {role: connection_settings(os.environ, HERMES_HOME, role) for role in updates}
            data.setdefault("opencode", {}).update(updates)
            secrets = data.setdefault("secrets", {})
            for role in reset:
                data["opencode"].pop(role, None)
                secrets.pop(f"opencode:{role}", None)
                for name in list(secrets):
                    if name.startswith(f"opencode-route:{role}:"):
                        secrets.pop(name)
            for role in updates:
                previous = previous_connections[role]
                old_scope = connection_key_scope(role, previous["model"], previous["base_url"])
                new_scope = connection_key_scope(role, updates[role]["model"], updates[role]["base_url"])
                if f"opencode:{role}" in secrets:
                    secrets[old_scope] = secrets[f"opencode:{role}"]
                if new_scope != old_scope:
                    secrets.pop(f"opencode:{role}", None)
                    if new_scope in secrets:
                        secrets[f"opencode:{role}"] = secrets[new_scope]
                if "api_key" in patch[role]:
                    secrets[f"opencode:{role}"] = patch[role]["api_key"]
                    secrets[new_scope] = patch[role]["api_key"]
            for name, value in keys.items():
                secrets[f"worker-key:{name}"] = value
            self._write_settings(data)
            if "main" in updates or "main" in reset:
                config_path, _, _ = write_opencode_config(os.environ, HERMES_HOME)
        result = self.get_opencode_settings()
        if reload_main:
            try:
                port = int(os.getenv("OPENCODE_SERVER_PORT", "4096"))
                config_path = HERMES_HOME / ".config" / "opencode" / "opencode.json"
                request = Request(f"http://127.0.0.1:{port}/global/config", data=config_path.read_bytes(),
                                  headers={"Content-Type": "application/json"}, method="PATCH")
                with urlopen(request, timeout=5) as response:
                    response.read()
                result["main_reloaded"] = True
            except (OSError, ValueError):
                result["main_reloaded"] = False
                result["warning"] = "Settings saved, but the running OpenCode server could not reload. Start a new CLI session or reload the server manually."
        return result

    def _read_settings(self):
        try:
            data = json.loads(self._settings_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _write_settings(self, data):
        path = self._settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(path)

    @classmethod
    def _strip_secrets(cls, config):
        if not isinstance(config, dict):
            return {}
        return {k: v for k, v in config.items() if k not in cls._SECRET_FIELDS}

    @staticmethod
    def _provider_key_scope(provider):
        if not isinstance(provider, dict) or provider.get("kind") != "api":
            return None
        base = str(provider.get("baseUrl") or "").strip().rstrip("/")
        if not base or base == "/hermes-gw":
            return None
        return "provider-endpoint:" + hashlib.sha256(base.encode("utf-8")).hexdigest()

    def get_settings(self):
        with self.workbench_state_lock:
            data = self._read_settings()
        secrets = data.get("secrets") or {}
        speech_overrides = data.get("speech") or {}
        if not isinstance(speech_overrides, dict):
            speech_overrides = {}
        speech = {}
        for service in ("stt", "tts"):
            speech.update({
                f"{service}_url": str(speech_overrides.get(f"{service}_url") or os.getenv(f"SPEECH_{service.upper()}_URL", "")).strip(),
                f"{service}_url_override_set": bool(speech_overrides.get(f"{service}_url")),
                f"{service}_token_set": bool(secrets.get(f"speech:{service}")),
            })
        provider = data.get("provider")
        if isinstance(provider, dict):
            provider = {**provider, "apiKeySet": bool(self._provider_key_scope(provider) and secrets.get("provider"))}
        profiles = [
            {**p, "config": {**(p.get("config") or {}), "apiKeySet": bool(secrets.get(f"profile:{p.get('id')}"))}}
            for p in (data.get("profiles") or [])
            if isinstance(p, dict)
        ]
        return {"ok": True, "provider": provider, "profiles": profiles, "tools": data.get("tools"), "speech": speech}

    def save_settings(self, patch):
        with self.workbench_state_lock:
            data = self._read_settings()
            if "provider_key" in patch:
                key = patch["provider_key"]
                if not isinstance(key, dict) or not isinstance(key.get("endpoint"), str) or not isinstance(key.get("value"), str):
                    raise ValueError("A pending API key needs its endpoint and string value")
                scope = self._provider_key_scope({"kind": "api", "baseUrl": key["endpoint"]})
                if not scope:
                    raise ValueError("Pending API keys cannot target Hermes Gateway")
                secrets = data.setdefault("secrets", {})
                if key["value"]:
                    secrets[scope] = key["value"]
                else:
                    secrets.pop(scope, None)
                if self._provider_key_scope(data.get("provider")) == scope:
                    if key["value"]:
                        secrets["provider"] = key["value"]
                    else:
                        secrets.pop("provider", None)
            if "provider" in patch:
                previous = data.get("provider")
                provider = self._strip_secrets(patch["provider"])
                previous_scope = self._provider_key_scope(previous)
                scope = self._provider_key_scope(provider)
                secrets = data.setdefault("secrets", {})
                if previous_scope != scope:
                    if previous_scope and secrets.get("provider"):
                        secrets[previous_scope] = secrets["provider"]
                    if scope and scope in secrets:
                        secrets["provider"] = secrets[scope]
                    elif scope and previous is None and secrets.get("provider"):
                        secrets[scope] = secrets["provider"]
                    else:
                        secrets.pop("provider", None)
                data["provider"] = provider
            if "profiles" in patch and isinstance(patch["profiles"], list):
                data["profiles"] = [
                    {"id": str(p.get("id", "")), "name": str(p.get("name", "")), "config": self._strip_secrets(p.get("config"))}
                    for p in patch["profiles"]
                    if isinstance(p, dict)
                ]
                live = {f"profile:{p['id']}" for p in data["profiles"]}
                secrets = data.get("secrets") or {}
                data["secrets"] = {k: v for k, v in secrets.items() if not k.startswith("profile:") or k in live}
            if "tools" in patch and isinstance(patch["tools"], list):
                data["tools"] = patch["tools"]
            if "speech" in patch:
                speech_patch = patch["speech"]
                if not isinstance(speech_patch, dict) or set(speech_patch) - {"stt_url", "tts_url"}:
                    raise ValueError("Speech settings may contain only STT/TTS URLs")
                speech = data.setdefault("speech", {})
                if not isinstance(speech, dict):
                    speech = {}
                    data["speech"] = speech
                for service in ("stt", "tts"):
                    field = f"{service}_url"
                    if field not in speech_patch:
                        continue
                    value = speech_patch[field]
                    if value is None or value == "":
                        speech.pop(field, None)
                    elif isinstance(value, str):
                        speech[field] = speech_services.validate_base_url(value)
                    else:
                        raise ValueError(f"{field} must be a URL string or null")
                if not speech:
                    data.pop("speech", None)
            self._write_settings(data)
            key_set = bool(self._provider_key_scope(data.get("provider")) and (data.get("secrets") or {}).get("provider"))
        return {"ok": True, "apiKeySet": key_set}

    def set_secret(self, name, value=None, copy_from=None, endpoint=None):
        if not self._SECRET_NAME.match(str(name or "")):
            raise ValueError("Invalid secret name")
        with self.workbench_state_lock:
            data = self._read_settings()
            if name == "provider" and endpoint is not None:
                active = str((data.get("provider") or {}).get("baseUrl") or "").rstrip("/")
                if active != str(endpoint).rstrip("/"):
                    raise ValueError("The API endpoint changed before the key could be saved")
            secrets = data.setdefault("secrets", {})
            if copy_from:
                if not self._SECRET_NAME.match(str(copy_from)):
                    raise ValueError("Invalid secret name")
                value = secrets.get(copy_from)
            if value:
                secrets[name] = str(value)
            else:
                secrets.pop(name, None)
            if name == "provider":
                scope = self._provider_key_scope(data.get("provider"))
                if scope and value:
                    secrets[scope] = str(value)
                elif scope:
                    secrets.pop(scope, None)
                elif (data.get("provider") or {}).get("baseUrl", "").rstrip("/") == "/hermes-gw":
                    secrets.pop("provider", None)
                    value = None
            self._write_settings(data)
        return {"ok": True, "set": bool(value)}

    def _hermes_job_call(self, prompt):
        # Resolved per call so a rotated gateway key is picked up without a restart.
        return HermesClient(*self.proxy_target("hermes"))(prompt)

    def proxy_target(self, target):
        """(upstream base URL, bearer key) for /api/proxy/<target>/...; keys never reach the browser."""
        if target == "hermes":
            base = os.getenv("HERMES_GATEWAY_URL", "").strip()
            values = self._hermes_env_values()
            if not base:
                base = f"http://127.0.0.1:{values.get('API_SERVER_PORT') or os.getenv('API_SERVER_PORT', '8642')}"
            return base.rstrip("/") + "/v1", values.get("API_SERVER_KEY", "")
        if target == "provider":
            with self.workbench_state_lock:
                data = self._read_settings()
            base = str((data.get("provider") or {}).get("baseUrl", "")).strip()
            if not re.match(r"^https?://[^/]+", base):
                raise ValueError("Active provider has no absolute http(s) base URL")
            return base.rstrip("/"), (data.get("secrets") or {}).get("provider", "")
        raise ValueError("Unknown proxy target")

    def remember_gateway_session_id(self, workbench_chat_id, gateway_session_id):
        """Associate the browser's stable chat id with the Hermes session from its response header."""
        chat_id = str(workbench_chat_id or "").strip()
        session_id = str(gateway_session_id or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", chat_id):
            return
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", session_id):
            return
        with self.gateway_session_lock:
            self.gateway_session_ids.pop(chat_id, None)
            self.gateway_session_ids[chat_id] = session_id
            while len(self.gateway_session_ids) > 256:
                self.gateway_session_ids.pop(next(iter(self.gateway_session_ids)))

    def gateway_session_totals(self, session_id):
        """Token totals Hermes persisted for every turn of this chat; the command agent starts at zero."""
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", str(session_id or "")):
            return ""
        try:
            base, key = self.proxy_target("hermes")
            request = Request(
                f"{re.sub(r'/v1$', '', base)}/api/sessions/{session_id}",
                headers={"Authorization": f"Bearer {key}"} if key else {},
            )
            with urlopen(request, timeout=10) as response:
                session = json.loads(response.read().decode("utf-8")).get("session") or {}
        except (HTTPError, URLError, TimeoutError, ValueError, OSError):
            return ""

        def n(field):
            try:
                return f"{int(session.get(field) or 0):,}"
            except (TypeError, ValueError):
                return "0"
        rows = [
            ("Input tokens:", n("input_tokens")),
            ("Output tokens:", n("output_tokens")),
            ("Cache read tokens:", n("cache_read_tokens")),
            ("Reasoning tokens:", n("reasoning_tokens")),
            ("API calls:", n("api_call_count")),
            ("Messages:", n("message_count")),
        ]
        cost = session.get("actual_cost_usd") or session.get("estimated_cost_usd")
        if isinstance(cost, (int, float)) and cost:
            rows.append(("Cost (USD):", f"${cost:,.4f}"))
        lines = ["Chat Totals (all turns, from Hermes session store)", "─" * 40]
        if session.get("model"):
            lines.append(f"Model: {session['model']}")
        return "\n".join(lines + [f"{label:<30}{value}" for label, value in rows])

    def gateway_session_id_for(self, workbench_chat_id):
        chat_id = str(workbench_chat_id or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", chat_id):
            return ""
        with self.gateway_session_lock:
            return self.gateway_session_ids.get(chat_id, "")

    def agent_skills(self):
        roots = self._agent_roots()
        skills = []
        seen = set()

        def collect(root, source):
            if not root.exists():
                return
            for skill_file in sorted(root.rglob("SKILL.md")):
                if "index-cache" in skill_file.parts or "node_modules" in skill_file.parts:
                    continue
                info = self._parse_skill_file(skill_file)
                if not info:
                    continue
                key = (source, info["name"])
                if key in seen:
                    continue
                seen.add(key)
                info["source"] = source
                skills.append(info)

        collect(roots["hermes_skills_user"], "hermes")
        collect(roots["hermes_skills_bundled"], "hermes-bundled")
        for root in roots["opencode_skills"]:
            collect(root, "opencode")
        skills.sort(key=lambda s: (s["source"], s["name"].lower()))
        return {"ok": True, "count": len(skills), "skills": skills}

    def agent_memory(self):
        roots = self._agent_roots()
        files = []
        candidates = [HERMES_HOME / "SOUL.md"]
        if roots["hermes_memories"].exists():
            candidates += [
                p
                for p in sorted(roots["hermes_memories"].glob("*.md"))
                if not p.name.endswith((".bak", ".lock")) and ".bak." not in p.name
            ]
        if roots["hermes_memory"].exists():
            candidates += [p for p in sorted(roots["hermes_memory"].glob("*.md"))]
        for path in candidates:
            try:
                stat = path.stat()
                content = path.read_text(errors="replace")
            except OSError:
                continue
            files.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "content": content[:6000],
                    "truncated": len(content) > 6000,
                }
            )
        return {"ok": True, "count": len(files), "files": files}

    # Hermes tool registry access --------------------------------------
    # Built-in tools are enumerated by importing the agent package's
    # model_tools module in the agent's own venv (subprocess, ~1s). MCP
    # server tools come from the schema cache Hermes writes at discovery.
    # Results are cached with a short TTL so tab loads stay fast.

    _HERMES_TOOLS_CACHE_TTL = 120.0
    _HERMES_TOOLS_SNAPSHOT = None  # (fetched_at, payload)

    def agent_tools(self):
        now = time.time()
        if self._HERMES_TOOLS_SNAPSHOT and now - self._HERMES_TOOLS_SNAPSHOT[0] < self._HERMES_TOOLS_CACHE_TTL:
            return self._HERMES_TOOLS_SNAPSHOT[1]

        roots = self._agent_roots()
        managed = os.getenv("WORKBENCH_HERMES_MANAGED") == "1"
        agent_dir = RuntimeManager(HERMES_HOME).runtime_path() if managed else HERMES_AGENT_DIR
        venv_python = agent_dir / ".venv/bin/python" if managed else Path(os.getenv("HERMES_PYTHON", "").strip() or str(agent_dir / "venv" / "bin" / "python"))

        builtin = []
        if venv_python.exists():
            script = (
                "import json, sys\n"
                "sys.path.insert(0, '.')\n"
                "from model_tools import get_tool_definitions, get_toolset_for_tool\n"
                "tools = get_tool_definitions(quiet_mode=True, skip_tool_search_assembly=True)\n"
                "out = [{\n"
                "  'name': t['function']['name'],\n"
                "  'description': t['function'].get('description', ''),\n"
                "  'toolset': get_toolset_for_tool(t['function']['name']) or 'unknown',\n"
                "  'parameters': t['function'].get('parameters', {}),\n"
                "} for t in tools]\n"
                "print(json.dumps(out))\n"
            )
            try:
                proc = subprocess.run(
                    [str(venv_python), "-c", script],
                    cwd=str(agent_dir),
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if proc.returncode == 0:
                    builtin = json.loads(proc.stdout.strip().splitlines()[-1])
                else:
                    print(f"[agent-tools] builtin enumeration failed: {proc.stderr.strip()[:300]}", file=sys.stderr)
            except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as exc:
                print(f"[agent-tools] builtin enumeration error: {exc}", file=sys.stderr)

        mcp_tools = []
        cache_path = roots["hermes_root"] / "cache" / "mcp_schema_cache.json"
        if cache_path.exists():
            try:
                cache = json.loads(cache_path.read_text(encoding="utf-8"))
                for server_name in sorted(cache):
                    entry = cache[server_name] or {}
                    for tool in entry.get("tools", []) or []:
                        name = tool.get("name")
                        if not name:
                            continue
                        mcp_tools.append(
                            {
                                "name": name,
                                "description": tool.get("description", ""),
                                "toolset": f"mcp:{server_name}",
                                "parameters": tool.get("inputSchema", {}) or {},
                            }
                        )
            except (OSError, json.JSONDecodeError) as exc:
                print(f"[agent-tools] mcp cache read error: {exc}", file=sys.stderr)

        payload = {
            "ok": True,
            "builtin_count": len(builtin),
            "mcp_count": len(mcp_tools),
            "builtin": builtin,
            "mcp": mcp_tools,
        }
        self._HERMES_TOOLS_SNAPSHOT = (now, payload)
        return payload

    def agent_sessions(self, limit=25):
        roots = self._agent_roots()
        safe_limit = max(1, min(int(limit), 100))
        sessions = []

        rows = self._read_sqlite(
            roots["hermes_state_db"],
            "SELECT id, title, source, model, message_count, started_at, last_activity_at, cwd, archived "
            "FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?",
            (safe_limit,),
        )
        if rows:
            for row in rows:
                sessions.append(
                    {
                        "source": "hermes",
                        "id": row[0],
                        "title": row[1] or "(untitled)",
                        "model": row[3],
                        "message_count": row[4],
                        "started_at": row[5],
                        "last_activity_at": row[6],
                        "cwd": row[7],
                        "archived": bool(row[8]),
                    }
                )

        rows = self._read_sqlite(
            roots["opencode_db"],
            "SELECT id, title, slug, directory, model, time_updated FROM session "
            "ORDER BY time_updated DESC LIMIT ?",
            (safe_limit,),
        )
        if rows:
            for row in rows:
                model = row[4]
                try:
                    model = json.loads(model).get("id") if model else None
                except (json.JSONDecodeError, AttributeError):
                    pass
                sessions.append(
                    {
                        "source": "opencode",
                        "id": row[0],
                        "title": row[1] or row[2] or "(untitled)",
                        "model": model,
                        "message_count": None,
                        "started_at": None,
                        "last_activity_at": row[5],
                        "cwd": row[3],
                        "archived": False,
                    }
                )

        sessions.sort(key=lambda s: s.get("last_activity_at") or 0, reverse=True)
        return {"ok": True, "count": len(sessions), "sessions": sessions[:safe_limit]}

    def agent_session_messages(self, source, session_id, limit=40):
        roots = self._agent_roots()
        safe_limit = max(1, min(int(limit), 200))
        messages = []
        if source == "hermes":
            rows = self._read_sqlite(
                roots["hermes_state_db"],
                "SELECT role, content, timestamp FROM messages "
                "WHERE session_id = ? AND role IN ('user', 'assistant') "
                "ORDER BY timestamp ASC LIMIT ?",
                (session_id, safe_limit),
            )
            if rows is None:
                return {"ok": False, "message": "Hermes state database unavailable"}
            for row in rows:
                content = (row[1] or "").strip()
                if not content:
                    continue
                messages.append(
                    {
                        "role": row[0],
                        "content": content[:2000],
                        "timestamp": row[2],
                    }
                )
        elif source == "opencode":
            rows = self._read_sqlite(
                roots["opencode_db"],
                "SELECT m.data, p.data FROM message m "
                "JOIN part p ON p.message_id = m.id "
                "WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'text' "
                "ORDER BY m.time_created ASC LIMIT ?",
                (session_id, safe_limit * 4),
            )
            if rows is None:
                return {"ok": False, "message": "OpenCode database unavailable"}
            for msg_data, part_data in rows:
                try:
                    msg = json.loads(msg_data)
                    part = json.loads(part_data)
                except json.JSONDecodeError:
                    continue
                text = (part.get("text") or "").strip()
                if not text:
                    continue
                messages.append(
                    {
                        "role": msg.get("role", "assistant"),
                        "content": text[:2000],
                        "timestamp": msg.get("time"),
                    }
                )
        else:
            return {"ok": False, "message": "Unknown session source"}
        return {"ok": True, "count": len(messages), "messages": messages[-safe_limit:]}

    def agent_session_delete(self, source, session_id):
        """Delete a session (and its messages) from the Hermes/OpenCode state DB."""
        import sqlite3

        roots = self._agent_roots()
        if source == "hermes":
            db = roots["hermes_state_db"]
            statements = [
                ("DELETE FROM messages WHERE session_id = ?", (session_id,)),
                ("DELETE FROM sessions WHERE id = ?", (session_id,)),
            ]
        elif source == "opencode":
            db = roots["opencode_db"]
            statements = [
                ("DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)", (session_id,)),
                ("DELETE FROM message WHERE session_id = ?", (session_id,)),
                ("DELETE FROM session WHERE id = ?", (session_id,)),
            ]
        else:
            return {"ok": False, "message": "Unknown session source"}
        if not db.exists():
            return {"ok": False, "message": f"{source} state database not found"}
        try:
            con = sqlite3.connect(str(db), timeout=5)
            try:
                for sql, params in statements:
                    con.execute(sql, params)
                con.commit()
            finally:
                con.close()
        except sqlite3.Error as exc:
            return {"ok": False, "message": f"Delete failed: {exc}"}
        return {"ok": True}

    def _resolve_wiki_path(self, rel_path, must_exist=False):
        rel = str(rel_path or "").strip()
        rel = rel.lstrip("/")
        candidate = (self.wiki_root / rel).resolve()
        try:
            candidate.relative_to(self.wiki_root)
        except ValueError as exc:
            raise ValueError("Path escapes wiki root") from exc
        if must_exist and not candidate.exists():
            raise FileNotFoundError("Path not found")
        return candidate

    def _is_text_wiki_file(self, path: Path):
        return path.suffix.lower() in {".md", ".markdown", ".txt"}

    def list_wiki(self, path=""):
        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            raise FileNotFoundError("Wiki root is not available")
        target = self._resolve_wiki_path(path or "", must_exist=True)
        if not target.is_dir():
            raise ValueError("Requested path is not a directory")

        dirs = []
        files = []
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith("."):
                continue
            rel = str(child.relative_to(self.wiki_root))
            entry = {
                "name": child.name,
                "path": rel,
                "is_dir": child.is_dir(),
            }
            try:
                stat = child.stat()
                entry["modified_ts"] = stat.st_mtime
                entry["size_bytes"] = stat.st_size
            except OSError:
                pass
            if child.is_dir():
                dirs.append(entry)
            else:
                # Show every file (not just text) so uploaded attachments are
                # visible in the browser. The read route stays text-only.
                files.append(entry)

        return {
            "root": str(self.wiki_root),
            "path": str(target.relative_to(self.wiki_root)) if target != self.wiki_root else "",
            "items": dirs + files,
        }

    def read_wiki_file(self, path):
        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            raise FileNotFoundError("Wiki root is not available")
        target = self._resolve_wiki_path(path, must_exist=True)
        if not target.is_file():
            raise ValueError("Requested path is not a file")
        if not self._is_text_wiki_file(target):
            raise ValueError("Only markdown or text files are supported")

        content = target.read_text(encoding="utf-8")
        stat = target.stat()
        return {
            "path": str(target.relative_to(self.wiki_root)),
            "content": content,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def fetch_web_page(self, url):
        """Fetch a public web page for the agent's web_fetch tool.

        Runs server-side so the browser never needs CORS. Returns
        {ok, url, status, content_type, truncated, content} or raises
        ValueError with a user-readable reason.
        """
        parsed = urlparse(str(url or "").strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Only http(s) URLs with a host are supported")
        request = Request(
            str(url).strip(),
            headers={"User-Agent": WEB_FETCH_USER_AGENT, "Accept": "text/html,application/json,text/plain,*/*"},
        )
        try:
            with urlopen(request, timeout=WEB_FETCH_TIMEOUT_SECONDS) as response:
                status = getattr(response, "status", 200)
                content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                body = response.read(WEB_FETCH_MAX_BYTES + 1)
        except HTTPError as exc:
            raise ValueError(f"HTTP {exc.code} {exc.reason}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise ValueError(f"Fetch failed: {reason}") from exc

        truncated = len(body) > WEB_FETCH_MAX_BYTES
        if truncated:
            body = body[:WEB_FETCH_MAX_BYTES]

        if content_type.startswith("text/html") or content_type == "" or body.lstrip()[:1] == b"<":
            content = _strip_html(body.decode("utf-8", errors="replace"))
        elif content_type == "application/json" or content_type.startswith("text/"):
            try:
                content = body.decode("utf-8", errors="replace")
            except (UnicodeDecodeError, ValueError):
                content = body.decode("latin-1", errors="replace")
        else:
            raise ValueError(f"Unsupported content type: {content_type or 'unknown'}")

        if len(content) > WEB_FETCH_MAX_OUTPUT_CHARS:
            content = content[:WEB_FETCH_MAX_OUTPUT_CHARS]
            truncated = True

        return {
            "url": str(url).strip(),
            "status": status,
            "content_type": content_type or "unknown",
            "truncated": truncated,
            "content": content,
        }

    def model_context(self):
        """Probe the local llama.cpp server for the model's context length.

        Reads ``default_generation_settings.n_ctx`` from the server's
        ``/props`` endpoint (the authoritative value the server actually
        runs with). Falls back to a conservative default when the probe
        fails so the frontend always has a usable budget.
        """
        props_url = os.getenv("LLAMA_PROPS_URL", "").strip()
        if not props_url and os.getenv("LLM_BASE_URL", "").strip():
            base = os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
            props_url = re.sub(r"/v1$", "", base) + "/props"
        if not props_url:
            return {
                "ok": True,
                "context_length": DEFAULT_MODEL_CONTEXT,
                "source": "default (no LLAMA_PROPS_URL / LLM_BASE_URL)",
                "model": "",
            }
        try:
            request = Request(props_url, headers={"Accept": "application/json"})
            with urlopen(request, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            n_ctx = (
                payload.get("default_generation_settings", {}).get("n_ctx")
                or payload.get("n_ctx")
            )
            if isinstance(n_ctx, int) and n_ctx > 0:
                return {
                    "ok": True,
                    "context_length": n_ctx,
                    "source": "llama.cpp /props",
                    "model": payload.get("model", ""),
                }
            return {
                "ok": True,
                "context_length": DEFAULT_MODEL_CONTEXT,
                "source": "default (probe returned no n_ctx)",
                "model": "",
            }
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            reason = getattr(exc, "reason", exc)
            return {
                "ok": True,
                "context_length": DEFAULT_MODEL_CONTEXT,
                "source": f"default (probe failed: {reason})",
                "model": "",
            }

    def _append_wiki_log(self, action, rel_path, detail=""):
        log_file = self.wiki_root / "log.md"
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"- {timestamp} | {action} | {rel_path}"
        if detail:
            line += f" | {detail}"
        line += "\n"
        try:
            with log_file.open("a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass

    def write_wiki_file(self, path, content):
        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            raise FileNotFoundError("Wiki root is not available")

        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing wiki file path")
        target = self._resolve_wiki_path(rel, must_exist=False)
        if target.exists() and target.is_dir():
            raise ValueError("Cannot write to a directory path")
        if not self._is_text_wiki_file(target):
            raise ValueError("Only markdown or text files are supported")

        target.parent.mkdir(parents=True, exist_ok=True)
        now_token = time.strftime("%Y%m%d_%H%M%S")
        rel_for_log = str(target.relative_to(self.wiki_root))

        if target.exists() and target.is_file():
            backup_name = re.sub(r"[^a-zA-Z0-9._-]", "_", rel_for_log) + f".{now_token}.bak"
            backup_path = self.wiki_backup_dir / backup_name
            try:
                shutil.copy2(target, backup_path)
            except OSError:
                pass

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(target.parent)) as tmp:
            tmp.write(str(content))
            tmp_path = Path(tmp.name)

        try:
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        self._append_wiki_log("update", rel_for_log, "dashboard write")
        self.record_event("wiki_write", "Wiki file updated", {"path": rel_for_log})
        stat = target.stat()
        return {
            "path": rel_for_log,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def upload_wiki_file(self, path, content_base64):
        """Write an arbitrary (binary-safe) file into the wiki root.

        Unlike write_wiki_file this accepts any file type and raw bytes, so
        users can attach images/PDFs/etc. to the wiki without going through
        the agent. The same containment rules apply.
        """
        import base64
        import binascii

        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            raise FileNotFoundError("Wiki root is not available")

        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing wiki file path")
        target = self._resolve_wiki_path(rel, must_exist=False)
        if target.exists() and target.is_dir():
            raise ValueError("Cannot upload to a directory path")

        try:
            data = base64.b64decode(str(content_base64 or ""), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid base64 content") from exc
        if len(data) > UPLOAD_MAX_BYTES:
            raise ValueError(f"Upload exceeds {UPLOAD_MAX_BYTES // (1024 * 1024)} MB")

        target.parent.mkdir(parents=True, exist_ok=True)
        rel_for_log = str(target.relative_to(self.wiki_root))

        if target.exists() and target.is_file():
            backup_name = re.sub(r"[^a-zA-Z0-9._-]", "_", rel_for_log) + f".{time.strftime('%Y%m%d_%H%M%S')}.bak"
            backup_path = self.wiki_backup_dir / backup_name
            try:
                shutil.copy2(target, backup_path)
            except OSError:
                pass

        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(target.parent)) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        try:
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        self._append_wiki_log("upload", rel_for_log, "dashboard upload")
        self.record_event("wiki_upload", "Wiki file uploaded", {"path": rel_for_log, "size": len(data)})
        stat = target.stat()
        return {
            "path": rel_for_log,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def search_wiki(self, query, limit=25):
        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            raise FileNotFoundError("Wiki root is not available")
        needle = str(query or "").strip().lower()
        if not needle:
            return []
        safe_limit = max(1, min(int(limit), 100))
        results = []
        for path in self.wiki_root.rglob("*"):
            if len(results) >= safe_limit:
                break
            if not path.is_file() or path.name.startswith("."):
                continue
            if not self._is_text_wiki_file(path):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            lowered = text.lower()
            idx = lowered.find(needle)
            if idx == -1:
                continue
            start = max(0, idx - 100)
            end = min(len(text), idx + len(needle) + 100)
            snippet = text[start:end].replace("\n", " ").strip()
            results.append(
                {
                    "path": str(path.relative_to(self.wiki_root)),
                    "snippet": snippet,
                }
            )
        return results

    def resolve_wiki_link(self, target, from_path=""):
        """Resolve an Obsidian-style [[wikilink]] target to a wiki file path.

        The wiki is plain markdown, but pages cross-reference each other with
        [[wikilinks]]. This maps a link target (e.g. "hermes-agent",
        "entities/hermes-agent", "hermes-agent#Some Heading") to the relative
        path of the matching .md file so the dashboard viewer can make links
        clickable without any Obsidian tooling.

        Resolution order:
        1. Exact relative path (with or without .md) from the wiki root.
        2. Same directory as the linking file (Obsidian "shortest path" rule).
        3. Case-insensitive filename match anywhere in the wiki (first match,
           sorted for determinism).

        Returns {"ok": True, "path": rel_path} or {"ok": False, "message": ...}.
        """
        if not self.wiki_root.exists() or not self.wiki_root.is_dir():
            return {"ok": False, "message": "Wiki root is not available"}

        raw = str(target or "").strip()
        if not raw:
            return {"ok": False, "message": "Empty wikilink target"}
        # Strip heading anchors ([[page#Heading]] -> page) and aliases ([[page|alias]] -> page).
        raw = raw.split("#", 1)[0].split("|", 1)[0].strip()
        if not raw:
            return {"ok": False, "message": "Empty wikilink target"}

        def is_md_file(path: Path) -> bool:
            return path.is_file() and path.suffix.lower() in {".md", ".markdown"}

        # 1. Exact relative path from the wiki root.
        for candidate in (raw, f"{raw}.md"):
            try:
                resolved = self._resolve_wiki_path(candidate, must_exist=True)
            except (ValueError, FileNotFoundError):
                continue
            if is_md_file(resolved):
                return {"ok": True, "path": str(resolved.relative_to(self.wiki_root))}

        # 2. Same directory as the linking file.
        if from_path:
            try:
                source = self._resolve_wiki_path(from_path, must_exist=True)
                if source.is_file():
                    for candidate in (raw, f"{raw}.md"):
                        sibling = (source.parent / candidate).resolve()
                        try:
                            sibling.relative_to(self.wiki_root)
                        except ValueError:
                            continue
                        if is_md_file(sibling):
                            return {"ok": True, "path": str(sibling.relative_to(self.wiki_root))}
            except (ValueError, FileNotFoundError):
                pass

        # 3. Case-insensitive filename match anywhere in the wiki.
        wanted = Path(raw).stem.lower()
        matches = []
        for path in self.wiki_root.rglob("*"):
            if not is_md_file(path) or path.name.startswith("."):
                continue
            if path.stem.lower() == wanted:
                matches.append(path)
        if matches:
            matches.sort(key=lambda p: str(p.relative_to(self.wiki_root)).lower())
            return {"ok": True, "path": str(matches[0].relative_to(self.wiki_root))}

        return {"ok": False, "message": f"No wiki page matches '{raw}'"}

    def _resolve_workspace_path(self, rel_path, must_exist=False):
        raw = str(rel_path or "").strip()
        if raw.startswith("/"):
            candidate = Path(raw).resolve()
        else:
            candidate = (self.workspace_root / raw).resolve()
        # Allowed roots: the workspace root plus the agent state roots
        # (skills/memory live under ~/.hermes, opencode skill dirs).
        for root in [self.workspace_root, *self.workspace_extra_roots]:
            try:
                candidate.relative_to(root)
                break
            except ValueError:
                continue
        else:
            raise ValueError("Path escapes workspace root")
        if must_exist and not candidate.exists():
            raise FileNotFoundError("Path not found")
        return candidate

    def _display_path(self, target: Path) -> str:
        # Under the workspace root: relative (existing Project-tab behavior).
        try:
            rel = target.relative_to(self.workspace_root)
            return "" if rel == Path(".") else str(rel)
        except ValueError:
            pass
        # Under an extra root (skills/memory): return the ABSOLUTE path so it
        # round-trips — the frontend stores this and sends it back, and an
        # absolute path re-resolves under the same extra root.
        return str(target)

    def _is_workspace_text_file(self, path: Path):
        return path.suffix.lower() in {
            ".c", ".cc", ".cpp", ".css", ".go", ".html", ".htm", ".java", ".js", ".json",
            ".jsx", ".md", ".markdown", ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
            ".txt", ".yaml", ".yml",
        }

    def list_workspace(self, path=""):
        target = self._resolve_workspace_path(path or "", must_exist=True)
        if not target.is_dir():
            raise ValueError("Requested path is not a directory")

        dirs = []
        files = []
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            entry = {
                "name": child.name,
                "path": self._display_path(child),
                "is_dir": child.is_dir(),
            }
            try:
                stat = child.stat()
                entry["modified_ts"] = stat.st_mtime
                entry["size_bytes"] = stat.st_size
            except OSError:
                pass
            if child.is_dir():
                dirs.append(entry)
            elif child.is_file():
                files.append(entry)

        return {
            "root": str(self.workspace_root),
            "path": self._display_path(target),
            "items": dirs + files,
        }

    def read_workspace_file(self, path):
        target = self._resolve_workspace_path(path, must_exist=True)
        if not target.is_file():
            raise ValueError("Requested path is not a file")
        if not self._is_workspace_text_file(target):
            raise ValueError("Only text and code files are supported")
        stat = target.stat()
        if stat.st_size > WORKSPACE_MAX_FILE_BYTES:
            raise ValueError(f"Workspace file exceeds max read size ({WORKSPACE_MAX_FILE_BYTES // 1024} KB)")
        with target.open("rb") as handle:
            head = handle.read(8192)
        if b"\x00" in head:
            raise ValueError("Binary files are not supported")

        content = target.read_text(encoding="utf-8", errors="replace")
        return {
            "path": self._display_path(target),
            "content": content,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def workspace_file_status(self, path):
        target = self._resolve_workspace_path(path, must_exist=True)
        if not target.is_file():
            raise ValueError("Requested path is not a file")
        stat = target.stat()
        return {
            "path": self._display_path(target),
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def write_workspace_file(self, path, content, expected_modified_ts=None, expected_size_bytes=None, force=False):
        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing workspace file path")

        target = self._resolve_workspace_path(rel, must_exist=True)
        if not target.is_file():
            raise ValueError("Requested path is not a file")

        encoded = str(content).encode("utf-8")
        if len(encoded) > WORKSPACE_MAX_FILE_BYTES:
            raise ValueError(f"Workspace file exceeds max write size ({WORKSPACE_MAX_FILE_BYTES // 1024} KB)")

        stat = target.stat()
        rel_for_log = self._display_path(target)
        current_status = {
            "path": rel_for_log,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

        if not force:
            expected_ts = _try_float(expected_modified_ts)
            expected_size = _try_int(expected_size_bytes)
            if expected_ts is None or expected_size is None:
                error = RuntimeError("Workspace write conflict: missing expected file metadata")
                error.current_status = current_status  # type: ignore[attr-defined]
                raise error
            if expected_ts != stat.st_mtime or expected_size != stat.st_size:
                error = RuntimeError("Workspace write conflict: file changed on disk")
                error.current_status = current_status  # type: ignore[attr-defined]
                raise error

        self.workspace_backup_dir.mkdir(parents=True, exist_ok=True)
        now_token = time.strftime("%Y%m%d_%H%M%S")
        backup_name = re.sub(r"[^a-zA-Z0-9._-]", "_", rel_for_log) + f".{now_token}.bak"
        backup_path = self.workspace_backup_dir / backup_name
        try:
            shutil.copy2(target, backup_path)
        except OSError:
            pass

        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(target.parent)) as tmp:
            tmp.write(encoded)
            tmp_path = Path(tmp.name)

        try:
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        self.record_event("workspace_write", "Workspace file updated", {"path": rel_for_log})
        stat = target.stat()
        return {
            "path": rel_for_log,
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def save_upload(self, filename, content_base64, directory=None):
        import base64
        import binascii

        name = Path(str(filename or "")).name.strip()
        name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(" .") or "upload"
        try:
            data = base64.b64decode(str(content_base64 or ""), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid base64 content") from exc
        if len(data) > UPLOAD_MAX_BYTES:
            raise ValueError(f"Upload exceeds {UPLOAD_MAX_BYTES // (1024 * 1024)} MB")

        if directory is None:
            upload_dir = self.workspace_root / "uploads"
            upload_dir.mkdir(parents=True, exist_ok=True)
            target = upload_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}-{name}"
        else:
            name = str(filename or "").strip()
            if not name or name in {".", ".."} or "/" in name or "\\" in name or "\x00" in name:
                raise ValueError("Invalid import filename")
            upload_dir = self._resolve_workspace_path(directory, must_exist=True)
            if not upload_dir.is_dir():
                raise ValueError("Import destination is not a directory")
            target = upload_dir / name
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(upload_dir)) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        try:
            if directory is None:
                os.replace(tmp_path, target)
            else:
                os.link(tmp_path, target)
        except FileExistsError as exc:
            raise ValueError("File already exists; import will not overwrite it") from exc
        finally:
            tmp_path.unlink(missing_ok=True)
        self.record_event("workspace_upload", "File uploaded", {"path": str(target), "size": len(data)})
        return {"path": self._display_path(target) if directory is not None else str(target), "name": name, "size": len(data)}

    def create_workspace_file(self, path, content):
        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing workspace file path")

        target = self._resolve_workspace_path(rel, must_exist=False)
        if target.exists():
            raise ValueError("File already exists")

        encoded = str(content).encode("utf-8")
        if len(encoded) > WORKSPACE_MAX_FILE_BYTES:
            raise ValueError(f"Workspace file exceeds max write size ({WORKSPACE_MAX_FILE_BYTES // 1024} KB)")

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"Could not create parent directory: {exc}") from exc

        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(target.parent)) as tmp:
            tmp.write(encoded)
            tmp_path = Path(tmp.name)

        try:
            os.replace(tmp_path, target)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

        self.record_event("workspace_create", "Workspace file created", {"path": self._display_path(target)})
        stat = target.stat()
        return {
            "path": self._display_path(target),
            "modified_ts": stat.st_mtime,
            "size_bytes": stat.st_size,
        }

    def create_workspace_directory(self, path):
        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing workspace directory path")
        target = self._resolve_workspace_path(rel, must_exist=False)
        workspace = self.workspace_root.resolve()
        if target == workspace or not target.is_relative_to(workspace):
            raise ValueError("New directories must be inside the workspace root")
        if target.exists():
            raise ValueError("A file or directory already exists at that path")
        try:
            target.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise ValueError("A file or directory already exists at that path") from exc
        except OSError as exc:
            raise ValueError(f"Could not create workspace directory: {exc}") from exc
        self.record_event("workspace_directory_create", "Workspace directory created", {"path": self._display_path(target)})
        return {"path": self._display_path(target)}

    def _workspace_git_target(self, path):
        target = self._resolve_workspace_path(path, must_exist=True)
        workspace = self.workspace_root.resolve()
        if target == workspace or not target.is_relative_to(workspace) or not target.is_dir():
            raise ValueError("Choose a project directory inside the workspace")
        try:
            existing = subprocess.run(["git", "-C", str(target), "rev-parse", "--show-toplevel"],
                                      capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError(f"Could not inspect Git repository: {exc}") from exc
        if existing.returncode == 0:
            raise ValueError("This folder is already inside a Git repository")
        return target

    @staticmethod
    def _validate_git_branch(branch):
        branch = str(branch or "main").strip()
        if subprocess.run(["git", "check-ref-format", "--branch", branch],
                          capture_output=True, timeout=10).returncode != 0:
            raise ValueError("Base branch name is invalid")
        return branch

    def _workspace_git_inventory(self, target):
        inventory = []
        symlinks = []
        total_bytes = 0
        for current, dirs, files in os.walk(target, followlinks=False):
            current_path = Path(current)
            for name in list(dirs):
                child = current_path / name
                if name == ".git":
                    if current_path == target:
                        dirs.remove(name)
                        continue
                    raise ValueError("Nested Git metadata found; choose a single-repository folder")
                if child.is_symlink():
                    symlinks.append(str(child.relative_to(target)))
                    dirs.remove(name)
            for name in files:
                child = current_path / name
                if child.is_symlink():
                    symlinks.append(str(child.relative_to(target)))
                    continue
                stat = child.stat()
                relative = str(child.relative_to(target))
                inventory.append((relative, stat.st_size, stat.st_mtime_ns))
                total_bytes += stat.st_size
                if len(inventory) > 5000 or total_bytes > 256 * 1024 * 1024:
                    raise ValueError("Project is too large to initialize from the workspace UI (limit: 5,000 files / 256 MB)")
        if symlinks:
            raise ValueError(f"Remove symlinks before initializing Git: {', '.join(symlinks[:10])}")
        digest = hashlib.sha256(json.dumps(inventory, separators=(",", ":")).encode("utf-8")).hexdigest()
        return inventory, digest, total_bytes

    def preview_workspace_git(self, path, branch="main"):
        target = self._workspace_git_target(path)
        branch = self._validate_git_branch(branch)
        inventory, digest, total_bytes = self._workspace_git_inventory(target)
        with tempfile.TemporaryDirectory(prefix="workspace-git-preview-") as temp:
            git_dir = Path(temp) / "index.git"
            initialized = subprocess.run(["git", "init", "--bare", "--quiet", str(git_dir)],
                                         capture_output=True, text=True, timeout=10)
            if initialized.returncode != 0:
                raise ValueError(initialized.stderr.strip()[:500] or "Could not prepare Git preview")
            prefix = ["git", "-C", str(target), f"--git-dir={git_dir}", f"--work-tree={target}"]
            staged = subprocess.run([*prefix, "add", "--all"], capture_output=True, text=True, timeout=60)
            if staged.returncode != 0:
                raise ValueError(staged.stderr.strip()[:1000] or "Could not preview Git files")
            listed = subprocess.run([*prefix, "ls-files", "-z"], capture_output=True, timeout=10)
            if listed.returncode != 0:
                raise ValueError("Could not list files for Git preview")
            files = sorted(os.fsdecode(item) for item in listed.stdout.split(b"\0") if item)

        sensitive = [name for name in files if self._looks_sensitive_git_path(name)]
        inventory_names = {item[0] for item in inventory}
        return {
            "path": self._display_path(target),
            "branch": branch,
            "files": files,
            "sensitive_files": sensitive,
            "ignored_file_count": len({item[0] for item in inventory} - set(files)),
            "file_count": len(inventory),
            "size_bytes": total_bytes,
            "inventory_hash": digest,
        }

    @staticmethod
    def _looks_sensitive_git_path(path):
        name = Path(path).name.lower()
        return (name.startswith(".env") or "secret" in name or "credential" in name
                or name.endswith((".pem", ".key", ".p12", ".pfx")))

    def initialize_workspace_git(self, path, branch, inventory_hash, confirm_existing=False):
        preview = self.preview_workspace_git(path, branch)
        if not hmac.compare_digest(str(inventory_hash or ""), preview["inventory_hash"]):
            raise ValueError("Folder contents changed after preview. Review a fresh preview before initializing Git.")
        if preview["file_count"] and not confirm_existing:
            raise ValueError("Review and confirm the existing files before creating the initial Git commit")

        target = self._workspace_git_target(path)
        _, current_hash, _ = self._workspace_git_inventory(target)
        if not hmac.compare_digest(current_hash, preview["inventory_hash"]):
            raise ValueError("Folder contents changed after preview. Review a fresh preview before initializing Git.")
        branch = preview["branch"]
        initialized = subprocess.run(["git", "-C", str(target), "init", "--initial-branch", branch],
                                     capture_output=True, text=True, timeout=20)
        if initialized.returncode != 0:
            raise ValueError(initialized.stderr.strip()[:1000] or "Git repository initialization failed")
        commands = [
            ("config", "user.name", "Spatial Workbench"),
            ("config", "user.email", "spatial-workbench@localhost"),
        ]
        for args in commands:
            configured = subprocess.run(["git", "-C", str(target), *args], capture_output=True, text=True, timeout=10)
            if configured.returncode != 0:
                raise ValueError(configured.stderr.strip()[:500] or "Could not configure the repository commit identity")

        if not preview["files"]:
            starter = target / ("README.md" if not (target / "README.md").exists() else "SPATIAL_WORKBENCH.md")
            if starter.exists():
                starter = target / f"SPATIAL_WORKBENCH-{uuid.uuid4().hex[:8]}.md"
            starter.write_text(f"# {target.name}\n\nInitialized by Spatial Workbench.\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(target), "add", "--force", "--", starter.name],
                           capture_output=True, text=True, timeout=20, check=True)
        else:
            added = subprocess.run(["git", "-C", str(target), "add", "--all"],
                                   capture_output=True, text=True, timeout=60)
            if added.returncode != 0:
                raise ValueError(added.stderr.strip()[:1000] or "Could not stage the reviewed project files")

        committed = subprocess.run(["git", "-C", str(target), "commit", "-m", "chore: initialize repository"],
                                   capture_output=True, text=True, timeout=60)
        if committed.returncode != 0:
            raise ValueError(committed.stderr.strip()[:1000] or "Initial Git commit failed")
        self.record_event("workspace_git_init", "Git repository initialized", {"path": self._display_path(target), "branch": branch})
        return {"path": self._display_path(target), "branch": branch, "commit": committed.stdout.strip()}

    def delete_workspace_file(self, path, recursive=False):
        rel = str(path or "").strip()
        if not rel:
            raise ValueError("Missing workspace file path")

        source = Path(rel) if Path(rel).is_absolute() else self.workspace_root / rel
        if source.is_symlink():
            raise ValueError("Deleting symbolic links is not supported")
        target = self._resolve_workspace_path(rel, must_exist=True)
        is_directory = target.is_dir()
        if not is_directory and not target.is_file():
            raise ValueError("Requested path is not a file or directory")
        protected_roots = [self.workspace_root, *self.workspace_extra_roots, self.workspace_backup_dir]
        if any(target == root or target in root.parents for root in protected_roots):
            raise ValueError("Cannot delete workspace, agent, or backup roots")
        if self.workspace_backup_dir in target.parents:
            raise ValueError("Cannot delete recovery backups")
        if is_directory and recursive is not True:
            raise ValueError("Folder deletion requires explicit recursive confirmation")

        try:
            self.workspace_backup_dir.mkdir(parents=True, exist_ok=True)
            now_token = time.strftime("%Y%m%d_%H%M%S")
            backup_name = re.sub(r"[^a-zA-Z0-9._-]", "_", self._display_path(target))[:120] + f".{now_token}.{time.time_ns()}.del"
            backup_path = self.workspace_backup_dir / backup_name
            if is_directory:
                shutil.move(str(target), str(backup_path))
            else:
                shutil.copy2(target, backup_path)
                target.unlink()
        except (OSError, shutil.Error) as exc:
            raise ValueError(f"Could not back up and delete path: {exc}") from exc

        self.record_event("workspace_delete", "Workspace path deleted", {"path": self._display_path(target), "is_dir": is_directory})
        return {"path": self._display_path(target), "deleted": True, "is_dir": is_directory, "backup_path": str(backup_path)}

    def workspace_download_target(self, path):
        """Resolve a workspace path for download.

        Returns (target, kind) where kind is "file" or "dir". The same
        containment rules as the rest of the workspace API apply, so a
        download can never escape the workspace root or the extra roots.
        """
        target = self._resolve_workspace_path(path, must_exist=True)
        if target.is_dir():
            return target, "dir"
        if target.is_file():
            return target, "file"
        raise ValueError("Requested path is not a file or directory")

    def workspace_download_size(self, target: Path, kind: str):
        """Total size in bytes a download would transfer (zip = raw total)."""
        if kind == "file":
            return target.stat().st_size
        total = 0
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in self.workspace_ignored_dirs]
            for name in files:
                if name.startswith("."):
                    continue
                try:
                    total += (Path(root) / name).stat().st_size
                except OSError:
                    pass
        return total

    def workspace_zip_bytes(self, target: Path):
        """Zip a workspace directory, mirroring the explorer's visibility rules."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for root, dirs, files in os.walk(target):
                dirs[:] = [d for d in dirs if not d.startswith(".") and d not in self.workspace_ignored_dirs]
                for name in sorted(files):
                    if name.startswith("."):
                        continue
                    source = Path(root) / name
                    try:
                        archive.write(source, arcname=str(source.relative_to(target)))
                    except OSError:
                        continue
        return buffer.getvalue()

    def wiki_download_target(self, path):
        """Resolve a wiki path for download.

        Returns (target, kind) where kind is "file" or "dir". The same
        containment rules as the rest of the wiki API apply, so a download
        can never escape the wiki root.
        """
        target = self._resolve_wiki_path(path, must_exist=True)
        if target.is_dir():
            return target, "dir"
        if target.is_file():
            return target, "file"
        raise ValueError("Requested path is not a file or directory")

    class TerminalSession:
        def __init__(self, sid, proc, master_fd, mode):
            self.sid = sid
            self.proc = proc
            self.master_fd = master_fd
            self.mode = mode
            self.lock = threading.Lock()
            self.output = ""
            self.base_offset = 0
            self.max_chars = 400000
            self.last_active = time.time()
            self.created_at = time.time()

        def append(self, text):
            if not text:
                return
            with self.lock:
                self.output += text
                self.last_active = time.time()
                if len(self.output) > self.max_chars:
                    trim = len(self.output) - self.max_chars
                    # Trim on a newline boundary so we do not start future reads
                    # in the middle of ANSI/OSC escape sequences.
                    nl = self.output.find("\n", trim)
                    if nl != -1:
                        trim = nl + 1
                    self.output = self.output[trim:]
                    self.base_offset += trim

        def read_from(self, offset):
            with self.lock:
                if offset < self.base_offset:
                    offset = self.base_offset
                rel = offset - self.base_offset
                chunk = self.output[rel:]
                next_offset = self.base_offset + len(self.output)
                return chunk, next_offset, self.base_offset

    def _terminal_reader(self, session):
        try:
            while True:
                try:
                    data = os.read(session.master_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                session.append(data.decode("utf-8", errors="ignore"))
        finally:
            session.append("\r\n[terminal closed]\r\n")

    def _cleanup_terminals(self):
        now = time.time()
        to_remove = []
        with self.terminal_lock:
            for sid, session in self.terminal_sessions.items():
                exited = session.proc.poll() is not None
                idle = (now - session.last_active) > self.terminal_idle_ttl_seconds
                if exited or idle:
                    to_remove.append((sid, session))
            for sid, _session in to_remove:
                self.terminal_sessions.pop(sid, None)

        for _sid, session in to_remove:
            try:
                if session.proc.poll() is None:
                    os.killpg(session.proc.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                os.close(session.master_fd)
            except OSError:
                pass

    def start_terminal(self, mode="cli", cols=120, rows=32):
        self._cleanup_terminals()
        if mode == "tui":
            argv = [self.hermes_cli, "--tui"]
        else:
            argv = ["/bin/bash", "-li"]

        cwd = self.hermes_workdir if self.hermes_workdir.is_dir() else BASE_DIR

        sid = str(uuid.uuid4())
        master_fd, slave_fd = pty.openpty()
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")

        proc = subprocess.Popen(
            argv,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=str(cwd),
            env=env,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave_fd)

        session = DashboardState.TerminalSession(sid, proc, master_fd, mode)
        with self.terminal_lock:
            self.terminal_sessions[sid] = session

        thread = threading.Thread(target=self._terminal_reader, args=(session,), daemon=True)
        thread.start()
        return sid

    def get_terminal(self, sid):
        self._cleanup_terminals()
        with self.terminal_lock:
            return self.terminal_sessions.get(sid)

    def get_latest_terminal(self):
        self._cleanup_terminals()
        with self.terminal_lock:
            sessions = [s for s in self.terminal_sessions.values() if s.proc.poll() is None]
            if not sessions:
                return None
            sessions.sort(key=lambda s: s.created_at, reverse=True)
            s = sessions[0]
            return {
                "session_id": s.sid,
                "mode": s.mode,
                "running": True,
                "created_at": s.created_at,
            }

    def terminal_output(self, sid, offset):
        session = self.get_terminal(sid)
        if not session:
            return None
        chunk, next_offset, base_offset = session.read_from(offset)
        return {
            "session_id": sid,
            "data": chunk,
            "next_offset": next_offset,
            "base_offset": base_offset,
            "running": session.proc.poll() is None,
            "exit_code": session.proc.poll(),
        }

    def terminal_input(self, sid, data):
        session = self.get_terminal(sid)
        if not session:
            return False, "Terminal session not found"
        if session.proc.poll() is not None:
            return False, "Terminal session already exited"
        try:
            os.write(session.master_fd, data.encode("utf-8", errors="ignore"))
            session.last_active = time.time()
            return True, "ok"
        except OSError as exc:
            return False, str(exc)

    def terminal_resize(self, sid, cols, rows):
        session = self.get_terminal(sid)
        if not session:
            return False, "Terminal session not found"
        try:
            fcntl.ioctl(session.master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            return True, "ok"
        except OSError as exc:
            return False, str(exc)

    def terminal_close(self, sid):
        with self.terminal_lock:
            session = self.terminal_sessions.pop(sid, None)
        if not session:
            return False
        try:
            if session.proc.poll() is None:
                os.killpg(session.proc.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.close(session.master_fd)
        except OSError:
            pass
        return True

    def list_workflows(self):
        return []

    def _fetch_stats_from_http(self):
        req = Request(self.ai_node_stats_url, method="GET")
        with urlopen(req, timeout=4) as response:
            body = response.read().decode("utf-8")
        payload = json.loads(body)
        payload["source"] = "ai_node_http"
        return payload

    def _fetch_stats_from_ssh(self):
        remote_cmd = f"python3 -c {shlex.quote(REMOTE_STATS_SCRIPT)}"
        cmd = [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=4",
            self.ai_node_ssh_target,
            remote_cmd,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=7,
            check=False,
        )
        if result.returncode != 0:
            error_detail = result.stderr.strip() or result.stdout.strip() or "unknown ssh error"
            raise RuntimeError(f"SSH stats collection failed: {error_detail}")
        payload = json.loads(result.stdout.strip())
        payload["source"] = "ai_node_ssh"
        return payload

    def _glances_get(self, plugin):
        versions = [self._glances_api] if self._glances_api else ["4", "3"]
        last_error = None
        for version in versions:
            try:
                req = Request(f"{self.glances_url}/api/{version}/{plugin}", headers={"Accept": "application/json"})
                with urlopen(req, timeout=4) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                self._glances_api = version
                return payload
            except HTTPError as exc:
                last_error = exc
                if exc.code != 404:
                    break
        raise RuntimeError(f"Glances {plugin} request failed: {last_error}")

    def _fetch_stats_from_glances(self):
        """Map a remote Glances REST API (glances -w) onto the dashboard stats shape."""
        gb = 1024 ** 3
        cpu = self._glances_get("cpu")
        mem = self._glances_get("mem")
        payload = {
            "timestamp": time.time(),
            "source": "glances",
            "cpu": {"usage_percent": cpu.get("total"), "core_count": cpu.get("cpucore")},
            "memory": {
                "percentage": mem.get("percent"),
                "used_gb": round((mem.get("used") or 0) / gb, 2),
                "total_gb": round((mem.get("total") or 0) / gb, 2),
                "available_gb": round((mem.get("available") or 0) / gb, 2),
            },
            "disk": None,
            "gpu": None,
            "temperatures": {},
            "process_count": None,
        }
        mount = os.getenv("GLANCES_DISK_MOUNT", "/").strip() or "/"
        optional = {}
        for plugin in ("fs", "gpu", "sensors", "processcount"):
            try:
                optional[plugin] = self._glances_get(plugin)
            except (RuntimeError, URLError, OSError, ValueError):
                optional[plugin] = None
        disks = optional["fs"] or []
        disk = next((d for d in disks if d.get("mnt_point") == mount), disks[0] if disks else None)
        if disk:
            payload["disk"] = {
                "percentage": disk.get("percent"),
                "used_gb": round((disk.get("used") or 0) / gb, 2),
                "total_gb": round((disk.get("size") or 0) / gb, 2),
                "free_gb": round((disk.get("free") or 0) / gb, 2),
            }
        gpus = optional["gpu"] or []
        wanted = os.getenv("GLANCES_GPU_ID", "").strip()
        gpu = next((g for g in gpus if wanted and g.get("gpu_id") == wanted), None) or next(
            (g for g in gpus if str(g.get("gpu_id", "")).startswith("nvidia")), gpus[0] if gpus else None
        )
        if gpu:
            # Glances reports GPU memory as a percentage only.
            payload["gpu"] = {
                "utilization_gpu": gpu.get("proc"),
                "memory_percent": gpu.get("mem"),
                "temperature_gpu": gpu.get("temperature"),
                "name": gpu.get("name"),
            }
        # CPU package sensors first: the header's CPU temperature uses the first entry.
        cpu_labels = ("tctl", "tdie", "package id", "cpu", "core")
        sensors = [
            s for s in (optional["sensors"] or [])
            if str(s.get("unit", "")).upper() == "C" and isinstance(s.get("value"), (int, float))
        ]
        sensors.sort(key=lambda s: not str(s.get("label", "")).lower().startswith(cpu_labels))
        for sensor in sensors:
            payload["temperatures"][str(sensor.get("label"))] = sensor["value"]
        counts = optional["processcount"] or {}
        payload["process_count"] = counts.get("total")
        return payload

    def _fetch_stats_local(self):
        result = subprocess.run(
            [sys.executable, "-c", REMOTE_STATS_SCRIPT],
            capture_output=True,
            text=True,
            timeout=7,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Local stats collection failed: {result.stderr.strip() or 'unknown error'}")
        payload = json.loads(result.stdout.strip())
        payload["source"] = "local"
        return payload

    def get_stats(self):
        now = time.time()
        with self.stats_lock:
            if now - self.stats_cache_ts < self.stats_ttl_seconds:
                return self.stats_cache

            try:
                if self.stats_source == "glances":
                    data = self._fetch_stats_from_glances()
                elif self.stats_source == "http":
                    data = self._fetch_stats_from_http()
                elif self.stats_source == "ssh":
                    data = self._fetch_stats_from_ssh()
                else:
                    data = self._fetch_stats_local()
                data["status"] = "ok"
                self.stats_cache = data
            except (URLError, TimeoutError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
                self.stats_cache = {
                    "status": "error",
                    "message": str(exc),
                    "source": "ai_node_unavailable",
                    "timestamp": now,
                }
            self.stats_cache_ts = now
            return self.stats_cache

    def _create_workflow_job(self, workflow_id, prompt):
        job_id = str(uuid.uuid4())
        job = {
            "job_id": job_id,
            "workflow_id": workflow_id,
            "status": "queued",
            "message": "Queued for execution.",
            "prompt": prompt,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        with self.workflow_lock:
            self.workflow_jobs[job_id] = job
            self.workflow_jobs[workflow_id] = job
        return job

    def _update_workflow_job(self, job_id, **fields):
        with self.workflow_lock:
            job = self.workflow_jobs.get(job_id)
            if not job:
                return None
            job.update(fields)
            job["updated_at"] = time.time()
            self.workflow_jobs[job_id] = job
            self.workflow_jobs[job["workflow_id"]] = job
            return job

    def get_workflow_job(self, workflow_id=None, job_id=None):
        with self.workflow_lock:
            if job_id and job_id in self.workflow_jobs:
                return dict(self.workflow_jobs[job_id])
            if workflow_id and workflow_id in self.workflow_jobs:
                return dict(self.workflow_jobs[workflow_id])
            return None

    def trigger_workflow(self, workflow_id, payload):
        url = self.workflow_urls.get(workflow_id, "")
        if not url:
            cfg = WORKFLOW_CONFIG.get(workflow_id)
            if not cfg:
                return False, f"Workflow '{workflow_id}' not found."
            return False, f"Workflow not configured. Set {cfg['env_var']}."

        body = {
            "workflow_id": workflow_id,
            "triggered_at": time.time(),
            "source": "dashboard",
            "payload": payload,
        }
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urlopen(req, timeout=6) as response:
                response_text = response.read().decode("utf-8", errors="ignore")
                status = response.getcode()
            if status >= 400:
                return False, f"Workflow endpoint returned status {status}."
            trimmed = response_text[:200].strip()
            return True, f"Triggered successfully. Response: {trimmed or 'no body'}"
        except Exception as exc:  # pragma: no cover - network/runtime dependent
            return False, f"Failed to call workflow endpoint: {exc}"

    def request_self_restart(self, reason="manual"):
        self.record_event(
            "server_restart",
            "Dashboard server restart requested",
            {"reason": str(reason or "manual")},
        )

        def _restart():
            time.sleep(0.35)
            os.execv(sys.executable, [sys.executable] + sys.argv)

        threading.Thread(target=_restart, daemon=True).start()

class DashboardHandler(SimpleHTTPRequestHandler):
    """HTTP handler serving static content plus JSON APIs."""

    server_version = "AIDashboard/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    @property
    def state(self):
        return self.server.state  # type: ignore[attr-defined]

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw.strip() else {}

    def _handle_hermes_chat(self, action):
        """POST /api/hermes/chat/<action>: live Hermes session per Workbench chat (see hermes_live.py)."""
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > 48 * 1024 * 1024:
            self._send_json({"ok": False, "message": "Request body must be between 1 byte and 48 MB"},
                            status=413 if length > 0 else 400)
            return
        hub = self.state.hermes_live
        try:
            body = self._read_json_body()
            if not isinstance(body, dict):
                raise ValueError("Request must be a JSON object")
            chat_id = str(body.get("chat_id") or "")
            if action == "open":
                result = hub.open(chat_id)
            elif action == "prompt":
                images = body.get("images") or []
                if not isinstance(images, list):
                    raise ValueError("images must be a list of data URLs")
                result = hub.prompt(chat_id, body.get("text", ""), images)
            elif action == "command":
                result = hub.command(chat_id, body.get("command", ""))
                if result.get("type") == "output" and result.get("command", "").split(" ", 1)[0] == "/usage":
                    totals = self.state.gateway_session_totals(hub.chat(chat_id).stored_session_id)
                    if totals:
                        result["output"] = f"{result['output']}\n\n{totals}"
            elif action == "interrupt":
                result = hub.interrupt(chat_id)
            elif action == "steer":
                result = hub.steer(chat_id, body.get("text", ""))
            elif action == "respond":
                hub.respond(chat_id, body.get("request_id", ""), str(body.get("choice") or ""), bool(body.get("all")))
                result = {}
            elif action == "close":
                hub.close_chat(chat_id)
                result = {}
            else:
                self._send_json({"ok": False, "message": "Unknown Hermes chat action"}, status=404)
                return
        except json.JSONDecodeError:
            self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
            return
        except (HermesLiveError, ValueError) as exc:
            self._send_json({"ok": False, "message": str(exc)}, status=400)
            return
        except Exception:
            self._send_json({"ok": False, "message": "Hermes live session is unavailable"}, status=502)
            return
        self._send_json({"ok": True, **result})

    def _query_params(self):

        parsed = urlparse(self.path)
        raw = parse_qs(parsed.query, keep_blank_values=True)
        return {k: (v[0] if v else "") for k, v in raw.items()}

    def _send_file(self, file_path: Path, download_name: str):
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _terminal_auth_ok(self):
        # proxy mode: an upstream reverse proxy authenticates users, and this API is only reachable through it.
        if os.getenv("WORKBENCH_AUTH", "token").strip().lower() == "proxy":
            return True
        expected = self.state.terminal_api_token
        if not expected:
            return True
        supplied = self.headers.get("X-Terminal-Token", "")
        return hmac.compare_digest(supplied, expected)

    def _proxy_request(self, method):
        """Stream /api/proxy/<target>/<path> upstream, adding the server-held bearer key."""
        parsed = urlparse(self.path)
        parts = parsed.path.split("/", 4)  # ['', 'api', 'proxy', target, rest]
        target = parts[3] if len(parts) > 3 else ""
        rest = parts[4] if len(parts) > 4 else ""
        try:
            base, key = self.state.proxy_target(target)
        except ValueError as exc:
            self._send_json({"ok": False, "message": str(exc)}, status=400)
            return
        url = f"{base}/{rest}" + (f"?{parsed.query}" if parsed.query else "")
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if method == "POST" and length > 0 else None
        headers = {"Accept": self.headers.get("Accept", "*/*"), "User-Agent": WEB_FETCH_USER_AGENT}
        if body is not None:
            headers["Content-Type"] = self.headers.get("Content-Type", "application/json")
        if target == "hermes":
            session_id = self.headers.get("X-Hermes-Session-Id", "").strip()
            if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", session_id):
                headers["X-Hermes-Session-Id"] = session_id
            workbench_chat_id = self.headers.get("X-Workbench-Chat-Id", "").strip()
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", workbench_chat_id):
                workbench_chat_id = ""
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            upstream = urlopen(Request(url, data=body, method=method, headers=headers), timeout=600)
        except HTTPError as exc:
            upstream = exc
        except (URLError, TimeoutError, OSError) as exc:
            self._send_json({"ok": False, "message": f"Upstream unreachable: {exc}"}, status=502)
            return
        try:
            self.send_response(getattr(upstream, "status", None) or upstream.getcode())
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
            if target == "hermes":
                session_id = upstream.headers.get("X-Hermes-Session-Id", "").strip()
                if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", session_id):
                    self.send_header("X-Hermes-Session-Id", session_id)
                    if workbench_chat_id:
                        self.state.remember_gateway_session_id(workbench_chat_id, session_id)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            reader = getattr(upstream, "read1", upstream.read)
            while True:
                chunk = reader(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    def _jobs_get(self):
        jobs = self.state.jobs
        parts = self.path.split("?", 1)[0].strip("/").split("/")  # api, jobs, [id, subtasks, n, log]
        if len(parts) == 2:
            archived = self._query_params().get("archived") == "1"
            self._send_json({"ok": True, "jobs": jobs.list_jobs(include_archived=archived), "settings": jobs.public_settings()})
            return
        job_id = parts[2]
        if len(parts) == 3:
            job = jobs.get_job(job_id)
            self._send_json({"ok": True, "job": job} if job else {"ok": False, "message": "Job not found"}, status=200 if job else 404)
            return
        if len(parts) == 4 and parts[3] == "files":
            if not jobs.get_job(job_id):
                self._send_json({"ok": False, "message": "Job not found"}, status=404)
            else:
                self._send_json({"ok": True, "files": jobs.job_files(job_id)})
            return
        if len(parts) > 4 and parts[3] == "files":
            path = jobs.output_file(job_id, unquote("/".join(parts[4:])))
            if path is None:
                self._send_json({"ok": False, "message": "File not found"}, status=404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{re.sub(r"[^A-Za-z0-9._-]", "_", path.name)}"')
            self.end_headers()
            with path.open("rb") as output:
                shutil.copyfileobj(output, self.wfile)
            return
        if len(parts) == 4 and parts[3] == "comms":
            if not jobs.get_job(job_id):
                self._send_json({"ok": False, "message": "Job not found"}, status=404)
            else:
                self._send_json(jobs.job_comms(job_id))
            return
        if len(parts) == 6 and parts[3] == "subtasks" and parts[4].isdigit() and parts[5] == "project":
            try:
                changes = jobs.project_changes(job_id, int(parts[4]))
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=409)
                return
            self._send_json({"ok": True, "changes": changes} if changes else {"ok": False, "message": "Project worker not found"},
                            status=200 if changes else 404)
            return
        if len(parts) == 6 and parts[3] == "subtasks" and parts[5] == "log" and parts[4].isdigit():
            log = jobs.subtask_log(job_id, int(parts[4]))
            if log is None:
                self._send_json({"ok": False, "message": "Subtask not found"}, status=404)
            else:
                self._send_json({"ok": True, "log": log})
            return
        self._send_json({"ok": False, "message": "Unknown jobs route"}, status=404)

    def _jobs_subtask_stream(self, job_id, idx):
        jobs = self.state.jobs
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last_log = None
        last_status = None
        deadline = time.monotonic() + max(60, jobs.settings["job_timeout_minutes"] * 60 + 60)
        try:
            while time.monotonic() < deadline:
                job = jobs.get_job(job_id)
                if not job:
                    break
                sub = next((item for item in job["subtasks"] if item["idx"] == idx), None)
                if not sub:
                    break
                log = jobs.subtask_log(job_id, idx) or ""
                if log != last_log or sub["status"] != last_status:
                    append = last_log is not None and log.startswith(last_log)
                    payload = json.dumps({
                        "log": log[len(last_log):] if append else log,
                        "replace": not append,
                        "status": sub["status"],
                    })
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_log, last_status = log, sub["status"]
                if sub["status"] not in ("queued", "running", "waiting_input"):
                    break
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _jobs_post(self):
        jobs = self.state.jobs
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        try:
            body = self._read_json_body()
            body = body if isinstance(body, dict) else {}
            if len(parts) == 2:
                job = jobs.create(str(body.get("title") or ""), str(body.get("description") or ""),
                                  body.get("attachments"), body.get("skills"), body.get("profile_id"),
                                  body.get("project_path"), body.get("base_branch") or "",
                                  body.get("token_budget"), body.get("cost_budget"))
                self._send_json({"ok": True, "job": job}, status=201)
                return
            if (len(parts) == 6 and parts[3] == "subtasks" and parts[4].isdigit()
                    and parts[5] == "merge" and jobs.get_job(parts[2])):
                result = jobs.merge_project_worker(parts[2], int(parts[4]))
                self._send_json({"ok": True, "merge": result})
                return
            if (len(parts) == 6 and parts[3] == "subtasks" and parts[4].isdigit()
                    and parts[5] == "retry" and jobs.get_job(parts[2])):
                jobs.retry_subtask(parts[2], int(parts[4]))
                self._send_json({"ok": True, "job": jobs.get_job(parts[2])})
                return
            if len(parts) != 4 or not jobs.get_job(parts[2]):
                self._send_json({"ok": False, "message": "Job not found"}, status=404)
                return
            job_id, action = parts[2], parts[3]
            if action == "answer":
                answers = body.get("answers")
                jobs.answer(job_id, [str(a) for a in answers] if isinstance(answers, list) else [str(answers or "")])
            elif action == "approve":
                jobs.approve(job_id, body.get("plan") if isinstance(body.get("plan"), dict) else None)
            elif action == "move":
                jobs.move(job_id, str(body.get("stage") or ""), str(body.get("note") or ""))
            elif action in ("stop", "retry", "archive"):
                getattr(jobs, action)(job_id)
            elif action == "delete":
                jobs.delete(job_id)
                self._send_json({"ok": True, "deleted": job_id})
                return
            else:
                self._send_json({"ok": False, "message": "Unknown job action"}, status=404)
                return
        except json.JSONDecodeError:
            self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
            return
        except ValueError as exc:
            self._send_json({"ok": False, "message": str(exc)}, status=409)
            return
        self._send_json({"ok": True, "job": jobs.get_job(job_id)})

    def _require_terminal_auth(self):
        if self._terminal_auth_ok():
            return True
        self._send_json({"ok": False, "message": "Terminal API unauthorized"}, status=401)
        return False

    def _proxy_app_preview(self, method="GET"):
        parsed = urlparse(self.path)
        prefix = "/api/app-preview/view/"
        remainder = parsed.path[len(prefix):]
        session_id, separator, relative_path = remainder.partition("/")
        if not session_id or any(char in session_id for char in "\\\r\n"):
            self._send_json({"ok": False, "message": "Invalid preview session"}, status=404)
            return
        session = self.state.app_previews.get_session(session_id)
        if not session:
            self._send_json({"ok": False, "message": "Preview session not found"}, status=404)
            return
        if session.process.poll() is not None:
            self._send_json({"ok": False, "message": "Preview process has stopped"}, status=410)
            return

        target = "/" + relative_path if separator else "/"
        if any(ord(char) < 32 for char in target) or target.startswith("//"):
            self._send_json({"ok": False, "message": "Invalid preview path"}, status=400)
            return
        if parsed.query:
            target += "?" + parsed.query

        if method == "OPTIONS":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "null")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        try:
            request_length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            request_length = -1
        if request_length < 0 or request_length > 8 * 1024 * 1024:
            self._send_json({"ok": False, "message": "Preview request body exceeds the 8 MB limit"}, status=413)
            return
        request_body = self.rfile.read(request_length) if request_length else None

        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=15)
            request_headers = {
                "Accept": self.headers.get("Accept", "*/*"),
                "Accept-Encoding": "identity",
                "User-Agent": "spatial-workbench-preview/1.0",
            }
            for name in ("Content-Type", "Accept-Language"):
                if self.headers.get(name):
                    request_headers[name] = self.headers[name]
            connection.request(method, target, body=request_body, headers=request_headers)
            upstream = connection.getresponse()
            length = upstream.getheader("Content-Length")
            if length and int(length) > 32 * 1024 * 1024:
                upstream.close()
                self._send_json({"ok": False, "message": "Preview response exceeds the 32 MB limit"}, status=413)
                return
            body = upstream.read(32 * 1024 * 1024 + 1)
            if len(body) > 32 * 1024 * 1024:
                self._send_json({"ok": False, "message": "Preview response exceeds the 32 MB limit"}, status=413)
                return
            status = upstream.status
            content_type = upstream.getheader("Content-Type")
            location = upstream.getheader("Location")
            if location:
                parsed_location = urlparse(location)
                if parsed_location.hostname in {"127.0.0.1", "localhost"} and parsed_location.port == session.port:
                    location = prefix + session_id + (parsed_location.path or "/")
                    if parsed_location.query:
                        location += "?" + parsed_location.query
            upstream.close()
        except (OSError, http.client.HTTPException, TimeoutError, ValueError):
            self._send_json({"ok": False, "message": "Could not reach the preview process"}, status=502)
            return
        finally:
            if connection:
                connection.close()

        if content_type and "text/html" in content_type.lower():
            base_href = prefix + session_id + "/"
            base_tag = f'<base href="{base_href}">'
            html_body = body.decode("utf-8", errors="replace")
            html_body = re.sub(
                r"([\"'])/(?!/)",
                lambda match: match.group(1) + base_href,
                html_body,
            )
            html_body = re.sub(
                r"url\(([\"']?)/(?!/)",
                lambda match: "url(" + match.group(1) + base_href,
                html_body,
                flags=re.IGNORECASE,
            )
            if re.search(r"<base\b", html_body, re.IGNORECASE):
                html_body = re.sub(r"<base\b[^>]*>", base_tag, html_body, count=1, flags=re.IGNORECASE)
            elif re.search(r"<head\b[^>]*>", html_body, re.IGNORECASE):
                html_body = re.sub(r"<head\b[^>]*>", lambda match: match.group(0) + base_tag,
                                   html_body, count=1, flags=re.IGNORECASE)
            else:
                html_body = base_tag + html_body
            body = html_body.encode("utf-8")

        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        if location:
            if location.startswith("/") and not location.startswith("//"):
                location = prefix + session_id + location
            self.send_header("Location", location)
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if method != "HEAD" and status not in {204, 304}:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("GET")
            return
        if self.path.split("?", 1)[0] == "/api/app-preview/status":
            if not self._require_terminal_auth():
                return
            params = self._query_params()
            result = self.state.app_previews.status(params.get("session_id", ""))
            if result is None:
                self._send_json({"ok": False, "message": "Preview session not found"}, status=404)
                return
            result["view_url"] = f"/api/app-preview/view/{result['session_id']}/"
            self._send_json({"ok": True, **result})
            return
        if self.path.split("?", 1)[0] == "/api/app-preview/logs":
            if not self._require_terminal_auth():
                return
            params = self._query_params()
            try:
                offset = int(params.get("offset", "0"))
            except ValueError:
                offset = 0
            result = self.state.app_previews.logs(params.get("session_id", ""), offset)
            if result is None:
                self._send_json({"ok": False, "message": "Preview session not found"}, status=404)
                return
            self._send_json({"ok": True, **result})
            return
        if self.path.startswith("/api/proxy/"):
            self._proxy_request("GET")
            return
        if self.path.split("?", 1)[0] == "/api/hermes/chat/events":
            query = parse_qs(urlparse(self.path).query)
            try:
                after = int((query.get("after") or ["0"])[0] or 0)
                wait = float((query.get("wait") or ["0"])[0] or 0)
                result = self.state.hermes_live.events((query.get("chat_id") or [""])[0], after, wait)
            except (ValueError, HermesLiveError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **result})
            return
        if self.path.split("?", 1)[0] == "/api/speech/voices":
            try:
                base_url, token = self.state.speech_service_config("tts")
                self._send_json(speech_services.list_voices(base_url, token))
            except speech_services.SpeechServiceError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=exc.status)
            return
        if self.path.split("?", 1)[0] == "/api/worker-profiles":
            self._send_json({"ok": True, "profiles": self.state.jobs.list_profiles()})
            return
        if self.path.split("?", 1)[0] == "/api/model-catalog":
            query = parse_qs(urlparse(self.path).query)
            try:
                self._send_json(self.state.get_model_catalog((query.get("engine") or [""])[0], (query.get("refresh") or [""])[0] == "1"))
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
            return
        if self.path == "/api/hermes-runtime":
            try:
                self._send_json({"ok": True, **RuntimeManager(HERMES_HOME).status()})
            except (ValueError, OSError):
                self._send_json({"ok": False, "message": "Could not read Hermes runtime state"}, status=400)
            return
        if self.path == "/api/hermes-settings":
            try:
                self._send_json(self.state.get_hermes_settings())
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": "Could not read Hermes settings"}, status=400)
            return
        if self.path == "/api/opencode-settings":
            self._send_json(self.state.get_opencode_settings())
            return
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if (len(parts) == 6 and parts[:2] == ["api", "jobs"] and parts[3] == "subtasks"
                and parts[4].isdigit() and parts[5] == "stream"):
            self._jobs_subtask_stream(unquote(parts[2]), int(parts[4]))
            return
        if self.path == "/api/settings":
            self._send_json(self.state.get_settings())
            return
        if self.path.split("?", 1)[0] == "/api/jobs" or self.path.startswith("/api/jobs/"):
            self._jobs_get()
            return
        if self.path.startswith("/api/terminal/output"):
            if not self._require_terminal_auth():
                return
            params = self._query_params()
            sid = params.get("session_id", "")
            try:
                offset = int(params.get("offset", "0"))
            except ValueError:
                offset = 0
            payload = self.state.terminal_output(sid, offset)
            if payload is None:
                self._send_json({"ok": False, "message": "Terminal session not found"}, status=404)
                return
            payload["ok"] = True
            self._send_json(payload)
            return
        if self.path == "/api/terminal/active":
            if not self._require_terminal_auth():
                return
            latest = self.state.get_latest_terminal()
            if latest is None:
                self._send_json({"ok": True, "active": None})
                return
            self._send_json({"ok": True, "active": latest})
            return
        if self.path.split("?", 1)[0] == "/api/stats/source":
            self._send_json(self.state.stats_source_options())
            return
        if self.path == "/api/stats":
            self._send_json(self.state.get_stats())
            return
        if self.path == "/api/chat-providers":
            self._send_json({"ok": True, "items": self.state.list_chat_providers()})
            return
        if self.path == "/api/gateway-api":
            self._send_json(self.state.gateway_api_info())
            return
        if self.path == "/api/workbench/state":
            self._send_json(self.state.load_workbench_state())
            return
        if self.path.split("?", 1)[0] == "/api/workbench/artifact":
            name = self._query_params().get("name", "")
            self._send_json(self.state.load_workbench_artifact(name))
            return
        if self.path == "/api/board":
            self._send_json(self.state.load_board_state())
            return
        if self.path == "/api/agent/status":
            self._send_json(self.state.agent_status())
            return
        if self.path == "/api/sandbox/status":
            self._send_json({"ok": True, **self.state.sandbox_status()})
            return
        if self.path == "/api/agent/skills":
            self._send_json(self.state.agent_skills())
            return
        if self.path == "/api/agent/memory":
            self._send_json(self.state.agent_memory())
            return
        if self.path == "/api/agent/tools":
            self._send_json(self.state.agent_tools())
            return
        if self.path == "/api/model/context":
            self._send_json(self.state.model_context())
            return
        if self.path.split("?", 1)[0] == "/api/free-models":
            force = self._query_params().get("refresh", "") in {"1", "true"}
            self._send_json(free_model_tracker.get(force=force))
            return
        if self.path.startswith("/api/updates"):
            force = self._query_params().get("refresh", "") in {"1", "true"}
            self._send_json(self.state.updates_status(force=force))
            return
        if self.path.startswith("/api/agent/sessions"):
            params = self._query_params()
            try:
                limit = int(params.get("limit", "25"))
            except ValueError:
                limit = 25
            self._send_json(self.state.agent_sessions(limit=limit))
            return
        if self.path.startswith("/api/agent/session/messages"):
            params = self._query_params()
            source = params.get("source", "")
            session_id = params.get("session_id", "")
            try:
                limit = int(params.get("limit", "40"))
            except ValueError:
                limit = 40
            if not source or not session_id:
                self._send_json({"ok": False, "message": "source and session_id are required"}, status=400)
                return
            self._send_json(self.state.agent_session_messages(source, session_id, limit=limit))
            return
        if self.path.startswith("/api/events/recent"):
            params = self._query_params()
            try:
                limit = int(params.get("limit", "30"))
            except ValueError:
                limit = 30
            self._send_json({"ok": True, "items": self.state.list_events(limit=limit)})
            return
        if self.path.startswith("/api/wiki/list"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                payload = self.state.list_wiki(rel_path)
            except (FileNotFoundError, ValueError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/wiki/read"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                payload = self.state.read_wiki_file(rel_path)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/wiki/search"):
            params = self._query_params()
            q = params.get("q", "")
            try:
                limit = int(params.get("limit", "25"))
            except ValueError:
                limit = 25
            try:
                items = self.state.search_wiki(q, limit=limit)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            self._send_json({"ok": True, "query": q, "items": items})
            return
        if self.path.startswith("/api/wiki/resolve-link"):
            params = self._query_params()
            target = params.get("target", "")
            from_path = params.get("from", "")
            payload = self.state.resolve_wiki_link(target, from_path=from_path)
            if not payload.get("ok"):
                self._send_json(payload, status=404)
                return
            self._send_json(payload)
            return
        if self.path.startswith("/api/wiki/download"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                target, kind = self.state.wiki_download_target(rel_path)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            try:
                if kind == "file":
                    data = target.read_bytes()
                    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    download_name = target.name
                else:
                    if self.state.workspace_download_size(target, "dir") > WORKSPACE_DOWNLOAD_MAX_BYTES:
                        self._send_json(
                            {"ok": False, "message": f"Folder exceeds max download size ({WORKSPACE_DOWNLOAD_MAX_BYTES // (1024 * 1024)} MB)"},
                            status=413,
                        )
                        return
                    data = self.state.workspace_zip_bytes(target)
                    content_type = "application/zip"
                    download_name = f"{target.name}.zip"
            except OSError as exc:
                self._send_json({"ok": False, "message": f"Download failed: {exc}"}, status=500)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.state.record_event(
                "wiki_download",
                "Wiki download served",
                {"path": str(target.relative_to(self.state.wiki_root)), "kind": kind, "size": len(data)},
            )
            return
        if self.path.startswith("/api/web/fetch"):
            params = self._query_params()
            url = params.get("url", "").strip()
            if not url:
                self._send_json({"ok": False, "message": "url query parameter is required"}, status=400)
                return
            try:
                payload = self.state.fetch_web_page(url)
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/workspace/list"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                payload = self.state.list_workspace(rel_path)
            except (FileNotFoundError, ValueError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/workspace/read"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                payload = self.state.read_workspace_file(rel_path)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/workspace/status"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                payload = self.state.workspace_file_status(rel_path)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return
        if self.path.startswith("/api/workspace/download"):
            params = self._query_params()
            rel_path = params.get("path", "")
            try:
                target, kind = self.state.workspace_download_target(rel_path)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            try:
                if kind == "file":
                    data = target.read_bytes()
                    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    download_name = target.name
                else:
                    if self.state.workspace_download_size(target, "dir") > WORKSPACE_DOWNLOAD_MAX_BYTES:
                        self._send_json(
                            {"ok": False, "message": f"Folder exceeds max download size ({WORKSPACE_DOWNLOAD_MAX_BYTES // (1024 * 1024)} MB)"},
                            status=413,
                        )
                        return
                    data = self.state.workspace_zip_bytes(target)
                    content_type = "application/zip"
                    download_name = f"{target.name}.zip"
            except OSError as exc:
                self._send_json({"ok": False, "message": f"Download failed: {exc}"}, status=500)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.state.record_event(
                "workspace_download",
                "Workspace download served",
                {"path": self.state._display_path(target), "kind": kind, "size": len(data)},
            )
            return
        if self.path == "/api/workflows":
            self._send_json({"items": self.state.list_workflows()})
            return
        if self.path.startswith("/api/workflows/status"):
            params = self._query_params()
            workflow_id = params.get("workflow_id", "").strip()
            job_id = params.get("job_id", "").strip()
            job = self.state.get_workflow_job(workflow_id=workflow_id or None, job_id=job_id or None)
            if job is None:
                self._send_json({"ok": False, "message": "Workflow job not found"}, status=404)
                return
            if job.get("job_id"):
                job["download_url"] = f"/api/workflows/download?job_id={job['job_id']}"
            self._send_json({"ok": True, "job": job})
            return
        if self.path.startswith("/api/workflows/artifacts"):
            self._send_json({"ok": True, "items": []})
            return
        if urlparse(self.path).path == "/api/workflows/download":
            self._send_json({"ok": False, "message": "Workflow artifact downloads are retired"}, status=410)
            return
        if urlparse(self.path).path == "/api/workflows/download-artifact":
            self._send_json({"ok": False, "message": "Workflow artifact downloads are retired"}, status=410)
            return
        if self.path == "/api/config":
            self._send_json(
                {
                    "ai_node_ssh_target": self.state.ai_node_ssh_target,
                    "ai_node_stats_url": self.state.ai_node_stats_url,
                    "terminal_auth_required": bool(self.state.terminal_api_token)
                    and os.getenv("WORKBENCH_AUTH", "token").strip().lower() != "proxy",
                    "wiki_root": str(self.state.wiki_root),
                    "workspace_root": str(self.state.workspace_root),
                    "hermes_home": str(HERMES_HOME),
                    "stats_source": self.state.stats_source,
                    "stats_label": self.state._stats_source_label(),
                }
            )
            return
        if self.path == "/":
            self._send_json({
                "ok": True,
                "service": "spatial-workbench-companion-api",
                "workbench": "http://127.0.0.1:1420/",
            })
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("HEAD")
            return
        super().do_HEAD()

    def do_OPTIONS(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("OPTIONS")
            return
        self.send_error(501, "Unsupported method")

    def do_PUT(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("PUT")
            return
        self.send_error(501, "Unsupported method")

    def do_PATCH(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("PATCH")
            return
        self.send_error(501, "Unsupported method")

    def do_DELETE(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("DELETE")
            return
        self.send_error(501, "Unsupported method")

    def do_POST(self):
        if self.path.split("?", 1)[0].startswith("/api/app-preview/view/"):
            self._proxy_app_preview("POST")
            return
        if self.path.startswith("/api/proxy/"):
            self._proxy_request("POST")
            return
        clean_path = self.path.split("?", 1)[0]
        if clean_path.startswith("/api/hermes/chat/"):
            self._handle_hermes_chat(clean_path.rsplit("/", 1)[-1])
            return
        if clean_path == "/api/speech/transcriptions":
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError:
                self._send_json({"ok": False, "message": "Invalid audio request size"}, status=400)
                return
            if length <= 0:
                self._send_json({"ok": False, "message": "No microphone audio was received"}, status=400)
                return
            if length > speech_services.MAX_SPEECH_UPLOAD_BYTES:
                self._send_json({"ok": False, "message": "Audio exceeds the 8 MB upload limit"}, status=413)
                return
            try:
                audio = self.rfile.read(length)
                if len(audio) != length:
                    self._send_json({"ok": False, "message": "Audio upload was incomplete"}, status=400)
                    return
                base_url, token = self.state.speech_service_config("stt")
                result = speech_services.transcribe(audio, self.headers.get("Content-Type", ""), base_url, token)
                self._send_json(result)
            except speech_services.SpeechServiceError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=exc.status)
            return
        if clean_path == "/api/speech/synthesize":
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError:
                self._send_json({"ok": False, "message": "Invalid speech request size"}, status=400)
                return
            if length <= 0 or length > 32 * 1024:
                self._send_json({"ok": False, "message": "Speech request must be between 1 byte and 32 KB"}, status=413 if length > 32 * 1024 else 400)
                return
            try:
                body = self._read_json_body()
                if not isinstance(body, dict):
                    raise speech_services.SpeechServiceError("Speech request must be a JSON object", 400)
                base_url, token = self.state.speech_service_config("tts")
                audio = speech_services.synthesize(body.get("text"), body.get("voice"), body.get("speed", 1.0), base_url, token)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Cache-Control", "no-store, private")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
            except speech_services.SpeechServiceError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=exc.status)
            return
        if self.path.split("?", 1)[0] == "/api/stats/source":
            try:
                body = self._read_json_body()
                result = self.state.set_stats_source(body.get("source") if isinstance(body, dict) else None)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json(result)
            return
        clean_path = self.path.split("?", 1)[0]
        profile_path = clean_path.strip("/").split("/")
        if clean_path == "/api/hermes-runtime":
            if not self._require_terminal_auth():
                return
            try:
                payload = self.state.change_hermes_runtime(self._read_json_body())
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json(payload, status=202)
            return
        if clean_path == "/api/hermes-settings":
            if not self._require_terminal_auth():
                return
            try:
                payload = self.state.save_hermes_settings(self._read_json_body())
            except (ValueError, OSError):
                self._send_json({"ok": False, "message": "Invalid Hermes settings or configuration could not be saved"}, status=400)
                return
            self._send_json(payload)
            return
        if clean_path == "/api/opencode-settings":
            if not self._require_terminal_auth():
                return
            try:
                payload = self.state.save_opencode_settings(self._read_json_body())
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json(payload)
            return
        if clean_path == "/api/worker-profiles":
            try:
                body = self._read_json_body()
                profile = self.state.jobs.save_profile(body if isinstance(body, dict) else {})
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=409)
                return
            self._send_json({"ok": True, "profile": profile})
            return
        if len(profile_path) == 4 and profile_path[:2] == ["api", "worker-profiles"] and profile_path[3] == "delete":
            profile_id = unquote(profile_path[2])
            try:
                self.state.jobs.delete_profile(profile_id)
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            self._send_json({"ok": True, "deleted": profile_id})
            return
        if self.path == "/api/jobs" or self.path.startswith("/api/jobs/"):
            self._jobs_post()
            return
        if self.path in ("/api/settings", "/api/settings/secret"):
            try:
                body = self._read_json_body()
                if self.path == "/api/settings":
                    payload = self.state.save_settings(body if isinstance(body, dict) else {})
                else:
                    payload = self.state.set_secret(body.get("name"), body.get("value"), body.get("copy_from"), body.get("endpoint"))
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json(payload)
            return
        if self.path == "/api/workbench/state":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            result = self.state.save_workbench_state(body)
            self._send_json(result, status=200 if result.get("ok") else 500)
            return
        if self.path == "/api/board":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            board = body.get("board") if isinstance(body, dict) else None
            base_revision = body.get("base_revision") if isinstance(body, dict) else None
            merge = bool(body.get("merge")) if isinstance(body, dict) else False
            result = self.state.save_board_state(board, base_revision=base_revision, merge=merge)
            if result.get("status") == "conflict":
                self._send_json(result, status=409)
                return
            self._send_json(result, status=200 if result.get("ok") else 400)
            return
        if self.path == "/api/board/command":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            command = body.get("command") if isinstance(body, dict) else None
            if command == "read_full":
                loaded = self.state.load_board_state()
                if not loaded.get("ok"):
                    self._send_json(loaded, status=500)
                    return
                board = loaded.get("board") or {"elements": [], "appState": {}, "files": {}}
                self._send_json({"ok": True, "board": board, "revision": loaded.get("revision", 0)})
                return
            if command not in ("add_node", "add_arrow", "clear", "set_layout", "update_element", "delete_element"):
                self._send_json({"ok": False, "message": "Unknown board command"}, status=400)
                return
            loaded = self.state.load_board_state()
            if not loaded.get("ok"):
                self._send_json(loaded, status=500)
                return
            board = loaded.get("board") or {"elements": [], "appState": {}, "files": {}}
            elements = board["elements"] if isinstance(board.get("elements"), list) else []
            stamp = self.state._stamp_board_element
            # Agent edits always merge: hard removals would be resurrected by open browser tabs.
            merge = True
            if command == "clear":
                board["elements"] = [
                    e if e.get("isDeleted") else stamp(e, isDeleted=True)
                    for e in elements if isinstance(e, dict)
                ]
            elif command == "set_layout":
                new_elements = body.get("elements")
                if not isinstance(new_elements, list):
                    self._send_json({"ok": False, "message": "set_layout requires an elements array"}, status=400)
                    return
                if len(new_elements) > 10000:
                    self._send_json({"ok": False, "message": "Board has too many elements"}, status=400)
                    return
                existing = {self.state._board_element_key(e): e for e in elements if self.state._board_element_key(e)}
                laid_out = []
                for element in new_elements:
                    if not isinstance(element, dict):
                        continue
                    element = dict(element)
                    element.setdefault("id", f"agent-{uuid.uuid4().hex[:12]}")
                    previous = existing.pop(str(element["id"]), None)
                    laid_out.append(stamp(
                        self.state.board_element_defaults(element),
                        floor=self.state._board_element_updated(previous) + 1 if previous else 0))
                laid_out.extend(
                    e if e.get("isDeleted") else stamp(e, isDeleted=True) for e in existing.values())
                board["elements"] = laid_out
            elif command == "update_element":
                element = body.get("element")
                if not isinstance(element, dict) or not element.get("id"):
                    self._send_json({"ok": False, "message": "update_element requires an element with an id"}, status=400)
                    return
                target_id = str(element.get("id"))
                target = next((e for e in elements if self.state._board_element_key(e) == target_id), None)
                if target is None:
                    self._send_json({"ok": False, "message": f"No board element with id {target_id}"}, status=404)
                    return
                updated = dict(target)
                for key, value in element.items():
                    if key == "id":
                        continue
                    updated[key] = value
                if "text" in element:
                    updated["originalText"] = updated.get("text")
                    updated["rawText"] = updated.get("text")
                updated = stamp(self.state.board_element_defaults(updated),
                                floor=self.state._board_element_updated(target) + 1)
                board["elements"] = [
                    updated if self.state._board_element_key(e) == target_id else e
                    for e in elements
                ]
            elif command == "delete_element":
                element_id = str(body.get("id") or "")
                if not element_id:
                    self._send_json({"ok": False, "message": "delete_element requires an id"}, status=400)
                    return
                found = False
                for index, element in enumerate(elements):
                    key = self.state._board_element_key(element)
                    if key == element_id:
                        found = True
                    # A shape's bound label goes with it.
                    if key == element_id or (isinstance(element, dict) and element.get("containerId") == element_id):
                        elements[index] = stamp(element, isDeleted=True)
                board["elements"] = elements
                if not found:
                    self._send_json({"ok": False, "message": f"No board element with id {element_id}"}, status=404)
                    return
            else:
                payload = body.get("node") if command == "add_node" else body.get("arrow")
                if not isinstance(payload, dict):
                    self._send_json({"ok": False, "message": "A node or arrow object is required"}, status=400)
                    return
                if command == "add_node" and not str(payload.get("text", "")).strip():
                    self._send_json({"ok": False, "message": "Node text is required"}, status=400)
                    return
                additions = self.state.board_elements(command, payload)
                if len(elements) + len(additions) > 10000:
                    self._send_json({"ok": False, "message": "Board has too many elements"}, status=400)
                    return
                board["elements"] = [*elements, *additions]
            result = self.state.save_board_state(board, merge=merge)
            if result.get("ok"):
                board["revision"] = result.get("revision")
            self._send_json({**result, "board": board}, status=200 if result.get("ok") else 500)
            return

        if self.path.startswith("/api/agent/session/delete"):
            params = self._query_params()
            source = params.get("source", "")
            session_id = params.get("session_id", "")
            if not source or not session_id:
                self._send_json({"ok": False, "message": "source and session_id are required"}, status=400)
                return
            self._send_json(self.state.agent_session_delete(source, session_id))
            return

        if self.path == "/api/app-preview/start":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
                if not isinstance(body, dict):
                    raise ValueError("Request body must be an object")
                result = self.state.app_previews.start(
                    body.get("path", ""), body.get("command", ""), body.get("port", 0),
                )
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except (app_preview.PreviewError, OSError, TypeError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            result["view_url"] = f"/api/app-preview/view/{result['session_id']}/"
            self._send_json({"ok": True, **result})
            return

        if self.path == "/api/app-preview/stop":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            session_id = str(body.get("session_id", "")) if isinstance(body, dict) else ""
            stopped = self.state.app_previews.stop(session_id)
            self._send_json({"ok": stopped, "message": "Preview session not found" if not stopped else "Preview stopped"},
                            status=200 if stopped else 404)
            return

        if self.path == "/api/terminal/start":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            mode = str(body.get("mode", "cli")).lower()
            cols = int(body.get("cols", 120))
            rows = int(body.get("rows", 32))
            if mode not in {"cli", "tui"}:
                self._send_json({"ok": False, "message": "mode must be 'cli' or 'tui'"}, status=400)
                return
            sid = self.state.start_terminal(mode=mode, cols=max(cols, 20), rows=max(rows, 8))
            self._send_json({"ok": True, "session_id": sid})
            return

        if self.path == "/api/terminal/input":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            sid = str(body.get("session_id", ""))
            data = str(body.get("data", ""))
            ok, msg = self.state.terminal_input(sid, data)
            self._send_json({"ok": ok, "message": msg}, status=200 if ok else 400)
            return

        if self.path == "/api/terminal/resize":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            sid = str(body.get("session_id", ""))
            cols = int(body.get("cols", 120))
            rows = int(body.get("rows", 32))
            ok, msg = self.state.terminal_resize(sid, max(cols, 20), max(rows, 8))
            self._send_json({"ok": ok, "message": msg}, status=200 if ok else 400)
            return

        if self.path == "/api/terminal/close":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            sid = str(body.get("session_id", ""))
            closed = self.state.terminal_close(sid)
            self._send_json({"ok": closed})
            return

        if self.path == "/api/wiki/write":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            rel_path = str(body.get("path", "")).strip()
            content = body.get("content")
            if content is None:
                self._send_json({"ok": False, "message": "Missing content"}, status=400)
                return
            try:
                payload = self.state.write_wiki_file(rel_path, str(content))
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/wiki/upload":
            # base64 inflates ~4/3; reject oversized bodies before reading them.
            if int(self.headers.get("Content-Length", "0") or 0) > UPLOAD_MAX_BYTES * 4 // 3 + 4096:
                self._send_json({"ok": False, "message": f"Upload exceeds {UPLOAD_MAX_BYTES // (1024 * 1024)} MB"}, status=413)
                return
            try:
                body = self._read_json_body()
                payload = self.state.upload_wiki_file(body.get("path"), body.get("content_base64"))
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/workspace/write":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            rel_path = str(body.get("path", "")).strip()
            content = body.get("content")
            if content is None:
                self._send_json({"ok": False, "message": "Missing content"}, status=400)
                return
            try:
                payload = self.state.write_workspace_file(
                    rel_path,
                    str(content),
                    expected_modified_ts=body.get("expected_modified_ts"),
                    expected_size_bytes=body.get("expected_size_bytes"),
                    force=bool(body.get("force", False)),
                )
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except RuntimeError as exc:
                current_status = getattr(exc, "current_status", None)
                payload = {"ok": False, "message": str(exc)}
                if current_status:
                    payload["current_status"] = current_status
                self._send_json(payload, status=409)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/workspace/upload":
            # base64 inflates ~4/3; reject oversized bodies before reading them.
            if int(self.headers.get("Content-Length", "0") or 0) > UPLOAD_MAX_BYTES * 4 // 3 + 4096:
                self._send_json({"ok": False, "message": f"Upload exceeds {UPLOAD_MAX_BYTES // (1024 * 1024)} MB"}, status=413)
                return
            try:
                body = self._read_json_body()
                payload = self.state.save_upload(body.get("filename"), body.get("content_base64"), directory=body.get("directory"))
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/workspace/create":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            rel_path = str(body.get("path", "")).strip()
            content = body.get("content")
            if content is None:
                self._send_json({"ok": False, "message": "Missing content"}, status=400)
                return
            try:
                payload = self.state.create_workspace_file(rel_path, str(content))
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/workspace/mkdir":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            try:
                payload = self.state.create_workspace_directory(str(body.get("path") or ""))
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path in ("/api/workspace/git/preview", "/api/workspace/git/initialize"):
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            try:
                path = str(body.get("path") or "")
                branch = str(body.get("branch") or "main")
                if self.path.endswith("/preview"):
                    preview = self.state.preview_workspace_git(path, branch)
                    self._send_json({"ok": True, "preview": preview})
                    return
                initialized = self.state.initialize_workspace_git(
                    path, branch, str(body.get("inventory_hash") or ""),
                    bool(body.get("confirm_existing", False)),
                )
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=409)
                return
            self._send_json({"ok": True, **initialized})
            return

        if self.path == "/api/workspace/delete":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            rel_path = str(body.get("path", "")).strip()
            try:
                payload = self.state.delete_workspace_file(rel_path, recursive=body.get("recursive") is True)
            except FileNotFoundError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=404)
                return
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, status=400)
                return
            self._send_json({"ok": True, **payload})
            return

        if self.path == "/api/server/restart":
            if not self._require_terminal_auth():
                return
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            reason = str(body.get("reason", "dashboard_ui")).strip() or "dashboard_ui"
            self.state.request_self_restart(reason=reason)
            self._send_json({"ok": True, "message": "Server restart initiated."})
            return

        if self.path == "/api/chat/session":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
                return
            provider_id = str(body.get("provider", "")).strip().lower()
            providers = {p["id"]: p for p in self.state.list_chat_providers()}
            if provider_id not in providers:
                self._send_json({"ok": False, "message": "Unknown provider"}, status=400)
                return
            provider = providers[provider_id]
            self.state.record_event(
                "chat_session",
                "Chat provider session requested",
                {"provider": provider_id},
            )
            self._send_json(
                {
                    "ok": True,
                    "provider": provider,
                    "session": {
                        "id": str(uuid.uuid4()),
                        "provider": provider_id,
                        "started_at": time.time(),
                    },
                }
            )
            return

        if not self.path.startswith("/api/workflows/"):
            self._send_json({"ok": False, "message": "Not found"}, status=404)
            return
        workflow_id = self.path.split("/")[-1].strip()
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            self._send_json({"ok": False, "message": "Invalid JSON body"}, status=400)
            return
        result = self.state.trigger_workflow(workflow_id, payload)
        if isinstance(result, dict):
            self._send_json(result, status=200 if result.get("ok") else 400)
            return
        ok, message = result
        self._send_json({"ok": ok, "message": message}, status=200 if ok else 400)

    def log_message(self, fmt, *args):
        print(f"[dashboard] {self.address_string()} - {fmt % args}")


def parse_args():
    parser = argparse.ArgumentParser(description="AI Tools Dashboard Server")
    parser.add_argument("--port", type=int, default=PORT, help=f"Port (default: {PORT})")
    parser.add_argument("--host", type=str, default=HOST, help=f"Host IP (default: {HOST})")
    return parser.parse_args()


def start_server(port=PORT, host=HOST):
    state = DashboardState()
    os.chdir(BASE_DIR)
    server = ThreadingHTTPServer((host, port), DashboardHandler)
    server.state = state  # type: ignore[attr-defined]
    state.jobs.start()
    free_model_refresh_stop = free_model_tracker.start_daily_refresh()
    state.hermes_live.start_sweeper()
    state.app_previews.start_sweeper()

    print(f"{Colors.GREEN}{'=' * 64}{Colors.RESET}")
    print(f"{Colors.CYAN}AI TOOLS DASHBOARD SERVER{Colors.RESET}")
    print(f"{Colors.GREEN}{'=' * 64}{Colors.RESET}")
    print(f"{Colors.GREEN}Dashboard URL: http://{host}:{port}{Colors.RESET}")
    print(f"{Colors.YELLOW}Stats source:{Colors.RESET} {state._stats_source_label()}")
    print(f"{Colors.GREEN}Press Ctrl+C to stop...{Colors.RESET}")
    print(f"{Colors.GREEN}{'=' * 64}{Colors.RESET}")
    try:
        server.serve_forever()
    finally:
        free_model_refresh_stop.set()
        state.app_previews.close_all()
        state.hermes_live.close_all()
        server.server_close()


def main():
    args = parse_args()
    start_server(port=args.port, host=args.host)


if __name__ == "__main__":
    main()
