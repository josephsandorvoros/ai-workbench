import socket
import tempfile
import unittest
from pathlib import Path

from app_preview import AppPreviewManager, PreviewError


def unused_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class AppPreviewManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name) / "workspace"
        self.project = self.workspace / "demo"
        self.project.mkdir(parents=True)
        self.manager = AppPreviewManager(self.workspace)

    def tearDown(self):
        self.manager.close_all()
        self.temp_dir.cleanup()

    def test_rejects_paths_outside_workspace(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        with self.assertRaisesRegex(PreviewError, "inside the workspace"):
            self.manager.start(str(outside), "true", unused_port())

    def test_rejects_invalid_ports(self):
        with self.assertRaisesRegex(PreviewError, "between 1024 and 65535"):
            self.manager.start("demo", "true", 80)

    def test_starts_captures_logs_and_stops_process(self):
        preview = self.manager.start("demo", "printf 'preview-started\\n'; exec sleep 30", unused_port())
        session = self.manager.sessions[preview["session_id"]]
        session.reader.join(timeout=2)

        logs = self.manager.logs(preview["session_id"])
        self.assertIn("preview-started", logs["data"])
        self.assertTrue(preview["running"])
        self.assertTrue(self.manager.stop(preview["session_id"]))
        self.assertIsNotNone(session.process.poll())


if __name__ == "__main__":
    unittest.main()