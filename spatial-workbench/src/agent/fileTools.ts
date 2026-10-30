import type { HermesToolSchema } from "./hermesClient";

export const FILE_TOOLS: HermesToolSchema[] = [
  {
    name: "read_code_file",
    description:
      "Read a text/code file from the project workspace. Always read a file before editing it so the old_string you pass to edit_code_file matches exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute path." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_code_file",
    description:
      "Make a targeted edit to an existing file by replacing an exact snippet. Prefer this over write_code_file for changes to existing files. old_string must appear exactly once — include surrounding lines to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute path." },
        old_string: { type: "string", description: "Exact text to replace, including whitespace and indentation." },
        new_string: { type: "string", description: "Replacement text. Use an empty string to delete the snippet." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_code_file",
    description:
      "Write a file's full contents, creating it if needed. Use this for new files; use edit_code_file to modify an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute path." },
        contents: { type: "string", description: "Complete new file contents." },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "delete_code_file",
    description: "Delete a file from the project workspace. The companion API keeps a timestamped backup.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute path." },
      },
      required: ["path"],
    },
  },
];
