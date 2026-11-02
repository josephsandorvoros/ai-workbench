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

export function filterDuplicateAgentSessions<T extends { id: string; source: string; workbench_chat_id?: string }>(
  agentSessions: T[],
  savedSessions: Pick<SavedChatSession, "id">[],
): T[] {
  const savedIds = new Set(savedSessions.map((session) => session.id));
  return agentSessions.filter((session) =>
    !savedIds.has(session.workbench_chat_id ?? "") &&
    !savedIds.has(`agent-${session.source}-${session.id}`),
  );
}

export const CHAT_SESSIONS_STORAGE_KEY = "homelabSpatialWorkbench.agentChatSessions.v1";
export const CHAT_SESSIONS_CHANGED_EVENT = "homelabSpatialWorkbench.chatSessionsChanged";
export const LOAD_CHAT_SESSION_EVENT = "homelabSpatialWorkbench.loadChatSession";
const MAX_SAVED_SESSIONS = 50;
const MAX_SAVED_MESSAGES = 100;
const MAX_SESSION_STORAGE_CHARS = 1_000_000;

function limitText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)} [truncated]`;
}

function compactMessage(message: SavedChatMessage): SavedChatMessage {
  return {
    ...message,
    content: limitText(message.content, 16_000) ?? "",
    reasoning: limitText(message.reasoning, 4_000),
    context: message.context?.slice(-12).map((chip) => ({
      ...chip,
      label: limitText(chip.label, 500) ?? "",
      value: limitText(chip.value, 2_000),
    })),
    toolCalls: message.toolCalls?.slice(-12).map((toolCall) => ({
      ...toolCall,
      summary: limitText(toolCall.summary, 1_000) ?? "",
      args: limitText(toolCall.args, 4_000) ?? "",
      output: limitText(toolCall.output, 4_000),
    })),
  };
}

function shrinkOldest(sessions: SavedChatSession[]): boolean {
  if (sessions.length > 1) {
    sessions.pop();
    return true;
  }
  const session = sessions[0];
  if (!session || session.messages.length <= 1) return false;
  session.messages = session.messages.slice(-Math.max(1, Math.ceil(session.messages.length / 2)));
  return true;
}

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

export function persistSavedChatSessions(sessions: SavedChatSession[]) {
  const compacted = [...sessions]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SAVED_SESSIONS)
    .map((session) => ({
      ...session,
      messages: session.messages.slice(-MAX_SAVED_MESSAGES).map(compactMessage),
    }));

  let serialized = JSON.stringify(compacted);
  while (serialized.length > MAX_SESSION_STORAGE_CHARS && shrinkOldest(compacted)) {
    serialized = JSON.stringify(compacted);
  }

  try {
    while (true) {
      try {
        window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, serialized);
        window.dispatchEvent(new Event(CHAT_SESSIONS_CHANGED_EVENT));
        return;
      } catch (_error) {
        if (!shrinkOldest(compacted)) return;
        serialized = JSON.stringify(compacted);
      }
    }
  } catch (_error) {
    /* ignore quota / privacy-mode errors */
  }
}

/** Upsert a saved chat session (by id) and notify listeners. */
export function upsertSavedChatSession(session: SavedChatSession): SavedChatSession[] {
  const current = loadSavedChatSessions();
  const next = [session, ...current.filter((item) => item.id !== session.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SAVED_SESSIONS);
  persistSavedChatSessions(next);
  return next;
}

/** Delete a saved chat session by id and notify listeners. */
export function deleteSavedChatSession(id: string): SavedChatSession[] {
  const next = loadSavedChatSessions().filter((session) => session.id !== id);
  persistSavedChatSessions(next);
  return next;
}
