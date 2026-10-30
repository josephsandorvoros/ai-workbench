import assert from "node:assert/strict";
import test from "node:test";
import { filterDuplicateAgentSessions } from "./chatSessions.ts";

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