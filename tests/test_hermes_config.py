import json
import tempfile
import unittest
from pathlib import Path

import yaml

from hermes_config import connection_settings, key_scope, validate_connection, write_config


class HermesConfigTests(unittest.TestCase):
    def test_saved_settings_survive_environment_defaults_and_preserve_other_config(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.yaml").write_text("model:\n  provider: custom\n  default: old\n  api_key: old-key\nmemory:\n  enabled: true\n")
            settings = home / "spatial-workbench" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({"hermes": {"provider": "openrouter", "model": "org/new", "base_url": ""},
                                            "secrets": {key_scope("openrouter", ""): "new-key"}}))
            env = {"LLM_BASE_URL": "http://old.example/v1", "LLM_MODEL": "old", "LLM_API_KEY": "old-key"}
            write_config(env, home)
            config = yaml.safe_load((home / "config.yaml").read_text())
            self.assertEqual(config["model"], {"provider": "openrouter", "default": "org/new"})
            self.assertEqual(config["providers"]["openrouter"]["api_key"], "new-key")
            self.assertTrue(config["memory"]["enabled"])
            self.assertEqual((home / "config.yaml").stat().st_mode & 0o777, 0o600)
            write_config(env, home)
            self.assertEqual(connection_settings(env, home)["model"], "org/new")

    def test_custom_endpoint_switch_does_not_reuse_previous_key(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.yaml").write_text("model:\n  provider: custom\n  api_key: old-key\n")
            settings = home / "spatial-workbench" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({"hermes": {"provider": "custom", "model": "new", "base_url": "http://new.example/v1"},
                                            "secrets": {key_scope("custom", "http://old.example/v1"): "old-key"}}))
            write_config({"LLM_API_KEY": "old-key"}, home)
            self.assertEqual(yaml.safe_load((home / "config.yaml").read_text())["model"]["api_key"], "")

    def test_unmanaged_config_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.yaml"
            original = "# user-owned\nmodel: my-model\n"
            path.write_text(original)
            write_config({}, directory)
            self.assertEqual(path.read_text(), original)

    def test_validation_rejects_unsafe_or_incomplete_connections(self):
        for connection in ({}, {"provider": "custom", "model": "ok"},
                           {"provider": "custom", "model": "ok", "base_url": "http://user:secret@host/v1"},
                           {"provider": "openai", "model": "bad model"},
                           {"provider": "openai", "model": "ok", "base_url": "http://host/v1"}):
            with self.subTest(connection=connection), self.assertRaises(ValueError):
                validate_connection(connection)