"""Bounded server-side client for the separately hosted speech wrappers."""

import json
import re
import threading
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

MAX_SPEECH_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_TRANSCRIPT_CHARS = 12_000
MAX_TTS_TEXT_CHARS = 4_000
MAX_SPEECH_RESPONSE_BYTES = 16 * 1024 * 1024
SPEECH_TIMEOUT_SECONDS = 90

_AUDIO_TYPES = {
    "audio/webm": ("webm", "audio/webm"),
    "audio/ogg": ("ogg", "audio/ogg"),
    "audio/mp4": ("m4a", "audio/mp4"),
    "audio/wav": ("wav", "audio/wav"),
    "audio/x-wav": ("wav", "audio/wav"),
    "audio/mpeg": ("mp3", "audio/mpeg"),
    "audio/flac": ("flac", "audio/flac"),
}
_VOICE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
_STT_SLOT = threading.BoundedSemaphore(1)
_TTS_SLOT = threading.BoundedSemaphore(1)


class SpeechServiceError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def validate_base_url(value):
    value = str(value or "").strip().rstrip("/")
    try:
        parsed = urlparse(value)
        valid = (
            parsed.scheme in ("http", "https")
            and parsed.hostname
            and parsed.port is not None
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and parsed.path in ("", "/")
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Speech service URL must be an http(s) base URL with a host and port")
    return value


def _validate_base_url(value):
    try:
        return validate_base_url(value)
    except ValueError as exc:
        raise SpeechServiceError("Speech service URL is not configured correctly", 503) from exc


def _validate_token(token):
    if not isinstance(token, str) or not token or len(token) > 1024 or "\r" in token or "\n" in token:
        raise SpeechServiceError("Speech service credentials are not configured", 503)
    return token


def _read_limited(response, limit):
    data = response.read(limit + 1)
    if len(data) > limit:
        raise SpeechServiceError("Speech service response exceeds the size limit")
    return data


def _open(request, timeout):
    try:
        return urlopen(request, timeout=timeout)
    except HTTPError as exc:
        exc.close()
        raise SpeechServiceError(f"Speech service returned HTTP {exc.code}") from None
    except (URLError, TimeoutError, OSError) as exc:
        raise SpeechServiceError(f"Speech service is unreachable: {type(exc).__name__}", 502) from None


def _slot(semaphore, name):
    if not semaphore.acquire(blocking=False):
        raise SpeechServiceError(f"{name} is busy; try again shortly", 503)


def transcribe(audio, content_type, base_url, token):
    if not isinstance(audio, bytes) or not audio:
        raise SpeechServiceError("No microphone audio was received", 400)
    if len(audio) > MAX_SPEECH_UPLOAD_BYTES:
        raise SpeechServiceError("Audio exceeds the 8 MB upload limit", 413)
    media_type = str(content_type or "").split(";", 1)[0].strip().lower()
    audio_type = _AUDIO_TYPES.get(media_type)
    if not audio_type:
        raise SpeechServiceError("Unsupported audio format", 415)
    extension, normalized_type = audio_type
    base_url = _validate_base_url(base_url)
    token = _validate_token(token)
    boundary = f"----AIWorkbench-{uuid.uuid4().hex}"
    multipart = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="recording.{extension}"\r\n'
        f"Content-Type: {normalized_type}\r\n\r\n"
    ).encode("ascii") + audio + f"\r\n--{boundary}--\r\n".encode("ascii")
    request = Request(
        f"{base_url}/v1/audio/transcriptions",
        data=multipart,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(multipart)),
        },
    )
    _slot(_STT_SLOT, "Speech recognition")
    try:
        with _open(request, SPEECH_TIMEOUT_SECONDS) as response:
            try:
                payload = json.loads(_read_limited(response, 1024 * 1024))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise SpeechServiceError("Speech recognition returned invalid JSON") from None
    finally:
        _STT_SLOT.release()
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise SpeechServiceError("Speech recognition response did not include transcript text")
    text = payload["text"].strip()
    if len(text) > MAX_TRANSCRIPT_CHARS:
        raise SpeechServiceError("Transcript exceeds the 12,000 character limit", 502)
    return {"ok": True, "text": text, **{
        key: payload[key]
        for key in ("language", "duration_seconds", "processing_time_seconds", "model", "compute_type")
        if isinstance(payload.get(key), (str, int, float))
    }}


def list_voices(base_url, token):
    base_url = _validate_base_url(base_url)
    token = _validate_token(token)
    request = Request(
        f"{base_url}/voices",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    _slot(_TTS_SLOT, "Speech synthesis")
    try:
        with _open(request, 10) as response:
            try:
                payload = json.loads(_read_limited(response, 256 * 1024))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise SpeechServiceError("Voice catalogue returned invalid JSON") from None
    finally:
        _TTS_SLOT.release()
    values = payload.get("voices") if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        raise SpeechServiceError("Voice catalogue has an unsupported response format")
    voices = []
    seen = set()
    for item in values[:100]:
        voice_id = item if isinstance(item, str) else item.get("id", item.get("name")) if isinstance(item, dict) else None
        if isinstance(voice_id, str) and _VOICE_ID.fullmatch(voice_id) and voice_id not in seen:
            seen.add(voice_id)
            voices.append({"id": voice_id, "label": voice_id})
    return {
        "ok": True,
        "voices": voices,
        "warning": "The speech service returned no voices. Voice discovery may be incomplete." if not voices else "",
    }


def synthesize(text, voice, speed, base_url, token):
    if not isinstance(text, str) or not text.strip():
        raise SpeechServiceError("Speech text is required", 400)
    if len(text) > MAX_TTS_TEXT_CHARS:
        raise SpeechServiceError("Speech text exceeds the 4,000 character limit", 413)
    if not isinstance(voice, str) or not _VOICE_ID.fullmatch(voice):
        raise SpeechServiceError("Select a valid speech voice", 400)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
        raise SpeechServiceError("Speech speed must be between 0.5 and 2.0", 400)
    base_url = _validate_base_url(base_url)
    token = _validate_token(token)
    body = json.dumps({"text": text, "voice": voice, "speed": float(speed)}).encode("utf-8")
    request = Request(
        f"{base_url}/v1/tts",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "audio/wav",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )
    _slot(_TTS_SLOT, "Speech synthesis")
    try:
        with _open(request, SPEECH_TIMEOUT_SECONDS) as response:
            response_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if response_type not in ("audio/wav", "audio/x-wav"):
                raise SpeechServiceError(
                    f"Speech service returned {response_type or 'an unknown content type'}, not WAV audio; its OpenAPI schema advertises JSON"
                )
            audio = _read_limited(response, MAX_SPEECH_RESPONSE_BYTES)
    finally:
        _TTS_SLOT.release()
    if not audio.startswith(b"RIFF") or audio[8:12] != b"WAVE":
        raise SpeechServiceError("Speech service response is not a valid WAV file")
    return audio