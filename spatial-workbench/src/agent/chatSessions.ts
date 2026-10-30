/** A tool call the agent made during an assistant turn (VS Code-style card). */
export interface ToolCallRecord {
  id: string;
  name: string;
  /** Human-readable summary of the arguments, e.g. `add_board_node "Gateway"`. */
  summary: string;
  /** Full arguments JSON (shown collapsed in the card). */
  args: string;
  status: "pending" | "running" | "done" | "denied" | "error";
  /** Tool output (truncated) once finished. */
  output?: string;
}

/** A context chip attached to a user message (VS Code @-mention style). */
export interface ContextChip {
  kind: "board" | "file" | "web" | "note" | "upload" | "image";
  label: string;
  /** Optional payload included in the prompt, e.g. a file path or URL. */
  value?: string;
}

export interface SavedChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** Assistant turns: the tool calls made while producing this message. */
  toolCalls?: ToolCallRecord[];
  /** User turns: context chips attached via @-mentions. */
  context?: ContextChip[];
  /** Assistant turns: streamed reasoning/thinking text (collapsible). */
  reasoning?: string;
}

export interface SavedChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: SavedChatMessage[];
}

export const CHAT_SESSIONS_STORAGE_KEY = "homelabSpatialWorkbench.agentChatSessions.v1";
export const CHAT_SESSIONS_CHANGED_EVENT = "homelabSpatialWorkbench.chatSessionsChanged";
export const LOAD_CHAT_SESSION_EVENT = "homelabSpatialWorkbench.loadChatSession";

export function loadSavedChatSessions(): SavedChatSession[] {
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedChatSession[];
    return Array.isArray(parsed) ? parsed.filter((session) => session?.id && Array.isArray(session.messages)) : [];
  } catch (_error) {
    return [];
  }
}

function persistSavedChatSessions(sessions: SavedChatSession[]) {
  try {
    window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    window.dispatchEvent(new Event(CHAT_SESSIONS_CHANGED_EVENT));
  } catch (_error) {
    /* ignore quota / privacy-mode errors */
  }
}

/** Upsert a saved chat session (by id) and notify listeners. */
export function upsertSavedChatSession(session: SavedChatSession): SavedChatSession[] {
  const current = loadSavedChatSessions();
  const next = [session, ...current.filter((item) => item.id !== session.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 50);
  persistSavedChatSessions(next);
  return next;
}

/** Delete a saved chat session by id and notify listeners. */
export function deleteSavedChatSession(id: string): SavedChatSession[] {
  const next = loadSavedChatSessions().filter((session) => session.id !== id);
  persistSavedChatSessions(next);
  return next;
}
