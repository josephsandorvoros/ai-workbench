import { applyHermesEvent, emptyHermesTurn, type HermesLiveEvent, type HermesLiveTurn } from "../agent/hermesLiveEvents";

const apiBaseUrl = import.meta.env.VITE_DIRECT_API_BASE_URL || "";

export type HermesCommandResult =
  | { ok: boolean; command: string; type: "output"; output: string; warning?: string }
  | { ok: boolean; command: string; type: "send"; message: string; notice?: string; display?: string }
  | { ok: boolean; command: string; type: "prefill"; message: string; notice?: string };

interface EventsResponse {
  ok: boolean;
  events: HermesLiveEvent[];
  cursor: number;
  running: boolean;
  closed: boolean;
  truncated: boolean;
}

async function call<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/hermes/chat/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(`Hermes ${action} returned HTTP ${response.status}`);
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(typeof payload.message === "string" ? payload.message : `Hermes ${action} failed with ${response.status}`);
  }
  return payload as T;
}

export const hermesLive = {
  open: (chatId: string) => call<{ session_id: string; cursor: number; running: boolean; info: Record<string, unknown> }>("open", { chat_id: chatId }),
  prompt: (chatId: string, text: string, images: string[] = []) =>
    call<{ cursor: number; status: string }>("prompt", { chat_id: chatId, text, images }),
  command: (chatId: string, command: string) => call<HermesCommandResult>("command", { chat_id: chatId, command }),
  interrupt: (chatId: string) => call<Record<string, unknown>>("interrupt", { chat_id: chatId }),
  steer: (chatId: string, text: string) => call<{ status?: string }>("steer", { chat_id: chatId, text }),
  respond: (chatId: string, requestId: string, choice: "once" | "session" | "always" | "deny") =>
    call<Record<string, unknown>>("respond", { chat_id: chatId, request_id: requestId, choice }),

  async events(chatId: string, after: number, waitSeconds: number, signal?: AbortSignal): Promise<EventsResponse> {
    const query = new URLSearchParams({ chat_id: chatId, after: String(after), wait: String(waitSeconds) });
    const response = await fetch(`${apiBaseUrl}/api/hermes/chat/events?${query}`, { cache: "no-store", signal });
    const payload = await response.json() as EventsResponse & { message?: string };
    if (!response.ok || payload.ok === false) throw new Error(payload.message || `Hermes events failed with ${response.status}`);
    return payload;
  },
};

/**
 * Follow one turn from `after` until Hermes reports message.complete (or the connection drops).
 * `onTurn` receives the accumulated turn after every batch of events.
 */
export async function followHermesTurn(
  chatId: string,
  after: number,
  onTurn: (turn: HermesLiveTurn) => void,
  signal: AbortSignal,
): Promise<HermesLiveTurn> {
  let turn = emptyHermesTurn();
  let cursor = after;
  let failures = 0;
  while (!turn.done) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    let batch: EventsResponse;
    try {
      batch = await hermesLive.events(chatId, cursor, 25, signal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      failures += 1;
      if (failures > 20) throw error;
      onTurn({ ...turn, status: "Reconnecting to Hermes…" });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 3000));
      continue;
    }
    for (const event of batch.events) turn = applyHermesEvent(turn, event);
    cursor = batch.cursor;
    if (!turn.done && (batch.truncated || (batch.closed && batch.events.length === 0))) {
      turn = { ...turn, done: true, outcome: "lost", error: turn.error || "Lost track of this Hermes turn." };
    }
    onTurn(turn);
  }
  return turn;
}
