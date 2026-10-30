import argparse
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path


GITHUB_REPOSITORY = "https://github.com/josephsandorvoros/ai-workbench.git"
RELEASE_RECORD = ".ai-workbench-release.json"
PUBLICATION_KIND = "ai-workbench-public-snapshot"
PRIVATE_PATHS = (
    ".forgejo", "BLOG_POST_DRAFT.md", "MAINTAINER_README.local.md",
    "spatial-workbench/unified_build_plan.html",
)


def git(directory, *arguments, data=None, environment=None):
    result = subprocess.run(
        ["git", "-C", str(directory), "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", *arguments],
        input=data, text=True, capture_output=True, env=environment,
    )
    if result.returncode:
        raise RuntimeError(f"Git {arguments[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def release_record(directory, reference):
    try:
        record = json.loads(git(directory, "show", f"{reference}:{RELEASE_RECORD}"))
    except (RuntimeError, ValueError) as error:
        raise RuntimeError("GitHub main/tag is not a managed public snapshot; refusing to overwrite it.") from error
    if record.get("kind") != PUBLICATION_KIND or record.get("schema") != 1:
        raise RuntimeError("GitHub history is not a managed public snapshot; manual reconciliation is required.")
    return record


def prepare_snapshot(source, destination, tag, repository=GITHUB_REPOSITORY):
    source = Path(source).resolve()
    destination = Path(destination).resolve()
    if not tag.startswith("v"):
        raise RuntimeError("Only v* release tags can be published.")
    git(source, "check-ref-format", f"refs/tags/{tag}")
    commit = git(source, "rev-parse", "HEAD")
    if commit != git(source, "rev-parse", f"refs/tags/{tag}^{{commit}}"):
        raise RuntimeError("Checkout does not match the release tag.")
    destination.mkdir()
    archive = subprocess.check_output(["git", "-C", str(source), "archive", "--format=tar", commit])
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as content:
        content.extractall(destination, filter="data")
    for relative in PRIVATE_PATHS:
        candidate = destination / relative
        if candidate.is_symlink() or candidate.is_file():
            candidate.unlink()
        elif candidate.is_dir():
            shutil.rmtree(candidate)
    record = {"kind": PUBLICATION_KIND, "schema": 1, "sourceCommit": commit, "releaseTag": tag}
    (destination / RELEASE_RECORD).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    git(destination, "init", "--initial-branch=main")
    git(destination, "add", "--force", "--all")
    tree = git(destination, "write-tree")
    main_ref = "refs/heads/main"
    tag_ref = f"refs/tags/{tag}"
    remote_lines = git(destination, "ls-remote", "--refs", repository, main_ref, tag_ref)
    remote = dict(line.split("\t", 1)[::-1] for line in remote_lines.splitlines())
    if tag_ref in remote:
        git(destination, "fetch", "--no-tags", repository, f"{tag_ref}:{tag_ref}")
        if release_record(destination, tag_ref) != record or git(destination, "rev-parse", f"{tag_ref}^{{tree}}") != tree:
            raise RuntimeError("GitHub release tag already exists with different source or files; refusing to overwrite it.")
        return "already-published"
    parent = []
    if main_ref in remote:
        public_ref = "refs/remotes/public/main"
        git(destination, "fetch", "--no-tags", repository, f"{main_ref}:{public_ref}")
        release_record(destination, public_ref)
        parent = ["-p", public_ref]
    timestamp = git(source, "show", "-s", "--format=%ct", commit)
    identity = {
        **os.environ,
        "GIT_AUTHOR_NAME": "AI Workbench Release", "GIT_COMMITTER_NAME": "AI Workbench Release",
        "GIT_AUTHOR_EMAIL": "josephsandorvoros@users.noreply.github.com",
        "GIT_COMMITTER_EMAIL": "josephsandorvoros@users.noreply.github.com",
        "GIT_AUTHOR_DATE": f"@{timestamp} +0000", "GIT_COMMITTER_DATE": f"@{timestamp} +0000",
    }
    public_commit = git(destination, "commit-tree", tree, *parent, data=f"Release {tag}\n", environment=identity)
    git(destination, "update-ref", main_ref, public_commit)
    git(destination, "tag", "--annotate", tag, public_commit, "--message", f"Release {tag}", environment=identity)
    return "prepared"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("tag")
    arguments = parser.parse_args()
    try:
        print(prepare_snapshot(arguments.source, arguments.destination, arguments.tag))
    except (OSError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
        parser.exit(1, f"Public snapshot failed: {error}\n")