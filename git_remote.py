"""Remote Git operations for workspace repositories."""

import json
import ipaddress
import os
import re
import socket
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

    @property
    def path(self):
        return f"{self.namespace}/{self.name}"


def parse_remote_url(value):
    raw = str(value or "").strip()
    if not raw or len(raw) > 2048:
        raise GitRemoteError("Enter an HTTPS Git repository URL")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise GitRemoteError("Repository URL is invalid") from exc
    if (parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise GitRemoteError("Only HTTPS repository URLs without embedded credentials are supported")
    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname or any(character.isspace() for character in hostname):
        raise GitRemoteError("Repository host is invalid")
    if port == 443:
        port = None
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port:
        host = f"{host}:{port}"
    origin = f"https://{host}"
    raw_parts = parsed.path.strip("/").split("/")
    parts = [unquote(part) for part in raw_parts if part]
    if len(parts) < 2 or any(not _SAFE_SEGMENT.fullmatch(part) or part in {".", ".."} for part in parts):
        raise GitRemoteError("Repository URL must include a valid namespace and repository name")
    if parts[-1].endswith(".git"):
        parts[-1] = parts[-1][:-4]
    if not parts[-1] or len(parts) < 2:
        raise GitRemoteError("Repository URL must include a repository name")
    safe_path = "/".join(quote(part, safe="-._~") for part in parts)
    return RemoteRepository(f"{origin}/{safe_path}.git", origin, host, "/".join(parts[:-1]), parts[-1])


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
    host = normalize_host(remote.origin)
    if normalize_host(credentials.get("host")) != host:
        raise GitRemoteError("Saved Git credentials do not match this repository host")
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
        helper = Path(temp_dir) / "askpass"
        helper.write_text(
            "#!/usr/bin/env python3\n"
            "import os, re, sys\n"
            "prompt = sys.argv[1] if len(sys.argv) > 1 else ''\n"
            "match = re.search(r\"https://([^/'\\\" ]+)\", prompt)\n"
            "if not match or match.group(1).lower() != os.environ.get('GIT_HTTP_EXPECTED_HOST', '').lower(): sys.exit(1)\n"
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
        return normalize_host(parsed.netloc) == remote.host
    except GitRemoteError:
        return False