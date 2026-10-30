import os
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy" / "publish-github.sh"
SNAPSHOT_SPEC = importlib.util.spec_from_file_location("github_snapshot", ROOT / "deploy" / "github_snapshot.py")
SNAPSHOT = importlib.util.module_from_spec(SNAPSHOT_SPEC)
SNAPSHOT_SPEC.loader.exec_module(SNAPSHOT)


class GitHubPublishTests(unittest.TestCase):
    def run_publish(self, failure="", repo_token="unit-test-repo-token",
                    ghcr_token="unit-test-ghcr-token", mismatch=False,
                    already_published=False, snapshot_failure=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "bin"
            binaries.mkdir()
            deploy = root / "deploy"
            deploy.mkdir()
            licenses = root / "licenses"
            licenses.mkdir()
            shutil.copyfile(SCRIPT, deploy / SCRIPT.name)
            shutil.copyfile(ROOT / "deploy" / "check-license-review.mjs", deploy / "check-license-review.mjs")
            shutil.copyfile(ROOT / "deploy" / "github_snapshot.py", deploy / "github_snapshot.py")
            (licenses / "review.json").write_text(json.dumps({
                "status": "approved", "blockers": [], "reviewedAt": "2026-10-30", "evidence": "unit test fixture",
            }), encoding="utf-8")
            for name, content in {
                "git": '''#!/bin/sh
printf 'git %s\n' "$*" >> "$PUBLISH_TEST_LOG"
case "$*" in
  'rev-parse HEAD') printf 'release-commit\n' ;;
    'rev-parse --show-toplevel') printf '%s\n' "$PUBLISH_TEST_SOURCE" ;;
  'rev-parse refs/tags/v1.2.3^{commit}') printf '%s\n' "${PUBLISH_TEST_COMMIT:-release-commit}" ;;
  'rev-parse --is-shallow-repository') printf 'true\n' ;;
    *'push --atomic'*)
        [ "$("$GIT_ASKPASS" Username)" = josephsandorvoros ] || exit 90
        [ "$("$GIT_ASKPASS" Password)" = unit-test-repo-token ] || exit 91
        printf 'Git credential verified\n' >> "$PUBLISH_TEST_LOG"
        ;;
esac
''',
                "python3": '''#!/bin/sh
printf 'snapshot prepare\n' >> "$PUBLISH_TEST_LOG"
if [ "$PUBLISH_TEST_SNAPSHOT_FAILURE" = 1 ]; then exit 1; fi
printf '%s\n' "$PUBLISH_TEST_SNAPSHOT_STATUS"
''',
                "skopeo": '''#!/bin/sh
printf 'skopeo %s\n' "$*" >> "$PUBLISH_TEST_LOG"
if [ "$1" = login ]; then
    case "$*" in
        *ghcr.io) expected=unit-test-ghcr-token ;;
        *) expected=unit-test-password ;;
    esac
    [ "$(cat)" = "$expected" ] || exit 92
    printf 'Registry credential verified\n' >> "$PUBLISH_TEST_LOG"
fi
case "$*" in
  *"$PUBLISH_TEST_FAILURE"*) if [ -n "$PUBLISH_TEST_FAILURE" ]; then exit 1; fi ;;
esac
''',
            }.items():
                binary = binaries / name
                binary.write_text(content, encoding="utf-8")
                binary.chmod(0o700)
            result = subprocess.run(
                ["bash", str(deploy / SCRIPT.name), "v1.2.3"], text=True, capture_output=True,
                env={
                    **os.environ, "PATH": f"{binaries}:{os.environ['PATH']}",
                    "PUBLISH_TEST_LOG": str(root / "commands"),
                    "PUBLISH_TEST_FAILURE": failure,
                    "PUBLISH_TEST_SOURCE": str(root),
                    "PUBLISH_TEST_SNAPSHOT_FAILURE": "1" if snapshot_failure else "0",
                    "PUBLISH_TEST_SNAPSHOT_STATUS": "already-published" if already_published else "prepared",
                    "PUBLISH_TEST_COMMIT": "different-commit" if mismatch else "release-commit",
                    "REGISTRY_USERNAME": "test-user", "REGISTRY_PASSWORD": "unit-test-password",
                    "REPO_TOKEN_GITHUB": repo_token, "GHCR_TOKEN": ghcr_token,
                },
            )
            log = root / "commands"
            return result, log.read_text() if log.exists() else ""

    def test_copies_all_images_before_atomic_non_force_source_push(self):
        result, commands = self.run_publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        copies = [line for line in commands.splitlines() if line.startswith("skopeo copy")]
        self.assertEqual(len(copies), 8)
        for name in ("agent", "web", "sandbox", "worker"):
            self.assertIn(f"docker://ghcr.io/josephsandorvoros/spatial-workbench-{name}:v1.2.3", commands)
            self.assertIn(f"docker://ghcr.io/josephsandorvoros/spatial-workbench-{name}:latest", commands)
        self.assertTrue(all("--all --preserve-digests" in line for line in copies))
        self.assertLess(commands.rindex("skopeo copy"), commands.index("push --atomic"))
        self.assertNotIn("fetch --unshallow origin", commands)
        self.assertLess(commands.index("snapshot prepare"), commands.index("skopeo login"))
        self.assertIn("/public -c credential.helper= push --atomic", commands)
        self.assertIn("HEAD:refs/heads/main refs/tags/v1.2.3:refs/tags/v1.2.3", commands)
        self.assertNotIn("--force", commands)
        self.assertNotIn("--mirror", commands)
        self.assertIn("Git credential verified", commands)
        self.assertEqual(commands.count("Registry credential verified"), 2)
        for secret in ("unit-test-repo-token", "unit-test-ghcr-token", "unit-test-password"):
            self.assertNotIn(secret, commands + result.stdout + result.stderr)

    def test_failed_version_copy_blocks_latest_and_source(self):
        result, commands = self.run_publish(failure="spatial-workbench-sandbox:v1.2.3")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(":latest", commands)
        self.assertNotIn("push --atomic", commands)

    def test_failed_latest_copy_blocks_source(self):
        result, commands = self.run_publish(failure="spatial-workbench-web:latest")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("push --atomic", commands)

    def test_missing_repo_token_stops_before_external_commands(self):
        result, commands = self.run_publish(repo_token="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, "")

    def test_missing_ghcr_token_stops_before_external_commands(self):
        result, commands = self.run_publish(ghcr_token="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, "")

    def test_workflow_maps_distinct_secrets(self):
        workflow = (ROOT / ".forgejo" / "workflows" / "publish.yml").read_text()
        self.assertIn("REPO_TOKEN_GITHUB: ${{ secrets.REPO_TOKEN_GITHUB }}", workflow)
        self.assertIn("GHCR_TOKEN: ${{ secrets.GHCR_TOKEN }}", workflow)
        self.assertIn("github.ref_type == 'tag' && vars.PUBLISH_GITHUB_ENABLED == 'true'", workflow)
        self.assertNotIn("vars.GITHUB_PUBLISH_ENABLED", workflow)
        self.assertNotIn("GITHUB_PUBLISH_TOKEN", workflow)

    def test_wrong_checkout_stops_before_registry_access(self):
        result, commands = self.run_publish(mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("skopeo", commands)
        self.assertNotIn("push --atomic", commands)

    def test_snapshot_failure_stops_before_registry_access(self):
        result, commands = self.run_publish(snapshot_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("skopeo", commands)
        self.assertNotIn("push --atomic", commands)

    def test_already_published_tag_does_not_change_main_or_latest(self):
        result, commands = self.run_publish(already_published=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("skopeo", commands)
        self.assertNotIn("push --atomic", commands)


class PublicSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.remote = self.root / "public.git"
        self.source.mkdir()
        self.git(self.source, "init", "--initial-branch=main")
        self.git(self.source, "config", "user.name", "Private development identity")
        self.git(self.source, "config", "user.email", "private@example.invalid")
        (self.source / "BLOG_POST_DRAFT.md").write_text("private historical draft", encoding="utf-8")
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-m", "private development history")
        self.private_commit = self.git(self.source, "rev-parse", "HEAD")
        (self.source / "BLOG_POST_DRAFT.md").unlink()
        (self.source / "README.md").write_text("public release source", encoding="utf-8")
        (self.source / "MAINTAINER_README.local.md").write_text("private notes", encoding="utf-8")
        (self.source / ".forgejo").mkdir()
        (self.source / ".forgejo" / "workflow.yml").write_text("private build configuration", encoding="utf-8")
        self.git(self.source, "add", "--all")
        self.git(self.source, "commit", "-m", "release source")
        self.git(self.source, "tag", "v1.0.0")
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))

    def git(self, directory, *arguments):
        result = subprocess.run(
            ["git", "-C", str(directory), "-c", "core.hooksPath=/dev/null", *arguments],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def prepare(self, name="snapshot", tag="v1.0.0"):
        destination = self.root / name
        status = SNAPSHOT.prepare_snapshot(self.source, destination, tag, str(self.remote))
        return destination, status

    def publish(self, destination, tag="v1.0.0"):
        self.git(destination, "push", "--atomic", str(self.remote), "HEAD:refs/heads/main", f"refs/tags/{tag}:refs/tags/{tag}")

    def test_first_public_commit_contains_no_private_history_or_identity(self):
        destination, status = self.prepare()
        self.assertEqual(status, "prepared")
        self.assertEqual(self.git(destination, "rev-list", "--count", "HEAD"), "1")
        tracked = self.git(destination, "ls-tree", "-r", "--name-only", "HEAD")
        self.assertNotIn("BLOG_POST_DRAFT.md", tracked)
        self.assertNotIn("MAINTAINER_README.local.md", tracked)
        self.assertNotIn(".forgejo/", tracked)
        self.assertNotIn("private@example.invalid", self.git(destination, "log", "--format=fuller"))
        self.assertNotIn(self.private_commit, self.git(destination, "rev-list", "HEAD"))
        self.assertEqual((destination / "README.md").read_text(), "public release source")
        record = json.loads((destination / SNAPSHOT.RELEASE_RECORD).read_text())
        self.assertEqual(record["sourceCommit"], self.git(self.source, "rev-parse", "HEAD"))
        self.assertEqual(self.git(self.source, "rev-list", "--count", "HEAD"), "2")
        self.assertEqual(self.git(self.source, "status", "--porcelain"), "")

    def test_next_release_extends_only_public_snapshot_history(self):
        first, _ = self.prepare("first")
        self.publish(first)
        (self.source / "README.md").write_text("next public release", encoding="utf-8")
        self.git(self.source, "commit", "-a", "-m", "private internal release description")
        self.git(self.source, "tag", "v1.0.1")
        second, status = self.prepare("second", "v1.0.1")
        self.assertEqual(status, "prepared")
        self.assertEqual(self.git(second, "rev-list", "--count", "HEAD"), "2")
        self.assertEqual(self.git(second, "rev-parse", "HEAD^"), self.git(first, "rev-parse", "HEAD"))
        self.assertNotIn("private internal", self.git(second, "log", "--format=%B"))
        self.publish(second, "v1.0.1")

    def test_retry_of_identical_published_release_is_a_no_op(self):
        first, _ = self.prepare("first")
        self.publish(first)
        _, status = self.prepare("retry")
        self.assertEqual(status, "already-published")

    def test_existing_unmanaged_github_history_is_not_overwritten(self):
        self.git(self.source, "push", str(self.remote), "HEAD:refs/heads/main")
        before = self.git(self.remote, "rev-parse", "refs/heads/main")
        with self.assertRaisesRegex(RuntimeError, "not a managed public snapshot"):
            self.prepare()
        self.assertEqual(self.git(self.remote, "rev-parse", "refs/heads/main"), before)


if __name__ == "__main__":
    unittest.main()