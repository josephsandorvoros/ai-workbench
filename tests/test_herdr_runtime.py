import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from herdr_runtime import HerdrError, HerdrRuntime


class HerdrRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.calls = []
        self.agent = {"status": "idle", "completion_seq": None}
        self.worker_name = ""
        self.runtime = HerdrRuntime(self.temporary.name, runner=self.run_command)

    def run_command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        command = args[3:]
        if command[:2] == ["workspace", "create"]:
            self.workspace_label = command[command.index("--label") + 1]
            result = {"root_pane": {"pane_id": "w1:p1"}, "workspace": {"workspace_id": "w1"}}
        elif command[:2] == ["workspace", "get"]:
            result = {"workspace": {"workspace_id": "w1", "label": self.workspace_label}}
        elif command[:2] in (["agent", "get"], ["agent", "start"]):
            if command[1] == "start":
                self.worker_name = command[2]
            result = {"agent": {"name": self.worker_name, "pane_id": "w1:p1", **self.agent}}
        elif command[:2] == ["agent", "list"]:
            result = {"agents": []}
        else:
            result = {}
        return subprocess.CompletedProcess(args, 0, json.dumps({"result": result}), "")

    def launch(self):
        workdir = Path(self.temporary.name) / "job"
        (workdir / "comms").mkdir(parents=True, exist_ok=True)
        config = {"provider": {"custom": {"options": {"apiKey": "{env:WORKER_ENDPOINT_API_KEY}"}}}}
        return self.runtime.run_detached(["-w", str(workdir), "-e", "HOME=/tmp", "-e", "WORKER_ENDPOINT_API_KEY=private-key",
                                          "-e", "OPENCODE_CONFIG_CONTENT=" + json.dumps(config), "opencode", "run", "-m", "custom/model", "Do work"])

    def test_idle_does_not_complete_a_job_without_a_completion_record(self):
        reference = self.launch()
        self.assertEqual(self.runtime.state(reference), ("running", None))
        self.agent = {"status": "working"}
        self.runtime.state(reference)
        self.agent = {"status": "idle", "completion_seq": 1}
        self.assertEqual(self.runtime.state(reference), ("blocked", None))

    def test_completed_record_requires_attempt_identity_and_verification(self):
        reference = self.launch()
        path = Path(self.runtime._record(reference)["result_path"])
        path.write_text(json.dumps({"run_id": reference, "status": "done", "summary": "Finished", "verification": "Tests pass"}))
        self.assertEqual(self.runtime.state(reference), ("exited", 0))
        path.write_text(json.dumps({"run_id": "other", "status": "done", "summary": "Finished", "verification": "Tests pass"}))
        with self.assertRaises(ValueError):
            self.runtime.completion(reference)

    def test_worker_keys_are_not_in_launch_arguments_or_public_records(self):
        reference = self.launch()
        self.assertNotIn("private-key", json.dumps(self.calls))
        self.assertNotIn("private-key", json.dumps(self.runtime._record(reference)))
        config = json.loads((Path(self.temporary.name) / reference / "home/opencode.json").read_text())
        self.assertIn("{file:", config["provider"]["custom"]["options"]["apiKey"])
        self.assertEqual((Path(self.temporary.name) / reference / "home/WORKER_ENDPOINT_API_KEY").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls[0][1]["env"]["HERDR_SESSION"], "workbench-jobs")

    def test_restart_uses_persisted_worker_reference(self):
        reference = self.launch()
        restarted = HerdrRuntime(self.temporary.name, runner=self.run_command)
        self.assertEqual(restarted.state(reference), ("running", None))
        restarted.remove(reference)
        self.assertEqual(restarted.state(reference), ("missing", None))
        self.assertEqual(self.calls[-1][0][-3:], ["workspace", "close", "w1"])

    def test_busy_agents_do_not_receive_duplicate_prompts(self):
        reference = self.launch()
        self.agent = {"status": "working"}
        count = len(self.calls)
        with self.assertRaises(ValueError):
            self.runtime.message(reference, "Retry")
        self.assertEqual(len(self.calls), count + 1)

    def test_wrong_worker_references_are_rejected(self):
        with self.assertRaises(ValueError):
            self.runtime.state("../other")

    def test_invalid_responses_fail_closed(self):
        self.runtime.runner = lambda args, **kwargs: subprocess.CompletedProcess(args, 0, "not-json", "")
        self.assertFalse(self.runtime.ready())
        with self.assertRaises(HerdrError):
            self.runtime._call("agent", "list")

    def test_readiness_uses_the_structured_agent_list(self):
        self.assertTrue(self.runtime.ready())
        self.assertEqual(self.calls[-1][0][-2:], ["agent", "list"])

    def test_replaced_agent_cannot_receive_worker_input(self):
        reference = self.launch()
        self.agent["pane_id"] = "w2:p1"
        with self.assertRaises(HerdrError) as error:
            self.runtime.message(reference, "enter", key=True)
        self.assertEqual(error.exception.code, "worker_replaced")

    def test_cleanup_cannot_close_another_workers_workspace(self):
        reference = self.launch()
        self.workspace_label = "unrelated-user-workspace"
        with self.assertRaisesRegex(ValueError, "not owned"):
            self.runtime.remove(reference)
        self.assertNotIn(["workspace", "close", "w1"], [args[3:] for args, _ in self.calls])