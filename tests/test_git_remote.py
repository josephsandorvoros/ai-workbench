import io
import json
import os
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

    def test_parse_https_remote_and_nested_gitlab_path(self):
        github = git_remote.parse_remote_url("https://GitHub.com/octo/project.git")
        self.assertEqual(github.host, "github.com")
        self.assertEqual(github.origin, "https://github.com")
        self.assertEqual(github.path, "octo/project")

        gitlab = git_remote.parse_remote_url("https://gitlab.example:443/team/subgroup/project.git")
        self.assertEqual(gitlab.host, "gitlab.example")
        self.assertEqual(gitlab.path, "team/subgroup/project")

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