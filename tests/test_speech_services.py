import io
import json
import unittest
from email.message import Message
from unittest.mock import patch

import speech_services


class FakeResponse(io.BytesIO):
    def __init__(self, body, content_type="application/json"):
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class SpeechServicesTests(unittest.TestCase):
    def test_transcribe_sends_bounded_multipart_with_server_token(self):
        response = {"text": "hello there", "language": "en", "duration_seconds": 1.2,
                    "processing_time_seconds": 0.3, "model": "small.en", "compute_type": "int8",
                    "unexpected": "not exposed"}
        with patch("speech_services.urlopen", return_value=FakeResponse(json.dumps(response).encode())) as open_url:
            result = speech_services.transcribe(b"webm-audio", "audio/webm;codecs=opus", "http://192.0.2.2:8081", "private-token")
        request = open_url.call_args.args[0]
        timeout = open_url.call_args.kwargs["timeout"]
        self.assertEqual(request.full_url, "http://192.0.2.2:8081/v1/audio/transcriptions")
        self.assertEqual(request.get_header("Authorization"), "Bearer private-token")
        self.assertIn('name="file"; filename="recording.webm"'.encode(), request.data)
        self.assertIn(b"webm-audio", request.data)
        self.assertEqual(timeout, speech_services.SPEECH_TIMEOUT_SECONDS)
        self.assertNotIn("unexpected", result)
        self.assertEqual(result["text"], "hello there")

    def test_transcribe_rejects_oversized_or_unsupported_audio_without_network(self):
        with patch("speech_services.urlopen") as open_url:
            with self.assertRaises(speech_services.SpeechServiceError) as oversized:
                speech_services.transcribe(b"x" * (speech_services.MAX_SPEECH_UPLOAD_BYTES + 1), "audio/webm", "http://192.0.2.2:8081", "token")
            self.assertEqual(oversized.exception.status, 413)
            with self.assertRaises(speech_services.SpeechServiceError) as unsupported:
                speech_services.transcribe(b"audio", "text/plain", "http://192.0.2.2:8081", "token")
            self.assertEqual(unsupported.exception.status, 415)
            open_url.assert_not_called()

    def test_service_urls_and_credentials_are_validated(self):
        with patch("speech_services.urlopen") as open_url:
            for url in ("file:///etc/passwd", "http://user:pass@192.0.2.2:8081", "http://host:1/path"):
                with self.subTest(url=url), self.assertRaises(speech_services.SpeechServiceError):
                    speech_services.list_voices(url, "token")
            with self.assertRaises(speech_services.SpeechServiceError) as missing:
                speech_services.list_voices("http://192.0.2.2:8082", "")
            self.assertEqual(missing.exception.status, 503)
            open_url.assert_not_called()

    def test_empty_voice_catalogue_is_reported_without_inventing_voices(self):
        with patch("speech_services.urlopen", return_value=FakeResponse(b'{"voices":[]}')):
            result = speech_services.list_voices("http://192.0.2.2:8082", "token")
        self.assertEqual(result["voices"], [])
        self.assertTrue(result["warning"])

    def test_voice_catalogue_sanitizes_and_deduplicates(self):
        body = json.dumps({"voices": ["af_heart", "af_heart", "../unsafe", 4, {"id": "am_michael"}]}).encode()
        with patch("speech_services.urlopen", return_value=FakeResponse(body)):
            result = speech_services.list_voices("http://192.0.2.2:8082", "token")
        self.assertEqual([voice["id"] for voice in result["voices"]], ["af_heart", "am_michael"])

    def test_synthesis_validates_text_voice_speed_and_wav_contract(self):
        wav = b"RIFF" + (len(b"WAVE") + 4).to_bytes(4, "little") + b"WAVEdata"
        with patch("speech_services.urlopen", return_value=FakeResponse(wav, "audio/wav")) as open_url:
            result = speech_services.synthesize("Hello.", "af_heart", 1.0, "http://192.0.2.2:8082", "private-token")
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://192.0.2.2:8082/v1/tts")
        self.assertEqual(request.get_header("Authorization"), "Bearer private-token")
        self.assertEqual(json.loads(request.data), {"text": "Hello.", "voice": "af_heart", "speed": 1.0})
        self.assertEqual(result, wav)
        with patch("speech_services.urlopen", return_value=FakeResponse(b'{"audio":"wrong"}')):
            with self.assertRaisesRegex(speech_services.SpeechServiceError, "OpenAPI schema advertises JSON"):
                speech_services.synthesize("Hello.", "af_heart", 1, "http://192.0.2.2:8082", "token")

    def test_synthesis_rejects_invalid_inputs_and_wav(self):
        with patch("speech_services.urlopen") as open_url:
            for text, voice, speed in (("", "af_heart", 1), ("Hi", "../x", 1), ("Hi", "af_heart", 4),
                                       ("x" * (speech_services.MAX_TTS_TEXT_CHARS + 1), "af_heart", 1)):
                with self.subTest(text_length=len(text), voice=voice, speed=speed), self.assertRaises(speech_services.SpeechServiceError):
                    speech_services.synthesize(text, voice, speed, "http://192.0.2.2:8082", "token")
            open_url.assert_not_called()
        with patch("speech_services.urlopen", return_value=FakeResponse(b"not wav", "audio/wav")):
            with self.assertRaisesRegex(speech_services.SpeechServiceError, "valid WAV"):
                speech_services.synthesize("Hi", "af_heart", 1, "http://192.0.2.2:8082", "token")

    def test_concurrency_is_rejected_without_queueing(self):
        self.assertTrue(speech_services._STT_SLOT.acquire(blocking=False))
        try:
            with patch("speech_services.urlopen") as open_url:
                with self.assertRaisesRegex(speech_services.SpeechServiceError, "busy"):
                    speech_services.transcribe(b"audio", "audio/webm", "http://192.0.2.2:8081", "token")
                open_url.assert_not_called()
        finally:
            speech_services._STT_SLOT.release()


if __name__ == "__main__":
    unittest.main()