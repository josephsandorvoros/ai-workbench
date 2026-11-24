import json
import subprocess
import sys
import tempfile
import time
import unittest
import venv
from pathlib import Path
from unittest.mock import patch

from hermes_runtime import DISCORD_CHECK, PM_METADATA, RuntimeManager, UPSTREAM, atomic_json, supervise


class HermesRuntimeTests(unittest.TestCase):
    def manager(self, home):
        return RuntimeManager(home, {"WORKBENCH_HERMES_MANAGED": "1"})

    def test_local_installs_cannot_be_updated(self):
        with tempfile.TemporaryDirectory() as home:
            manager = RuntimeManager(home, {})
            self.assertFalse(manager.status()["supported"])
            with self.assertRaises(ValueError):
                manager.start("apply")

    def test_release_input_cannot_select_branches_or_shell_commands(self):
        with tempfile.TemporaryDirectory() as home:
            for tag in ("main", "--upload-pack=evil", "v1.2;rm", "../../other", "https://other", None):
                with self.subTest(tag=tag), self.assertRaises(ValueError):
                    self.manager(home).start("update", tag)

    def test_invalid_actions_are_safe_validation_errors(self):
        with tempfile.TemporaryDirectory() as home:
            for action in (None, [], {}, "restart-everything"):
                with self.subTest(action=action), self.assertRaises(ValueError):
                    self.manager(home).start(action)

    def test_runtime_selection_cannot_escape_release_directory(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(ValueError):
                self.manager(home).runtime_path("../../other")

    def test_concurrent_operations_are_rejected(self):
        with tempfile.TemporaryDirectory() as home:
            first = self.manager(home)
            with first.lock():
                self.assertTrue(self.manager(home).busy())
                with self.assertRaises(ValueError):
                    self.manager(home).start("apply")
            self.assertFalse(first.busy())

    def test_prepare_is_pinned_and_failure_keeps_current_runtime(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            commands = []

            def run(command, cwd=None, timeout=None):
                commands.append(command)
                if command[:2] == ["git", "clone"]:
                    target = Path(command[-1])
                    target.mkdir()
                    (target / "uv.lock").touch()
                elif command[0] == "uv":
                    raise subprocess.CalledProcessError(1, command)

            with patch.object(manager, "_run", side_effect=run), self.assertRaises(subprocess.CalledProcessError):
                manager.prepare("v1.2.3")
            self.assertIn(UPSTREAM, commands[0])
            self.assertIn("refs/tags/v1.2.3", commands[1])
            self.assertIn("--frozen", commands[3])
            self.assertEqual(manager.selection()["current"], "image")
            self.assertEqual(list((manager.root / "releases").iterdir()), [])

    def test_failed_activation_restores_runtime_and_config(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            config = Path(home) / "config.yaml"
            config.write_text("original")
            calls = []

            def health(generation):
                calls.append(generation)
                if len(calls) == 1:
                    config.write_text("new-runtime-migration")
                    raise ValueError("unhealthy")

            with patch.object(manager, "_wait_healthy", side_effect=health):
                with self.assertRaisesRegex(ValueError, "previous runtime was restored"):
                    manager.activate("release-" + "a" * 32)
            self.assertEqual(manager.selection()["current"], "image")
            self.assertEqual(config.read_text(), "original")
            self.assertEqual(len(calls), 2)

    def test_successful_activation_retains_rollback_target(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            release = "release-" + "a" * 32
            with patch.object(manager, "_wait_healthy"):
                manager.activate(release)
            self.assertEqual(manager.selection()["current"], release)
            self.assertEqual(manager.selection()["previous"], "image")
            self.assertEqual(manager.state_path.stat().st_mode & 0o777, 0o600)

    def test_prepare_validates_release_before_activation(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            commands = []

            def run(command, cwd=None, timeout=None):
                commands.append(command)
                if command[:2] == ["git", "clone"]:
                    target = Path(command[-1])
                    (target / ".git").mkdir(parents=True)
                    (target / ".git/HEAD").write_text("a" * 40)
                    (target / "uv.lock").touch()
                    (target / "scripts").mkdir()
                    (target / "scripts/write_install_stamp.py").touch()

            with patch.object(manager, "_run", side_effect=run):
                release = manager.prepare("v1.2.3")
            self.assertTrue((manager.root / "releases" / release / "workbench-release.json").is_file())
            self.assertEqual(manager.selection()["current"], "image")
            self.assertIn("import hermes_cli.main; import gateway.run", commands[-3])
            self.assertIn(DISCORD_CHECK, commands[-2])
            sync_command = next(command for command in commands if command[:2] == ["uv", "sync"])
            self.assertEqual([sync_command[i + 1] for i, arg in enumerate(sync_command) if arg == "--extra"],
                             ["all", "discord"])
            stamp_command = next(command for command in commands if str(command[1]).endswith("write_install_stamp.py"))
            self.assertEqual(stamp_command[1], str(manager.runtime_path(release) / "scripts/write_install_stamp.py"))
            self.assertEqual(stamp_command[stamp_command.index("--base-version") + 1], "1.2.3")
            self.assertEqual(stamp_command[stamp_command.index("--commit") + 1], "a" * 40)
            self.assertEqual(stamp_command[stamp_command.index("--update-mechanism") + 1], "external")

    def test_discord_import_failure_rejects_release_before_selection(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)

            def run(command, cwd=None, timeout=None):
                if command[:2] == ["git", "clone"]:
                    target = Path(command[-1])
                    (target / ".git").mkdir(parents=True)
                    (target / ".git/HEAD").write_text("a" * 40)
                    (target / "uv.lock").touch()
                if DISCORD_CHECK in command:
                    raise subprocess.CalledProcessError(1, command)

            with patch.object(manager, "_run", side_effect=run), self.assertRaises(subprocess.CalledProcessError):
                manager.prepare("v1.2.3")
            self.assertEqual(manager.selection()["current"], "image")
            self.assertEqual(list((manager.root / "releases").iterdir()), [])

    def test_packaged_release_prepares_and_checks_its_own_pm_runtime(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            commands = []

            def run(command, cwd=None, timeout=None):
                commands.append(command)
                if command[:2] == ["git", "clone"]:
                    target = Path(command[-1])
                    (target / ".git").mkdir(parents=True)
                    (target / ".git/HEAD").write_text("a" * 40)
                    (target / "uv.lock").touch()
                    (target / "scripts").mkdir()
                    (target / "scripts/write_install_stamp.py").touch()
                    (target / "pm").mkdir()
                    (target / "pm/pyproject.toml").touch()
                    (target / "pm/uv.lock").touch()

            with patch.object(manager, "_run", side_effect=run):
                release = manager.prepare("v1.2.3")
            target = manager.runtime_path(release)
            pm_sync = next(command for command in commands if "--project" in command)
            self.assertIn(str(target / "pm"), pm_sync)
            self.assertIn("--frozen", pm_sync)
            metadata = next(command for command in commands if PM_METADATA in command)
            self.assertEqual(metadata[0], str(target / "pm/.venv/bin/python"))
            self.assertEqual(metadata[-1], str(target / "install-stamp.json"))
            self.assertTrue(any("bootstrap=False" in str(command) for command in commands))

    def test_pm_metadata_points_to_runnable_independent_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "pm/.venv"
            venv.EnvBuilder(with_pip=False).create(runtime)
            stamp = Path(directory) / "install-stamp.json"
            atomic_json(stamp, {"distribution": "docker", "updateMechanism": "external"})
            subprocess.run([str(runtime / "bin/python"), "-c", PM_METADATA, str(stamp)], check=True)
            metadata = json.loads((runtime / "pm-runtime.json").read_text())
            self.assertEqual(json.loads(stamp.read_text())["pmRuntime"], str(runtime))
            python = (runtime / metadata["python"]).resolve()
            site = runtime / metadata["sitePackages"]
            (site / "pm_probe.py").write_text("ready = True\n")
            subprocess.run([str(python), "-I", "-S", "-c",
                            "import sys; sys.path.insert(0, sys.argv[1]); import pm_probe; assert pm_probe.ready",
                            str(site)], check=True)
            self.assertEqual(json.loads(stamp.read_text())["updateMechanism"], "external")

    def test_preparation_failure_keeps_dependency_diagnostics(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            with self.assertRaises(subprocess.CalledProcessError):
                manager._run([sys.executable, "-c", "import sys; sys.stderr.write('missing SDK'); sys.exit(1)"])
            log = manager.root / "preparation.log"
            self.assertIn("missing SDK", log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_cli_restart_uses_workbench_supervisor_not_upstream_s6_profiles(self):
        with tempfile.TemporaryDirectory() as home:
            for arguments in (["gateway", "restart"], ["gateway", "restart", "--detach"]):
                with self.subTest(arguments=arguments), \
                        patch.dict("os.environ", {"HERMES_HOME": home, "WORKBENCH_HERMES_MANAGED": "1"}), \
                        patch.object(RuntimeManager, "restart_gateway") as restart, \
                        patch("hermes_runtime.os.execve") as execute:
                    from hermes_runtime import exec_cli
                    exec_cli(arguments)
                    restart.assert_called_once_with(detach="--detach" in arguments)
                    execute.assert_not_called()

    def test_detached_restart_records_request_without_selecting_another_runtime(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            selection = manager.selection()
            atomic_json(manager.root / "gateway.json", {"state": "running", "pid": 100,
                                                       "updated_at": time.time()})
            with patch("builtins.print"):
                manager.restart_gateway(detach=True)
            self.assertTrue(json.loads((manager.root / "gateway-restart.json").read_text())["id"])
            self.assertEqual(manager.selection(), selection)

    def test_restart_rejects_stale_supervisor_without_writing_request(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            atomic_json(manager.root / "gateway.json", {"state": "running", "updated_at": time.time() - 60})
            with self.assertRaisesRegex(ValueError, "supervisor is not running"):
                manager.restart_gateway(detach=True)
            self.assertFalse((manager.root / "gateway-restart.json").exists())

    def test_health_requires_both_selected_service_generations(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            atomic_json(manager.root / "gateway.json", {"generation": "old", "state": "running"})
            with patch("hermes_runtime.urlopen") as http:
                self.assertFalse(manager.healthy("new"))
            http.assert_not_called()

    def test_health_rejects_an_old_gateway_despite_new_service_generations(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            for role, pid in (("gateway", 200), ("serve", 201)):
                atomic_json(manager.root / f"{role}.json", {"generation": "new", "state": "running",
                            "pid": pid, "updated_at": time.time()})
            atomic_json(Path(home) / "gateway_state.json", {"gateway_state": "running", "pid": 477})
            with patch("hermes_runtime.urlopen") as http:
                self.assertFalse(manager.healthy("new"))
            http.assert_not_called()

    def test_recovery_pauses_new_services_before_restoring_files(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            config = Path(home) / "config.yaml"
            config.write_text("original")
            checks = []

            def health(generation):
                checks.append(generation)
                if len(checks) == 1:
                    config.write_text("migration")
                    raise ValueError("unhealthy")

            def pause():
                self.assertEqual(config.read_text(), "migration")

            with patch.object(manager, "_wait_healthy", side_effect=health), patch.object(manager, "_pause_for_recovery", side_effect=pause) as paused:
                with self.assertRaisesRegex(ValueError, "previous runtime was restored"):
                    manager.activate("release-" + "a" * 32)
            paused.assert_called_once()
            self.assertEqual(config.read_text(), "original")

    def test_interrupted_operation_is_reported(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            atomic_json(manager.progress_path, {"state": "running", "step": "installing"})
            self.assertEqual(manager.status()["operation"]["state"], "interrupted")

    def test_interrupted_activation_is_recovered_on_boot(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            original = manager.selection()
            atomic_json(manager.root / "activation.json", {"selection": original,
                "config": {"config.yaml": b"original".hex(), ".env": None}})
            manager._select("release-" + "a" * 32, "image")
            (Path(home) / "config.yaml").write_text("migration")
            manager.recover_interrupted_activation()
            self.assertEqual(manager.selection()["current"], "image")
            self.assertEqual((Path(home) / "config.yaml").read_text(), "original")
            self.assertFalse((manager.root / "activation.json").exists())

    def test_missing_selected_release_recovers_to_image_without_activation_marker(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            missing = "release-" + "a" * 32
            manager._select(missing, None)

            manager.recover_interrupted_activation()

            self.assertEqual(manager.selection(), {"current": "image", "previous": None,
                                                   "generation": manager.selection()["generation"]})
            self.assertEqual(manager.status()["operation"]["state"], "recovered")
            self.assertIn("missing or incomplete", manager.status()["operation"]["step"])

    def test_legacy_startup_recovery_is_history_not_current_failure(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            message = "Selected Hermes runtime 'release-old' is missing or incomplete; recovered to 'image' at startup"
            atomic_json(manager.progress_path, {"state": "failed", "step": message})
            self.assertEqual(manager.status()["operation"], {"state": "recovered", "step": message})

    def test_real_operation_failure_is_not_hidden_as_recovery(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            atomic_json(manager.progress_path, {"state": "failed", "step": "Hermes activation failed"})
            self.assertEqual(manager.status()["operation"]["state"], "failed")

    def test_missing_selected_release_recovers_to_valid_previous_release(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            missing = "release-" + "a" * 32
            previous = "release-" + "b" * 32
            binaries = manager.root / "releases" / previous / ".venv" / "bin"
            binaries.mkdir(parents=True)
            for name in ("python", "hermes"):
                executable = binaries / name
                executable.write_text("#!/bin/sh\nexit 0\n")
                executable.chmod(0o755)
            manager._select(missing, previous)

            manager.recover_interrupted_activation()

            selection = manager.selection()
            self.assertEqual(selection["current"], previous)
            self.assertEqual(selection["previous"], "image")

    def test_release_with_hermes_but_missing_venv_python_is_unavailable(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            missing = "release-" + "a" * 32
            previous = "release-" + "b" * 32
            executable = manager.root / "releases" / previous / ".venv" / "bin" / "hermes"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/missing/venv/python\npass\n")
            executable.chmod(0o755)
            manager._select(missing, previous)

            manager.recover_interrupted_activation()

            selection = manager.selection()
            self.assertEqual(selection["current"], "image")
            self.assertIsNone(selection["previous"])

    def test_release_with_broken_python_shebang_is_unavailable(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            missing = "release-" + "a" * 32
            previous = "release-" + "b" * 32
            binaries = manager.root / "releases" / previous / ".venv" / "bin"
            binaries.mkdir(parents=True)
            for name in ("python", "hermes"):
                executable = binaries / name
                executable.write_text("#!/bin/sh\nexec /missing/venv/python\n")
                executable.chmod(0o755)
            manager._select(missing, previous)

            manager.recover_interrupted_activation()

            selection = manager.selection()
            self.assertEqual(selection["current"], "image")
            self.assertIsNone(selection["previous"])

    def test_runtime_probe_uses_selected_install_root(self):
        with tempfile.TemporaryDirectory() as home:
            manager = RuntimeManager(home, {"HERMES_INSTALL_ROOT": "/old-image"})
            release = "release-" + "a" * 32
            binaries = manager.runtime_path(release) / ".venv/bin"
            binaries.mkdir(parents=True)
            for name in ("python", "hermes"):
                executable = binaries / name
                executable.touch()
                executable.chmod(0o755)
            with patch("hermes_runtime.subprocess.run") as run:
                self.assertTrue(manager.runtime_available(release))
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                self.assertEqual(call.kwargs["env"]["HERMES_INSTALL_ROOT"], str(manager.runtime_path(release)))

    def test_early_cli_recovers_missing_release_before_exec(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            manager._select("release-" + "a" * 32, None)
            calls = []

            with patch.dict("os.environ", {"HERMES_HOME": home, "HERMES_IMAGE_DIR": "/opt/hermes", "HERMES_INSTALL_ROOT": "/old-image"}), \
                    patch("hermes_runtime.os.execve", side_effect=lambda *args: calls.append(args)):
                from hermes_runtime import exec_cli
                exec_cli(["config", "set", "mcp_servers.workbench", "{}"])

            self.assertEqual(manager.selection()["current"], "image")
            self.assertEqual(calls[0][0], "/opt/hermes/.venv/bin/hermes")
            self.assertEqual(calls[0][2]["HERMES_INSTALL_ROOT"], "/opt/hermes")

    def test_supervisor_runs_foreground_gateway_without_s6_handoff(self):
        with tempfile.TemporaryDirectory() as home:
            handlers = {}
            child = unittest.mock.Mock()
            child.poll.return_value = None

            def launch(command, **kwargs):
                self.assertEqual(command[-2:], ["gateway", "run"])
                self.assertEqual(kwargs["env"]["HERMES_GATEWAY_NO_SUPERVISE"], "1")
                self.assertEqual(kwargs["env"]["HERMES_INSTALL_ROOT"], str(RuntimeManager(home).runtime_path()))
                self.assertTrue(kwargs["start_new_session"])
                handlers[__import__("signal").SIGTERM](None, None)
                return child

            with patch.dict("os.environ", {"HERMES_HOME": home, "HERMES_INSTALL_ROOT": "/old-image"}), patch("hermes_runtime.signal.signal", side_effect=lambda signum, handler: handlers.update({signum: handler})), patch("hermes_runtime.subprocess.Popen", side_effect=launch), patch("hermes_runtime.os.killpg"):
                supervise("gateway")
            child.wait.assert_called()

    def test_gateway_restart_request_is_consumed_by_existing_supervisor(self):
        with tempfile.TemporaryDirectory() as home:
            manager = self.manager(home)
            handlers = {}
            children = []

            def launch(command, **kwargs):
                child = unittest.mock.Mock()
                child.pid = 200 + len(children)
                child.poll.return_value = None
                children.append(child)
                if len(children) == 1:
                    child.poll.side_effect = request_restart
                else:
                    handlers[__import__("signal").SIGTERM](None, None)
                return child

            def request_restart():
                atomic_json(manager.root / "gateway-restart.json", {"id": "request-1"})
                return None

            with patch.dict("os.environ", {"HERMES_HOME": home}), \
                    patch("hermes_runtime.signal.signal", side_effect=lambda signum, handler: handlers.update({signum: handler})), \
                    patch("hermes_runtime.subprocess.Popen", side_effect=launch), \
                    patch("hermes_runtime.os.killpg") as terminate:
                supervise("gateway")
            self.assertEqual(len(children), 2)
            self.assertEqual(terminate.call_args_list[0].args[0], children[0].pid)
            self.assertEqual(manager.selection()["current"], "image")