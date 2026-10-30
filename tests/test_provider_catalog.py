import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from provider_catalog import hermes_catalog, opencode_catalog, opencode_cli_catalog, parse_opencode_models


class ProviderCatalogTests(unittest.TestCase):
    def test_opencode_lists_connected_copilot_and_exact_model_ids_without_secrets(self):
        catalog = opencode_catalog({"all": [
            {"id": "other", "name": "Other", "models": {}},
            {"id": "github-copilot", "name": "GitHub Copilot", "key": "secret-key", "options": {"token": "oauth-secret"},
             "models": {"claude-sonnet": {"id": "claude-sonnet", "name": "Claude Sonnet", "api_key": "model-secret"}}},
        ], "connected": ["github-copilot"], "default": {"github-copilot": "claude-sonnet"}})
        self.assertEqual(catalog["providers"][0]["id"], "github-copilot")
        self.assertTrue(catalog["providers"][0]["connected"])
        self.assertEqual(catalog["providers"][0]["models"], [{"id": "claude-sonnet", "name": "Claude Sonnet"}])
        self.assertEqual(catalog["providers"][0]["default_model"], "claude-sonnet")
        self.assertNotIn("secret", json.dumps(catalog))

    def test_hermes_catalog_keeps_custom_options_and_current_runtime_selection(self):
        catalog = hermes_catalog({"provider": "custom", "model": "org/local", "api_key": "private", "providers": [
            {"provider": "copilot", "name": "Copilot", "authenticated": True, "models": ["gpt-4.1"]},
            {"provider": "custom", "name": "Local", "base_url": "http://model.example/v1", "is_user_defined": True,
             "authenticated": False, "models": ["org/local", "org/local"]},
        ]})
        self.assertEqual(catalog["current"], {"provider": "custom", "model": "org/local"})
        self.assertEqual(catalog["providers"][0]["id"], "copilot")
        self.assertTrue(catalog["providers"][1]["custom"])
        self.assertEqual(len(catalog["providers"][1]["models"]), 1)
        self.assertNotIn("private", json.dumps(catalog))

    def test_custom_url_credentials_are_not_returned(self):
        catalog = hermes_catalog({"providers": [{"provider": "custom", "base_url": "http://user:secret@model.example/v1", "models": []}]})
        self.assertEqual(catalog["providers"][0]["base_url"], "")
        self.assertNotIn("secret", json.dumps(catalog))

    def test_invalid_runtime_payload_is_not_mistaken_for_an_empty_catalog(self):
        for normalizer in (hermes_catalog, opencode_catalog):
            with self.subTest(normalizer=normalizer.__name__), self.assertRaises(ValueError):
                normalizer({"error": "unavailable"})

    def test_hermes_custom_provider_api_url_is_preserved(self):
        catalog = hermes_catalog({"providers": [{"slug": "custom:local", "api_url": "http://model.example/v1", "is_user_defined": True, "models": ["org/model"]}]})
        self.assertEqual(catalog["providers"][0]["base_url"], "http://model.example/v1")
        self.assertTrue(catalog["providers"][0]["custom"])

    def test_cli_metadata_keeps_model_names_and_connected_status_without_credentials(self):
        with tempfile.TemporaryDirectory() as home:
            auth = Path(home) / ".local/share/opencode/auth.json"
            auth.parent.mkdir(parents=True)
            auth.write_text(json.dumps({"github-copilot": {"access": "private-credential"}}))
            metadata = 'github-copilot/org/model\n' + json.dumps({"id": "org/model", "name": "My Model", "apiKey": "private-model-key"}, indent=2) + '\nopencode/free-model\n{}\n'
            catalog = parse_opencode_models(metadata, {"HOME": home})
            self.assertTrue(catalog["providers"][0]["connected"])
            self.assertEqual(catalog["providers"][0]["models"], [{"id": "org/model", "name": "My Model"}])
            self.assertNotIn("private", json.dumps(catalog))

    def test_cli_finds_user_install_when_service_path_does_not_include_it(self):
        with tempfile.TemporaryDirectory() as home:
            binary = Path(home) / ".opencode/bin/opencode"
            binary.parent.mkdir(parents=True)
            binary.touch(mode=0o755)
            with patch("provider_catalog.shutil.which", return_value=None), patch("provider_catalog.subprocess.run", return_value=SimpleNamespace(stdout='opencode/free-model\n{}\n')) as run:
                catalog = opencode_cli_catalog({"HOME": home, "PATH": "/usr/bin:/bin"}, home)
            self.assertEqual(run.call_args.args[0][0], str(binary))
            self.assertEqual(catalog["providers"][0]["id"], "opencode")