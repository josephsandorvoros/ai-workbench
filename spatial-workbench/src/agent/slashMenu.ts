/**
 * Slash command menu logic for the agent chat input.
 *
 * When the input starts with "/", a menu pops up (like OpenCode / GitHub
 * Copilot) listing:
 *  - built-in chat commands (/help, /clear, /new, /tools, /provider, /stop)
 *  - the agent's skills from /api/agent/skills (/skill:<name>)
 *  - saved provider profiles (/profile:<name>)
 *  - models from the active API endpoint (/model:<name>)
 *
 * Selecting a command runs it locally; selecting a skill/profile/model
 * either inserts a prompt (skills) or applies the setting live.
 */

import type { AgentSkill } from "./agentData";

export type SlashItemKind = "command" | "skill" | "profile" | "model";

export interface SlashItem {
  kind: SlashItemKind;
  /** Menu label, e.g. "/help", "/skill:frontend-design", "/model:qwen3.8-27b". */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /** For skills: the skill name. */
  skillName?: string;
  /** For skills: the skill file path (shown in the menu). */
  skillPath?: string;
  /** For profiles: the profile name. */
  profileName?: string;
  /** For models: the model name. */
  modelName?: string;
}

export interface SlashQuery {
  active: boolean;
  /** The token being typed after "/", lowercased (e.g. "sk" for "/sk"). */
  token: string;
}

/** Built-in chat commands (handled locally, never reach the model). */
export const BUILTIN_SLASH_ITEMS: SlashItem[] = [
  { kind: "command", label: "/help", description: "Show available slash commands" },
  { kind: "command", label: "/clear", description: "Clear the current conversation" },
  { kind: "command", label: "/new", description: "Start a new chat session" },
  { kind: "command", label: "/tools", description: "List the tools available to the agent" },
  { kind: "command", label: "/provider", description: "Show the active provider configuration" },
  { kind: "command", label: "/status", description: "Show Hermes gateway session status" },
  { kind: "command", label: "/usage", description: "Show token usage for this gateway session" },
  { kind: "command", label: "/context", description: "Show gateway context usage and breakdown" },
  { kind: "command", label: "/stop", description: "Stop the current agent turn" },
];

/**
 * Parse the chat input for a slash menu query. The menu is active only
 * while the (trimmed) input starts with "/" and contains no whitespace
 * after it — the moment the user types a space, the menu closes and the
 * text is treated as a normal message.
 */
export function parseSlashQuery(input: string): SlashQuery {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return { active: false, token: "" };
  const rest = trimmed.slice(1);
  if (/\s/.test(rest)) return { active: false, token: "" };
  return { active: true, token: rest.toLowerCase() };
}

/**
 * Does a menu item match the typed token?
 * - "/skill:front" (token contains ":") → substring match on the full label.
 * - "/skill" (token equals a prefix) → all items of that kind.
 * - "/front" → substring match on the name after the colon (so "/sk" does
 *   not match every "/skill:*" item via the "skill" prefix).
 * - plain commands → substring match on the label.
 */
export function slashItemMatches(item: SlashItem, token: string): boolean {
  if (!token) return true;
  if (token.includes(":")) return item.label.toLowerCase().includes(token);
  const colon = item.label.indexOf(":");
  if (colon > 0) {
    const prefix = item.label.slice(1, colon);
    const name = item.label.slice(colon + 1).toLowerCase();
    return token === prefix || name.includes(token);
  }
  return item.label.toLowerCase().includes(token);
}

/** Filter menu items by the typed token; returns at most `limit` matches. */
export function filterSlashItems(query: SlashQuery, items: SlashItem[], limit = 12): SlashItem[] {
  if (!query.active) return [];
  const matches = items.filter((item) => slashItemMatches(item, query.token));
  return matches.slice(0, limit);
}

/**
 * Prompt header inserted into the chat input when a skill is picked from
 * the menu. The user can append their task before sending, e.g.:
 *   Use the "frontend-design" skill (/home/.../SKILL.md). Make the board dark
 */
export function buildSkillPromptHeader(skill: AgentSkill): string {
  return `Use the "${skill.name}" skill${skill.path ? ` (${skill.path})` : ""}. `;
}

/** Full skill prompt used when the message is sent as-is. */
export function buildSkillPrompt(skill: AgentSkill, task: string): string {
  const parts = [
    `Use the "${skill.name}" skill${skill.path ? ` (${skill.path})` : ""}.`,
    skill.description ? `Skill summary: ${skill.description}` : "",
    task.trim() ? task.trim() : "Follow the skill's instructions for the current task.",
  ];
  return parts.filter(Boolean).join("\n");
}

// Workbench UI actions that must stay local even when chatting through the Hermes gateway.
const WORKBENCH_LOCAL_COMMANDS = new Set(["clear", "new", "stop", "provider"]);

/** In gateway mode every other `/name [args]` is a Hermes command, like Discord/Telegram/Slack. */
export function parseGatewaySlashCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = /^\/([A-Za-z0-9][\w.-]{0,63})(?:\s+[\s\S]*)?$/.exec(trimmed);
  if (!match || WORKBENCH_LOCAL_COMMANDS.has(match[1].toLowerCase())) return null;
  return trimmed;
}

export function buildHelpText(): string {
  const lines = ["Chat slash commands:", ""];
  for (const item of BUILTIN_SLASH_ITEMS) {
    lines.push(`  ${item.label.padEnd(11)} ${item.description}`);
  }
  lines.push(
    "",
    "Type / to open the full menu: skills (/skill:<name>), saved provider",
    "profiles (/profile:<name>), and models (/model:<name>).",
    "Anything else is sent to the agent as a normal message.",
  );
  return lines.join("\n");
}
