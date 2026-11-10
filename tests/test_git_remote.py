import io
import json
import os
import shutil
import shlex
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import git_remote


class GitRemoteTests(unittest.TestCase):
    def setUp(self):
        self._validate_remote_host = git_remote.validate_remote_host
        validation = patch.object(git_remote, "validate_remote_host")
        validation.start()
        self.addCleanup(validation.stop)

    @staticmethod
    def run_git(*args, cwd=None):
        return subprocess.run(["git", *map(str, args)], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

    def make_repository(self, workspace):
        repo = workspace / "projects" / "demo"
        repo.mkdir(parents=True)
        self.run_git("init", "-b", "main", repo)
        self.run_git("-C", repo, "config", "user.name", "Git Test")
        self.run_git("-C", repo, "config", "user.email", "git-test@example.invalid")
        (repo / "README.md").write_text("# Demo\n", encoding="utf-8")
        self.run_git("-C", repo, "add", "README.md")
        self.run_git("-C", repo, "commit", "-m", "initial")
        return repo

    def test_unconfigured_hosts_must_resolve_publicly(self):
        remote = git_remote.parse_remote_url("https://forgejo.example/o/r.git")
        private_result = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(git_remote.socket, "getaddrinfo", return_value=private_result):
            with self.assertRaisesRegex(git_remote.GitRemoteError, "public IP"):
                self._validate_remote_host(remote)
            self._validate_remote_host(remote, allow_private=True)

        public_result = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        with patch.object(git_remote.socket, "getaddrinfo", return_value=public_result):
            self._validate_remote_host(remote)

    def test_repository_status_and_selected_commit_are_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            (workspace / "projects").mkdir(parents=True)
            repo = self.make_repository(workspace)
            (repo / "README.md").write_text("# Updated\n", encoding="utf-8")
            (repo / "notes.txt").write_text("keep separate\n", encoding="utf-8")
            status = git_remote.repository_status(workspace, "projects/demo")
            self.assertEqual(status["branch"], "main")
            self.assertEqual({change["path"] for change in status["changes"]}, {"README.md", "notes.txt"})
            result = git_remote.commit_paths(workspace, "projects/demo", ["README.md"], "Update README", "Test User", "test@example.invalid")
            self.assertEqual(result["files"], ["README.md"])
            self.assertEqual(self.run_git("-C", repo, "show", "HEAD:README.md"), "# Updated")
            self.assertEqual(self.run_git("-C", repo, "status", "--porcelain"), "?? notes.txt")
            with self.assertRaisesRegex(git_remote.GitRemoteError, "under projects"):
                git_remote.resolve_workspace_repository(workspace, "wiki")

    def test_commit_refuses_unselected_existing_index_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            (workspace / "projects").mkdir(parents=True)
            repo = self.make_repository(workspace)
            (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
            self.run_git("-C", repo, "add", "staged.txt")
            with self.assertRaisesRegex(git_remote.GitRemoteError, "already has staged changes"):
                git_remote.commit_paths(workspace, "projects/demo", ["staged.txt"], "Staged commit", "Test", "test@example.invalid")

    def test_pull_and_push_use_fast_forward_and_never_force(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            (workspace / "projects").mkdir(parents=True)
            remote_path = root / "remote.git"
            self.run_git("init", "--bare", "--initial-branch=main", remote_path)
            repo = self.make_repository(workspace)
            self.run_git("-C", repo, "remote", "add", "origin", str(remote_path))
            self.run_git("-C", repo, "push", "-u", "origin", "main")

            other = root / "other"
            self.run_git("clone", str(remote_path), str(other))
            self.run_git("-C", other, "config", "user.name", "Git Test")
            self.run_git("-C", other, "config", "user.email", "git-test@example.invalid")
            (other / "remote.txt").write_text("remote update\n", encoding="utf-8")
            self.run_git("-C", other, "add", "remote.txt")
            self.run_git("-C", other, "commit", "-m", "remote update")
            self.run_git("-C", other, "push", "origin", "main")
            remote = git_remote.RemoteRepository(str(remote_path), "https://example.invalid", "example.invalid",
                                                 "owner", "repo", "https", "example.invalid", "git")
            with patch.object(git_remote, "_origin_for_operation", return_value=(remote, None)):
                pulled = git_remote.pull_fast_forward(workspace, "projects/demo")
            self.assertTrue((repo / "remote.txt").is_file())
            self.assertEqual(pulled["behind"], 0)
            (repo / "local.txt").write_text("local update\n", encoding="utf-8")
            self.run_git("-C", repo, "add", "local.txt")
            self.run_git("-C", repo, "commit", "-m", "local update")
            with patch.object(git_remote, "_origin_for_operation", return_value=(remote, None)):
                pushed = git_remote.push_current_branch(workspace, "projects/demo")
            self.assertEqual(pushed["ahead"], 0)
            self.assertTrue((other / "local.txt").is_file() is False)
            self.run_git("-C", other, "fetch", "origin")
            self.assertEqual(self.run_git("-C", other, "show", "origin/main:local.txt"), "local update")

    def test_parse_https_remote_and_nested_gitlab_path(self):
        github = git_remote.parse_remote_url("https://GitHub.com/octo/project.git")
        self.assertEqual(github.host, "github.com")
        self.assertEqual(github.origin, "https://github.com")
        self.assertEqual(github.path, "octo/project")

        gitlab = git_remote.parse_remote_url("https://gitlab.example:443/team/subgroup/project.git")
        self.assertEqual(gitlab.host, "gitlab.example")
        self.assertEqual(gitlab.path, "team/subgroup/project")

    def test_parse_ssh_urls_normalizes_scp_and_nonstandard_port(self):
        scp = git_remote.parse_remote_url("git@github.com:octo/project.git")
        self.assertEqual(scp.transport, "ssh")
        self.assertEqual(scp.url, "ssh://git@github.com/octo/project.git")
        self.assertEqual(scp.origin, "https://github.com")
        self.assertEqual(scp.ssh_host_key, "github.com")

        custom = git_remote.parse_remote_url("ssh://git@gitlab.example:2222/team/project.git")
        self.assertEqual(custom.host, "gitlab.example:2222")
        self.assertEqual(custom.origin, "https://gitlab.example")
        self.assertEqual(custom.ssh_host_key, "[gitlab.example]:2222")
        self.assertEqual(custom.path, "team/project")

    def test_ssh_key_requires_matching_known_hosts_and_returns_public_key(self):
        if not shutil.which("ssh-keygen"):
            self.skipTest("ssh-keygen is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client_key = root / "client"
            host_key = root / "host"
            for path in (client_key, host_key):
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path)], check=True)
            host_public = host_key.with_suffix(".pub").read_text(encoding="utf-8").split()
            known_hosts = f"[forgejo.example]:2222 {host_public[0]} {host_public[1]} test-host"
            public = git_remote.inspect_ssh_credentials("forgejo.example:2222", client_key.read_text(), known_hosts)
            self.assertEqual(public, client_key.with_suffix(".pub").read_text(encoding="utf-8").strip())
            with self.assertRaisesRegex(git_remote.GitRemoteError, "does not match"):
                git_remote.inspect_ssh_credentials("forgejo.example:2223", client_key.read_text(), known_hosts)

    def test_rejects_non_https_or_credential_bearing_urls(self):
        for remote in (
            "http://github.com/octo/project.git",
            "https://user:token@github.com/octo/project.git",
            "file:///tmp/project",
            "https://github.com/octo/%2e%2e/project.git",
            "https://github.com/octo%2fother/project.git",
            "https://github.com/octo/project.git?token=secret",
        ):
            with self.subTest(remote=remote), self.assertRaises(git_remote.GitRemoteError):
                git_remote.parse_remote_url(remote)

    def test_clone_destination_must_be_new_and_inside_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "projects").mkdir()
            self.assertEqual(
                git_remote.validate_clone_path(root, "projects/demo"),
                root / "projects" / "demo",
            )
            for path in ("../outside", "notes", "/tmp/repo", "projects/../outside"):
                with self.subTest(path=path), self.assertRaises(git_remote.GitRemoteError):
                    git_remote.validate_clone_path(root, path)
            (root / "projects" / "existing").mkdir()
            with self.assertRaises(git_remote.GitRemoteError):
                git_remote.validate_clone_path(root, "projects/existing")

    def test_credentials_are_host_scoped_and_provider_usernames_are_selected(self):
        remote = git_remote.parse_remote_url("https://github.com/octo/project.git")
        credentials = git_remote._credential_for(remote, {
            "host": "https://GITHUB.com/", "provider": "github", "token": "secret",
        })
        self.assertEqual(credentials, {"host": "github.com", "username": "x-access-token", "token": "secret"})
        with self.assertRaises(git_remote.GitRemoteError):
            git_remote._credential_for(remote, {
                "host": "gitlab.com", "provider": "gitlab", "token": "secret",
            })
        with self.assertRaises(git_remote.GitRemoteError):
            git_remote._credential_for(remote, {
                "host": "github.com", "provider": "forgejo", "token": "secret",
            })

    def test_askpass_only_returns_credentials_for_the_configured_host(self):
        credentials = {"host": "github.com", "username": "x-access-token", "token": "secret"}
        with patch.dict(os.environ, {"GIT_TRACE": "1", "GIT_CURL_VERBOSE": "1"}):
            with git_remote._git_environment(credentials) as env:
                self.assertNotIn("GIT_TRACE", env)
                self.assertNotIn("GIT_CURL_VERBOSE", env)
                allowed = subprocess.run(
                    [env["GIT_ASKPASS"], "Password for 'https://github.com/o/r.git':"],
                    capture_output=True, text=True, env=env,
                )
                blocked = subprocess.run(
                    [env["GIT_ASKPASS"], "Password for 'https://attacker.example/o/r.git':"],
                    capture_output=True, text=True, env=env,
                )
        self.assertEqual(allowed.stdout.strip(), "secret")
        self.assertEqual(blocked.returncode, 1)
        self.assertNotIn("secret", blocked.stdout)

    def test_ssh_environment_uses_temporary_key_and_strict_host_checking(self):
        credentials = {
            "method": "ssh", "host": "forgejo.example", "username": "git",
            "private_key": "private-key-material", "known_hosts": "forgejo.example ssh-ed25519 AAAA host-key",
        }
        with git_remote._git_environment(credentials) as env:
            command = env["GIT_SSH_COMMAND"]
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertIn("IdentitiesOnly=yes", command)
            parts = shlex.split(command)
            key_path = parts[parts.index("-i") + 1]
            known_hosts_path = next(value.split("=", 1)[1] for value in parts if value.startswith("UserKnownHostsFile="))
            self.assertEqual(Path(key_path).read_text(encoding="utf-8"), "private-key-material")
            self.assertEqual(Path(known_hosts_path).read_text(encoding="utf-8"), credentials["known_hosts"] + "\n")
            self.assertEqual(Path(key_path).stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(known_hosts_path).stat().st_mode & 0o777, 0o600)

    def test_git_error_output_redacts_access_token(self):
        completed = subprocess.CompletedProcess([], 1, "", "remote rejected secret-token")
        with patch.object(git_remote.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(git_remote.GitRemoteError, "\\[redacted\\]") as raised:
                git_remote._run_git(
                    ["clone", "https://github.com/o/r.git"],
                    credentials={"host": "github.com", "username": "x-access-token", "token": "secret-token"},
                )
        self.assertNotIn("secret-token", str(raised.exception))

    def test_clone_uses_clean_remote_and_returns_workspace_relative_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "projects").mkdir()

            def fake_git(args, cwd=None, credentials=None, timeout=60):
                if args[0] == "clone":
                    Path(args[-1]).mkdir()
                    return ""
                if args[0] == "-C" and args[2] == "branch":
                    return "main"
                raise AssertionError(args)

            with patch.object(git_remote, "_run_git", side_effect=fake_git) as run_git:
                result = git_remote.clone_repository(
                    root, "https://github.com/octo/project", "projects/project",
                    {"host": "github.com", "provider": "github", "token": "secret"},
                )
            self.assertEqual(result["path"], "projects/project")
            self.assertEqual(result["branch"], "main")
            self.assertEqual(result["remote"], "https://github.com/octo/project.git")
            self.assertEqual(run_git.call_args_list[0].kwargs["credentials"]["token"], "secret")

    def test_push_uses_fixed_remote_and_validated_branch(self):
        with patch.object(git_remote, "_run_git", return_value="") as run_git:
            remote = git_remote.push_branch("/workspace/projects/demo", "https://github.com/o/r.git", "jobs/task-1")
        self.assertEqual(remote.path, "o/r")
        self.assertEqual(run_git.call_args.args[0][-2], remote.url)
        self.assertEqual(run_git.call_args.args[0][-1], "jobs/task-1:refs/heads/jobs/task-1")
        with self.assertRaises(git_remote.GitRemoteError):
            git_remote.push_branch("/workspace/projects/demo", "https://github.com/o/r.git", "--delete")

    def test_github_and_forgejo_pull_request_contracts(self):
        response_body = json.dumps({"html_url": "https://github.com/o/r/pull/2", "number": 2}).encode()
        with patch.object(git_remote, "urlopen", side_effect=[io.BytesIO(b"[]"), io.BytesIO(response_body)]) as open_url:
            result = git_remote.create_review_request(
                "https://github.com/o/r.git", "github", "secret-token", "jobs/task", "main", "Changes", "Details",
            )
        request = open_url.call_args_list[1].args[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/o/r/pulls")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertEqual(json.loads(request.data), {"title": "Changes", "head": "jobs/task", "base": "main", "body": "Details"})
        self.assertEqual(result["url"], "https://github.com/o/r/pull/2")

        response_body = json.dumps({"html_url": "https://codeberg.org/o/r/pulls/3", "number": 3}).encode()
        with patch.object(git_remote, "urlopen", side_effect=[io.BytesIO(b"[]"), io.BytesIO(response_body)]) as open_url:
            git_remote.create_review_request(
                "https://codeberg.org/o/r.git", "forgejo", "secret-token", "jobs/task", "main", "Changes",
            )
        request = open_url.call_args_list[1].args[0]
        self.assertEqual(request.full_url, "https://codeberg.org/api/v1/repos/o/r/pulls")
        self.assertEqual(request.get_header("Authorization"), "token secret-token")

    def test_gitlab_merge_request_uses_encoded_namespace_path(self):
        response_body = json.dumps({"web_url": "https://gitlab.example/team/sub/project/-/merge_requests/4", "iid": 4}).encode()
        with patch.object(git_remote, "urlopen", side_effect=[io.BytesIO(b"[]"), io.BytesIO(response_body)]) as open_url:
            result = git_remote.create_review_request(
                "https://gitlab.example/team/sub/project.git", "gitlab", "secret-token",
                "jobs/task", "main", "Changes", "Details",
            )
        request = open_url.call_args_list[1].args[0]
        self.assertEqual(request.full_url, "https://gitlab.example/api/v4/projects/team%2Fsub%2Fproject/merge_requests")
        self.assertEqual(request.get_header("Private-token"), "secret-token")
        self.assertEqual(json.loads(request.data)["source_branch"], "jobs/task")
        self.assertEqual(result["number"], 4)

    def test_provider_http_errors_do_not_echo_access_token(self):
        error = git_remote.HTTPError("https://api.github.com", 403, "Forbidden", {}, io.BytesIO(b'{"message":"secret-token denied"}'))
        with patch.object(git_remote, "urlopen", side_effect=[io.BytesIO(b"[]"), error]):
            with self.assertRaisesRegex(git_remote.GitRemoteError, "\\[redacted\\]") as raised:
                git_remote.create_review_request(
                    "https://github.com/o/r.git", "github", "secret-token", "jobs/task", "main", "Changes",
                )
        self.assertNotIn("secret-token", str(raised.exception))

    def test_existing_review_request_is_returned_without_creating_another(self):
        existing = [{
            "html_url": "https://github.com/o/r/pull/8", "number": 8,
            "head": {"ref": "jobs/task"}, "base": {"ref": "main"}, "state": "open",
        }]
        with patch.object(git_remote, "urlopen", return_value=io.BytesIO(json.dumps(existing).encode())) as open_url:
            result = git_remote.create_review_request(
                "https://github.com/o/r.git", "github", "secret-token", "jobs/task", "main", "Changes",
            )
        self.assertEqual(result["url"], "https://github.com/o/r/pull/8")
        self.assertTrue(result["already_exists"])
        self.assertEqual(open_url.call_count, 1)
        self.assertEqual(open_url.call_args.args[0].get_method(), "GET")

    def test_review_request_rejects_link_to_an_unrelated_host(self):
        response_body = json.dumps({"html_url": "https://attacker.example/pull/2", "number": 2}).encode()
        with patch.object(git_remote, "urlopen", side_effect=[io.BytesIO(b"[]"), io.BytesIO(response_body)]):
            with self.assertRaisesRegex(git_remote.GitRemoteError, "no HTTPS link"):
                git_remote.create_review_request(
                    "https://github.com/o/r.git", "github", "secret-token", "jobs/task", "main", "Changes",
                )


if __name__ == "__main__":
    unittest.main()