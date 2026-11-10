import json
import os
import subprocess
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import jobs_engine
from jobs_engine import JobEngine, extract_json, parse_opencode_events, parse_opencode_usage


class FakeDocker:
    def __init__(self):
        self.containers = {}  # id -> [status, exit_code, logs]
        self.runs = []
        self.removed = []

    def run_detached(self, args):
        cid = f"c{len(self.runs):011d}"
        self.runs.append(args)
        self.containers[cid] = ["running", 0, ""]
        return cid

    def finish(self, cid, code=0, text="done", error=None):
        events = [json.dumps({"type": "text", "part": {"text": text}})]
        if error:
            events.append(json.dumps({"type": "error", "error": {"data": {"message": error}}}))
        self.containers[cid] = ["exited", code, "\n".join(events)]

    def state(self, cid):
        c = self.containers.get(cid)
        return (c[0], c[1]) if c else (None, None)

    def logs(self, cid, tail=None):
        return self.containers.get(cid, [None, None, ""])[2]

    def remove(self, cid):
        self.removed.append(cid)

    def ensure_image(self, image):
        self.pulled = image


class FakeHermes:
    def __init__(self, replies):
        self.replies = list(replies)
        self.prompts = []

    def __call__(self, prompt):
        self.prompts.append(prompt)
        return self.replies.pop(0)


class FakeSessionRuntime(FakeDocker):
    def ready(self):
        return True

    def message(self, reference, text, key=False):
        self.last_message = (reference, text, key)
        self.containers[reference][0] = "running"


def plan_reply(n=2, clear=True, questions=None):
    return "Sure!\n```json\n" + json.dumps({
        "clear": clear, "questions": questions or [],
        "plan": {"summary": "split it", "subtasks": [{"title": f"part {i}", "instructions": f"do part {i}"} for i in range(n)]},
    }) + "\n```"


def plan_reply_dag():
    """A two-subtask plan where subtask 1 depends on subtask 0."""
    return "Sure!\n```json\n" + json.dumps({
        "clear": True, "questions": [],
        "plan": {"summary": "dag", "subtasks": [
            {"title": "part 0", "instructions": "do part 0", "depends_on": []},
            {"title": "part 1", "instructions": "do part 1", "depends_on": [0]},
        ]},
    }) + "\n```"


def wave_review_reply(finish, subtasks=None, note=""):
    """A wave-review reply: finish the job, or append new subtasks for the next wave."""
    return "```json\n" + json.dumps({
        "finish": finish, "note": note, "subtasks": subtasks or [],
    }) + "\n```"


def plan_reply_missing_dep():
    """A two-subtask plan where subtask 1 references subtask 0's output in prose but leaves
    depends_on empty — the failure mode the dependency-repair safety net fixes."""
    return "```json\n" + json.dumps({
        "clear": True, "questions": [],
        "plan": {"summary": "calc", "subtasks": [
            {"title": "Create calculator module",
             "instructions": "Create artifacts/calculator.py with add, subtract, multiply, divide.",
             "depends_on": []},
            {"title": "Create tests",
             "instructions": "Create artifacts/test_calculator.py that imports calculator from the prior step and runs it.",
             "depends_on": []},
        ]},
    }) + "\n```"


def deps_fix_reply(depends_on=[0]):
    """The corrected plan re-emitted by the dependency-repair prompt."""
    return "```json\n" + json.dumps({
        "plan": {"summary": "calc", "subtasks": [
            {"title": "Create calculator module",
             "instructions": "Create artifacts/calculator.py with add, subtract, multiply, divide.",
             "depends_on": []},
            {"title": "Create tests",
             "instructions": "Create artifacts/test_calculator.py that imports calculator from the prior step and runs it.",
             "depends_on": depends_on},
        ]},
    }) + "\n```"


