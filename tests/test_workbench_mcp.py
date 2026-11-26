import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeTool:
    def __init__(self, **fields):
        self.__dict__.update(fields)


class FakeServer:
    pass


def load_workbench_mcp():
    mcp = types.ModuleType("mcp")
    mcp_types = types.ModuleType("mcp.types")
    mcp_types.Tool = FakeTool
    mcp_types.ListToolsResult = FakeTool
    mcp_types.CallToolResult = FakeTool
    mcp_types.TextContent = FakeTool
    mcp.types = mcp_types

    mcp_server = types.ModuleType("mcp.server")
    mcp_server.__path__ = []
    stdio = types.ModuleType("mcp.server.stdio")
    lowlevel = types.ModuleType("mcp.server.lowlevel")
    lowlevel.Server = FakeServer
    mcp_server.stdio = stdio

    modules = {
        "mcp": mcp,
        "mcp.types": mcp_types,
        "mcp.server": mcp_server,
        "mcp.server.stdio": stdio,
        "mcp.server.lowlevel": lowlevel,
    }
    path = Path(__file__).resolve().parents[1] / "deploy" / "agent" / "workbench_mcp.py"
    spec = importlib.util.spec_from_file_location("workbench_mcp_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


workbench_mcp = load_workbench_mcp()


class WorkbenchMcpPreviewTests(unittest.TestCase):
    def test_create_canvas_diagram_validates_and_forwards_kind_and_placement(self):
        args = {"chat_id": "chat-1", "title": "Flow", "kind": "mermaid", "content": "flowchart LR\n A-->B", "placement": "inherit"}
        with patch.object(workbench_mcp, "api_post", return_value={"document": {"id": "abc", "title": "Flow"}}) as post:
            ok, output = workbench_mcp._create_canvas_diagram(args)
        self.assertTrue(ok)
        self.assertIn("abc", output)
        post.assert_called_once_with("/api/workbench/documents/create-diagram", {**args, "project": None})
        with patch.object(workbench_mcp, "api_post") as post:
            ok, _ = workbench_mcp._create_canvas_diagram({**args, "kind": "invalid"})
        self.assertFalse(ok)
        post.assert_not_called()

    def test_create_canvas_html_passes_chat_and_placement_to_api(self):
        with patch.object(workbench_mcp, "api_post", return_value={"document": {"id": "abc", "title": "Chart"}}) as post:
            ok, output = workbench_mcp._create_canvas_html({
                "chat_id": "chat-1", "title": "Chart", "html": "<svg></svg>", "placement": "chat",
            })
        self.assertTrue(ok)
        self.assertIn("abc", output)
        post.assert_called_once_with("/api/workbench/documents/create-html", {
            "chat_id": "chat-1", "title": "Chart", "html": "<svg></svg>", "placement": "chat", "project": None,
        })

    def test_create_canvas_office_validates_kind_and_forwards_model(self):
        args = {
            "chat_id": "chat-1", "title": "Forecast", "kind": "spreadsheet",
            "content": '{"version":1,"sheets":[{"name":"Sheet1","cells":{}}]}',
            "placement": "inherit",
        }
        with patch.object(workbench_mcp, "api_post", return_value={"document": {"id": "office-1", "title": "Forecast"}}) as post:
            ok, output = workbench_mcp._create_canvas_office(args)
        self.assertTrue(ok)
        self.assertIn("office-1", output)
        post.assert_called_once_with("/api/workbench/documents/create-office", {**args, "project": None})
        with patch.object(workbench_mcp, "api_post") as post:
            ok, _ = workbench_mcp._create_canvas_office({**args, "kind": "invalid"})
        self.assertFalse(ok)
        post.assert_not_called()
        self.assertIn("create_canvas_office", {tool.name for tool in workbench_mcp.TOOLS})

    def test_project_file_tools_send_current_metadata_without_force(self):
        with patch.object(workbench_mcp, "api_get", return_value={"path": "demo/a.txt", "content": "before", "modified_ts": 12.5, "size_bytes": 6}), \
             patch.object(workbench_mcp, "api_post", return_value={"path": "demo/a.txt", "size_bytes": 5}) as post:
            ok, _ = workbench_mcp._edit_code_file({"path": "demo/a.txt", "old_string": "before", "new_string": "after"})
        self.assertTrue(ok)
        post.assert_called_once_with("/api/workspace/write", {
            "path": "demo/a.txt", "content": "after", "expected_modified_ts": 12.5, "expected_size_bytes": 6,
        })
        with patch.object(workbench_mcp, "api_get", return_value={"modified_ts": 13.5, "size_bytes": 5}), \
             patch.object(workbench_mcp, "api_post", return_value={"path": "demo/a.txt", "size_bytes": 0}) as post:
            ok, _ = workbench_mcp._write_code_file({"path": "demo/a.txt", "contents": ""})
        self.assertTrue(ok)
        self.assertEqual(post.call_args.args[1], {
            "path": "demo/a.txt", "content": "", "expected_modified_ts": 13.5, "expected_size_bytes": 5,
        })

    def test_canvas_document_tools_use_the_supplied_revision(self):
        tools = {tool.name: tool for tool in workbench_mcp.TOOLS}
        self.assertIn("read_canvas_document", tools)
        self.assertIn("edit_canvas_document", tools)
        with patch.object(workbench_mcp, "api_get", return_value={"documents": [
            {"id": "doc-1", "title": "Notes", "content": "before", "revision": 3},
        ]}):
            ok, output = workbench_mcp._read_canvas_document({"id": "doc-1"})
        self.assertTrue(ok)
        self.assertIn('"revision": 3', output)
        with patch.object(workbench_mcp, "api_post", return_value={"document": {"title": "Notes", "revision": 4}}) as post:
            ok, _ = workbench_mcp._edit_canvas_document({"id": "doc-1", "revision": 3, "content": "after"})
        self.assertTrue(ok)
        post.assert_called_once_with("/api/workbench/documents/edit", {"id": "doc-1", "revision": 3, "content": "after"})
        with patch.object(workbench_mcp, "api_post") as post:
            ok, _ = workbench_mcp._edit_canvas_document({"id": "doc-1", "revision": True, "content": "after"})
        self.assertFalse(ok)
        post.assert_not_called()

    def test_gateway_registry_exposes_managed_preview_tools(self):
        tools = {tool.name: tool for tool in workbench_mcp.TOOLS}
        self.assertIn("start_app_preview", tools)
        self.assertIn("stop_app_preview", tools)
        self.assertEqual(tools["start_app_preview"].input_schema["required"], ["path", "command", "port"])
        self.assertIn("do not return a localhost URL", tools["start_app_preview"].description)

    def test_start_returns_workbench_route_not_loopback_url(self):
        preview_id = "12345678-1234-4234-8234-123456789abc"
        with patch.object(workbench_mcp, "api_post", return_value={
            "session_id": preview_id,
            "path": "FellowshipSteps",
            "port": 8000,
        }) as api_post:
            ok, output = workbench_mcp._start_app_preview({
                "path": "FellowshipSteps",
                "command": 'python3 -m http.server "$PORT" --bind 127.0.0.1',
                "port": 8000,
            })
        self.assertTrue(ok)
        self.assertIn(f"[Open live preview](/?tab=project&preview={preview_id})", output)
        self.assertNotIn("http://localhost", output)
        self.assertNotIn("http://127.0.0.1", output)
        api_post.assert_called_once_with("/api/app-preview/start", {
            "path": "FellowshipSteps",
            "command": 'python3 -m http.server "$PORT" --bind 127.0.0.1',
            "port": 8000,
        })

    def test_start_rejects_non_integer_ports_before_api_call(self):
        with patch.object(workbench_mcp, "api_post") as api_post:
            ok, output = workbench_mcp._start_app_preview({"path": "demo", "command": "run", "port": 8000.5})
        self.assertFalse(ok)
        self.assertIn("integer", output)
        api_post.assert_not_called()

    def test_stop_calls_managed_preview_endpoint(self):
        with patch.object(workbench_mcp, "api_post") as api_post:
            ok, output = workbench_mcp._stop_app_preview({"session_id": "preview-123"})
        self.assertTrue(ok)
        self.assertIn("preview-123", output)
        api_post.assert_called_once_with("/api/app-preview/stop", {"session_id": "preview-123"})


if __name__ == "__main__":
    unittest.main()
