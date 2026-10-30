"""Public provider/model metadata, without runtime configuration or credentials."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

from opencode_config import validate_endpoint


def read_catalog_json(url, headers=None):
    request = Request(url, headers={"Accept": "application/json", **(headers or {})})
    with urlopen(request, timeout=20) as response:
        content = response.read(12 * 1024 * 1024 + 1)
    if len(content) > 12 * 1024 * 1024:
        raise ValueError("Provider catalog exceeds the size limit")
    return json.loads(content)


def opencode_cli_catalog(env, cwd):
    binary = shutil.which("opencode", path=env.get("PATH"))
    if not binary:
        home = Path(env.get("HOME") or str(Path.home()))
        binary = next((str(path) for path in (home / ".opencode/bin/opencode", home / ".local/bin/opencode")
                       if path.is_file() and os.access(path, os.X_OK)), None)
    if not binary:
        raise ValueError("OpenCode CLI is unavailable")
    result = subprocess.run([binary, "models", "--verbose"], cwd=cwd, env={**env, "NO_COLOR": "1"},
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, timeout=20, check=True)
    return parse_opencode_models(result.stdout, env)


def parse_opencode_models(content, env):
    if len(content) > 12 * 1024 * 1024:
        raise ValueError("OpenCode model metadata exceeds the size limit")
    providers = {}
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(content):
        line_end = content.find("\n", offset)
        line_end = len(content) if line_end < 0 else line_end
        identifier = content[offset:line_end].strip()
        offset = line_end + 1
        match = re.fullmatch(r"([A-Za-z0-9._-]+)/([^\s]+)", identifier)
        if not match:
            continue
        provider_id, model_id = match.groups()
        metadata = {}
        json_start = offset
        while json_start < len(content) and content[json_start].isspace():
            json_start += 1
        if content[json_start:json_start + 1] == "{":
            metadata, consumed = decoder.raw_decode(content, json_start)
            offset = consumed
        row = providers.setdefault(provider_id, {"id": provider_id, "name": provider_id, "models": {}})
        row["models"][model_id] = {"id": model_id, "name": metadata.get("name", model_id) if isinstance(metadata, dict) else model_id}
    if not providers:
        raise ValueError("OpenCode returned no model metadata")
    data_home = Path(env.get("XDG_DATA_HOME") or str(Path(env.get("HOME") or str(Path.home())) / ".local/share"))
    try:
        auth = json.loads((data_home / "opencode/auth.json").read_text())
        connected = list(auth) if isinstance(auth, dict) else []
    except (OSError, ValueError):
        connected = []
    return {**opencode_catalog({"all": list(providers.values()), "connected": connected}),
            "source": "opencode CLI", "warning": "Catalog from the installed OpenCode CLI; no headless runtime is reachable."}


def _models(values):
    entries = values.items() if isinstance(values, dict) else ((None, value) for value in values) if isinstance(values, list) else []
    models = {}
    for identifier, value in entries:
        if isinstance(value, dict):
            identifier = value.get("id") or identifier
            name = value.get("name") or value.get("label") or identifier
        else:
            identifier = identifier or value
            name = identifier
        if not isinstance(identifier, str) or not identifier or len(identifier) > 240:
            continue
        models[identifier] = {"id": identifier, "name": name if isinstance(name, str) else identifier}
    return sorted(models.values(), key=lambda model: model["name"].casefold())


def opencode_catalog(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("all"), list):
        raise ValueError("OpenCode returned an unsupported provider catalog")
    connected = set(value for value in payload.get("connected", []) if isinstance(value, str))
    defaults = payload.get("default") or {}
    providers = []
    for row in payload["all"]:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        identifier = row["id"]
        providers.append({"id": identifier, "name": str(row.get("name") or identifier),
                          "connected": identifier in connected, "models": _models(row.get("models")),
                          "default_model": defaults.get(identifier) if isinstance(defaults.get(identifier), str) else ""})
    return {"providers": sorted(providers, key=lambda provider: (not provider["connected"], provider["name"].casefold()))}


def hermes_catalog(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("providers"), list):
        raise ValueError("Hermes returned an unsupported model catalog")
    providers = []
    for row in payload["providers"]:
        if not isinstance(row, dict):
            continue
        identifier = row.get("provider") or row.get("id") or row.get("slug")
        if not isinstance(identifier, str) or not identifier:
            continue
        try:
            base_url = validate_endpoint(row.get("base_url") or row.get("api_url") or "")
        except ValueError:
            base_url = ""
        providers.append({"id": identifier, "name": str(row.get("name") or row.get("label") or identifier),
                          "connected": row.get("authenticated") is True,
                          "models": _models(row.get("models")), "base_url": base_url,
                          "custom": bool(base_url or row.get("is_user_defined"))})
    return {"providers": sorted(providers, key=lambda provider: (not provider["connected"], provider["name"].casefold())),
            "current": {"provider": payload.get("provider") if isinstance(payload.get("provider"), str) else "",
                        "model": payload.get("model") if isinstance(payload.get("model"), str) else ""}}