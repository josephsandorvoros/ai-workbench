import type { HermesToolSchema } from "./hermesClient";

export const HTML_TOOLS: HermesToolSchema[] = [
  {
    name: "read_html_artifact",
    description: "Read the active shared HTML artifact source.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "update_html_artifact",
    description:
      "Replace the active shared HTML artifact with complete HTML source and an optional name. Use edit_html_artifact instead when changing part of an existing artifact.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, html: { type: "string" } },
      required: ["html"],
    },
  },
  {
    name: "edit_html_artifact",
    description:
      "Make a targeted edit to the active HTML artifact by replacing an exact snippet. Read the artifact first; old_string must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        old_string: { type: "string", description: "Exact snippet to replace, including whitespace." },
        new_string: { type: "string", description: "Replacement text. Empty string deletes the snippet." },
      },
      required: ["old_string", "new_string"],
    },
  },
];
