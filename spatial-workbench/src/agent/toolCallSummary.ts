/**
 * Pure helpers for VS Code-style tool-call cards and @-mention context.
 *
 * Kept free of React/DOM so it is unit-testable with `node --test`:
 *  - summarizeToolCall: one-line human summary of a tool call's arguments
 *  - isMutatingTool: which tools change state (need approval in "ask" mode)
 *  - truncateOutput: cap tool output for the card
 *  - buildContextPrompt: render @-mention chips into a prompt preamble
 *  - parseMentionQuery / filterContextItems: the @ menu
 *  - buildFollowUps: suggested follow-up questions after an answer
 */

import type { ContextChip } from "./chatSessions";

/** Tools that only read state — never need approval. */
const READ_ONLY_TOOLS = new Set([
  "fetch_canvas_layout",
  "read_board_full",
  "web_fetch",
  "read_html_artifact",
  "read_code_file",
  "git_status",
  "search_wiki",
  "read_wiki_file",
]);

export function isMutatingTool(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}

function shortString(value: unknown, max = 48): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Build a one-line summary of a tool call, e.g.:
 *   add_board_node "Gateway" (rectangle)
 *   web_fetch https://example.com
 *   execute_bash_command npm test
 */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  const text = shortString(args.text ?? args.command ?? args.url ?? args.html ?? args.content);
  if (text) parts.push(`"${text}"`);
  if (args.type && typeof args.type === "string") parts.push(`(${args.type})`);
  if (args.path && typeof args.path === "string") parts.push(args.path);
  if (args.x !== undefined || args.y !== undefined) {
    parts.push(`@ ${Math.round(Number(args.x) || 0)},${Math.round(Number(args.y) || 0)}`);
  }
  return parts.length > 0 ? `${name} ${parts.join(" ")}` : name;
}

/** Cap tool output for display in the card (keeps the tail, where results live). */
export function truncateOutput(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [truncated ${text.length - max} chars] …\n${text.slice(-tail)}`;
}

/**
 * Render attached context chips into a prompt preamble. Empty array → "".
 * The preamble is prepended to the user's text before it reaches the model.
 */
export function buildContextPrompt(context: ContextChip[]): string {
  if (context.length === 0) return "";
  const lines = ["Attached context:"];
  for (const chip of context) {
    if (chip.kind === "board") lines.push("- Spatial Board: current canvas layout (agent may call fetch_canvas_layout)");
    else if (chip.kind === "file") lines.push(`- File: ${chip.value ?? chip.label}`);
    else if (chip.kind === "web") lines.push(`- Web page: ${chip.value ?? chip.label}`);
    else if (chip.kind === "upload" || chip.kind === "image") continue;
    else lines.push(`- Note: ${chip.value ?? chip.label}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// ---------------------------------------------------------------------------
// @-mention context menu
// ---------------------------------------------------------------------------

export interface MentionItem {
  kind: ContextChip["kind"];
  label: string;
  description: string;
  value?: string;
}

/**
 * Parse the input for an @-mention query. The menu is active while the
 * input contains an "@" token with no whitespace after it, e.g. "@bo" →
 * token "bo". A plain "@" (empty token) shows the full menu.
 */
export function parseMentionQuery(input: string): { active: boolean; token: string } {
  const match = /(^|\s)@([^\s@]*)$/.exec(input);
  if (!match) return { active: false, token: "" };
  return { active: true, token: match[2].toLowerCase() };
}

/** Filter mention items by the typed token (substring on label or kind). */
export function filterMentionItems(query: string, items: MentionItem[], limit = 8): MentionItem[] {
  if (!query) return items.slice(0, limit);
  return items
    .filter((item) => item.label.toLowerCase().includes(query) || item.kind.includes(query))
    .slice(0, limit);
}

/**
 * Replace the trailing "@token" in the input with the selected chip's
 * label, so the user can keep typing after the chip.
 */
export function applyMentionToInput(input: string, item: MentionItem): string {
  return input.replace(/@([^\s@]*)$/, `@${item.label} `);
}

/**
 * Extract @-mention context chips from a message, e.g.:
 *   "@board show the layout"        → chip board
 *   "@file /home/x/README.md fix it" → chip file (README.md)
 *   "@web https://example.com"      → chip web
 *   "@note remember the token"      → chip note
 * Returns the chips plus the text with the matched tokens removed.
 */
export function parseContextChips(text: string): { chips: ContextChip[]; cleanText: string } {
  const chips: ContextChip[] = [];
  let cleanText = text;

  cleanText = cleanText.replace(/@board\b/g, () => {
    chips.push({ kind: "board", label: "Spatial Board" });
    return "";
  });
  cleanText = cleanText.replace(/@file\s+(\S+)/g, (_match, path: string) => {
    const name = path.split("/").pop() || path;
    chips.push({ kind: "file", label: name, value: path });
    return "";
  });
  cleanText = cleanText.replace(/@web\s+(\S+)/g, (_match, url: string) => {
    let host = url;
    try {
      host = new URL(url).host;
    } catch (_error) {
      // not a URL — keep the raw value
    }
    chips.push({ kind: "web", label: host, value: url });
    return "";
  });
  cleanText = cleanText.replace(/@note\s+(.+?)(?=\s+@(?:board|file|web|note)\b|$)/g, (_match, note: string) => {
    const trimmed = note.trim();
    chips.push({ kind: "note", label: trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed, value: trimmed });
    return "";
  });

  cleanText = cleanText.replace(/[ \t]{2,}/g, " ").replace(/^[\s]+|[\s]+$/g, "");
  return { chips, cleanText };
}

// ---------------------------------------------------------------------------
// Follow-up suggestions (VS Code shows 2-3 chips after an answer)
// ---------------------------------------------------------------------------

/**
 * Suggest follow-up questions from the assistant's answer. Heuristic and
 * cheap: derived from the content, never from the network.
 */
export function buildFollowUps(content: string): string[] {
  const suggestions: string[] = [];
  const text = content.trim();
  if (!text) return [];

  if (/\b(error|failed|exception|traceback)\b/i.test(text)) {
    suggestions.push("Explain the root cause of this error");
    suggestions.push("Suggest a fix and apply it");
  } else if (/\b(board|canvas|node|layout)\b/i.test(text)) {
    suggestions.push("Update the Spatial Board to match");
    suggestions.push("Summarize the current board layout");
  } else if (/\b(code|function|component|file)\b/i.test(text)) {
    suggestions.push("Show the relevant code");
    suggestions.push("Explain how this works");
  } else {
    suggestions.push("Explain that in more detail");
    suggestions.push("What are the next steps?");
  }
  if (/\b(should|recommend|option|alternative)\b/i.test(text)) {
    suggestions.push("Compare the options");
  }
  return suggestions.slice(0, 3);
}
