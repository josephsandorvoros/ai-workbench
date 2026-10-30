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
