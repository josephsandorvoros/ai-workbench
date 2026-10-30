import unittest
from unittest.mock import Mock, patch

from free_models import FreeModelTracker, METADATA_URL, TRACKER_URL, TTL, ZEN_URL, normalize_api, normalize_zen


class FreeModelsTests(unittest.TestCase):
    def test_api_ranking_unknown_capabilities_and_safe_links(self):
        result = normalize_api({"models": [
            {"id": "unranked", "source": "https://example.com/model", "context_window": 1000000},
            {"id": "ranked", "source": "https://example.com/ranked", "zo_rank": 1, "modalities": ["image", "unknown"]},
            {"id": "unsafe", "source": "javascript:alert(1)"},
            {"id": "malformed", "source": "https://[broken"},
            {"id": "expired", "source": "https://example.com", "expires": "2000-01-01"},
            {"id": "ranked", "source": "https://example.com/duplicate"},
        ]})
        self.assertEqual([model["id"] for model in result["models"]], ["ranked", "unranked"])
        self.assertIsNone(result["models"][0]["tools"])
        self.assertEqual(result["models"][0]["input_modalities"], ["image"])

    def test_zen_requires_live_zero_price_non_deprecated_metadata(self):
        entries = {
            "free": {"cost": {"input": 0, "output": 0}, "tool_call": True, "limit": {"context": 128000}},
            "paid-free": {"cost": {"input": 0, "output": 1}},
            "missing": {},
            "gone": {"cost": {"input": 0, "output": 0}},
            "old": {"cost": {"input": 0, "output": 0}, "status": "deprecated"},
        }
        result = normalize_zen({"data": [{"id": model_id} for model_id in entries if model_id != "gone"]}, {"opencode": {"models": entries}})
        self.assertEqual([model["id"] for model in result["models"]], ["free"])
        self.assertTrue(result["models"][0]["tools"])
        self.assertEqual(result["models"][0]["context"], 128000)

    def test_cache_partial_failure_and_forced_refresh(self):
        calls = []
        fail = False

        def fetcher(url):
            calls.append(url)
            if fail and url == TRACKER_URL:
                raise OSError("offline")
            return {
                TRACKER_URL: {"models": [{"id": "model", "source": "https://example.com"}]},
                ZEN_URL: {"data": []}, METADATA_URL: {"opencode": {"models": {}}},
            }[url]

        tracker = FreeModelTracker(fetcher)
        self.assertEqual(len(tracker.get()["sections"]["api"]["models"]), 1)
        tracker.get()
        self.assertEqual(len(calls), 3)
        fail = True
        result = tracker.get(force=True)
        self.assertTrue(result["sections"]["api"]["stale"])
        self.assertEqual(len(result["sections"]["api"]["models"]), 1)
        self.assertFalse(result["sections"]["zen"]["stale"])

    def test_sources_update_after_24_hours(self):
        model_id = "original"
        calls = []

        def fetcher(url):
            calls.append(url)
            return {
                TRACKER_URL: {"models": [{"id": model_id, "source": "https://example.com"}]},
                ZEN_URL: {"data": [{"id": model_id}]},
                METADATA_URL: {"opencode": {"models": {model_id: {"cost": {"input": 0, "output": 0}}}}},
            }[url]

        tracker = FreeModelTracker(fetcher)
        with patch("free_models.time.time", return_value=100000) as clock:
            self.assertEqual(tracker.get()["refresh_seconds"], 86400)
            model_id = "updated"
            clock.return_value = 100000 + 86400 - 1
            cached = tracker.get()
            self.assertEqual(len(calls), 3)
            self.assertEqual(cached["sections"]["api"]["models"][0]["id"], "original")
            clock.return_value += 1
            refreshed = tracker.get()
            self.assertEqual(len(calls), 6)
            for section in refreshed["sections"].values():
                self.assertEqual(section["models"][0]["id"], "updated")

    def test_background_checker_refreshes_without_browser_requests(self):
        tracker = FreeModelTracker()
        tracker.get = Mock()
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        tracker._refresh_loop(stop)
        self.assertEqual(tracker.get.call_count, 2)
        tracker.get.assert_called_with(force=True)
        self.assertEqual(TTL, 86400)
        self.assertEqual(stop.wait.call_args_list, [unittest.mock.call(86400), unittest.mock.call(86400)])


if __name__ == "__main__":
    unittest.main()