class JobEngineTests(unittest.TestCase):
    def test_herdr_workers_resume_in_place_without_docker_or_requeue(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr = FakeSessionRuntime()
        engine.settings["sandbox"] = False
        job = engine.create("Persistent task", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        sub = engine.get_job(job["id"])["subtasks"][0]
        reference = sub["container"]
        self.assertFalse(sub["attempts"][0]["usage_available"])
        self.assertIsNone(sub["attempts"][0]["input_tokens"])
        engine.herdr.containers[reference][0] = "blocked"
        engine._check_workers()
        self.assertEqual(engine.get_job(job["id"])["subtasks"][0]["status"], "waiting_input")
        engine.message_worker(job["id"], 0, "Continue with the smaller scope")
        self.assertEqual(engine.herdr.last_message, (reference, "Continue with the smaller scope", False))
        self.assertEqual(engine.get_job(job["id"])["subtasks"][0]["container"], reference)
        self.assertEqual(len(engine.herdr.runs), 1)
        self.assertEqual(self.docker.runs, [])
        self.assertNotIn("one-shot", engine.herdr.runs[0][-1])
        engine.herdr.finish(reference, text="Complete")
        engine._check_workers()
        result = engine.get_job(job["id"])["subtasks"][0]
        self.assertEqual(result["status"], "done")
        self.assertFalse(result["attempts"][0]["usage_available"])
        self.assertIsNone(result["attempts"][0]["input_tokens"])
        self.assertEqual(engine.herdr.removed, [])
        engine.stop(job["id"])

    def test_herdr_budget_accounting_is_not_faked(self):
        engine = self.engine([])
        with self.assertRaisesRegex(ValueError, "accounting"):
            engine.create("Bounded work", "go", execution_runtime="herdr", token_budget=100)

    def test_paused_herdr_worker_still_times_out(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr = FakeSessionRuntime()
        job = engine.create("Paused work", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        reference = engine.get_job(job["id"])["subtasks"][0]["container"]
        engine.herdr.containers[reference][0] = "blocked"
        engine._check_workers()
        with engine._db() as db:
            db.execute("UPDATE jobs SET started_at=1 WHERE id=?", (job["id"],))
        engine._check_workers()
        self.assertEqual(engine.get_job(job["id"])["subtasks"][0]["status"], "timeout")
        self.assertIn(reference, engine.herdr.removed)

    def test_stopping_herdr_preserves_the_last_screen_and_attempt(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr = FakeSessionRuntime()
        job = engine.create("Stop safely", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        reference = engine.get_job(job["id"])["subtasks"][0]["container"]
        engine.herdr.containers[reference][2] = "Last worker screen"
        engine.stop(job["id"])
        sub = engine.get_job(job["id"])["subtasks"][0]
        self.assertEqual(sub["attempts"][0]["status"], "stopped")
        self.assertEqual(engine.subtask_log(job["id"], 0), "Last worker screen")

    def test_summary_uses_the_actual_job_root_and_artifact_manifest(self):
        engine = self.engine([plan_reply(1), "Summary"])
        job = engine.create("Real paths", "go")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        artifact = engine.job_dir(job["id"]) / "subtask-1/artifacts/note.txt"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("ready")
        self.docker.finish(engine.get_job(job["id"])["subtasks"][0]["container"])
        self.settle(engine)
        self.assertIn(str(engine.job_dir(job["id"]).resolve()), engine.hermes.prompts[-1])
        self.assertIn("subtask-1/artifacts/note.txt", engine.hermes.prompts[-1])

    def test_invalid_herdr_status_does_not_disable_timeout(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr = FakeSessionRuntime()
        job = engine.create("Malformed result", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        reference = engine.get_job(job["id"])["subtasks"][0]["container"]
        with engine._db() as db:
            db.execute("UPDATE jobs SET started_at=1 WHERE id=?", (job["id"],))
        with patch.object(engine.herdr, "state", side_effect=ValueError("Invalid completion")):
            engine._check_workers()
        self.assertEqual(engine.get_job(job["id"])["subtasks"][0]["status"], "timeout")
        self.assertIn(reference, engine.herdr.removed)

    def test_invalid_herdr_log_does_not_prevent_stop(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr = FakeSessionRuntime()
        job = engine.create("Unreadable result", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        reference = engine.get_job(job["id"])["subtasks"][0]["container"]
        with patch.object(engine.herdr, "logs", side_effect=ValueError("Invalid completion")):
            engine.stop(job["id"])
        self.assertEqual(engine.get_job(job["id"])["stage"], "stopped")
        self.assertIn(reference, engine.herdr.removed)

    def test_unavailable_herdr_does_not_fall_back_to_docker(self):
        engine = self.engine([plan_reply(1)])
        engine.herdr.ready = lambda: False
        job = engine.create("Herdr only", "go", execution_runtime="herdr")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "failed")
        self.assertEqual(self.docker.runs, [])

    def test_execution_runtime_is_snapshotted_per_job(self):
        engine = self.engine([])
        docker_job = engine.create("Existing execution", "go")
        engine.settings["execution_runtime"] = "herdr"
        herdr_job = engine.create("Local execution", "go")
        self.assertEqual(engine.get_job(docker_job["id"])["execution_runtime"], "docker")
        self.assertEqual(herdr_job["execution_runtime"], "herdr")
        self.assertEqual(engine.create("Explicit execution", "go", execution_runtime="docker")["execution_runtime"], "docker")

    def test_unknown_execution_runtime_is_rejected(self):
        engine = self.engine([])
        with self.assertRaisesRegex(ValueError, "Worker runtime"):
            engine.create("Unknown runtime", "go", execution_runtime="other")

    def test_hosted_profile_does_not_receive_another_providers_default_key(self):
        engine = self.engine([])
        engine.worker_config = lambda: {"model": "anthropic/default", "base_url": "", "api_key": "anthropic-secret",
                                         "keys": {"WORKER_OPENAI_API_KEY": "profile-openai-secret"}}
        profile = engine.save_profile({"name": "OpenAI", "model": "openai/model"})
        with patch.dict(os.environ, {}, clear=True):
            args = engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=profile)
            self.assertNotIn("anthropic-secret", " ".join(args))
            profile = engine.save_profile({**profile, "base_url": "", "api_key_env": "WORKER_OPENAI_API_KEY"})
            args = engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=profile)
        self.assertIn("OPENAI_API_KEY=profile-openai-secret", args)
        self.assertNotIn("anthropic-secret", " ".join(args))

    def test_profile_endpoint_and_key_reference_are_snapshotted(self):
        engine = self.engine([plan_reply(1)])
        profile = engine.save_profile({"name": "Private coder", "model": "org/coder",
                                       "base_url": "http://private.example/v1", "api_key_env": "WORKER_CODER_API_KEY"})
        job = engine.create("Private work", "go", profile_id=profile["id"])
        engine.save_profile({**profile, "base_url": "http://other.example/v1", "model": "other"})
        self.settle(engine)
        with patch.dict(os.environ, {"WORKER_CODER_API_KEY": "coder-secret"}):
            engine.approve(job["id"])
            self.settle(engine)
        snapshot = engine.get_job(job["id"])["subtasks"][0]["profile_snapshot"]
        self.assertEqual(snapshot["base_url"], "http://private.example/v1")
        self.assertEqual(snapshot["api_key_env"], "WORKER_CODER_API_KEY")
        self.assertNotIn("coder-secret", json.dumps(engine.get_job(job["id"])))
        self.assertNotIn("coder-secret", json.dumps(engine.list_profiles()))
        args = self.docker.runs[0]
        self.assertIn("custom/org/coder", args)
        self.assertIn("WORKER_ENDPOINT_API_KEY=coder-secret", args)
        self.assertIn("http://private.example/v1", " ".join(args))

    def test_profile_endpoint_validation_and_missing_key_fail_closed(self):
        engine = self.engine([])
        for url in ("file:///tmp/model", "http://user:secret@model.example/v1", "http://model.example:bad/v1", "http://model.example/v1 bad"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                engine.save_profile({"name": "Bad endpoint", "base_url": url})
        with self.assertRaises(ValueError):
            engine.save_profile({"name": "Bad key", "api_key_env": "API_SERVER_KEY"})
        profile = engine.save_profile({"name": "Missing key", "base_url": "http://model.example/v1",
                                       "api_key_env": "WORKER_MISSING_API_KEY"})
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(RuntimeError):
            engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=profile)

    def test_profile_can_inherit_private_default_or_select_hosted_provider(self):
        engine = self.engine([])
        self.settings.update(worker_model="private-coder", worker_base_url="http://private.example/v1")
        inherited = engine.save_profile({"name": "Inherited"})
        hosted = engine.save_profile({"name": "Hosted", "model": "openai/gpt-model", "base_url": ""})
        with patch.dict(os.environ, {"OPENAI_API_KEY": "hosted-key", "WORKER_API_KEY": "private-key"}):
            inherited_args = engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=inherited)
            hosted_args = engine._worker_args("j2", {"idx": 0, "instructions": "go"}, profile=hosted)
        self.assertIn("custom/private-coder", inherited_args)
        self.assertIn("openai/gpt-model", hosted_args)
        self.assertIn("OPENAI_API_KEY=hosted-key", hosted_args)
        self.assertNotIn("WORKER_ENDPOINT_API_KEY=private-key", hosted_args)
        self.assertNotIn("OPENAI_API_KEY=hosted-key", inherited_args)
        for args in (inherited_args, hosted_args):
            config = json.loads(next(value.partition("=")[2] for value in args if value.startswith("OPENCODE_CONFIG_CONTENT=")))
            self.assertNotIn("enabled_providers", config)
            self.assertIn("permission", config)

    def test_existing_worker_profiles_gain_endpoint_fields_without_losing_rows(self):
        with tempfile.TemporaryDirectory() as root:
            db_path = Path(root) / "jobs.db"
            with sqlite3.connect(db_path) as db:
                db.execute("CREATE TABLE worker_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, instructions TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL, permission_preset TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
                db.execute("INSERT INTO worker_profiles VALUES ('old', 'Existing', '', 'opencode', 'opencode/big-pickle', '[]', 'guarded', 1, 1)")
            engine = JobEngine(db_path, Path(root) / "workspace", lambda prompt: "")
            profile = engine.get_profile("old")
            self.assertEqual(profile["model"], "opencode/big-pickle")
            self.assertIsNone(profile["base_url"])
            self.assertIsNone(profile["api_key_env"])

    def test_default_worker_custom_endpoint_keeps_key_out_of_config(self):
        engine = self.engine([])
        self.settings.update(worker_model="org/private-coder", worker_base_url="http://model.example/v1")
        with patch.dict(os.environ, {"WORKER_API_KEY": "private-worker-key"}):
            args = engine._worker_args("j1", {"idx": 0, "instructions": "go"})
        self.assertIn("custom/org/private-coder", args)
        config = json.loads(next(value.partition("=")[2] for value in args
                                 if value.startswith("OPENCODE_CONFIG_CONTENT=")))
        self.assertEqual(config["provider"]["custom"]["options"], {
            "baseURL": "http://model.example/v1", "apiKey": "{env:WORKER_ENDPOINT_API_KEY}",
        })
        self.assertNotIn("enabled_providers", config)
        self.assertEqual(config["share"], "disabled")
        self.assertNotIn("private-worker-key", json.dumps(config))
        self.assertIn("WORKER_ENDPOINT_API_KEY=private-worker-key", args)

    def test_existing_jobs_gain_empty_attachments_without_losing_rows(self):
        with tempfile.TemporaryDirectory() as root:
            db_path = Path(root) / "jobs.db"
            with sqlite3.connect(db_path) as db:
                db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT, description TEXT, stage TEXT, detail TEXT, created_at REAL, updated_at REAL, started_at REAL, finished_at REAL, questions TEXT, answers TEXT, plan TEXT, summary TEXT, error TEXT, archived INTEGER DEFAULT 0)")
                db.execute("INSERT INTO jobs (id, title, stage) VALUES ('old', 'Existing job', 'done')")
            engine = JobEngine(db_path, Path(root) / "workspace", lambda prompt: "")
            self.assertEqual(engine.get_job("old")["attachments"], [])
            self.assertEqual(engine.get_job("old")["execution_runtime"], "docker")
            self.assertEqual(engine.get_job("old")["skills"], [])
            self.assertEqual(engine.list_jobs()[0]["title"], "Existing job")

    def test_missing_attachment_fails_review_without_running_workers(self):
        engine = self.engine([plan_reply(1)])
        uploads = engine.workspace_root / "uploads"
        uploads.mkdir(parents=True)
        source = uploads / "spec.md"
        source.write_text("# Spec\n", encoding="utf-8")
        job = engine.create("Use spec", "Write a report", [str(source)])
        (engine.job_dir(job["id"]) / "inputs" / source.name).unlink()
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "failed")
        self.assertIn("attachment", engine.get_job(job["id"])["error"])
        self.assertEqual(self.docker.runs, [])

    def test_output_symlink_cannot_expose_other_files(self):
        engine = self.engine([plan_reply(1)])
        job = engine.create("Write", "a report")
        self.settle(engine)
        engine.approve(job["id"])
        output_dir = engine.job_dir(job["id"]) / "subtask-1" / "artifacts"
        output_dir.mkdir(parents=True)
        (output_dir / "report.txt").write_text("report", encoding="utf-8")
        (output_dir.parent / "scratch.txt").write_text("intermediate", encoding="utf-8")
        secret = Path(self.tmp.name) / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        (output_dir / "secret.txt").symlink_to(secret)
        self.assertEqual(engine.job_files(job["id"]), [{"path": "subtask-1/artifacts/report.txt", "size": 6}])
        self.assertIsNone(engine.output_file(job["id"], "subtask-1/artifacts/secret.txt"))
        self.assertIsNone(engine.output_file(job["id"], "subtask-1/scratch.txt"))
        self.assertIsNone(engine.output_file(job["id"], "../secret.txt"))

    def test_selected_skill_is_staged_without_hidden_files_or_symlinks(self):
        engine = self.engine([plan_reply(1)])
        skill = Path(self.tmp.name) / "skills" / "devops" / "sample"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# Sample skill", encoding="utf-8")
        (skill / "scripts").mkdir()
        (skill / "scripts" / "run.sh").write_text("echo ready", encoding="utf-8")
        (skill / ".env").write_text("SECRET=value", encoding="utf-8")
        secret = Path(self.tmp.name) / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        (skill / "scripts" / "secret.txt").symlink_to(secret)
        engine.skills_root = Path(self.tmp.name) / "skills"
        job = engine.create("Use the skill", "do work", skills=[str(skill / "SKILL.md")])
        snapshot = engine.job_dir(job["id"]) / "skills" / "devops" / "sample"
        self.assertEqual(job["skills"], ["devops/sample"])
        self.assertTrue((snapshot / "SKILL.md").is_file())
        self.assertTrue((snapshot / "scripts" / "run.sh").is_file())
        self.assertFalse((snapshot / ".env").exists())
        self.assertFalse((snapshot / "scripts" / "secret.txt").exists())
        with self.assertRaises(ValueError):
            engine.create("Invalid", "skill", skills=[str(secret)])
        self.settle(engine)
        self.assertIn("devops/sample", self.hermes.prompts[0])
        engine.approve(job["id"])
        self.settle(engine)
        config = next(value for value in self.docker.runs[0] if value.startswith("OPENCODE_CONFIG_CONTENT="))
        self.assertEqual(json.loads(config.partition("=")[2])["skills"]["paths"], [f"/workspace/jobs/{job['id']}/skills"])

    def test_worker_profile_is_snapshotted_at_job_creation(self):
        engine = self.engine([plan_reply(1)])
        profile = engine.save_profile({
            "name": "Research analyst",
            "instructions": "Use evidence and cite sources.",
            "runtime": "opencode",
            "model": "opencode/big-pickle",
            "skills": [],
            "permission_preset": "guarded",
        })
        job = engine.create("Profile snapshot", "Research this", profile_id=profile["id"])
        engine.save_profile({
            **profile,
            "instructions": "Ignore evidence and make guesses.",
            "model": "opencode/deepseek-v4-flash-free",
            "permission_preset": "trusted",
        })

        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)

        saved_job = engine.get_job(job["id"])
        snapshot = saved_job["subtasks"][0]["profile_snapshot"]
        self.assertEqual(snapshot["model"], "opencode/big-pickle")
        self.assertEqual(snapshot["instructions"], "Use evidence and cite sources.")
        args = self.docker.runs[0]
        self.assertIn("opencode/big-pickle", args)
        self.assertIn("Use evidence and cite sources.", args[-1])
        config = next(value for value in args if value.startswith("OPENCODE_CONFIG_CONTENT="))
        self.assertIn('"git push*": "deny"', config)

    def test_trusted_worker_profile_cannot_override_global_auto_approve_gate(self):
        engine = self.engine([])
        profile = {
            "instructions": "Trusted role",
            "model": "opencode/big-pickle",
            "permission_preset": "trusted",
        }
        guarded_args = engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=profile)
        guarded_config = next(value for value in guarded_args if value.startswith("OPENCODE_CONFIG_CONTENT="))
        self.assertIn('"git push*": "deny"', guarded_config)

        self.settings.update(auto_approve=True)
        trusted_args = engine._worker_args("j1", {"idx": 0, "instructions": "go"}, profile=profile)
        trusted_config = next(value for value in trusted_args if value.startswith("OPENCODE_CONFIG_CONTENT="))
        self.assertEqual(json.loads(trusted_config.split("=", 1)[1])["permission"]["bash"], "allow")

    def test_top_level_hermes_skill_is_staged(self):
        engine = self.engine([])
        engine.skills_root = Path(self.tmp.name) / "skills"
        skill = engine.skills_root / "archify"
        skill.mkdir(parents=True)
        source = skill / "SKILL.md"
        source.write_text("# Archify", encoding="utf-8")
        job = engine.create("Diagram", "Use archify", skills=[str(source)])
        self.assertEqual(job["skills"], ["archify"])
        self.assertEqual((engine.job_dir(job["id"]) / "skills" / "archify" / "SKILL.md").read_text(), "# Archify")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.docker = FakeDocker()
        self.settings = JobEngine.settings_from_env()
        self.settings.update(sandbox=True, plan_gate=True, max_workers_per_job=3, max_workers_total=4,
                             max_parallel_jobs=2, worker_uid="10000", job_timeout_minutes=30)

    def test_hermes_and_jobs_sandbox_settings_are_independent(self):
        original = {key: os.environ.get(key) for key in ("AGENT_SANDBOX", "JOBS_SANDBOX")}
        try:
            os.environ["AGENT_SANDBOX"] = "0"
            os.environ["JOBS_SANDBOX"] = "1"
            settings = JobEngine.settings_from_env()
            self.assertTrue(settings["sandbox"])
            os.environ["JOBS_SANDBOX"] = "0"
            self.assertFalse(JobEngine.settings_from_env()["sandbox"])
        finally:
            for key, value in original.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def tearDown(self):
        self.tmp.cleanup()

    def engine(self, replies):
        self.hermes = FakeHermes(replies)
        return JobEngine(Path(self.tmp.name) / "jobs.db", Path(self.tmp.name) / "ws", self.hermes, self.docker, self.settings)

    def _git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)

    def _project_repo(self, engine):
        repo = engine.workspace_root / "projects" / "sample"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-b", "main", str(repo)], capture_output=True, text=True, check=True)
        self._git(repo, "config", "user.name", "Workbench Test")
        self._git(repo, "config", "user.email", "workbench-test@example.invalid")
        (repo / "README.md").write_text("# Sample\n", encoding="utf-8")
        self._git(repo, "add", "README.md")
        self._git(repo, "commit", "-m", "initial project")
        return repo

    def _completed_project_job(self, engine):
        repo = self._project_repo(engine)
        self._git(repo, "remote", "add", "origin", "https://github.com/acme/sample.git")
        job = engine.create("Publish sample", "Add a project note", project_path=str(repo), base_branch="main")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        worktree = engine.job_dir(job["id"]) / "subtask-1" / "repo-attempt-1"
        (worktree / "note.md").write_text("Project change\n", encoding="utf-8")
        self._git(worktree, "add", "note.md")
        self._git(worktree, "commit", "-m", "add project note")
        self.docker.finish(self._running_cid(), text="completed project change")
        self.settle(engine)
        engine.git_credentials = lambda host: {
            "host": host, "provider": "github", "username": "x-access-token", "token": "test-secret",
        }
        return job, repo

    def settle(self, engine, rounds=6):
        for _ in range(rounds):
            engine.tick()
            deadline = time.time() + 2
            while engine._busy and time.time() < deadline:
                time.sleep(0.01)

    def settle_comms(self, engine, rounds=6):
        """settle() that also waits for in-flight comms (question-answering) threads."""
        for _ in range(rounds):
            engine.tick()
            deadline = time.time() + 2
            while (engine._busy or engine._comms_busy) and time.time() < deadline:
                time.sleep(0.01)

    def _comms_dir(self, job_id):
        # Comms live inside the subtask workdir (see engine._comms_dir).
        return Path(self.tmp.name) / "ws" / "jobs" / job_id / "subtask-1" / "comms"

    def _running_cid(self):
        # FakeDocker.remove() does not drop the id from .containers, so pick the
        # live one by status rather than by insertion order.
        return next(c for c, state in self.docker.containers.items() if state[0] == "running")

    def test_worker_question_gets_answered_and_reruns(self):
        engine = self.engine([plan_reply(1), "Use ISO 8601 timestamps.", "# Report\ndone"])
        job = engine.create("Ask", "x")
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "planned")
        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 1)
        cid = self._running_cid()

        # Worker hits a blocker: writes question.json and exits.
        comms = self._comms_dir(job["id"])
        comms.mkdir(parents=True, exist_ok=True)
        (comms / "question.json").write_text(json.dumps({"id": "ts-format", "question": "Which timestamp format?"}), encoding="utf-8")
        self.docker.finish(cid, text="blocked, asked a question")
        self.settle_comms(engine)

        # Engine answered and re-queued; a fresh container is now running.
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "running")
        self.assertEqual(len(self.docker.runs), 2)
        new_cid = self._running_cid()
        self.assertNotEqual(new_cid, cid)
        self.assertTrue((comms / "answer.json").is_file())
        self.assertFalse((comms / "question.json").exists())

        # Worker reads the answer and finishes.
        self.docker.finish(new_cid, text="result with ISO timestamps")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")

        comms_state = engine.job_comms(job["id"])
        self.assertTrue(comms_state["ok"])
        self.assertEqual(len(comms_state["threads"]), 1)
        thread = comms_state["threads"][0]
        self.assertEqual(thread["rounds"], 1)
        self.assertIsNone(thread["pending"])
        self.assertEqual(len(thread["entries"]), 2)
        self.assertEqual(thread["entries"][0]["question"], "Which timestamp format?")
        self.assertEqual(thread["entries"][1]["answer"], "Use ISO 8601 timestamps.")

    def test_worker_question_loop_guard_fails_after_max_rounds(self):
        self.settings.update(max_comms_rounds=1)
        engine = self.engine([plan_reply(1), "Use ISO 8601.", "summary"])
        job = engine.create("Ask", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid = self._running_cid()
        comms = self._comms_dir(job["id"])
        comms.mkdir(parents=True, exist_ok=True)

        # Round 1: worker asks, engine answers, re-queues.
        (comms / "question.json").write_text(json.dumps({"id": "q1", "question": "Which format?"}), encoding="utf-8")
        self.docker.finish(cid, text="blocked")
        self.settle_comms(engine)
        cid = self._running_cid()
        self.assertTrue((comms / "answer.json").is_file())

        # Round 2: worker asks again. rounds would become 2 > max(1) -> failed.
        (comms / "question.json").write_text(json.dumps({"id": "q2", "question": "Which format, really?"}), encoding="utf-8")
        self.docker.finish(cid, text="blocked again")
        self.settle_comms(engine)

        job = engine.get_job(job["id"])
        sub = job["subtasks"][0]
        self.assertEqual(sub["status"], "failed")
        self.assertIn("still blocked after 1 clarification round(s)", sub["error"])
        self.assertEqual(sub["rounds"], 1)

    def test_stop_during_worker_clarification_does_not_requeue_subtask(self):
        engine = self.engine([plan_reply(1)])
        job = engine.create("Stop clarification", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid = self._running_cid()
        comms = self._comms_dir(job["id"])
        comms.mkdir(parents=True, exist_ok=True)
        (comms / "question.json").write_text(json.dumps({"id": "q1", "question": "Which format?"}), encoding="utf-8")
        self.docker.finish(cid, text="blocked")
        engine._check_workers()

        entered = threading.Event()
        release = threading.Event()

        def blocked_hermes(prompt):
            entered.set()
            release.wait(timeout=3)
            return "Use ISO 8601."

        engine.hermes = blocked_hermes
        engine._dispatch_comms()
        self.assertTrue(entered.wait(timeout=2))
        try:
            engine.stop(job["id"])
        finally:
            release.set()
        deadline = time.time() + 2
        while engine._comms_busy and time.time() < deadline:
            time.sleep(0.01)

        stopped = engine.get_job(job["id"])
        self.assertEqual(stopped["stage"], "stopped")
        self.assertEqual(stopped["subtasks"][0]["status"], "stopped")
        self.assertFalse((comms / "answer.json").exists())

    def test_move_running_job_to_inbox_stops_workers(self):
        engine = self.engine([plan_reply(1)])
        job = engine.create("Move running job", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid = self._running_cid()

        moved = engine.move(job["id"], "inbox")

        self.assertEqual(moved["stage"], "inbox")
        self.assertEqual(moved["subtasks"][0]["status"], "stopped")
        self.assertIn(cid, self.docker.removed)

    def test_full_lifecycle_with_plan_gate(self):
        engine = self.engine([plan_reply(2), "# Report\nall good"])
        job = engine.create("Benchmark sorts", "compare two sorts")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "planned")
        self.assertEqual(len(job["plan"]["subtasks"]), 2)
        self.assertEqual(self.docker.runs, [])  # gate holds workers back

        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 2)
        args = self.docker.runs[0]
        self.assertIn("--cap-drop", args)
        self.assertIn("opencode/big-pickle", args)
        self.assertTrue(any(a.startswith("OPENCODE_CONFIG_CONTENT=") and '"git push*": "deny"' in a for a in args))
        self.assertTrue((Path(self.tmp.name) / "ws" / "jobs" / job["id"] / "subtask-1").is_dir())

        for cid in list(self.docker.containers):
            self.docker.finish(cid, text=f"result from {cid}")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")
        self.assertEqual(job["summary"], "# Report\nall good")
        self.assertIn("result from", self.hermes.prompts[-1])
        self.assertTrue((Path(self.tmp.name) / "ws" / "jobs" / job["id"] / ".logs" / "subtask-1-attempt-1.jsonl").exists())
        stages = [e["message"].split(":")[0] for e in job["events"] if e["kind"] == "stage"]
        self.assertEqual(stages, ["inbox", "review", "planned", "running", "collating", "done"])

    def test_done_job_writes_title_txt_into_job_folder(self):
        engine = self.engine([plan_reply(1), "# Report\ndone"])
        job = engine.create("Pieter Teeling 2", "a task")
        job_id = job["id"]
        label = engine.job_dir(job_id) / "Pieter Teeling 2.txt"

        # No label file until the job is done.
        self.assertFalse(label.is_file())
        self.settle(engine)
        engine.approve(job_id)
        self.settle(engine)  # let the worker start
        self.assertFalse(label.is_file())

        for cid in list(self.docker.containers):
            self.docker.finish(cid, text="result")
        self.settle(engine)
        self.assertEqual(engine.get_job(job_id)["stage"], "done")

        self.assertTrue(label.is_file())
        lines = label.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines, ["title: Pieter Teeling 2", f"id: {job_id}"])

    def test_delete_removes_job_rows_and_files(self):
        engine = self.engine([plan_reply(1), "# Report\ndone"])
        job = engine.create("Pieter Teeling 2", "a task")
        job_id = job["id"]
        job_dir = engine.job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "Pieter Teeling 2.txt").write_text("title: Pieter Teeling 2\n", encoding="utf-8")

        self.settle(engine)
        engine.approve(job_id)
        self.settle(engine)  # let the worker start

        # Active jobs cannot be deleted.
        with self.assertRaises(ValueError):
            engine.delete(job_id)

        for cid in list(self.docker.containers):
            self.docker.finish(cid, text="result")
        self.settle(engine)
        self.assertEqual(engine.get_job(job_id)["stage"], "done")

        engine.delete(job_id)
        self.assertIsNone(engine.get_job(job_id))
        self.assertNotIn(job_id, [j["id"] for j in engine.list_jobs(include_archived=True)])
        self.assertFalse(job_dir.exists())

        with self.assertRaises(ValueError):
            engine.delete(job_id)  # already gone

    def test_unclear_request_asks_questions_then_replans(self):
        engine = self.engine([plan_reply(clear=False, questions=["Which language?"]), plan_reply(1)])
        job = engine.create("Build it", "")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "needs_input")
        self.assertEqual(job["questions"], ["Which language?"])
        engine.answer(job["id"], ["Python"])
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "planned")
        self.assertIn("A: Python", self.hermes.prompts[-1])

    def test_no_gate_auto_runs_and_caps_workers(self):
        self.settings.update(plan_gate=False, max_workers_total=2)
        engine = self.engine([plan_reply(3)])
        engine.create("Big", "x")
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 2)  # third waits for a slot
        self.docker.finish(next(iter(self.docker.containers)))
        self.settle(engine, rounds=2)
        self.assertEqual(len(self.docker.runs), 3)

    def test_failures_timeout_stop_retry_archive(self):
        self.settings.update(plan_gate=False)
        engine = self.engine([plan_reply(1), "summary"])
        job = engine.create("Fails", "x")
        self.settle(engine)
        cid = next(iter(self.docker.containers))
        self.docker.finish(cid, code=1, text="", error="FreeTierError")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "failed")
        self.assertIn("FreeTierError", job["subtasks"][0]["error"])

        engine.retry(job["id"])
        self.hermes.replies = [plan_reply(1)]
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "running")
        with self.assertRaises(ValueError):
            engine.archive(job["id"])
        engine.stop(job["id"])
        self.assertEqual(engine.get_job(job["id"])["stage"], "stopped")
        engine.archive(job["id"])
        self.assertEqual(engine.list_jobs(), [])

    def test_failed_worker_can_be_retried_with_attempt_history(self):
        engine = self.engine([plan_reply(1), "first summary", "second summary"])
        job = engine.create("Retry worker", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        first_cid = self._running_cid()
        self.docker.finish(first_cid, code=1, text="failed attempt", error="temporary")
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "failed")

        engine.retry_subtask(job["id"], 0)
        self.settle(engine)
        second_cid = self._running_cid()
        self.assertNotEqual(first_cid, second_cid)
        self.docker.finish(second_cid, text="successful attempt")
        self.settle(engine)

        retried = engine.get_job(job["id"])
        self.assertEqual(retried["stage"], "done")
        attempts = retried["subtasks"][0]["attempts"]
        self.assertEqual([item["status"] for item in attempts], ["failed", "done"])
        self.assertTrue(Path(attempts[0]["log_path"]).is_file())
        self.assertTrue(Path(attempts[1]["log_path"]).is_file())

    def test_project_worker_uses_isolated_worktree_and_merges_explicitly(self):
        engine = self.engine([plan_reply(1), "summary"])
        repo = self._project_repo(engine)
        job = engine.create("Update sample", "Add a project note", project_path=str(repo), base_branch="main")
        self.assertEqual(job["project_path"], str(repo))
        self.assertEqual(job["base_branch"], "main")
        relative_job = engine.create("Relative project", "Use workspace path", project_path="projects/sample", base_branch="main")
        self.assertEqual(relative_job["project_path"], str(repo))
        engine.stop(relative_job["id"])
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)

        worktree = engine.job_dir(job["id"]) / "subtask-1" / "repo-attempt-1"
        self.assertTrue((worktree / "README.md").is_file())
        self.assertIn("repo-attempt-1", self.docker.runs[0][-1])
        (worktree / "note.md").write_text("Project change\n", encoding="utf-8")
        self._git(worktree, "add", "note.md")
        self._git(worktree, "commit", "-m", "add project note")
        self.docker.finish(self._running_cid(), text="completed project change")
        self.settle(engine)

        changes = engine.project_changes(job["id"], 0)
        self.assertIn("A\tnote.md", changes["files"])
        self.assertIn("+Project change", changes["diff"])
        self.assertFalse(changes["diff_truncated"])
        self.assertFalse(changes["uncommitted"])
        readme = worktree / "README.md"
        readme.write_text("# Sample\n\nUncommitted review change\n", encoding="utf-8")
        dirty_changes = engine.project_changes(job["id"], 0)
        self.assertIn("+Uncommitted review change", dirty_changes["working_diff"])
        self.assertFalse(dirty_changes["working_diff_truncated"])
        with self.assertRaisesRegex(ValueError, "uncommitted project work"):
            engine.delete(job["id"])
        readme.write_text("# Sample\n", encoding="utf-8")
        engine.merge_project_worker(job["id"], 0)
        self.assertEqual((repo / "note.md").read_text(encoding="utf-8"), "Project change\n")
        with self.assertRaises(ValueError):
            engine.merge_project_worker(job["id"], 0)
        engine.delete(job["id"])
        self.assertFalse(worktree.exists())

    def test_project_worker_publish_is_explicit_and_idempotent(self):
        engine = self.engine([plan_reply(1), "summary"])
        job, _ = self._completed_project_job(engine)
        with patch.object(jobs_engine.git_remote, "push_branch") as push, patch.object(
            jobs_engine.git_remote, "create_review_request",
            return_value={"url": "https://github.com/acme/sample/pull/12", "provider": "github", "number": 12, "title": "Changes"},
        ) as create_review:
            result = engine.publish_project_worker(job["id"], 0, "Changes", "Review details")
            again = engine.publish_project_worker(job["id"], 0, "Changes", "Review details")
        self.assertEqual(result["url"], "https://github.com/acme/sample/pull/12")
        self.assertTrue(again["already_exists"])
        self.assertEqual(push.call_count, 1)
        self.assertEqual(create_review.call_count, 1)
        saved = engine.get_job(job["id"])["subtasks"][0]["attempts"][0]
        self.assertEqual(saved["project_review_url"], result["url"])
        self.assertEqual(saved["project_publish_state"], "published")
        self.assertNotIn("test-secret", json.dumps(engine.get_job(job["id"])))

    def test_project_worker_publish_retries_review_after_branch_push(self):
        engine = self.engine([plan_reply(1), "summary"])
        job, _ = self._completed_project_job(engine)
        with patch.object(jobs_engine.git_remote, "push_branch") as push, patch.object(
            jobs_engine.git_remote, "create_review_request",
            side_effect=[jobs_engine.git_remote.GitRemoteError("Git host unavailable"),
                         {"url": "https://github.com/acme/sample/pull/13", "provider": "github", "number": 13, "title": "Changes"}],
        ) as create_review:
            with self.assertRaisesRegex(ValueError, "Git host unavailable"):
                engine.publish_project_worker(job["id"], 0, "Changes")
            after_failure = engine.get_job(job["id"])["subtasks"][0]["attempts"][0]
            self.assertEqual(after_failure["project_publish_state"], "pushed")
            result = engine.publish_project_worker(job["id"], 0, "Changes")
        self.assertEqual(result["url"], "https://github.com/acme/sample/pull/13")
        self.assertEqual(push.call_count, 1)
        self.assertEqual(create_review.call_count, 2)

    def test_job_mutations_are_blocked_while_worker_branch_is_publishing(self):
        engine = self.engine([])
        job = engine.create("Publish lock", "description")
        engine._publish_busy.add((job["id"], 0))
        try:
            for operation in (
                lambda: engine.move(job["id"], "inbox"),
                lambda: engine.retry(job["id"]),
                lambda: engine.retry_subtask(job["id"], 0),
                lambda: engine.archive(job["id"]),
                lambda: engine.delete(job["id"]),
            ):
                with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, "publish operation"):
                    operation()
        finally:
            engine._publish_busy.discard((job["id"], 0))

    def test_existing_worker_attempts_gain_publish_columns_without_losing_rows(self):
        with tempfile.TemporaryDirectory() as root:
            db_path = Path(root) / "jobs.db"
            with sqlite3.connect(db_path) as db:
                db.execute("""CREATE TABLE worker_attempts (
                    job_id TEXT NOT NULL, idx INTEGER NOT NULL, attempt INTEGER NOT NULL, title TEXT NOT NULL,
                    status TEXT NOT NULL, container TEXT, started_at REAL, finished_at REAL,
                    exit_code INTEGER, error TEXT, log_path TEXT, profile_snapshot TEXT,
                    project_branch TEXT, project_worktree TEXT, project_merged_at REAL,
                    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0,
                    PRIMARY KEY (job_id, idx, attempt))""")
                db.execute("INSERT INTO worker_attempts (job_id, idx, attempt, title, status, project_branch) "
                           "VALUES ('old-job', 0, 1, 'Old worker', 'done', 'workbench/old')")
            JobEngine(db_path, Path(root) / "workspace", lambda prompt: "")
            with sqlite3.connect(db_path) as db:
                columns = {row[1] for row in db.execute("PRAGMA table_info(worker_attempts)")}
                row = db.execute("SELECT title, project_branch FROM worker_attempts WHERE job_id='old-job'").fetchone()
            self.assertTrue({"project_pushed_at", "project_pushed_commit", "project_review_url",
                             "project_review_provider", "project_publish_state", "project_publish_started_at"}.issubset(columns))
            self.assertEqual(row, ("Old worker", "workbench/old"))

    def test_project_path_must_be_inside_workspace_and_git(self):
        engine = self.engine([])
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        with self.assertRaisesRegex(ValueError, "does not exist"):
            engine.create("Missing project", "x", project_path="projects/board-smoke")
        with self.assertRaises(ValueError):
            engine.create("Invalid project", "x", project_path=str(outside))
        inside = engine.workspace_root / "not-a-repo"
        inside.mkdir(parents=True)
        with self.assertRaises(ValueError):
            engine.create("Invalid project", "x", project_path=str(inside))

    def test_timeout_and_sandbox_required(self):
        self.settings.update(plan_gate=False, job_timeout_minutes=0)
        engine = self.engine([plan_reply(1), "summary"])
        job = engine.create("Slow", "x")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["subtasks"][0]["status"], "timeout")

        self.settings.update(sandbox=False, job_timeout_minutes=30)
        engine2 = self.engine([plan_reply(1)])
        job2 = engine2.create("No sandbox", "x")
        self.settle(engine2)
        self.assertEqual(engine2.get_job(job2["id"])["stage"], "failed")

    def test_bad_plan_fails_review(self):
        engine = self.engine(["I cannot help with that."])
        job = engine.create("Weird", "x")
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "failed")

    def test_parsers(self):
        self.assertEqual(extract_json('pre {"a": {"b": "}"}} post'), {"a": {"b": "}"}})
        raw = "\n".join([
            "npm notice x",
            json.dumps({"type": "text", "part": {"text": "hello"}}),
            json.dumps({"type": "error", "error": {"name": "APIError", "data": {"message": "boom"}}}),
        ])
        self.assertEqual(parse_opencode_events(raw), ("hello", ["boom"]))
        usage = parse_opencode_usage("\n".join([
            json.dumps({"type": "step_finish", "part": {"cost": 0.12, "tokens": {"input": 100, "output": 40}}}),
            json.dumps({"type": "step_finish", "part": {"cost": 0.03, "tokens": {"input": 20, "output": 10}}}),
        ]))
        self.assertEqual(usage, {"input_tokens": 120, "output_tokens": 50, "cost": 0.15})

    def test_token_budget_prevents_queued_workers_after_usage_is_reported(self):
        self.settings.update(plan_gate=False, max_workers_total=1)
        engine = self.engine([plan_reply(2), "summary"])
        job = engine.create("Budget cap", "x", token_budget=100)
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 1)
        cid = self._running_cid()
        event = json.dumps({"type": "step_finish", "part": {
            "cost": 0.02, "tokens": {"input": 80, "output": 40},
        }})
        self.docker.finish(cid, text="finished")
        self.docker.containers[cid][2] += "\n" + event
        self.settle(engine)

        job = engine.get_job(job["id"])
        self.assertEqual(len(self.docker.runs), 1)
        self.assertEqual(job["subtasks"][0]["attempts"][0]["input_tokens"], 80)
        self.assertEqual(job["subtasks"][0]["attempts"][0]["output_tokens"], 40)
        self.assertEqual(job["subtasks"][0]["attempts"][0]["cost"], 0.02)
        self.assertEqual(job["subtasks"][1]["status"], "failed")
        self.assertIn("token budget reached", job["subtasks"][1]["error"])

    def test_auto_approve_allows_all_bash(self):
        self.settings.update(auto_approve=True)
        engine = self.engine([])
        args = engine._worker_args("j1", {"idx": 0, "instructions": "go"})
        conf = next(a for a in args if a.startswith("OPENCODE_CONFIG_CONTENT="))
        self.assertEqual(json.loads(conf.split("=", 1)[1])["permission"]["bash"], "allow")

    def test_dag_orders_execution_and_feeds_upstream(self):
        engine = self.engine([plan_reply_dag(), "# Report\ndone"])
        job = engine.create("DAG", "x")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "planned")
        self.assertEqual(job["plan"]["subtasks"][1]["depends_on"], [0])
        engine.approve(job["id"])
        self.settle(engine)

        # Only subtask 0 may start; subtask 1 is held back by its dependency.
        self.assertEqual(len(self.docker.runs), 1)
        job = engine.get_job(job["id"])
        self.assertEqual(job["subtasks"][0]["status"], "running")
        self.assertEqual(job["subtasks"][1]["status"], "queued")

        # Subtask 0 finishes and writes an artifact.
        cid0 = self._running_cid()
        art0 = Path(self.tmp.name) / "ws" / "jobs" / job["id"] / "subtask-1" / "artifacts"
        art0.mkdir(parents=True)
        (art0 / "module.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
        self.docker.finish(cid0, text="wrote module.py")
        self.settle(engine)

        # Subtask 1 now starts, and its prompt carries the upstream artifact.
        self.assertEqual(len(self.docker.runs), 2)
        job = engine.get_job(job["id"])
        self.assertEqual(job["subtasks"][1]["status"], "running")
        prompt1 = self.docker.runs[1][-1]
        self.assertIn("Upstream work", prompt1)
        # The upstream path points at the staged copy inside the worker's own workdir.
        self.assertIn("upstream/subtask-1/artifacts/module.py", prompt1)
        self.assertIn("def add(a, b):", prompt1)

        cid1 = self._running_cid()
        self.docker.finish(cid1, text="tested module.py")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")
        self.assertEqual([s["status"] for s in job["subtasks"]], ["done", "done"])

    def test_upstream_artifacts_staged_into_worker_workdir(self):
        # The read tool is scoped to the worker's workdir, so upstream artifacts must be
        # staged inside it (upstream/subtask-N/) — otherwise a downstream worker that
        # reads an upstream file hits an external_directory auto-reject and stalls.
        engine = self.engine([plan_reply_dag(), "# Report\ndone"])
        job = engine.create("DAG stage", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid0 = self._running_cid()
        art0 = Path(self.tmp.name) / "ws" / "jobs" / job["id"] / "subtask-1" / "artifacts"
        art0.mkdir(parents=True)
        (art0 / "module.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
        self.docker.finish(cid0, text="wrote module.py")
        self.settle(engine)
        # Subtask 1 is running and its workdir now holds a staged copy of subtask 0's artifact.
        job = engine.get_job(job["id"])
        self.assertEqual(job["subtasks"][1]["status"], "running")
        staged = Path(self.tmp.name) / "ws" / "jobs" / job["id"] / "subtask-2" / "upstream" / "subtask-1" / "artifacts" / "module.py"
        self.assertTrue(staged.is_file())
        self.assertEqual(staged.read_text(encoding="utf-8"), "def add(a, b):\n    return a + b\n")
        # The prompt tells the worker to read from the staged location, not sibling dirs.
        prompt1 = self.docker.runs[1][-1]
        self.assertIn("staged in your workdir under upstream/", prompt1)
        self.assertIn("Do NOT read other subtask directories", prompt1)

    def test_dag_dependency_failure_cascades(self):
        engine = self.engine([plan_reply_dag(), "failed summary", "done summary"])
        job = engine.create("DAG fail", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 1)
        cid0 = self._running_cid()
        self.docker.finish(cid0, code=1, text="", error="boom")
        self.settle(engine)

        job = engine.get_job(job["id"])
        self.assertEqual(job["subtasks"][0]["status"], "failed")
        # Subtask 1 never ran; its dependency failed, so it cascade-fails.
        self.assertEqual(job["subtasks"][1]["status"], "failed")
        self.assertIn("dependency subtask 1", job["subtasks"][1]["error"])
        # The job reaches collating (and then failed) instead of hanging.
        self.assertEqual(job["stage"], "failed")
        self.assertEqual(len(self.docker.runs), 1)  # subtask 1 was never started

        engine.retry_subtask(job["id"], 0)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "running")
        self.assertEqual([sub["status"] for sub in job["subtasks"]], ["queued", "queued"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 2)
        retry_cid = self._running_cid()
        self.docker.finish(retry_cid, text="upstream recovered")
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 3)
        downstream_cid = self._running_cid()
        self.docker.finish(downstream_cid, text="downstream recovered")
        self.settle(engine)

        recovered = engine.get_job(job["id"])
        self.assertEqual(recovered["stage"], "done")
        self.assertEqual([sub["status"] for sub in recovered["subtasks"]], ["done", "done"])
        self.assertEqual([attempt["status"] for attempt in recovered["subtasks"][0]["attempts"]], ["failed", "done"])
        self.assertEqual([attempt["status"] for attempt in recovered["subtasks"][1]["attempts"]], ["done"])

    def test_normalize_plan_drops_cycle_and_bad_refs(self):
        engine = self.engine([])
        plan = {"summary": "s", "subtasks": [
            {"title": "a", "instructions": "a", "depends_on": [1, 99, 0]},  # cycle + out-of-range + self
            {"title": "b", "instructions": "b", "depends_on": [0]},
        ]}
        normalized = engine._normalize_plan(plan)
        self.assertEqual(normalized["subtasks"][0]["depends_on"], [])  # cycle + self + bad ref dropped
        self.assertEqual(normalized["subtasks"][1]["depends_on"], [0])

    def test_normalize_plan_remaps_deps_after_dropping_empty(self):
        engine = self.engine([])
        plan = {"summary": "s", "subtasks": [
            {"title": "a", "instructions": "a"},
            {"title": "skip", "instructions": ""},  # dropped (no instructions)
            {"title": "c", "instructions": "c", "depends_on": [0]},
        ]}
        normalized = engine._normalize_plan(plan)
        self.assertEqual(len(normalized["subtasks"]), 2)
        self.assertEqual(normalized["subtasks"][1]["depends_on"], [0])

    def test_plan_with_prose_dependency_gets_repaired(self):
        # Hermes describes the dependency in prose but leaves depends_on empty; the
        # safety net asks once more and stores the corrected plan.
        engine = self.engine([plan_reply_missing_dep(), deps_fix_reply([0]), "# Report\ndone"])
        job = engine.create("Calc", "x")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "planned")
        self.assertEqual(job["plan"]["subtasks"][1]["depends_on"], [0])
        # Two Hermes calls: the review + the dependency repair.
        self.assertEqual(len(self.hermes.prompts), 2)
        self.assertIn("depends_on", self.hermes.prompts[1])

    def test_plan_repair_failure_keeps_original_plan(self):
        # The repair call fails; the job still proceeds with the (unrepaired) plan.
        engine = self.engine([plan_reply_missing_dep(), "I cannot help with that.", "# Report\ndone"])
        job = engine.create("Calc", "x")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "planned")
        self.assertEqual(job["plan"]["subtasks"][1]["depends_on"], [])
        self.assertEqual(len(self.hermes.prompts), 2)

    def test_plan_without_dependency_markers_is_not_repaired(self):
        # No prose dependency markers -> no extra Hermes call.
        engine = self.engine([plan_reply(2), "# Report\ndone"])
        job = engine.create("Two parts", "x")
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "planned")
        self.assertEqual(len(self.hermes.prompts), 1)

    def test_tighter_loop_appends_wave_and_finishes(self):
        self.settings.update(tighter_loop=True, max_waves=3)
        engine = self.engine([
            plan_reply(1),
            wave_review_reply(False, [{"title": "fix", "instructions": "fix the bug", "depends_on": [0]}], "needs a fix"),
            wave_review_reply(True, note="all good"),
            "# Report\ndone",
        ])
        job = engine.create("Tight loop", "x")
        self.settle(engine)
        self.assertEqual(engine.get_job(job["id"])["stage"], "planned")
        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 1)  # wave 0

        # Wave 0 finishes -> Hermes reviews and appends wave 1.
        cid0 = self._running_cid()
        art0 = Path(self.tmp.name) / "ws" / "jobs" / job["id"] / "subtask-1" / "artifacts"
        art0.mkdir(parents=True)
        (art0 / "module.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
        self.docker.finish(cid0, text="wrote module.py")
        self.settle(engine)

        # Wave 1 subtask started; it depends on wave 0 and sees its artifact.
        self.assertEqual(len(self.docker.runs), 2)
        job = engine.get_job(job["id"])
        self.assertEqual(len(job["subtasks"]), 2)
        self.assertEqual(job["subtasks"][1]["status"], "running")
        self.assertEqual(job["subtasks"][1]["wave"], 1)
        self.assertEqual(job["subtasks"][1]["depends_on"], [0])
        prompt1 = self.docker.runs[1][-1]
        self.assertIn("Upstream work", prompt1)
        self.assertIn("subtask-1/artifacts/module.py", prompt1)
        # The wave review saw the prior result before deciding.
        self.assertTrue(any("wrote module.py" in p and "wave 0" in p for p in self.hermes.prompts))

        # Wave 1 finishes -> Hermes says finish -> collating -> done.
        cid1 = self._running_cid()
        self.docker.finish(cid1, text="fixed the bug")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")
        self.assertEqual([s["status"] for s in job["subtasks"]], ["done", "done"])
        stages = [e["message"].split(":")[0] for e in job["events"] if e["kind"] == "stage"]
        self.assertIn("replanning", stages)

    def test_tighter_loop_off_goes_straight_to_collating(self):
        self.settings.update(tighter_loop=False)
        engine = self.engine([plan_reply(1), "# Report\ndone"])
        job = engine.create("No loop", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 1)
        cid = self._running_cid()
        self.docker.finish(cid, text="done")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")
        self.assertEqual(len(job["subtasks"]), 1)
        stages = [e["message"].split(":")[0] for e in job["events"] if e["kind"] == "stage"]
        self.assertNotIn("replanning", stages)
        self.assertEqual(len(self.hermes.prompts), 2)  # review + collate only

    def test_tighter_loop_respects_max_waves(self):
        self.settings.update(tighter_loop=True, max_waves=2)
        engine = self.engine([
            plan_reply(1),
            wave_review_reply(False, [{"title": "fix", "instructions": "fix it"}]),
            wave_review_reply(False, [{"title": "fix2", "instructions": "fix it again"}]),  # never used
            "# Report\ndone",
        ])
        job = engine.create("Max waves", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid0 = self._running_cid()
        self.docker.finish(cid0, text="wave 0 done")
        self.settle(engine)
        self.assertEqual(len(self.docker.runs), 2)  # wave 1 started
        cid1 = self._running_cid()
        self.docker.finish(cid1, text="wave 1 done")
        self.settle(engine)
        job = engine.get_job(job["id"])
        self.assertEqual(job["stage"], "done")
        self.assertEqual(len(job["subtasks"]), 2)  # only waves 0 and 1
        self.assertEqual([s["wave"] for s in job["subtasks"]], [0, 1])
        # The third wave-review reply was never consumed (max waves reached).
        self.assertEqual(len(self.hermes.replies), 1)

    def test_tighter_loop_wave_review_failure_collates(self):
        self.settings.update(tighter_loop=True, max_waves=3)
        engine = self.engine([plan_reply(1), "I cannot help with that.", "# Report\ndone"])
        job = engine.create("Bad review", "x")
        self.settle(engine)
        engine.approve(job["id"])
        self.settle(engine)
        cid = self._running_cid()
        self.docker.finish(cid, text="wave 0 done")
        self.settle(engine)
        job = engine.get_job(job["id"])
        # A failed wave review falls back to collating instead of hanging.
        self.assertEqual(job["stage"], "done")
        self.assertEqual(len(job["subtasks"]), 1)
        self.assertEqual(len(self.hermes.prompts), 3)  # review + wave review + collate


if __name__ == "__main__":
    unittest.main()
