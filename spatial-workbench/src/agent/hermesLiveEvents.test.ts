import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyHermesEvent, emptyHermesTurn, type HermesLiveEvent, type HermesLiveTurn } from "./hermesLiveEvents.ts";

function run(events: Array<[string, Record<string, unknown>?]>): HermesLiveTurn {
  return events.reduce(
    (turn, [type, payload], index) => applyHermesEvent(turn, { seq: index + 1, type, payload: payload ?? {} } as HermesLiveEvent),
    emptyHermesTurn(),
  );
}

describe("applyHermesEvent", () => {
  it("streams text and reasoning and finishes on message.complete", () => {
    const turn = run([
      ["message.start"],
      ["reasoning.delta", { text: "think " }],
      ["reasoning.delta", { text: "more" }],
      ["message.delta", { text: "Hel" }],
      ["message.delta", { text: "lo" }],
      ["message.complete", { text: "Hello", status: "complete", usage: { prompt: 120, context_used: 500, context_max: 1000, context_percent: 50 } }],
    ]);
    assert.equal(turn.text, "Hello");
    assert.equal(turn.reasoning, "think more");
    assert.equal(turn.done, true);
    assert.equal(turn.outcome, "complete");
    assert.deepEqual(turn.usage, { inputTokens: 120, contextUsed: 500, contextMax: 1000, contextPercent: 50, estimated: false });
  });

  it("uses the final text when nothing streamed", () => {
    assert.equal(run([["message.complete", { text: "Only final" }]]).text, "Only final");
  });

  it("tracks tool rows by id", () => {
    const turn = run([
      ["tool.start", { tool_id: "t1", name: "terminal", args: { command: "ls" } }],
      ["tool.start", { tool_id: "t1", name: "terminal" }],
      ["tool.complete", { tool_id: "t1", name: "terminal", summary: "2 files" }],
      ["tool.complete", { tool_id: "t2", name: "read_file", result: { success: false } }],
    ]);
    assert.equal(turn.tools.length, 2);
    assert.deepEqual(turn.tools[0], { id: "t1", name: "terminal", args: "{\n  \"command\": \"ls\"\n}", status: "done", output: "2 files" });
    assert.equal(turn.tools[1].status, "error");
  });

  it("adds approvals and removes cancelled ones", () => {
    const pending = run([["approval.request", { id: "srq-1", command: "rm -rf x", choices: ["once", "deny"] }]]);
    assert.deepEqual(pending.approvals, [{ id: "srq-1", command: "rm -rf x", description: "", toolName: "terminal", choices: ["once", "deny"] }]);
    const cancelled = applyHermesEvent(pending, { seq: 9, type: "request.cancel", payload: { id: "srq-1" } });
    assert.deepEqual(cancelled.approvals, []);
  });

  it("reports interrupted, error and lost outcomes", () => {
    assert.equal(run([["message.complete", { status: "interrupted" }]]).outcome, "interrupted");
    const failed = run([["message.complete", { status: "error", error: "provider down" }]]);
    assert.equal(failed.outcome, "error");
    assert.equal(failed.error, "provider down");
    const lost = run([["message.delta", { text: "part" }], ["error", { message: "boom" }], ["connection.closed"]]);
    assert.equal(lost.outcome, "lost");
    assert.equal(lost.error, "boom");
    assert.equal(lost.text, "part");
  });

  it("ignores unknown events and interim text that already streamed", () => {
    const turn = run([["pet.update", { x: 1 }], ["message.interim", { text: "dup", already_streamed: true }]]);
    assert.deepEqual(turn, emptyHermesTurn());
  });

  it("shows thinking spinners as status and drops reasoning that repeats the reply", () => {
    const turn = run([
      ["thinking.delta", { text: "pondering..." }],
      ["message.delta", { text: "Answer" }],
      ["reasoning.available", { text: "Answer" }],
    ]);
    assert.equal(turn.reasoning, "");
    assert.equal(turn.status, "");
    assert.equal(run([["thinking.delta", { text: "pondering..." }]]).status, "pondering...");
  });
});
