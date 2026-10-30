"""Shared boot-time and runtime OpenCode configuration."""

import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate_endpoint(value):
    if not isinstance(value, str):
        raise ValueError("Endpoint must be a URL string")
    value = value.strip()
    if not value:
        return value
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password and not parsed.fragment
        parsed.port
    except ValueError:
        valid = False
    if not valid or any(character.isspace() for character in value):
        raise ValueError("Endpoint must be an http(s) URL without embedded credentials")
    return value


def read_saved_settings(home):
    try:
        data = json.loads((Path(home) / "spatial-workbench" / "settings.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def connection_key_scope(role, model, base_url):
    route = "custom\n" + base_url.rstrip("/") if base_url else model.split("/", 1)[0]
    return f"opencode-route:{role}:" + hashlib.sha256(route.encode()).hexdigest()


def connection_settings(env, home, role):
    saved = read_saved_settings(home)
    override = (saved.get("opencode") or {}).get(role) or {}
    if role == "main":
        default_model = env.get("OPENCODE_MODEL", "").strip() or "opencode/big-pickle"
        default_base = env.get("OPENCODE_CUSTOM_BASE_URL", "").strip()
        model = override.get("model", default_model)
        base_url = override.get("base_url", default_base)
        default_route = connection_key_scope(role, model, base_url) == connection_key_scope(role, default_model, default_base)
        key_env = {"opencode": "OPENCODE_API_KEY", "openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY",
                   "openrouter": "OPENROUTER_API_KEY", "google": "GEMINI_API_KEY", "local": "LLM_API_KEY"}.get(model.split("/", 1)[0], "")
        api_key = (env.get("OPENCODE_CUSTOM_API_KEY", "") if default_route else "") if base_url else (env.get("OPENCODE_MAIN_API_KEY", "") if default_route else "") or env.get(key_env, "")
    else:
        default_model = env.get("WORKER_MODEL", "").strip() or "opencode/big-pickle"
        default_base = env.get("WORKER_BASE_URL", "").strip()
        model = override.get("model", default_model)
        base_url = override.get("base_url", default_base)
        api_key = env.get("WORKER_API_KEY", "") if connection_key_scope(role, model, base_url) == connection_key_scope(role, default_model, default_base) else ""
    secrets = saved.get("secrets") or {}
    return {
        "model": model,
        "base_url": base_url,
        "api_key": secrets.get(connection_key_scope(role, model, base_url), secrets.get(f"opencode:{role}", api_key)),
        "keys": {name.removeprefix("worker-key:"): value for name, value in secrets.items()
                 if name.startswith("worker-key:")},
    }


def opencode_settings(env):
    providers = {}
    llm_base = env.get("LLM_BASE_URL", "").strip()
    llm_model = env.get("LLM_MODEL", "").strip() or "default"
    if llm_base:
        options = {"baseURL": llm_base}
        if env.get("LLM_API_KEY", "").strip():
            options["apiKey"] = "{env:LLM_API_KEY}"
        providers["local"] = {
            "npm": "@ai-sdk/openai-compatible", "name": "Local LLM",
            "options": options, "models": {llm_model: {"name": llm_model}},
        }
    model = env.get("OPENCODE_MODEL", "").strip() or "opencode/big-pickle"
    custom_base = env.get("OPENCODE_CUSTOM_BASE_URL", "").strip()
    if custom_base:
        custom_model = model.removeprefix("custom/")
        options = {"baseURL": custom_base}
        if env.get("OPENCODE_CUSTOM_API_KEY", "").strip():
            options["apiKey"] = "{env:OPENCODE_CUSTOM_API_KEY}"
        providers["custom"] = {
            "npm": "@ai-sdk/openai-compatible", "name": "Custom endpoint",
            "options": options, "models": {custom_model: {"name": custom_model}},
        }
        model = f"custom/{custom_model}"
    return providers, model


def write_opencode_config(env, home):
    home = Path(home)
    connection = connection_settings(env, home, "main")
    effective = {**env, "OPENCODE_MODEL": connection["model"],
                 "OPENCODE_CUSTOM_BASE_URL": connection["base_url"]}
    providers, model = opencode_settings(effective)
    config_path = home / ".config" / "opencode" / "opencode.json"
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {"$schema": "https://opencode.ai/config.json"}
    managed = config.setdefault("provider", {})
    for name in ("local", "custom"):
        managed.pop(name, None)
    managed.update(providers)
    selected = model.split("/", 1)[0]
    secret_path = home / "spatial-workbench" / "opencode-main.key"
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    secret_path.touch(mode=0o600, exist_ok=True)
    os.chmod(secret_path, 0o600)
    secret_path.write_text(connection["api_key"], encoding="utf-8")
    for provider in managed.values():
        if isinstance(provider, dict) and isinstance(provider.get("options"), dict) and provider["options"].get("apiKey") == f"{{file:{secret_path}}}":
            provider["options"].pop("apiKey")
    if connection["base_url"] or connection["api_key"] or "opencode:main" in (read_saved_settings(home).get("secrets") or {}):
        managed.setdefault(selected, {}).setdefault("options", {})["apiKey"] = f"{{file:{secret_path}}}"
    config.pop("enabled_providers", None)
    config.update(model=model, small_model=model, share="disabled", autoupdate=False)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config_path.with_suffix(".tmp")
    temporary.touch(mode=0o600, exist_ok=True)
    os.chmod(temporary, 0o600)
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temporary.replace(config_path)
    return config_path, secret_path, model