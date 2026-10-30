import type { HermesToolSchema } from "./hermesClient";

export const WIKI_TOOLS: HermesToolSchema[] = [
  {
    name: "search_wiki",
    description: "Search the wiki knowledge base for a phrase and return matching notes with snippets.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "read_wiki_file",
    description:
      "Read a wiki note. Always read a note before editing it so the old_string you pass to edit_wiki_file matches exactly.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Wiki-relative path, e.g. concepts/networking.md" } },
      required: ["path"],
    },
  },
  {
    name: "edit_wiki_file",
    description:
      "Make a targeted edit to an existing wiki note by replacing an exact snippet. Prefer this over write_wiki_file for changes to an existing note. old_string must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Wiki-relative path." },
        old_string: { type: "string", description: "Exact text to replace, including whitespace." },
        new_string: { type: "string", description: "Replacement text. Empty string deletes the snippet." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_wiki_file",
    description:
      "Write a wiki note's full contents, creating it if needed. Use this for new notes; use edit_wiki_file to modify an existing one. Markdown and text files only.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Wiki-relative path, e.g. concepts/networking.md" },
        content: { type: "string", description: "Complete new note contents." },
      },
      required: ["path", "content"],
    },
  },
];
