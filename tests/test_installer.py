import os
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "install.sh"
COMPOSE = SCRIPT.parent / "docker-compose.yml"
sys.path.insert(0, str(SCRIPT.parent / "agent"))
import bootstrap


class InstallerTests(unittest.TestCase):
    def test_agent_image_has_one_managed_gateway_owner(self):
        dockerfile = (SCRIPT.parent / "agent" / "Dockerfile").read_text()
        mcp_source = (SCRIPT.parent / "agent" / "workbench_mcp.py").read_text()
        self.assertIn("RUN rm -f /etc/cont-init.d/02-reconcile-profiles", dockerfile)
        self.assertIn("openssh-client", dockerfile)
        self.assertIn('CMD ["python3", "/opt/workbench/hermes_runtime.py", "supervise", "gateway"]', dockerfile)
        self.assertIn("COPY git_remote.py /opt/workbench/git_remote.py", dockerfile)
        for name in ("git_status", "git_commit", "git_pull_ff", "git_push"):
            self.assertIn(f'"{name}"', mcp_source)

    def test_managed_hermes_cli_path_is_preferred_and_profile_edit_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / ".profile"
            original = 'PATH="$HOME/.local/bin:$PATH"\nexport PATH\n'
            profile.write_text(original, encoding="utf-8")

            bootstrap.ensure_managed_hermes_cli_path(profile)
            first = profile.read_text(encoding="utf-8")
            bootstrap.ensure_managed_hermes_cli_path(profile)

            self.assertTrue(first.startswith(original))
            self.assertIn("/opt/workbench/bin:$PATH", first)
            self.assertEqual(profile.read_text(encoding="utf-8"), first)

    def test_agent_image_provides_uv_before_dependency_installation(self):
        dockerfile = (SCRIPT.parent / "agent" / "Dockerfile").read_text()
        self.assertRegex(dockerfile, r"COPY --from=ghcr\.io/astral-sh/uv:\d+\.\d+\.\d+ /uv /usr/local/bin/uv")
        self.assertLess(dockerfile.index("COPY --from=ghcr.io/astral-sh/uv:"), dockerfile.index("RUN uv --version"))
        self.assertIn("uv pip install --python /opt/hermes/.venv/bin/python PyYAML==6.0.3", dockerfile)
        self.assertIn('/opt/hermes/.venv/bin/python -c "import yaml"', dockerfile)

    def test_hermes_mcp_exposes_confirmed_git_tools(self):
        mcp_source = (SCRIPT.parent / "agent" / "workbench_mcp.py").read_text()
        for name in ("git_status", "git_commit", "git_pull_ff", "git_push"):
            self.assertIn(f'"{name}"', mcp_source)
        self.assertIn('if args.get("confirm") is not True:', mcp_source)

    def test_dry_run_does_not_write_or_disclose_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            install_dir = Path(directory) / "app"
            result = subprocess.run(
                ["bash", str(SCRIPT), "--dry-run"], input="\n".join([
                    "https://model.example/v1", "model", "private-key", "", "", "", "", "", "", "yes", "", "", "",
                ]) + "\n",
                text=True, capture_output=True, env={**os.environ, "WORKBENCH_INSTALL_DIR": str(install_dir)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("127.0.0.1:1420", result.stdout)
            self.assertIn("Image tag: latest", result.stdout)
            self.assertIn("Compose source ref: main", result.stdout)
            self.assertNotIn("private-key", result.stdout + result.stderr)
            self.assertFalse(install_dir.exists())

    def test_install_uses_latest_compose_and_private_env(self):
        self.check_install()

    def test_install_writes_independent_private_endpoints(self):
        self.check_install(private=True)

    def test_install_can_enable_optional_dind_workers(self):
        self.check_install(sandbox=True)

    def check_install(self, private=False, sandbox=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "bin"
            binaries.mkdir()
            commands = root / "commands"
            for name, script in {
                "sudo": '#!/bin/sh\nexec "$@"\n',
                "docker": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_TEST_LOG"\nexit 0\n',
                "curl": '''#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
    case "$1" in https://*) url="$1" ;; esac
  shift
done
if [ -n "$out" ]; then
  if [ "${INSTALL_TEST_DOWNLOAD_FAIL:-0}" = 1 ]; then exit 22; fi
            if [ -n "${INSTALL_TEST_URL_LOG:-}" ]; then printf '%s\n' "$url" >> "$INSTALL_TEST_URL_LOG"; fi
    case "$url" in
        *docker-compose.jobs.yml) cp "$INSTALL_TEST_JOBS_COMPOSE" "$out" ;;
        *) cp "$INSTALL_TEST_COMPOSE" "$out" ;;
    esac
fi
''',
            }.items():
                target = binaries / name
                target.write_text(script, encoding="utf-8")
                target.chmod(0o755)
            env = {
                **os.environ, "PATH": f"{binaries}:{os.environ['PATH']}",
                "WORKBENCH_INSTALL_DIR": str(root / "app"),
                "INSTALL_TEST_COMPOSE": str(COMPOSE), "INSTALL_TEST_LOG": str(commands),
                "INSTALL_TEST_JOBS_COMPOSE": str(COMPOSE.parent / "docker-compose.jobs.yml"),
                "INSTALL_TEST_URL_LOG": str(root / "urls"),
            }
            sandbox_answer = "yes" if sandbox else ""
            choices = ["custom", "http://main.example/v1", "org/main", "main$secret", sandbox_answer,
                       "custom", "http://worker.example/v1", "org/worker", "worker$secret"]
            if private and sandbox:
                choices.append("192.0.2.20/32")
            if not private:
                choices = ["", "", "", sandbox_answer, "", "", ""]
            answers = "\n".join(["https://model.example/v1", "model", "test$secret", "", "", "admin@example.com", *choices, "yes"]) + "\n"
            result = subprocess.run(["bash", str(SCRIPT)], input=answers, text=True, capture_output=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = (root / "app" / ".env").read_text(encoding="utf-8")
            self.assertIn("LLM_API_KEY='test$secret'", config)
            self.assertIn("WORKBENCH_BIND='127.0.0.1'", config)
            self.assertIn("AGENT_SANDBOX='0'", config)
            self.assertIn(f"JOBS_SANDBOX='{int(sandbox)}'", config)
            self.assertIn("JOB_WORKER_RUNTIME='herdr'", config)
            self.assertIn(f"JOB_HERDR_ENABLED='{int(sandbox)}'", config)
            self.assertIn("WORKBENCH_TAG='latest'", config)
            self.assertIn("WORKBENCH_IMAGE_PREFIX='ghcr.io/josephsandorvoros'", config)
            expected_model = "org/main" if private else "opencode/big-pickle"
            self.assertIn(f"OPENCODE_MODEL='{expected_model}'", config)
            if private:
                self.assertIn("OPENCODE_CUSTOM_BASE_URL='http://main.example/v1'", config)
                self.assertIn("OPENCODE_CUSTOM_API_KEY='main$secret'", config)
                self.assertIn("WORKER_MODEL='org/worker'", config)
                self.assertIn("WORKER_BASE_URL='http://worker.example/v1'", config)
                self.assertIn("WORKER_API_KEY='worker$secret'", config)
                self.assertIn(f"SANDBOX_ALLOW_LAN='{'192.0.2.20/32' if sandbox else ''}'", config)
                self.assertNotIn("main$secret", result.stdout + result.stderr)
                self.assertNotIn("worker$secret", result.stdout + result.stderr)
            self.assertNotIn("COMPOSE_PROFILES", config)
            self.assertEqual(stat.S_IMODE((root / "app" / ".env").stat().st_mode), 0o600)
            self.assertEqual((root / "app" / "docker-compose.yml").read_bytes(), COMPOSE.read_bytes())
            if sandbox:
                self.assertEqual(
                    (root / "app" / "docker-compose.jobs.yml").read_bytes(),
                    (COMPOSE.parent / "docker-compose.jobs.yml").read_bytes(),
                )
            else:
                self.assertFalse((root / "app" / "docker-compose.jobs.yml").exists())
            urls = (root / "urls").read_text(encoding="utf-8")
            self.assertIn("https://raw.githubusercontent.com/josephsandorvoros/ai-workbench/main/deploy/docker-compose.yml", urls)
            if sandbox:
                self.assertIn("https://raw.githubusercontent.com/josephsandorvoros/ai-workbench/main/deploy/docker-compose.jobs.yml", urls)
            else:
                self.assertNotIn("docker-compose.jobs.yml", urls)
            self.assertIn("ssh -N -o ExitOnForwardFailure=yes -L 18420:127.0.0.1:1420 admin@example.com", result.stdout)
            self.assertIn("http://127.0.0.1:18420", result.stdout)
            self.assertNotIn("test$secret", result.stdout + result.stderr)
            recorded = commands.read_text(encoding="utf-8")
            self.assertLess(recorded.index("config --quiet"), recorded.index(" pull"))
            self.assertLess(recorded.index(" pull"), recorded.index(" up -d"))
            if sandbox:
                self.assertIn("-f " + str(root / "app" / "docker-compose.jobs.yml"), recorded)
                self.assertIn("--profile sandbox", recorded)
            else:
                self.assertNotIn("-f " + str(root / "app" / "docker-compose.jobs.yml"), recorded)
                self.assertNotIn("--profile sandbox", recorded)
            docker = shutil.which("docker")
            if docker:
                parsed = subprocess.run([
                    docker, "compose", "--env-file", str(root / "app" / ".env"),
                    "-f", str(root / "app" / "docker-compose.yml"), "config", "--format", "json",
                ], text=True, capture_output=True)
                self.assertEqual(parsed.returncode, 0, parsed.stderr)
                services = json.loads(parsed.stdout)["services"]
                self.assertEqual(services["agent"]["environment"]["LLM_API_KEY"], "test$$secret")
                self.assertEqual(services["web"]["ports"][0]["host_ip"], "127.0.0.1")
                self.assertEqual(services["agent"]["environment"]["OPENCODE_MODEL"], expected_model)
                self.assertEqual(services["agent"]["environment"]["JOBS_SANDBOX"], str(int(sandbox)))
                self.assertEqual(services["agent"]["environment"]["JOB_WORKER_RUNTIME"], "herdr")
                if private:
                    self.assertEqual(services["agent"]["environment"]["WORKER_BASE_URL"], "http://worker.example/v1")
                if sandbox:
                    profiled = subprocess.run([
                        docker, "compose", "--profile", "sandbox", "--env-file", str(root / "app" / ".env"),
                        "-f", str(root / "app" / "docker-compose.yml"), "-f", str(root / "app" / "docker-compose.jobs.yml"),
                        "config", "--format", "json",
                    ], text=True, capture_output=True)
                    self.assertEqual(profiled.returncode, 0, profiled.stderr)
                    self.assertIn("sandbox", json.loads(profiled.stdout)["services"])
                effective = subprocess.run([
                    docker, "compose", "--env-file", str(root / "app" / ".env"),
                    "-f", str(root / "app" / "docker-compose.yml"), "config", "--environment",
                ], text=True, capture_output=True)
                self.assertEqual(effective.returncode, 0, effective.stderr)
                self.assertIn("LLM_API_KEY=test$secret", effective.stdout)

    def test_missing_release_stops_before_docker_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "bin"
            binaries.mkdir()
            curl = binaries / "curl"
            curl.write_text("#!/bin/sh\nexit 22\n", encoding="utf-8")
            curl.chmod(0o755)
            answers = "\n".join(["https://model.example/v1", "model", "", "", "", "", "", "", "", "", "", "", "", "yes"]) + "\n"
            result = subprocess.run(
                ["bash", str(SCRIPT)], input=answers, text=True, capture_output=True,
                env={**os.environ, "PATH": f"{binaries}:{os.environ['PATH']}", "WORKBENCH_INSTALL_DIR": str(root / "app")},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("could not download Compose", result.stderr)
            self.assertFalse((root / "app").exists())

    def test_opencode_defaults_to_big_pickle_without_endpoint(self):
        providers, model = bootstrap.opencode_settings({})
        self.assertEqual(providers, {})
        self.assertEqual(model, "opencode/big-pickle")

        providers, model = bootstrap.opencode_settings({"LLM_BASE_URL": "http://model.example/v1"})
        self.assertIn("local", providers)
        self.assertEqual(model, "opencode/big-pickle")

    def test_version_override_uses_matching_compose_source_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["bash", str(SCRIPT), "--dry-run"],
                input="\n".join(["https://model.example/v1", "model", "", "v0.1.48", "", "", "", "", "", "yes", "", "", ""]) + "\n",
                text=True, capture_output=True,
                env={**os.environ, "WORKBENCH_INSTALL_DIR": str(Path(directory) / "app")},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Image tag: v0.1.48", result.stdout)
            self.assertIn("Compose source ref: v0.1.48", result.stdout)


if __name__ == "__main__":
    unittest.main()