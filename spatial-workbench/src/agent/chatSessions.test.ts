import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_SESSIONS_STORAGE_KEY,
  filterDuplicateAgentSessions,
  persistSavedChatSessions,
  type SavedChatSession,
} from "./chatSessions.ts";

function withMockWindow<T>(windowValue: Window, callback: () => T): T {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  try {
    return callback();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("filters agent history mirrored by saved Workbench chats", () => {
  const sessions = [
    { source: "hermes", id: "gateway-session", workbench_chat_id: "chat-1" },
    { source: "hermes", id: "standalone-session" },
    { source: "opencode", id: "copied-session" },
  ];
  const saved = [
    { id: "chat-1" },
    { id: "agent-opencode-copied-session" },
  ];

  assert.deepEqual(filterDuplicateAgentSessions(sessions, saved), [sessions[1]]);
});

test("keeps mapped history visible when its Workbench chat is absent", () => {
  const session = { source: "hermes", id: "gateway-session", workbench_chat_id: "deleted-chat" };

  assert.deepEqual(filterDuplicateAgentSessions([session], []), [session]);
});

test("reduces saved chat history when localStorage rejects oversized values", () => {
  let storedValue = "";
  const mockWindow = {
    localStorage: {
      setItem: (key: string, value: string) => {
        assert.equal(key, CHAT_SESSIONS_STORAGE_KEY);
        if (value.length > 15_000) throw new DOMException("Quota exceeded", "QuotaExceededError");
        storedValue = value;
      },
    },
    dispatchEvent: () => true,
  } as unknown as Window;
  const sessions: SavedChatSession[] = Array.from({ length: 3 }, (_, sessionIndex) => ({
    id: `session-${sessionIndex}`,
    title: `Session ${sessionIndex}`,
    updatedAt: 3 - sessionIndex,
    messages: Array.from({ length: 5 }, (_, messageIndex) => ({
      id: `${sessionIndex}-${messageIndex}`,
      role: "user" as const,
      content: "x".repeat(2_000),
      timestamp: messageIndex,
    })),
  }));

  withMockWindow(mockWindow, () => persistSavedChatSessions(sessions));

  const storedSessions = JSON.parse(storedValue) as SavedChatSession[];
  assert.ok(storedValue.length <= 15_000);
  assert.equal(storedSessions[0]?.id, "session-0");
  assert.ok(storedSessions.length < sessions.length);
});

test("does not throw when localStorage remains over quota", () => {
  const mockWindow = {
    localStorage: { setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); } },
    dispatchEvent: () => true,
  } as unknown as Window;
  const session: SavedChatSession = {
    id: "session-1",
    title: "Session",
    updatedAt: 1,
    messages: [{ id: "message-1", role: "user", content: "Hello", timestamp: 1 }],
  };

  assert.doesNotThrow(() => withMockWindow(mockWindow, () => persistSavedChatSessions([session])));
});