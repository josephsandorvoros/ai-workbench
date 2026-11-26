import assert from "node:assert/strict";
import test from "node:test";
import { CanvasCreationTracker } from "./canvasCreationTracker.ts";
import type { CanvasDocument } from "../api/compatClient.ts";

function document(id: string, chatId = "chat-1", createdByAi = true): CanvasDocument {
  return { id, chat_id: chatId, title: id, content: "", project: null, revision: 1, updated_at: 1, created_by_ai: createdByAi };
}

test("detects new agent items for the active chat without reopening existing or manual items", () => {
  const tracker = new CanvasCreationTracker();
  const old = document("old");
  assert.equal(tracker.update([old], "chat-1"), undefined);
  const manual = document("manual", "chat-1", false);
  const other = document("other", "chat-2");
  assert.equal(tracker.update([manual, other, old], "chat-1"), undefined);
  const created = document("created");
  assert.equal(tracker.update([created, manual, other, old], "chat-1"), created);
  assert.equal(tracker.update([{ ...created, revision: 2 }], "chat-1"), undefined);
});

test("an item already opened by a direct tool event is not opened again by polling", () => {
  const tracker = new CanvasCreationTracker();
  tracker.update([], "chat-1");
  tracker.remember("created");
  assert.equal(tracker.update([document("created")], "chat-1"), undefined);
});
