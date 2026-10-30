import type { HermesToolSchema } from "./hermesClient";

export const APP_PREVIEW_TOOLS: HermesToolSchema[] = [
  {
    name: "start_app_preview",
    description: "Start a project app for live preview. Only use after the user asks to run or preview an app; confirm the project folder, command, and port when unclear. This executes the command as the Workbench agent user and requires approval. Return the preview link from the tool result to the user.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project folder relative to the workspace root." },
        command: { type: "string", description: "Explicit command that starts the project server; bind it to 127.0.0.1 and use $PORT." },
        port: { type: "integer", description: "Local port from 1024 through 65535." },
      },
      required: ["path", "command", "port"],
    },
  },
  {
    name: "stop_app_preview",
    description: "Stop a Workbench app preview by its session ID. Use only when the user asks to stop it or confirms cleanup.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string", description: "Preview session ID returned by start_app_preview." } },
      required: ["session_id"],
    },
  },
];