"""Remote Git operations for workspace repositories."""

import json
import ipaddress
import os
import re
import shlex
import socket
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen


PROVIDERS = {"github", "gitlab", "forgejo"}
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._~-]{1,200}$")
_SAFE_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,240}$")


class GitRemoteError(ValueError):
    pass


@dataclass(frozen=True)
class RemoteRepository:
    url: str
    origin: str
    host: str
    namespace: str
    name: str
    transport: str
    ssh_host_key: str
    ssh_user: str

    @property
    def path(self):
        return f"{self.namespace}/{self.name}"


def parse_remote_url(value):
    raw = str(value or "").strip()
    if not raw or len(raw) > 2048:
        raise GitRemoteError("Enter an HTTPS or SSH Git repository URL")
    transport = "https"
    ssh_user = "git"
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise GitRemoteError("Repository URL is invalid") from exc
    if parsed.scheme.lower() == "ssh":
        if not parsed.hostname or parsed.password is not None or parsed.query or parsed.fragment:
            raise GitRemoteError("SSH repository URL is invalid")
        ssh_user = parsed.username or "git"
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", ssh_user):
            raise GitRemoteError("SSH repository username is invalid")
        transport = "ssh"
        source_path = parsed.path
    elif parsed.scheme.lower() == "https":
        if (not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment):
            raise GitRemoteError("HTTPS repository URL must not embed credentials or query values")
        source_path = parsed.path
    elif "://" not in raw:
        scp = re.fullmatch(r"(?:(?P<user>[A-Za-z0-9._-]{1,64})@)?(?P<host>\[[^]]+\]|[^/:]+):(?P<path>.+)", raw)
        if not scp:
            raise GitRemoteError("Use an HTTPS URL or SSH URL such as git@host:owner/repository.git")
        ssh_user = scp.group("user") or "git"
        parsed = urlsplit(f"ssh://{ssh_user}@{scp.group('host')}/{scp.group('path')}")
        try:
            port = parsed.port
        except ValueError as exc:
            raise GitRemoteError("SSH repository URL is invalid") from exc
        transport = "ssh"
        source_path = parsed.path
    else:
        raise GitRemoteError("Only HTTPS or SSH Git repository URLs are supported")
    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname or any(character.isspace() for character in hostname):
        raise GitRemoteError("Repository host is invalid")
    if port == 443:
        port = None
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port:
        host = f"{host}:{port}"
    api_host = f"[{hostname}]" if ":" in hostname else hostname
    if port and transport == "https":
        api_host = f"{api_host}:{port}"
    origin = f"https://{api_host}"
    raw_parts = source_path.strip("/").split("/")
    parts = [unquote(part) for part in raw_parts if part]
    if len(parts) < 2 or any(not _SAFE_SEGMENT.fullmatch(part) or part in {".", ".."} for part in parts):
        raise GitRemoteError("Repository URL must include a valid namespace and repository name")
    if parts[-1].endswith(".git"):
        parts[-1] = parts[-1][:-4]
    if not parts[-1] or len(parts) < 2:
        raise GitRemoteError("Repository URL must include a repository name")
    safe_path = "/".join(quote(part, safe="-._~") for part in parts)
    if transport == "ssh":
        userinfo = f"{quote(ssh_user, safe='-._~')}@"
        remote_url = f"ssh://{userinfo}{host}/{safe_path}.git"
        ssh_host_key = f"[{host}]" if port else hostname
        if port:
            ssh_host_key = f"[{hostname}]:{port}"
    else:
        remote_url = f"{origin}/{safe_path}.git"
        ssh_host_key = host
    return RemoteRepository(remote_url, origin, host, "/".join(parts[:-1]), parts[-1], transport,
                            ssh_host_key, ssh_user)


