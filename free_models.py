"""Read-only, cached catalogues of free hosted models."""

import copy
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from urllib.parse import urlparse
from urllib.request import Request, urlopen

TRACKER_URL = "https://raw.githubusercontent.com/ClawLabsAI/free-ai-models/main/data/models.json"
ZEN_URL = "https://opencode.ai/zen/v1/models"
METADATA_URL = "https://models.dev/api.json"
TTL = 24 * 60 * 60


def fetch_json(url):
    request = Request(url, headers={"User-Agent": "AI-Workbench-Free-Models/1.0"})
    with urlopen(request, timeout=15) as response:
        data = response.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("Catalogue exceeds size limit")
    return json.loads(data)


def text(value):
    return value[:500] if isinstance(value, str) else ""


def positive_number(value):
    return value if type(value) in (int, float) and 0 < value < 1_000_000_000 else None


def safe_url(value):
    value = text(value)
    try:
        parsed = urlparse(value)
    except ValueError:
        return ""
    return value if parsed.scheme == "https" and parsed.hostname and not parsed.username else ""


def modalities(value):
    return [item for item in (value if isinstance(value, list) else []) if item in ("text", "image", "audio", "video", "file")]


def normalize_api(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise ValueError("Invalid tracker catalogue")
    models = []
    seen = set()
    for raw in payload["models"][:200]:
        if not isinstance(raw, dict) or not text(raw.get("id")):
            continue
        if raw["id"] in seen:
            continue
        expires = text(raw.get("expires"))
        try:
            if expires and date.fromisoformat(expires) <= datetime.now(timezone.utc).date():
                continue
        except ValueError:
            pass
        link = safe_url(raw.get("source"))
        if not link:
            continue
        seen.add(raw["id"])
        models.append({
            "id": text(raw["id"]), "name": text(raw.get("name")) or text(raw["id"]),
            "provider": text(raw.get("provider")), "url": link,
            "context": positive_number(raw.get("context_window")),
            "output": positive_number(raw.get("max_output")),
            "input_modalities": modalities(raw.get("modalities")),
            "output_modalities": modalities(raw.get("output_modalities")),
            "tools": raw.get("tool_call") if isinstance(raw.get("tool_call"), bool) else None,
            "reasoning": raw.get("reasoning") if isinstance(raw.get("reasoning"), bool) else None,
            "rate_limit": text(raw.get("rate_limit")), "expires": text(raw.get("expires")),
            "rank": positive_number(raw.get("zo_rank")),
            "health": raw.get("health") if raw.get("health") in ("ok", "sick", "dead") else None,
            "answering_now": raw.get("answering_now") is True,
        })
    models.sort(key=lambda model: (model["rank"] or float("inf"), -(model["context"] or 0), model["name"]))
    return {"models": models, "snapshot_at": text(payload.get("updated_at"))}


def normalize_zen(catalogue, metadata):
    if not isinstance(catalogue, dict) or not isinstance(catalogue.get("data"), list):
        raise ValueError("Invalid Zen catalogue")
    provider = metadata.get("opencode", {}) if isinstance(metadata, dict) else {}
    entries = provider.get("models") if isinstance(provider, dict) else None
    if not isinstance(entries, dict):
        raise ValueError("Missing Zen pricing metadata")
    live_ids = {entry.get("id") for entry in catalogue["data"] if isinstance(entry, dict) and isinstance(entry.get("id"), str)}
    models = []
    for model_id, raw in entries.items():
        if not isinstance(raw, dict) or model_id not in live_ids or raw.get("status") == "deprecated":
            continue
        cost = raw.get("cost", {})
        if not isinstance(cost, dict) or not all(type(cost.get(key)) in (int, float) and cost[key] == 0 for key in ("input", "output")):
            continue
        limits = raw.get("limit", {})
        media = raw.get("modalities", {})
        limits = limits if isinstance(limits, dict) else {}
        media = media if isinstance(media, dict) else {}
        models.append({
            "id": text(model_id), "name": text(raw.get("name")) or text(model_id),
            "provider": "OpenCode Zen", "url": "https://opencode.ai/docs/zen/#pricing",
            "context": positive_number(limits.get("context")), "output": positive_number(limits.get("output")),
            "input_modalities": modalities(media.get("input")), "output_modalities": modalities(media.get("output")),
            "tools": raw.get("tool_call") if isinstance(raw.get("tool_call"), bool) else None,
            "reasoning": raw.get("reasoning") if isinstance(raw.get("reasoning"), bool) else None,
            "rate_limit": "Limited-time free tier; provider limits apply",
            "expires": "", "rank": None, "health": None, "answering_now": False,
        })
    models.sort(key=lambda model: (-(model["context"] or 0), model["name"]))
    return {"models": models[:200], "snapshot_at": ""}


class FreeModelTracker:
    def __init__(self, fetcher=fetch_json):
        self.fetcher = fetcher
        self.lock = threading.Lock()
        self.cache = {}
        self.checked = {}

    def start_daily_refresh(self):
        stop = threading.Event()
        threading.Thread(target=self._refresh_loop, args=(stop,), name="free-model-refresh", daemon=True).start()
        return stop

    def _refresh_loop(self, stop):
        while not stop.is_set():
            self.get(force=True)
            stop.wait(TTL)

    def _refresh(self, source):
        if source == "api":
            return normalize_api(self.fetcher(TRACKER_URL))
        return normalize_zen(self.fetcher(ZEN_URL), self.fetcher(METADATA_URL))

    def get(self, force=False):
        with self.lock:
            now = time.time()
            due = [source for source in ("zen", "api") if force or now - self.checked.get(source, 0) >= TTL]
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending = {source: pool.submit(self._refresh, source) for source in due}
                for source, future in pending.items():
                    try:
                        self.cache[source] = {**future.result(), "fetched_at": datetime.now(timezone.utc).isoformat(), "stale": False, "error": ""}
                    except Exception:
                        self.cache[source] = {**self.cache.get(source, {"models": [], "snapshot_at": "", "fetched_at": ""}), "stale": True, "error": "Source unavailable; refresh to retry"}
                    self.checked[source] = now if not self.cache[source]["stale"] else now - TTL + 60
            return copy.deepcopy({"ok": True, "sections": self.cache, "refresh_seconds": TTL})


tracker = FreeModelTracker()