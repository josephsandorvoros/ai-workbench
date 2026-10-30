import { compatClient } from "../api/compatClient";
import {
  compactElement,
  createBoardArrow,
  createBoardElements,
  dispatchBoardCommand,
  loadCanvasManifest,
  type BoardArrowInput,
  type BoardNodeInput,
} from "./canvasManifest";
import { loadHtmlArtifact, saveHtmlArtifact } from "./htmlArtifact";
import { saveRemoteWorkbenchField } from "./workbenchRemote";

/**
 * Real execution handlers for the Hermes agent tool schemas.
 *
 * File and wiki tools go through the dashboard companion API (scoped to
 * WORKSPACE_ROOT and WIKI_ROOT server-side). Shell
 * commands run through the dashboard terminal API, which requires the
 * terminal token when auth is enabled.
 */

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

// The backend resolves absolute paths itself (within its allowed roots).
function toWorkspaceRelativePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return trimmed.replace(/^\.\//, "");
}

function truncate(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

async function runShellCommand(command: string, terminalToken: string): Promise<ToolExecutionResult> {
  // No token is fine when the server trusts its reverse proxy (WORKBENCH_AUTH=proxy); a 401 surfaces below.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (terminalToken) {
    headers["X-Terminal-Token"] = terminalToken;
  }

  const start = await fetch("/api/terminal/start", {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "cli", cols: 200, rows: 50 }),
  });
  if (!start.ok) {
    const body = await start.json().catch(() => ({}));
    return {
      ok: false,
      output: `terminal start failed (${start.status}): ${body.message ?? "check the terminal token"}`,
    };
  }
  const { session_id: sessionId } = (await start.json()) as { session_id: string };

  try {
    const input = await fetch("/api/terminal/input", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: sessionId, data: `${command}\n` }),
    });
    if (!input.ok) {
      return { ok: false, output: `terminal input failed (${input.status})` };
    }

    const deadline = Date.now() + 120_000;
    let offset = 0;
    let output = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const res = await fetch(
        `/api/terminal/output?session_id=${encodeURIComponent(sessionId)}&offset=${offset}`,
        { headers },
      );
      if (!res.ok) break;
      const payload = (await res.json()) as {
        data?: string;
        next_offset?: number;
        running?: boolean;
      };
      if (payload.data) output += payload.data;
      if (typeof payload.next_offset === "number") offset = payload.next_offset;
      if (payload.running === false) break;
    }

    return { ok: true, output: truncate(output.trim() || "(no output captured)") };
  } finally {
    await fetch("/api/terminal/close", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => undefined);
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  terminalToken: string,
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case "read_code_file": {
        const path = toWorkspaceRelativePath(String(args.path ?? ""));
        if (!path) return { ok: false, output: "Missing path argument." };
        const doc = await compatClient.readWorkspaceFile(path);
        return { ok: true, output: truncate(doc.content) };
      }

      case "write_code_file": {
        const path = toWorkspaceRelativePath(String(args.path ?? ""));
        const content = String(args.contents ?? args.content ?? "");
        if (!path) return { ok: false, output: "Missing path argument." };
        const result = await compatClient.writeWorkspaceFile(path, content, 0, 0, true);
        return {
          ok: true,
          output: `Wrote ${result.size_bytes} bytes to ${result.path}`,
        };
      }

      case "edit_code_file": {
        const path = toWorkspaceRelativePath(String(args.path ?? ""));
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        if (!path) return { ok: false, output: "Missing path argument." };
        if (!oldString) return { ok: false, output: "Missing old_string argument." };

        const doc = await compatClient.readWorkspaceFile(path);
        const original = doc.content ?? "";
        const first = original.indexOf(oldString);
        if (first === -1) {
          return { ok: false, output: `old_string not found in ${doc.path}. Read the file again and match it exactly.` };
        }
        if (original.indexOf(oldString, first + oldString.length) !== -1) {
          return {
            ok: false,
            output: `old_string appears more than once in ${doc.path}. Include more surrounding context to make it unique.`,
          };
        }

        const updated = original.slice(0, first) + newString + original.slice(first + oldString.length);
        const result = await compatClient.writeWorkspaceFile(path, updated, 0, 0, true);
        const removed = oldString.split("\n").length;
        const added = newString.split("\n").length;
        return {
          ok: true,
          output: `Edited ${result.path} (-${removed}/+${added} lines). Open it in Project Workspace and choose "View changes" to diff.`,
        };
      }

      case "delete_code_file": {
        const path = toWorkspaceRelativePath(String(args.path ?? ""));
        if (!path) return { ok: false, output: "Missing path argument." };
        const result = await compatClient.deleteWorkspaceFile(path);
        return { ok: true, output: `Deleted ${result.path}. A timestamped backup was kept.` };
      }

      case "execute_bash_command": {
        const command = String(args.command ?? "");
        if (!command) return { ok: false, output: "Missing command argument." };
        return runShellCommand(command, terminalToken);
      }

      case "start_app_preview": {
        const path = String(args.path ?? "").trim();
        const command = String(args.command ?? "").trim();
        const port = Number(args.port);
        if (!path || !command || !Number.isInteger(port)) {
          return { ok: false, output: "start_app_preview requires a project path, command, and integer port." };
        }
        try {
          const preview = await compatClient.startAppPreview(path, command, port, terminalToken);
          const link = new URL("/", window.location.href);
          link.searchParams.set("tab", "project");
          link.searchParams.set("preview", preview.session_id);
          const workbenchPath = `${link.pathname}${link.search}`;
          return {
            ok: true,
            output: `Started preview for ${preview.path} on port ${preview.port}.\n\n[Open live preview](${workbenchPath})\n\nPreview session: ${preview.session_id}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("unauthorized")) {
            return { ok: false, output: "This Workbench requires its terminal access token to start previews. Open Projects, choose Run app, enter the token there, then ask me to retry." };
          }
          return { ok: false, output: `Could not start app preview: ${message}` };
        }
      }

      case "stop_app_preview": {
        const sessionId = String(args.session_id ?? "").trim();
        if (!sessionId) return { ok: false, output: "Missing preview session ID." };
        await compatClient.stopAppPreview(sessionId, terminalToken);
        return { ok: true, output: `Stopped app preview ${sessionId}.` };
      }

      case "fetch_canvas_layout": {
        let manifest = loadCanvasManifest();
        try {
          const remote = await compatClient.getBoard();
          if (remote.board) {
            const elements = remote.board.elements || [];
            manifest = {
              nodes: elements.map(compactElement)
                .filter((node): node is NonNullable<typeof node> => node !== null)
                .slice(0, 40),
            };
          }
        } catch (_error) {
          // Use browser-local state when the companion API is unavailable.
        }
        return {
          ok: true,
          output: JSON.stringify(manifest, null, 2),
        };
      }

      case "add_board_node": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, output: "Missing node text." };
        const node = {
          text,
          type: (args.type as "rectangle" | "ellipse" | "diamond" | "text") || "rectangle",
          x: Number(args.x) || 120,
          y: Number(args.y) || 120,
          width: Number(args.width) || 240,
          height: Number(args.height) || 100,
        };
        try {
          await compatClient.commandBoard("add_node", node);
        } catch (_error) {
          dispatchBoardCommand("add_node", node);
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: `Added Spatial Board node: ${text}` };
      }

      case "add_board_arrow": {
        const arrow = {
          text: String(args.text ?? ""),
          x: Number(args.x) || 240,
          y: Number(args.y) || 170,
          width: Number(args.width) || 180,
          height: Number(args.height) || 0,
        };
        try {
          await compatClient.commandBoard("add_arrow", arrow);
        } catch (_error) {
          dispatchBoardCommand("add_arrow", arrow);
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: "Added a labeled Spatial Board arrow." };
      }

      case "clear_spatial_board":
        try {
          await compatClient.commandBoard("clear");
        } catch (_error) {
          dispatchBoardCommand("clear");
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: "Cleared the Spatial Board." };

      case "read_board_full": {
        try {
          const result = await compatClient.commandBoard("read_full");
          const board = result.board || { elements: [] };
          return { ok: true, output: truncate(JSON.stringify(board.elements, null, 2)) };
        } catch (error) {
          return { ok: false, output: `Failed to read board: ${error instanceof Error ? error.message : String(error)}` };
        }
      }

      case "set_board_layout": {
        const elements = Array.isArray(args.elements) ? (args.elements as Record<string, unknown>[]) : [];
        if (elements.length === 0) return { ok: false, output: "set_board_layout requires a non-empty elements array." };
        try {
          await compatClient.commandBoard("set_layout", { elements });
        } catch (error) {
          return { ok: false, output: `Failed to set board layout: ${error instanceof Error ? error.message : String(error)}` };
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: `Set Spatial Board layout with ${elements.length} elements.` };
      }

      case "update_board_element": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, output: "Missing element id." };
        const element: Record<string, unknown> = { id };
        for (const key of ["x", "y", "width", "height", "text", "strokeColor", "backgroundColor"]) {
          if (args[key] !== undefined) element[key] = args[key];
        }
        if (Object.keys(element).length === 1) return { ok: false, output: "Provide at least one field to update (x, y, width, height, text, strokeColor, backgroundColor)." };
        try {
          await compatClient.commandBoard("update_element", { element });
        } catch (error) {
          return { ok: false, output: `Failed to update board element: ${error instanceof Error ? error.message : String(error)}` };
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: `Updated Spatial Board element ${id}.` };
      }

      case "delete_board_element": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, output: "Missing element id." };
        try {
          await compatClient.commandBoard("delete_element", { id });
        } catch (error) {
          return { ok: false, output: `Failed to delete board element: ${error instanceof Error ? error.message : String(error)}` };
        }
        dispatchBoardCommand("refresh");
        return { ok: true, output: `Deleted Spatial Board element ${id}.` };
      }

      case "read_html_artifact": {
        const artifact = loadHtmlArtifact();
        return { ok: true, output: JSON.stringify(artifact) };
      }

      case "update_html_artifact": {
        const html = String(args.html ?? "");
        if (!html.trim()) return { ok: false, output: "Missing HTML source." };
        const current = loadHtmlArtifact();
        const artifact = {
          name: String(args.name ?? current.name).trim() || current.name,
          html,
          updatedAt: Date.now(),
        };
        saveHtmlArtifact(artifact);
        await saveRemoteWorkbenchField("artifact", artifact);
        return { ok: true, output: `Updated HTML artifact: ${artifact.name} (${html.length} chars)` };
      }

      case "edit_html_artifact": {
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        if (!oldString) return { ok: false, output: "Missing old_string argument." };

        const current = loadHtmlArtifact();
        const first = current.html.indexOf(oldString);
        if (first === -1) {
          return { ok: false, output: "old_string not found in the artifact. Read it again and match it exactly." };
        }
        if (current.html.indexOf(oldString, first + oldString.length) !== -1) {
          return {
            ok: false,
            output: "old_string appears more than once. Include more surrounding context to make it unique.",
          };
        }

        const artifact = {
          ...current,
          html: current.html.slice(0, first) + newString + current.html.slice(first + oldString.length),
          updatedAt: Date.now(),
        };
        saveHtmlArtifact(artifact);
        await saveRemoteWorkbenchField("artifact", artifact);
        return { ok: true, output: `Edited HTML artifact: ${artifact.name} (-${oldString.length}/+${newString.length} chars)` };
      }

      case "search_wiki": {
        const query = String(args.query ?? "");
        if (!query) return { ok: false, output: "Missing query argument." };
        const result = await compatClient.searchWiki(query, 10);
        const lines = result.items.map((item) => `- ${item.path}: ${item.snippet}`);
        return {
          ok: true,
          output: lines.length > 0 ? lines.join("\n") : "No wiki matches.",
        };
      }

      case "read_wiki_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return { ok: false, output: "Missing path argument." };
        const doc = await compatClient.readWikiFile(path);
        return { ok: true, output: truncate(doc.content) };
      }

      case "write_wiki_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? args.contents ?? "");
        if (!path) return { ok: false, output: "Missing path argument." };
        const result = await compatClient.writeWikiFile(path, content);
        return { ok: true, output: `Wrote ${result.size_bytes} bytes to wiki note ${result.path}` };
      }

      case "edit_wiki_file": {
        const path = String(args.path ?? "").trim();
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        if (!path) return { ok: false, output: "Missing path argument." };
        if (!oldString) return { ok: false, output: "Missing old_string argument." };

        const doc = await compatClient.readWikiFile(path);
        const original = doc.content ?? "";
        const first = original.indexOf(oldString);
        if (first === -1) {
          return { ok: false, output: `old_string not found in ${doc.path}. Read the note again and match it exactly.` };
        }
        if (original.indexOf(oldString, first + oldString.length) !== -1) {
          return {
            ok: false,
            output: `old_string appears more than once in ${doc.path}. Include more surrounding context to make it unique.`,
          };
        }

        const updated = original.slice(0, first) + newString + original.slice(first + oldString.length);
        const result = await compatClient.writeWikiFile(path, updated);
        const removed = oldString.split("\n").length;
        const added = newString.split("\n").length;
        return { ok: true, output: `Edited wiki note ${result.path} (-${removed}/+${added} lines).` };
      }

      case "web_fetch": {
        const url = String(args.url ?? "").trim();
        if (!url) return { ok: false, output: "Missing url argument." };
        const response = await fetch(`/api/web/fetch?url=${encodeURIComponent(url)}`);
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          message?: string;
          status?: number;
          content_type?: string;
          truncated?: boolean;
          content?: string;
        };
        if (!response.ok || payload.ok === false) {
          return { ok: false, output: `web_fetch failed: ${payload.message ?? `HTTP ${response.status}`}` };
        }
        const header = `Fetched ${url} (HTTP ${payload.status ?? "?"}, ${payload.content_type ?? "unknown"})${payload.truncated ? " [truncated]" : ""}\n\n`;
        return { ok: true, output: truncate(header + (payload.content ?? "")) };
      }

      case "trigger_workflow": {
        const id = String(args.id ?? "");
        if (!id) return { ok: false, output: "Missing workflow id argument." };
        const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.payload ?? {}),
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          ok: response.ok && payload.ok !== false,
          output: JSON.stringify(payload),
        };
      }

      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