def normalize_host(value):
    raw = str(value or "").strip()
    if not raw:
        raise GitRemoteError("Enter a Git host")
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise GitRemoteError("Git host is invalid") from exc
    if (parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise GitRemoteError("Git host must be an HTTPS host without a path or embedded credentials")
    hostname = parsed.hostname.rstrip(".").lower()
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port and port != 443:
        host = f"{host}:{port}"
    return host


def validate_host_provider(host, provider):
    host = normalize_host(host)
    provider = str(provider or "").strip().lower()
    if provider not in PROVIDERS:
        raise GitRemoteError("Choose GitHub, GitLab, or Forgejo")
    return host, provider


def validate_clone_path(workspace_root, value):
    raw = str(value or "").strip()
    path = Path(raw)
    if not raw or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise GitRemoteError("Choose a relative destination inside projects/")
    if path.parts[0] != "projects" or len(path.parts) < 2:
        raise GitRemoteError("Repositories must be cloned inside projects/")
    root = Path(workspace_root).resolve()
    target = root.joinpath(path)
    if target.exists() or target.is_symlink():
        raise GitRemoteError("A file or folder already exists at the clone destination")
    if not target.parent.resolve().is_relative_to(root):
        raise GitRemoteError("Clone destination must stay inside the workspace")
    return target


def validate_remote_host(remote, allow_private=False):
    parsed = urlsplit(remote.origin)
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise GitRemoteError("Git host could not be resolved") from exc
    if not addresses:
        raise GitRemoteError("Git host did not resolve to an address")
    if not allow_private:
        for address in {item[4][0] for item in addresses}:
            try:
                is_public = ipaddress.ip_address(address.split("%", 1)[0]).is_global
            except ValueError:
                is_public = False
            if not is_public:
                raise GitRemoteError("Unconfigured Git hosts must resolve to public IP addresses; add self-hosted hosts under Git host credentials")


def _credential_for(remote, credentials):
    if not credentials:
        return None
    host = normalize_host(remote.host)
    if normalize_host(credentials.get("host")) != host:
        raise GitRemoteError("Saved Git credentials do not match this repository host")
    if remote.transport == "ssh":
        private_key = str(credentials.get("private_key") or "")
        known_hosts = str(credentials.get("known_hosts") or "")
        if not private_key or not known_hosts:
            return None
        return {"method": "ssh", "host": remote.host, "private_key": private_key,
                "known_hosts": known_hosts, "username": remote.ssh_user}
    token = str(credentials.get("token") or "")
    if not token:
        return None
    provider = str(credentials.get("provider") or "").lower()
    username = str(credentials.get("username") or "").strip()
    if provider == "github":
        username = username or "x-access-token"
    elif provider == "gitlab":
        username = username or "oauth2"
    elif provider == "forgejo" and not username:
        raise GitRemoteError("A Forgejo username is required with its access token")
    return {"host": remote.host, "username": username, "token": token}


@contextmanager
def _git_environment(credentials=None):
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    for name in tuple(env):
        if name.startswith("GIT_TRACE") or name == "GIT_CURL_VERBOSE":
            env.pop(name, None)
    if not credentials:
        yield env
        return
    with tempfile.TemporaryDirectory(prefix="workbench-git-auth-") as temp_dir:
        if credentials.get("method") == "ssh":
            if not shutil.which("ssh"):
                raise GitRemoteError("SSH client is not installed in the Workbench image")
            key_file = Path(temp_dir) / "identity"
            known_hosts_file = Path(temp_dir) / "known_hosts"
            key_file.write_text(credentials["private_key"], encoding="utf-8")
            key_file.chmod(0o600)
            known_hosts_file.write_text(credentials["known_hosts"] + "\n", encoding="utf-8")
            known_hosts_file.chmod(0o600)
            env["GIT_SSH_COMMAND"] = shlex.join([
                shutil.which("ssh") or "ssh", "-i", str(key_file), "-o", "IdentitiesOnly=yes",
                "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", f"UserKnownHostsFile={known_hosts_file}", "-o", "ConnectTimeout=15",
            ])
            yield env
            return
        helper = Path(temp_dir) / "askpass"
        helper.write_text(
            "#!/usr/bin/env python3\n"
            "import os, re, sys\n"
            "prompt = sys.argv[1] if len(sys.argv) > 1 else ''\n"
            "match = re.search(r\"https://([^/'\\\" ]+)\", prompt)\n"
            "authority = match.group(1).rsplit('@', 1)[-1].rstrip(':') if match else ''\n"
            "if not authority or authority.lower() != os.environ.get('GIT_HTTP_EXPECTED_HOST', '').lower(): sys.exit(1)\n"
            "if 'Username' in prompt: print(os.environ['GIT_HTTP_USERNAME'])\n"
            "elif 'Password' in prompt: print(os.environ['GIT_HTTP_TOKEN'])\n"
            "else: sys.exit(1)\n",
            encoding="utf-8",
        )
        helper.chmod(0o700)
        env.update({
            "GIT_ASKPASS": str(helper),
            "GIT_HTTP_EXPECTED_HOST": credentials["host"],
            "GIT_HTTP_USERNAME": credentials["username"],
            "GIT_HTTP_TOKEN": credentials["token"],
        })
        yield env


def _run_git(args, cwd=None, credentials=None, timeout=60):
    with _git_environment(credentials) as env:
        try:
            result = subprocess.run(
                ["git", "-c", "credential.helper=", *map(str, args)],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise GitRemoteError("Git operation timed out") from exc
        except OSError as exc:
            raise GitRemoteError("Git could not be started") from exc
    if result.returncode:
        message = result.stderr.strip() or "Git operation failed"
        if credentials:
            message = message.replace(credentials.get("token", ""), "[redacted]")
        raise GitRemoteError(message[:800])
    return result.stdout.strip()


def _run_git_bytes(args, timeout=20):
    try:
        result = subprocess.run(["git", "-c", "credential.helper=", *map(str, args)],
                                capture_output=True, timeout=timeout, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except (OSError, subprocess.SubprocessError) as exc:
        raise GitRemoteError("Could not inspect the Git repository") from exc
    if result.returncode:
        raise GitRemoteError(result.stderr.decode("utf-8", "replace").strip()[:500] or "Git inspection failed")
    return result.stdout


def resolve_workspace_repository(workspace_root, value):
    raw = str(value or "").strip()
    path = Path(raw)
    if not raw or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise GitRemoteError("Choose a project repository inside projects/")
    if path.parts[0] != "projects" or len(path.parts) < 2:
        raise GitRemoteError("Git operations are limited to repositories under projects/")
    root = Path(workspace_root).resolve()
    projects = (root / "projects").resolve()
    try:
        target = (root / path).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise GitRemoteError("Project path does not exist") from exc
    if not target.is_dir() or not target.is_relative_to(projects):
        raise GitRemoteError("Project path must be a directory inside projects/")
    top = Path(_run_git(["-C", target, "rev-parse", "--show-toplevel"])).resolve()
    if not top.is_relative_to(projects):
        raise GitRemoteError("Git repository must stay inside projects/")
    return top


def repository_status(workspace_root, value):
    repo = resolve_workspace_repository(workspace_root, value)
    branch = _run_git(["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]) if _git_returns(
        ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]
    ) else ""
    try:
        upstream = _run_git(["-C", repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    except GitRemoteError:
        upstream = ""
    ahead = behind = None
    if upstream:
        counts = _run_git(["-C", repo, "rev-list", "--left-right", "--count", f"HEAD...{upstream}"])
        ahead, behind = (int(value) for value in counts.split())
    raw_status = _run_git_bytes(["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    records = raw_status.split(b"\0")
    changes = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        code = os.fsdecode(record[:2])
        path = os.fsdecode(record[3:])
        related_path = None
        if "R" in code or "C" in code:
            if index < len(records):
                related_path = os.fsdecode(records[index])
                index += 1
        changes.append({"path": path, "related_path": related_path, "status": code,
                        "conflicted": "U" in code or code == "AA" or code == "DD",
                        "staged": code[0] != " " and code[0] != "?"})
    remote_url = ""
    remote = None
    try:
        remote_url = _run_git(["-C", repo, "remote", "get-url", "origin"])
        remote = parse_remote_url(remote_url)
    except GitRemoteError:
        remote_url = ""
    configured_name = _run_git(["-C", repo, "config", "--get", "user.name"]) if _git_returns(
        ["-C", repo, "config", "--get", "user.name"]
    ) else ""
    configured_email = _run_git(["-C", repo, "config", "--get", "user.email"]) if _git_returns(
        ["-C", repo, "config", "--get", "user.email"]
    ) else ""
    return {
        "path": repo.relative_to(Path(workspace_root).resolve()).as_posix(),
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "remote_host": remote.host if remote else "",
        "remote_transport": remote.transport if remote else "",
        "changes": changes,
        "clean": not changes,
        "author_name": configured_name,
        "author_email": configured_email,
    }


def _git_returns(args):
    return subprocess.run(["git", *map(str, args)], capture_output=True, timeout=10).returncode == 0


def commit_paths(workspace_root, value, paths, message, author_name, author_email):
    repo = resolve_workspace_repository(workspace_root, value)
    status = repository_status(workspace_root, str(repo.relative_to(Path(workspace_root).resolve())))
    if not isinstance(paths, list) or not paths or len(paths) > 500:
        raise GitRemoteError("Select one or more changed files to commit")
    message = str(message or "").strip()
    author_name = str(author_name or "").strip()
    author_email = str(author_email or "").strip()
    if not message or len(message) > 2000 or "\n" in message:
        raise GitRemoteError("Enter a one-line commit message up to 2,000 characters")
    if not author_name or len(author_name) > 200 or any(ord(char) < 32 for char in author_name):
        raise GitRemoteError("Enter a valid commit author name")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+", author_email) or len(author_email) > 254:
        raise GitRemoteError("Enter a valid commit author email")
    if any(change["conflicted"] for change in status["changes"]):
        raise GitRemoteError("Resolve conflicted files before committing")
    staged = subprocess.run(["git", "-C", str(repo), "diff", "--cached", "--quiet"], capture_output=True, timeout=10)
    if staged.returncode == 1:
        raise GitRemoteError("The repository already has staged changes; commit or unstage them first")
    if staged.returncode != 0:
        raise GitRemoteError("Could not inspect staged changes")
    available = {change["path"] for change in status["changes"]}
    available.update(change["related_path"] for change in status["changes"] if change["related_path"])
    selected = []
    for raw_path in paths:
        path = str(raw_path or "")
        if not path or Path(path).is_absolute() or any(part in {"", ".", "..", ".git"} for part in Path(path).parts):
            raise GitRemoteError("Selected commit path is invalid")
        if path not in available:
            raise GitRemoteError("A selected path is no longer changed; refresh Git status")
        if path not in selected:
            selected.append(path)
    literals = [f":(literal){path}" for path in selected]
    _run_git(["-C", repo, "add", "-A", "--", *literals], timeout=60)
    _run_git(["-C", repo, "-c", f"user.name={author_name}", "-c", f"user.email={author_email}",
              "commit", "-m", message], timeout=60)
    return {"commit": _run_git(["-C", repo, "rev-parse", "--short", "HEAD"]),
            "message": message, "path": status["path"], "files": selected}


def _origin_for_operation(repo, credentials, require_credentials=False):
    remote_url = _run_git(["-C", repo, "remote", "get-url", "origin"])
    remote = parse_remote_url(remote_url)
    auth = _credential_for(remote, credentials)
    if require_credentials and not auth:
        raise GitRemoteError(f"Configure {remote.transport.upper()} credentials for {remote.host} before pushing")
    validate_remote_host(remote, allow_private=credentials is not None)
    return remote, auth


def pull_fast_forward(workspace_root, value, credentials=None):
    repo = resolve_workspace_repository(workspace_root, value)
    status = repository_status(workspace_root, str(repo.relative_to(Path(workspace_root).resolve())))
    if not status["clean"]:
        raise GitRemoteError("Commit or stash working-tree changes before pulling")
    if not status["branch"] or not status["upstream"].startswith("origin/"):
        raise GitRemoteError("Set an origin upstream for the current branch before pulling")
    branch = status["upstream"].removeprefix("origin/")
    if not _SAFE_BRANCH.fullmatch(branch):
        raise GitRemoteError("The configured upstream branch is invalid")
    remote, auth = _origin_for_operation(repo, credentials)
    _run_git(["-C", repo, "fetch", "--no-tags", remote.url,
              f"refs/heads/{branch}:refs/remotes/origin/{branch}"], credentials=auth, timeout=300)
    _run_git(["-C", repo, "merge", "--ff-only", f"refs/remotes/origin/{branch}"], timeout=120)
    return repository_status(workspace_root, status["path"])


def push_current_branch(workspace_root, value, credentials=None):
    repo = resolve_workspace_repository(workspace_root, value)
    status = repository_status(workspace_root, str(repo.relative_to(Path(workspace_root).resolve())))
    branch = status["branch"]
    if not branch or not _SAFE_BRANCH.fullmatch(branch):
        raise GitRemoteError("Cannot push a detached or invalid branch")
    remote, auth = _origin_for_operation(repo, credentials, require_credentials=True)
    _run_git(["-C", repo, "push", remote.url, f"HEAD:refs/heads/{branch}"], credentials=auth, timeout=300)
    _run_git(["-C", repo, "fetch", "--no-tags", remote.url,
              f"refs/heads/{branch}:refs/remotes/origin/{branch}"], credentials=auth, timeout=300)
    if not status["upstream"]:
        _run_git(["-C", repo, "branch", "--set-upstream-to", f"origin/{branch}", branch])
    return repository_status(workspace_root, status["path"])


def inspect_ssh_credentials(host, private_key, known_hosts):
    host = normalize_host(host)
    private_key = str(private_key or "").strip()
    known_hosts = str(known_hosts or "").strip()
    if not private_key or len(private_key) > 64 * 1024:
        raise GitRemoteError("Enter an SSH private key smaller than 64 KB")
    if not known_hosts or len(known_hosts) > 64 * 1024:
        raise GitRemoteError("Enter a verified known_hosts entry for this host")
    if not shutil.which("ssh-keygen"):
        raise GitRemoteError("ssh-keygen is not installed in the Workbench image")
    parsed_host = urlsplit(f"https://{host}")
    host_name = parsed_host.hostname or ""
    known_host_name = f"[{host_name}]:{parsed_host.port}" if parsed_host.port else host_name
    with tempfile.TemporaryDirectory(prefix="workbench-ssh-check-") as temp_dir:
        key_path = Path(temp_dir) / "identity"
        hosts_path = Path(temp_dir) / "known_hosts"
        key_path.write_text(private_key + "\n", encoding="utf-8")
        key_path.chmod(0o600)
        hosts_path.write_text(known_hosts + "\n", encoding="utf-8")
        try:
            checked = subprocess.run(["ssh-keygen", "-F", known_host_name, "-f", str(hosts_path)],
                                     capture_output=True, text=True, timeout=10)
            if checked.returncode != 0:
                raise GitRemoteError("Known_hosts entry does not match the configured host")
            public = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(key_path)],
                                    capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as exc:
            raise GitRemoteError("Could not validate the SSH private key") from exc
    if public.returncode != 0 or not public.stdout.strip():
        raise GitRemoteError("SSH private key is invalid or passphrase-protected; use an unencrypted deploy key")
    return public.stdout.strip()


def clone_repository(workspace_root, remote_url, destination, credentials=None):
    remote = parse_remote_url(remote_url)
    target = validate_clone_path(workspace_root, destination)
    auth = _credential_for(remote, credentials)
    validate_remote_host(remote, allow_private=credentials is not None)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = validate_clone_path(workspace_root, destination)
    if target.exists() or target.is_symlink():
        raise GitRemoteError("A file or folder already exists at the clone destination")
    with tempfile.TemporaryDirectory(prefix=".workbench-clone-", dir=target.parent) as temp_dir:
        clone_path = Path(temp_dir) / "checkout"
        _run_git(["clone", "--", remote.url, clone_path], credentials=auth, timeout=300)
        if not clone_path.is_dir() or clone_path.is_symlink():
            raise GitRemoteError("Clone did not create a repository directory")
        if target.exists() or target.is_symlink():
            raise GitRemoteError("Clone destination was created by another operation")
        os.rename(clone_path, target)
    branch = _run_git(["-C", target, "branch", "--show-current"])
    return {"path": target.relative_to(Path(workspace_root).resolve()).as_posix(), "branch": branch,
            "remote": remote.url, "host": remote.host}


def push_branch(repository_path, remote_url, branch, credentials=None):
    remote = parse_remote_url(remote_url)
    auth = _credential_for(remote, credentials)
    branch = str(branch or "")
    if not _SAFE_BRANCH.fullmatch(branch) or branch.startswith("-") or ".." in branch or "//" in branch:
        raise GitRemoteError("Branch name is invalid")
    validate_remote_host(remote, allow_private=credentials is not None)
    _run_git(["-C", repository_path, "push", "--", remote.url, f"{branch}:refs/heads/{branch}"],
             credentials=auth, timeout=180)
    return remote


def _api_configuration(remote, provider):
    if provider == "github":
        api_root = "https://api.github.com" if remote.host == "github.com" else f"{remote.origin}/api/v3"
        return api_root, {"Authorization": "Bearer", "Accept": "application/vnd.github+json",
                          "X-GitHub-Api-Version": "2022-11-28"}
    if provider == "gitlab":
        return f"{remote.origin}/api/v4", {"PRIVATE-TOKEN": ""}
    if provider == "forgejo":
        return f"{remote.origin}/api/v1", {"Authorization": "token"}
    raise GitRemoteError("Choose GitHub, GitLab, or Forgejo for pull request creation")


def create_review_request(remote_url, provider, token, head, base, title, body=""):
    remote = parse_remote_url(remote_url)
    provider = str(provider or "").strip().lower()
    if provider not in PROVIDERS:
        raise GitRemoteError("Choose GitHub, GitLab, or Forgejo for pull request creation")
    token = str(token or "").strip()
    if not token:
        raise GitRemoteError("Save an access token for this Git host before publishing")
    head, base = str(head or "").strip(), str(base or "").strip()
    title, body = str(title or "").strip(), str(body or "").strip()
    if not title or len(title) > 255 or len(body) > 65536:
        raise GitRemoteError("Enter a title up to 255 characters and a description up to 65,536 characters")
    if not _SAFE_BRANCH.fullmatch(head) or not _SAFE_BRANCH.fullmatch(base):
        raise GitRemoteError("Source or target branch name is invalid")
    validate_remote_host(remote, allow_private=True)
    api_root, auth_headers = _api_configuration(remote, provider)
    encoded_path = "/".join(quote(part, safe="-._~") for part in remote.path.split("/"))
    if provider == "github":
        endpoint = f"{api_root}/repos/{encoded_path}/pulls"
        payload = {"title": title, "head": head, "base": base, "body": body}
        headers = {**auth_headers, "Authorization": f"Bearer {token}"}
    elif provider == "gitlab":
        endpoint = f"{api_root}/projects/{quote(remote.path, safe='')}/merge_requests"
        payload = {"title": title, "source_branch": head, "target_branch": base, "description": body}
        headers = {**auth_headers, "PRIVATE-TOKEN": token}
    else:
        endpoint = f"{api_root}/repos/{encoded_path}/pulls"
        payload = {"title": title, "head": head, "base": base, "body": body}
        headers = {**auth_headers, "Authorization": f"token {token}"}
    if provider == "gitlab":
        list_params = {"state": "opened", "source_branch": head, "target_branch": base}
    else:
        list_params = {"state": "open", "head": f"{remote.namespace}:{head}", "base": base}
    list_request = Request(f"{endpoint}?{urlencode(list_params)}",
                           headers={**headers, "User-Agent": "AI-Workbench"})
    try:
        with urlopen(list_request, timeout=20) as response:
            existing = json.loads(response.read(1024 * 1024).decode("utf-8"))
    except HTTPError as exc:
        raise GitRemoteError(f"Could not check for an existing review request ({exc.code})") from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise GitRemoteError("Could not check for an existing review request") from exc
    if isinstance(existing, list):
        for item in existing:
            if not isinstance(item, dict):
                continue
            existing_head = item.get("source_branch") if provider == "gitlab" else (item.get("head") or {}).get("ref")
            existing_base = item.get("target_branch") if provider == "gitlab" else (item.get("base") or {}).get("ref")
            if existing_head != head or existing_base != base:
                continue
            url = item.get("html_url") or item.get("web_url")
            if _valid_review_url(url, remote):
                return {"url": url, "number": item.get("number") or item.get("iid"),
                        "title": item.get("title") or title, "provider": provider, "already_exists": True}
    request = Request(endpoint, data=json.dumps(payload).encode("utf-8"), method="POST",
                      headers={**headers, "Content-Type": "application/json", "User-Agent": "AI-Workbench"})
    try:
        with urlopen(request, timeout=20) as response:
            result = json.loads(response.read(1024 * 1024).decode("utf-8"))
    except HTTPError as exc:
        try:
            error = exc.read(4096).decode("utf-8", errors="replace")
            detail = json.loads(error)
            message = detail.get("message") or detail.get("error") or detail.get("errors") or ""
            if isinstance(message, (dict, list)):
                message = json.dumps(message)
        except (OSError, ValueError, json.JSONDecodeError):
            message = ""
        message = str(message).replace(token, "[redacted]")[:500]
        raise GitRemoteError(f"Review request was rejected ({exc.code})" + (f": {message}" if message else "")) from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise GitRemoteError("Could not reach the Git host to create the review request") from exc
    url = result.get("html_url") or result.get("web_url")
    if not _valid_review_url(url, remote):
        raise GitRemoteError("Git host created a review request but returned no HTTPS link")
    return {"url": url, "number": result.get("number") or result.get("iid"),
            "title": result.get("title") or title, "provider": provider, "already_exists": False}


def _valid_review_url(value, remote):
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "https":
        return False
    try:
        return normalize_host(parsed.netloc) == normalize_host(remote.origin)
    except GitRemoteError:
        return False