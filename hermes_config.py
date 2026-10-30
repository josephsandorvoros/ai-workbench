"""Persistent Hermes inference settings shared by bootstrap and the API."""

import hashlib
import os
import re
import tempfile
from pathlib import Path

import yaml

from opencode_config import read_saved_settings, validate_endpoint


def read_config(home):
    path = Path(home) / "config.yaml"
    if not path.exists():
        return {}
    try:
        config = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        raise ValueError("Hermes config contains invalid YAML") from None
    if config is None:
        return {}
    if not isinstance(config, dict):
        raise ValueError("Hermes config must be a mapping")
    return config


def key_scope(provider, base_url):
    route = f"{provider}\n{base_url.rstrip('/')}"
    return "hermes:" + hashlib.sha256(route.encode()).hexdigest()


def validate_connection(patch):
    if not isinstance(patch, dict):
        raise ValueError("Hermes connection must be an object")
    provider = patch.get("provider", "")
    model = patch.get("model", "")
    if not isinstance(provider, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,79}", provider):
        raise ValueError("A valid Hermes provider identifier is required")
    if not isinstance(model, str) or not model.strip() or len(model) > 200 or any(character.isspace() for character in model):
        raise ValueError("A model identifier without whitespace is required")
    base_url = validate_endpoint(patch.get("base_url", ""))
    if provider == "custom" and not base_url:
        raise ValueError("Custom providers require an endpoint URL")
    if provider != "custom" and base_url:
        raise ValueError("Select custom to use an endpoint URL")
    if "api_key" in patch and (not isinstance(patch["api_key"], str) or len(patch["api_key"]) > 16384):
        raise ValueError("API key must be a string of at most 16384 characters")
    return {"provider": provider, "model": model, "base_url": base_url}


def connection_settings(env, home):
    saved = read_saved_settings(home)
    config = read_config(home)
    model = config.get("model") or {}
    if isinstance(model, str):
        model = {"default": model}
    if not isinstance(model, dict):
        raise ValueError("Hermes model config must be a mapping")
    override = saved.get("hermes")
    if isinstance(override, dict):
        connection = validate_connection(override)
        scope = key_scope(connection["provider"], connection["base_url"])
        connection["api_key"] = (saved.get("secrets") or {}).get(scope)
    elif env.get("LLM_BASE_URL", "").strip():
        connection = {"provider": "custom", "base_url": env["LLM_BASE_URL"].strip(),
                      "model": env.get("LLM_MODEL", "").strip() or model.get("default", ""),
                      "api_key": env.get("LLM_API_KEY", "").strip()}
    else:
        provider = str(model.get("provider") or "openrouter")
        providers = config.get("providers") or {}
        credentials = providers.get(provider) or {}
        connection = {"provider": provider, "model": str(model.get("default") or ""),
                      "base_url": str(model.get("base_url") or "") if provider == "custom" else "",
                      "api_key": model.get("api_key") if provider == "custom" else credentials.get("api_key")}
    connection["override_set"] = isinstance(override, dict)
    return connection


def save_config(home, config):
    path = Path(home) / "config.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".config-", suffix=".yaml", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            yaml.safe_dump(config, stream, sort_keys=False)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_config(env, home):
    connection = connection_settings(env, home)
    if not connection["override_set"] and not env.get("LLM_BASE_URL", "").strip():
        return
    config = read_config(home)
    previous = config.get("model")
    model = dict(previous) if isinstance(previous, dict) else {}
    if model.get("provider") != connection["provider"] or str(model.get("base_url") or "").rstrip("/") != connection["base_url"].rstrip("/"):
        model.pop("api_mode", None)
    for field in ("base_url", "api_key", "api_key_env", "key_env"):
        model.pop(field, None)
    model.update(provider=connection["provider"], default=connection["model"])
    if connection["provider"] == "custom":
        model["base_url"] = connection["base_url"]
        model["api_key"] = connection["api_key"] or ""
    elif connection["api_key"] is not None:
        config.setdefault("providers", {}).setdefault(connection["provider"], {})["api_key"] = connection["api_key"]
    config["model"] = model
    save_config(home, config)