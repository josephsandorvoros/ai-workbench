/**
 * Pure reducer for events from a live Hermes session (companion /api/hermes/chat/events).
 * Mirrors what the Hermes desktop app renders: streamed text, reasoning, tool rows,
 * approvals, usage and the turn outcome.
 */

export interface HermesLiveEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface HermesLiveTool {
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  output?: string;
}

export interface HermesLiveApproval {
  id: string;
  command: string;
  description: string;
  toolName: string;
  choices: string[];
}

export interface HermesLiveUsage {
  inputTokens: number;
  contextUsed: number;
  contextMax: number;
  contextPercent: number;
  estimated: boolean;
}

export interface HermesLiveTurn {
  text: string;
  reasoning: string;
  status: string;
  tools: HermesLiveTool[];
  approvals: HermesLiveApproval[];
  usage: HermesLiveUsage | null;
  done: boolean;
  outcome: "complete" | "error" | "interrupted" | "lost" | null;
  error: string;
}

export function emptyHermesTurn(): HermesLiveTurn {
  return { text: "", reasoning: "", status: "", tools: [], approvals: [], usage: null, done: false, outcome: null, error: "" };
}

const MAX_TOOL_OUTPUT = 2000;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text;
}

export function parseHermesUsage(raw: unknown): HermesLiveUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  return {
    inputTokens: num(usage.prompt) || num(usage.input),
    contextUsed: num(usage.context_used),
    contextMax: num(usage.context_max),
    contextPercent: num(usage.context_percent),
    estimated: usage.context_estimated === true,
  };
}

/** Apply one event; returns a new turn object (never mutates the input). */
export function applyHermesEvent(turn: HermesLiveTurn, event: HermesLiveEvent): HermesLiveTurn {
  const p = event.payload || {};
  switch (event.type) {
    case "message.delta":
      return { ...turn, text: turn.text + str(p.text), status: "" };
    case "message.interim": {
      if (p.already_streamed === true || !str(p.text)) return turn;
      return { ...turn, text: `${turn.text}${turn.text ? "\n\n" : ""}${str(p.text)}\n\n` };
    }
    case "reasoning.delta":
      return { ...turn, reasoning: turn.reasoning + str(p.text) };
    // Hermes' thinking callback carries the spinner/kawaii status line, not model reasoning.
    case "thinking.delta":
      return str(p.text).trim() ? { ...turn, status: str(p.text).trim() } : turn;
    case "reasoning.available":
      return turn.reasoning || str(p.text).trim() === turn.text.trim() ? turn : { ...turn, reasoning: str(p.text) };
    case "status.update":
      return { ...turn, status: str(p.text) };
    case "tool.generating":
      return { ...turn, status: `Preparing ${str(p.name) || "tool"}…` };
    case "tool.start": {
      const id = str(p.tool_id);
      if (!id || turn.tools.some((tool) => tool.id === id)) return turn;
      const args = p.args && typeof p.args === "object" ? stringify(p.args) : str(p.args_text) || str(p.preview);
      return { ...turn, tools: [...turn.tools, { id, name: str(p.name) || "tool", args, status: "running" }] };
    }
    case "tool.complete": {
      const id = str(p.tool_id);
      const result = p.result && typeof p.result === "object" ? p.result as Record<string, unknown> : {};
      const failed = result.success === false || Boolean(str(result.error))
        || (typeof result.exit_code === "number" && result.exit_code !== 0);
      const output = clip(str(p.summary) || str(result.error) || str(p.result_text) || stringify(p.result));
      const status: HermesLiveTool["status"] = failed ? "error" : "done";
      const known = turn.tools.some((tool) => tool.id === id);
      const tools = known
        ? turn.tools.map((tool) => (tool.id === id ? { ...tool, status, output } : tool))
        : [...turn.tools, { id, name: str(p.name) || "tool", args: stringify(p.args), status, output }];
      return { ...turn, tools };
    }
    case "approval.request": {
      const id = str(p.id);
      if (!id || turn.approvals.some((approval) => approval.id === id)) return turn;
      const choices = Array.isArray(p.choices) ? p.choices.filter((choice): choice is string => typeof choice === "string") : [];
      return {
        ...turn,
        approvals: [...turn.approvals, {
          id,
          command: str(p.command),
          description: str(p.description),
          toolName: str(p.tool_name) || "terminal",
          choices,
        }],
      };
    }
    case "request.cancel":
      return { ...turn, approvals: turn.approvals.filter((approval) => approval.id !== str(p.id)) };
    case "session.usage":
      return { ...turn, usage: parseHermesUsage(p.usage) ?? turn.usage };
    case "message.complete": {
      const status = str(p.status);
      const outcome = status === "error" ? "error" : status === "interrupted" ? "interrupted" : "complete";
      const finalText = typeof p.text === "string" ? p.text : "";
      return {
        ...turn,
        text: turn.text || finalText,
        reasoning: turn.reasoning || str(p.reasoning),
        usage: parseHermesUsage(p.usage) ?? turn.usage,
        status: "",
        approvals: [],
        done: true,
        outcome,
        error: outcome === "error" ? str(p.error) || str(p.failure_reason) || "Hermes reported an error" : "",
      };
    }
    case "error":
      return { ...turn, error: str(p.message) };
    case "connection.closed":
      return turn.done ? turn : { ...turn, done: true, outcome: "lost", error: turn.error || "Lost connection to Hermes." };
    default:
      return turn;
  }
}
