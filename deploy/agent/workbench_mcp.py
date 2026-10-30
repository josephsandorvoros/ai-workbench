#!/usr/bin/env python3
"""
AI Workbench MCP server (stdio).

Exposes AI Workbench file / wiki / artifact / board / web tools to
the Hermes gateway agent over the Model Context Protocol (stdio transport).

Why this exists
---------------
The AI Workbench UI has two agent paths:

  * Direct API path  (baseUrl !== "/hermes-gw"): the browser sends the
    LOCAL_VISUAL_TOOLS schemas to the model and executes the resulting tool
    calls in the browser (toolExecutor.ts).
  * Hermes gateway path (baseUrl === "/hermes-gw"): the browser only forwards
    the user message; the gateway runs its own agent loop with its own tool
    registry (built-in tools + MCP servers). The browser tools are never sent
    on this path, so the gateway agent cannot touch the workbench.

This server closes that gap. It is spawned by the Hermes gateway as a stdio
MCP child process and re-implements the exact same 20 tools the browser uses,
talking to the companion API (dashboard_server.py) over HTTP. Because the
gateway and the companion API run in the same container, the server reaches
the API at http://127.0.0.1:8080.

Design constraints
------------------
* stdlib-only HTTP client (urllib) — no extra dependencies, so it runs in the
  base image's venv (/opt/hermes/.venv/bin/python) which already ships the
  `mcp` SDK.
* All logging goes to stderr — stdout is the MCP wire.
* Auth: the gateway only passes a filtered env to MCP children, so the
  TERMINAL_API_TOKEN / WORKBENCH_AUTH values are injected via the server's
  `env` block in the Hermes config (see bootstrap.py configure_hermes_mcp).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from mcp import types
from mcp.server import stdio
from mcp.server.lowlevel import Server

# ---------------------------------------------------------------------------
# Configuration (from environment)
# ---------------------------------------------------------------------------

API_BASE = os.environ.get("WORKBENCH_API_BASE", "http://127.0.0.1:8080").rstrip("/")
TERMINAL_TOKEN = os.environ.get("TERMINAL_API_TOKEN", "")
WORKBENCH_AUTH = os.environ.get("WORKBENCH_AUTH", "proxy")

DEFAULT_HTML_ARTIFACT = (
    "<!doctype html>\n"
    '<html lang="en">\n'
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    "<title>New artifact</title></head>\n"
    "<body><main><h1>New HTML artifact</h1><p>Ask the agent to shape this artifact.</p></main></body>\n"
    "</html>"
)


def log(message: str) -> None:
    """Log to stderr only — stdout is reserved for the MCP wire."""
    print(f"[workbench-mcp] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib urllib)
# ---------------------------------------------------------------------------


def _headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if TERMINAL_TOKEN:
        headers["X-Terminal-Token"] = TERMINAL_TOKEN
    return headers


def _request(method: str, path: str, body=None, timeout: int = 120) -> dict:
    """Perform an HTTP request against the companion API and return parsed JSON.

    Mirrors compatClient.getJson/postJson: raises RuntimeError on a non-2xx
    status or an explicit ``ok: false`` payload.
    """
    url = API_BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        status = exc.code
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
        raise RuntimeError(
            payload.get("message") or f"{method} {path} failed with HTTP {status}"
        ) from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{method} {path} failed: {exc.reason}") from None
    except Exception as exc:  # noqa: BLE001 - surface any transport error to the model
        raise RuntimeError(f"{method} {path} failed: {exc}") from None

    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}
    if status >= 400 or payload.get("ok") is False:
        raise RuntimeError(
            payload.get("message") or f"{method} {path} failed with HTTP {status}"
        ) from None
    return payload


def api_get(path: str) -> dict:
    return _request("GET", path)


def api_post(path: str, body: dict) -> dict:
    return _request("POST", path, body)


def with_query(path: str, query: dict) -> str:
    params = urllib.parse.urlencode({k: str(v) for k, v in query.items()})
    return f"{path}?{params}"


# ---------------------------------------------------------------------------
# Small shared helpers (mirror toolExecutor.ts)
# ---------------------------------------------------------------------------


def to_workspace_relative_path(path: str) -> str:
    trimmed = (path or "").strip()
    if trimmed.startswith("/"):
        return trimmed
    if trimmed.startswith("./"):
        return trimmed[2:]
    return trimmed


def truncate(text: str, max_chars: int = 8000) -> str:
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n... [truncated {len(text) - max_chars} chars]"


def as_number(value) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def as_string(value) -> str:
    return value if isinstance(value, str) else ""


def compact_element(element: dict):
    """Mirror canvasManifest.compactElement — reduce a raw Excalidraw element
    to a compact, model-readable node, or None if it should be skipped."""
    if not isinstance(element, dict):
        return None
    if element.get("isDeleted") is True:
        return None
    etype = as_string(element.get("type"))
    if not etype or etype in ("freedraw", "image"):
        return None
    return {
        "id": as_string(element.get("id")),
        "type": etype,
        "text": as_string(element.get("text")),
        "x": round(as_number(element.get("x"))),
        "y": round(as_number(element.get("y"))),
        "width": round(as_number(element.get("width"))),
        "height": round(as_number(element.get("height"))),
    }


def load_artifact() -> dict:
    """Read the active HTML artifact from the companion API's workbench state.

    Falls back to the default artifact when the API is unavailable or has no
    artifact stored yet (mirrors the browser's localStorage fallback).
    """
    try:
        state = api_get("/api/workbench/state")
        artifact = state.get("artifact")
        if isinstance(artifact, dict) and artifact.get("html"):
            return {
                "name": as_string(artifact.get("name")) or "New artifact",
                "html": as_string(artifact.get("html")),
                "updatedAt": as_number(artifact.get("updatedAt")),
            }
    except Exception as exc:  # noqa: BLE001
        log(f"load_artifact: {exc}")
    return {
        "name": "New artifact",
        "html": DEFAULT_HTML_ARTIFACT,
        "updatedAt": int(time.time() * 1000),
    }


def save_artifact(artifact: dict) -> None:
    """Persist the HTML artifact via the workbench state (GET then POST with
    the artifact field swapped, mirroring saveRemoteWorkbenchField)."""
    try:
        current = api_get("/api/workbench/state")
    except Exception:
        current = {}
    chat_sessions = current.get("chat_sessions")
    if not isinstance(chat_sessions, list):
        chat_sessions = []
    api_post(
        "/api/workbench/state",
        {"artifact": artifact, "chat_sessions": chat_sessions},
    )


def command_board(command: str, **payload) -> dict:
    """POST /api/board/command with the same field mapping as
    compatClient.commandBoard."""
    body = {"command": command}
    if command == "add_node":
        body["node"] = payload.get("node")
    elif command == "add_arrow":
        body["arrow"] = payload.get("arrow")
    elif command == "set_layout":
        body["elements"] = payload.get("elements")
    elif command == "update_element":
        body["element"] = payload.get("element")
    elif command == "delete_element":
        body["id"] = payload.get("id")
    return api_post("/api/board/command", body)


# ---------------------------------------------------------------------------
# Tool handlers — each returns (ok: bool, output: str)
# ---------------------------------------------------------------------------


def _read_code_file(args: dict):
    path = to_workspace_relative_path(as_string(args.get("path")))
    if not path:
        return False, "Missing path argument."
    doc = api_get(with_query("/api/workspace/read", {"path": path}))
    return True, truncate(as_string(doc.get("content")))


def _write_code_file(args: dict):
    path = to_workspace_relative_path(as_string(args.get("path")))
    content = as_string(args.get("contents") or args.get("content"))
    if not path:
        return False, "Missing path argument."
    result = api_post(
        "/api/workspace/write",
        {
            "path": path,
            "content": content,
            "expected_modified_ts": 0,
            "expected_size_bytes": 0,
            "force": True,
        },
    )
    return True, f"Wrote {result.get('size_bytes')} bytes to {result.get('path')}"


def _edit_code_file(args: dict):
    path = to_workspace_relative_path(as_string(args.get("path")))
    old_string = as_string(args.get("old_string"))
    new_string = as_string(args.get("new_string"))
    if not path:
        return False, "Missing path argument."
    if not old_string:
        return False, "Missing old_string argument."

    doc = api_get(with_query("/api/workspace/read", {"path": path}))
    original = as_string(doc.get("content"))
    first = original.find(old_string)
    if first == -1:
        return False, (
            f"old_string not found in {doc.get('path')}. "
            "Read the file again and match it exactly."
        )
    if original.find(old_string, first + len(old_string)) != -1:
        return False, (
            f"old_string appears more than once in {doc.get('path')}. "
            "Include more surrounding context to make it unique."
        )
    updated = original[:first] + new_string + original[first + len(old_string):]
    result = api_post(
        "/api/workspace/write",
        {
            "path": path,
            "content": updated,
            "expected_modified_ts": 0,
            "expected_size_bytes": 0,
            "force": True,
        },
    )
    removed = old_string.count("\n") + 1
    added = new_string.count("\n") + 1
    return True, (
        f"Edited {result.get('path')} (-{removed}/+{added} lines). "
        'Open it in Project Workspace and choose "View changes" to diff.'
    )


def _delete_code_file(args: dict):
    path = to_workspace_relative_path(as_string(args.get("path")))
    if not path:
        return False, "Missing path argument."
    result = api_post("/api/workspace/delete", {"path": path})
    return True, f"Deleted {result.get('path')}. A timestamped backup was kept."


def _fetch_canvas_layout(args: dict):
    try:
        remote = api_get("/api/board")
        board = remote.get("board")
        if board:
            elements = board.get("elements") or []
            nodes = [
                node
                for node in (compact_element(e) for e in elements)
                if node is not None
            ][:40]
            manifest = {"nodes": nodes}
        else:
            manifest = {"nodes": []}
    except Exception as exc:  # noqa: BLE001
        log(f"fetch_canvas_layout: {exc}")
        manifest = {"nodes": []}
    return True, json.dumps(manifest, indent=2)


def _add_board_node(args: dict):
    text = as_string(args.get("text")).strip()
    if not text:
        return False, "Missing node text."
    node = {
        "text": text,
        "type": as_string(args.get("type")) or "rectangle",
        "x": as_number(args.get("x")) or 120,
        "y": as_number(args.get("y")) or 120,
        "width": as_number(args.get("width")) or 240,
        "height": as_number(args.get("height")) or 100,
    }
    command_board("add_node", node=node)
    return True, f"Added Spatial Board node: {text}"


def _add_board_arrow(args: dict):
    arrow = {
        "text": as_string(args.get("text")),
        "x": as_number(args.get("x")) or 240,
        "y": as_number(args.get("y")) or 170,
        "width": as_number(args.get("width")) or 180,
        "height": as_number(args.get("height")) or 0,
    }
    command_board("add_arrow", arrow=arrow)
    return True, "Added a labeled Spatial Board arrow."


def _clear_spatial_board(args: dict):
    command_board("clear")
    return True, "Cleared the Spatial Board."


def _read_board_full(args: dict):
    result = command_board("read_full")
    board = result.get("board") or {"elements": []}
    return True, truncate(json.dumps(board.get("elements", []), indent=2))


def _set_board_layout(args: dict):
    elements = args.get("elements")
    if not isinstance(elements, list) or len(elements) == 0:
        return False, "set_board_layout requires a non-empty elements array."
    command_board("set_layout", elements=elements)
    return True, f"Set Spatial Board layout with {len(elements)} elements."


def _update_board_element(args: dict):
    element_id = as_string(args.get("id")).strip()
    if not element_id:
        return False, "Missing element id."
    element = {"id": element_id}
    for key in ("x", "y", "width", "height", "text", "strokeColor", "backgroundColor"):
        if args.get(key) is not None:
            element[key] = args.get(key)
    if len(element) == 1:
        return False, (
            "Provide at least one field to update "
            "(x, y, width, height, text, strokeColor, backgroundColor)."
        )
    command_board("update_element", element=element)
    return True, f"Updated Spatial Board element {element_id}."


def _delete_board_element(args: dict):
    element_id = as_string(args.get("id")).strip()
    if not element_id:
        return False, "Missing element id."
    command_board("delete_element", id=element_id)
    return True, f"Deleted Spatial Board element {element_id}."


def _read_html_artifact(args: dict):
    artifact = load_artifact()
    return True, json.dumps(artifact)


def _update_html_artifact(args: dict):
    html = as_string(args.get("html"))
    if not html.strip():
        return False, "Missing HTML source."
    current = load_artifact()
    artifact = {
        "name": as_string(args.get("name")).strip() or current["name"],
        "html": html,
        "updatedAt": int(time.time() * 1000),
    }
    save_artifact(artifact)
    return True, f"Updated HTML artifact: {artifact['name']} ({len(html)} chars)"


def _edit_html_artifact(args: dict):
    old_string = as_string(args.get("old_string"))
    new_string = as_string(args.get("new_string"))
    if not old_string:
        return False, "Missing old_string argument."
    current = load_artifact()
    first = current["html"].find(old_string)
    if first == -1:
        return False, (
            "old_string not found in the artifact. Read it again and match it exactly."
        )
    if current["html"].find(old_string, first + len(old_string)) != -1:
        return False, (
            "old_string appears more than once. Include more surrounding context "
            "to make it unique."
        )
    artifact = {
        **current,
        "html": current["html"][:first] + new_string + current["html"][first + len(old_string):],
        "updatedAt": int(time.time() * 1000),
    }
    save_artifact(artifact)
    return True, (
        f"Edited HTML artifact: {artifact['name']} "
        f"(-{len(old_string)}/+{len(new_string)} chars)"
    )


def _search_wiki(args: dict):
    query = as_string(args.get("query"))
    if not query:
        return False, "Missing query argument."
    result = api_get(with_query("/api/wiki/search", {"q": query, "limit": 10}))
    items = result.get("items") or []
    lines = [f"- {item.get('path')}: {item.get('snippet')}" for item in items]
    return True, ("\n".join(lines) if lines else "No wiki matches.")


def _read_wiki_file(args: dict):
    path = as_string(args.get("path")).strip()
    if not path:
        return False, "Missing path argument."
    doc = api_get(with_query("/api/wiki/read", {"path": path}))
    return True, truncate(as_string(doc.get("content")))


def _write_wiki_file(args: dict):
    path = as_string(args.get("path")).strip()
    content = as_string(args.get("content") or args.get("contents"))
    if not path:
        return False, "Missing path argument."
    result = api_post("/api/wiki/write", {"path": path, "content": content})
    return True, f"Wrote {result.get('size_bytes')} bytes to wiki note {result.get('path')}"


def _edit_wiki_file(args: dict):
    path = as_string(args.get("path")).strip()
    old_string = as_string(args.get("old_string"))
    new_string = as_string(args.get("new_string"))
    if not path:
        return False, "Missing path argument."
    if not old_string:
        return False, "Missing old_string argument."

    doc = api_get(with_query("/api/wiki/read", {"path": path}))
    original = as_string(doc.get("content"))
    first = original.find(old_string)
    if first == -1:
        return False, (
            f"old_string not found in {doc.get('path')}. "
            "Read the note again and match it exactly."
        )
    if original.find(old_string, first + len(old_string)) != -1:
        return False, (
            f"old_string appears more than once in {doc.get('path')}. "
            "Include more surrounding context to make it unique."
        )
    updated = original[:first] + new_string + original[first + len(old_string):]
    result = api_post("/api/wiki/write", {"path": path, "content": updated})
    removed = old_string.count("\n") + 1
    added = new_string.count("\n") + 1
    return True, f"Edited wiki note {result.get('path')} (-{removed}/+{added} lines)."


def _web_fetch(args: dict):
    url = as_string(args.get("url")).strip()
    if not url:
        return False, "Missing url argument."
    payload = api_get(with_query("/api/web/fetch", {"url": url}))
    if payload.get("ok") is False:
        return False, f"web_fetch failed: {payload.get('message') or 'unknown error'}"
    header = (
        f"Fetched {url} (HTTP {payload.get('status') or '?'}, "
        f"{payload.get('content_type') or 'unknown'})"
        + (" [truncated]" if payload.get("truncated") else "")
        + "\n\n"
    )
    return True, truncate(header + as_string(payload.get("content")))


def _start_app_preview(args: dict):
    path = to_workspace_relative_path(as_string(args.get("path")))
    command = as_string(args.get("command")).strip()
    port_value = args.get("port")
    if not path or not command:
        return False, "start_app_preview requires a workspace-relative project path and an explicit start command."
    if isinstance(port_value, bool) or not isinstance(port_value, int):
        return False, "Preview port must be an integer between 1024 and 65535."
    if len(command) > 2000:
        return False, "Preview start command exceeds the 2000-character limit."

    preview = api_post("/api/app-preview/start", {"path": path, "command": command, "port": port_value})
    session_id = as_string(preview.get("session_id"))
    if not session_id:
        return False, "The preview API did not return a session ID."
    preview_path = as_string(preview.get("path")) or path
    preview_port = preview.get("port") or port_value
    workbench_url = f"/?tab=project&preview={urllib.parse.quote(session_id, safe='')}"
    return True, (
        f"Started preview for {preview_path} on port {preview_port}. "
        "Open it inside AI Workbench using this link (do not substitute localhost): "
        f"[Open live preview]({workbench_url})\nPreview session: {session_id}"
    )


def _stop_app_preview(args: dict):
    session_id = as_string(args.get("session_id")).strip()
    if not session_id:
        return False, "Missing preview session ID."
    api_post("/api/app-preview/stop", {"session_id": session_id})
    return True, f"Stopped app preview {session_id}."


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

HANDLERS = {
    "read_code_file": _read_code_file,
    "write_code_file": _write_code_file,
    "edit_code_file": _edit_code_file,
    "delete_code_file": _delete_code_file,
    "fetch_canvas_layout": _fetch_canvas_layout,
    "add_board_node": _add_board_node,
    "add_board_arrow": _add_board_arrow,
    "clear_spatial_board": _clear_spatial_board,
    "read_board_full": _read_board_full,
    "set_board_layout": _set_board_layout,
    "update_board_element": _update_board_element,
    "delete_board_element": _delete_board_element,
    "read_html_artifact": _read_html_artifact,
    "update_html_artifact": _update_html_artifact,
    "edit_html_artifact": _edit_html_artifact,
    "search_wiki": _search_wiki,
    "read_wiki_file": _read_wiki_file,
    "write_wiki_file": _write_wiki_file,
    "edit_wiki_file": _edit_wiki_file,
    "web_fetch": _web_fetch,
    "start_app_preview": _start_app_preview,
    "stop_app_preview": _stop_app_preview,
}


def _tool(name, description, properties, required=None, **extra):
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return types.Tool(
        name=name,
        description=description,
        input_schema=schema,
        **extra,
    )


TOOLS = [
    # --- File tools ---
    _tool(
        "read_code_file",
        "Read a text/code file from the project workspace. Always read a file "
        "before editing it so the old_string you pass to edit_code_file matches exactly.",
        {"path": {"type": "string", "description": "Workspace-relative or absolute path."}},
        required=["path"],
    ),
    _tool(
        "edit_code_file",
        "Make a targeted edit to an existing file by replacing an exact snippet. "
        "Prefer this over write_code_file for changes to existing files. "
        "old_string must appear exactly once — include surrounding lines to make it unique.",
        {
            "path": {"type": "string", "description": "Workspace-relative or absolute path."},
            "old_string": {"type": "string", "description": "Exact text to replace, including whitespace and indentation."},
            "new_string": {"type": "string", "description": "Replacement text. Use an empty string to delete the snippet."},
        },
        required=["path", "old_string", "new_string"],
    ),
    _tool(
        "write_code_file",
        "Write a file's full contents, creating it if needed. Use this for new files; "
        "use edit_code_file to modify an existing file.",
        {
            "path": {"type": "string", "description": "Workspace-relative or absolute path."},
            "contents": {"type": "string", "description": "Complete new file contents."},
        },
        required=["path", "contents"],
    ),
    _tool(
        "delete_code_file",
        "Delete a file from the project workspace. The companion API keeps a timestamped backup.",
        {"path": {"type": "string", "description": "Workspace-relative or absolute path."}},
        required=["path"],
    ),
    _tool(
        "start_app_preview",
        "Start an app in the AI Workbench managed preview. Use only when the user asks to run or preview an app. "
        "Provide a workspace-relative project folder, explicit start command, and listening port; bind the app to "
        "127.0.0.1 and use $PORT when supported. This executes project code as the Workbench agent user. "
        "After starting, return the Open live preview link exactly as provided; do not return a localhost URL.",
        {
            "path": {"type": "string", "description": "Project folder relative to the workspace root."},
            "command": {"type": "string", "description": "Explicit start command; bind to 127.0.0.1 and use $PORT."},
            "port": {"type": "integer", "description": "Local app port, from 1024 through 65535."},
        },
        required=["path", "command", "port"],
    ),
    _tool(
        "stop_app_preview",
        "Stop a managed AI Workbench app preview. Only call when the user asks to stop the preview or confirms cleanup.",
        {"session_id": {"type": "string", "description": "Session ID returned by start_app_preview."}},
        required=["session_id"],
    ),
    # --- Board tools ---
    _tool(
        "fetch_canvas_layout",
        "Read the current Excalidraw Spatial Board as a compact, model-readable manifest "
        "of labeled nodes (id, type, text, x, y, width, height). Use this to see what is "
        "on the board before editing.",
        {},
    ),
    _tool(
        "read_board_full",
        "Read the full raw Excalidraw element JSON for the Spatial Board (every element "
        "with all fields). Use this when you need exact element ids or full element "
        "details to update or delete specific elements.",
        {},
    ),
    _tool(
        "add_board_node",
        "Add a labeled rectangle, ellipse, diamond, or text node to the Spatial Board. "
        "The board is stored server-side and the browser syncs it automatically.",
        {
            "type": {"type": "string", "enum": ["rectangle", "ellipse", "diamond", "text"]},
            "text": {"type": "string"},
            "x": {"type": "number"},
            "y": {"type": "number"},
            "width": {"type": "number"},
            "height": {"type": "number"},
        },
        required=["text"],
    ),
    _tool(
        "add_board_arrow",
        "Add a labeled arrow relationship to the Spatial Board.",
        {
            "text": {"type": "string"},
            "x": {"type": "number"},
            "y": {"type": "number"},
            "width": {"type": "number"},
            "height": {"type": "number"},
        },
    ),
    _tool(
        "set_board_layout",
        "Replace the entire Spatial Board with a full list of Excalidraw elements in one "
        "call. Use this to lay out a whole diagram at once instead of adding elements one "
        "by one. Each element needs at least an id, type, x, y, width, height; text "
        "elements also need text. The browser syncs the result automatically.",
        {
            "elements": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "type": {"type": "string"},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "width": {"type": "number"},
                        "height": {"type": "number"},
                        "text": {"type": "string"},
                    },
                },
            }
        },
        required=["elements"],
    ),
    _tool(
        "update_board_element",
        "Update an existing Spatial Board element by id (move, resize, relabel, recolor). "
        "Pass the element id plus any fields to change; unchanged fields are preserved. "
        "The browser syncs the result automatically.",
        {
            "id": {"type": "string"},
            "x": {"type": "number"},
            "y": {"type": "number"},
            "width": {"type": "number"},
            "height": {"type": "number"},
            "text": {"type": "string"},
            "strokeColor": {"type": "string"},
            "backgroundColor": {"type": "string"},
        },
        required=["id"],
    ),
    _tool(
        "delete_board_element",
        "Delete a Spatial Board element by id. The browser syncs the result automatically.",
        {"id": {"type": "string"}},
        required=["id"],
    ),
    _tool(
        "clear_spatial_board",
        "Clear all elements from the Spatial Board.",
        {},
    ),
    # --- HTML artifact tools ---
    _tool(
        "read_html_artifact",
        "Read the active shared HTML artifact source.",
        {},
    ),
    _tool(
        "update_html_artifact",
        "Replace the active shared HTML artifact with complete HTML source and an "
        "optional name. Use edit_html_artifact instead when changing part of an "
        "existing artifact.",
        {"name": {"type": "string"}, "html": {"type": "string"}},
        required=["html"],
    ),
    _tool(
        "edit_html_artifact",
        "Make a targeted edit to the active HTML artifact by replacing an exact snippet. "
        "Read the artifact first; old_string must appear exactly once.",
        {
            "old_string": {"type": "string", "description": "Exact snippet to replace, including whitespace."},
            "new_string": {"type": "string", "description": "Replacement text. Empty string deletes the snippet."},
        },
        required=["old_string", "new_string"],
    ),
    # --- Web tools ---
    _tool(
        "web_fetch",
        "Fetch a public web page (http/https) and return its readable text content. Use "
        "for documentation, articles, or any URL the user references. Returns up to ~12k "
        "characters; large pages are truncated.",
        {"url": {"type": "string", "description": "Absolute http(s) URL to fetch."}},
        required=["url"],
    ),
    # --- Wiki tools ---
    _tool(
        "search_wiki",
        "Search the wiki knowledge base for a phrase and return matching notes with snippets.",
        {"query": {"type": "string"}},
        required=["query"],
    ),
    _tool(
        "read_wiki_file",
        "Read a wiki note. Always read a note before editing it so the old_string you "
        "pass to edit_wiki_file matches exactly.",
        {"path": {"type": "string", "description": "Wiki-relative path, e.g. concepts/networking.md"}},
        required=["path"],
    ),
    _tool(
        "edit_wiki_file",
        "Make a targeted edit to an existing wiki note by replacing an exact snippet. "
        "Prefer this over write_wiki_file for changes to an existing note. "
        "old_string must appear exactly once.",
        {
            "path": {"type": "string", "description": "Wiki-relative path."},
            "old_string": {"type": "string", "description": "Exact text to replace, including whitespace."},
            "new_string": {"type": "string", "description": "Replacement text. Empty string deletes the snippet."},
        },
        required=["path", "old_string", "new_string"],
    ),
    _tool(
        "write_wiki_file",
        "Write a wiki note's full contents, creating it if needed. Use this for new notes; "
        "use edit_wiki_file to modify an existing one. Markdown and text files only.",
        {
            "path": {"type": "string", "description": "Wiki-relative path, e.g. concepts/networking.md"},
            "content": {"type": "string", "description": "Complete new note contents."},
        },
        required=["path", "content"],
    ),
]


# ---------------------------------------------------------------------------
# MCP server wiring
# ---------------------------------------------------------------------------


async def on_list_tools(ctx, params):
    return types.ListToolsResult(tools=TOOLS)


async def on_call_tool(ctx, params):
    name = params.name
    args = params.arguments or {}
    handler = HANDLERS.get(name)
    if handler is None:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Unknown tool: {name}")],
            is_error=True,
        )
    try:
        ok, output = handler(args)
    except Exception as exc:  # noqa: BLE001 - report any handler error to the model
        log(f"call_tool {name} error: {exc}")
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=str(exc))],
            is_error=True,
        )
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=output)],
        is_error=not ok,
    )


def main() -> None:
    import asyncio

    server = Server("workbench", on_list_tools=on_list_tools, on_call_tool=on_call_tool)

    async def _serve():
        async with stdio.stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )

    log(
        f"starting (api={API_BASE}, auth={WORKBENCH_AUTH}, "
        f"token={'set' if TERMINAL_TOKEN else 'unset'}, tools={len(TOOLS)})"
    )
    asyncio.run(_serve())


if __name__ == "__main__":
    main()
