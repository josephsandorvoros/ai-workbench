import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "./chatml.ts";
import {
  buildContextSummary,
  compressConversation,
  estimateTokens,
  formatTokenCount,
  shouldCompress,
} from "./contextBudget.ts";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("estimateTokens", () => {
  it("returns 0 for an empty conversation", () => {
    assert.equal(estimateTokens([]), 0);
  });

  it("estimates roughly 4 chars per token plus per-message overhead", () => {
    // 400 chars of content + 1 message * 4 overhead = 104 -> ceil(100 + 4) = 104
    assert.equal(estimateTokens([msg("user", "a".repeat(400))]), 104);
  });

  it("counts tool-call arguments toward the total", () => {
    const withTool: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "ls -la" } }],
    };
    // 0 content + (4 name + 6 args) = 10 chars -> ceil(10/4 + 4) = ceil(6.5) = 7
    assert.equal(estimateTokens([withTool]), 7);
  });
});

describe("shouldCompress", () => {
  it("is false when the estimate is under the threshold", () => {
    assert.equal(shouldCompress(1000, 10000), false);
  });

  it("is true when the estimate exceeds the threshold", () => {
    assert.equal(shouldCompress(8000, 10000), true);
  });

  it("respects a custom threshold", () => {
    assert.equal(shouldCompress(5000, 10000, 0.4), true);
    assert.equal(shouldCompress(5000, 10000, 0.6), false);
  });

  it("is false when the context length is unknown (<= 0)", () => {
    assert.equal(shouldCompress(999999, 0), false);
  });
});

describe("compressConversation", () => {
  it("returns the input unchanged when there is nothing to compress", () => {
    const messages = [msg("user", "hi"), msg("assistant", "hello")];
    assert.equal(compressConversation(messages), messages);
  });

  it("collapses older turns into a single summary and keeps the recent ones", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      messages.push(msg("user", `question ${i}`));
      messages.push(msg("assistant", `answer ${i}`));
    }
    const compressed = compressConversation(messages, 4);
    // One summary system message + the 4 most recent messages.
    assert.equal(compressed.length, 5);
    assert.equal(compressed[0].role, "system");
    assert.ok(compressed[0].content.startsWith("[Context summary"));
    // The recent window is the last 4 messages, intact.
    assert.equal(compressed[1].content, "question 8");
    assert.equal(compressed[2].content, "answer 8");
    assert.equal(compressed[3].content, "question 9");
    assert.equal(compressed[4].content, "answer 9");
  });

  it("preserves a leading persona system message and folds a prior summary", () => {
    const messages: ChatMessage[] = [
      msg("system", "You are Hermes."),
      msg("system", "[Context summary of 3 earlier messages]\n- User: old q"),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? msg("user", `q${i}`) : msg("assistant", `a${i}`),
      ),
    ];
    const compressed = compressConversation(messages, 4);
    // Persona first, then exactly one summary, then the recent window.
    assert.equal(compressed[0].content, "You are Hermes.");
    assert.equal(compressed[1].role, "system");
    assert.ok(compressed[1].content.startsWith("[Context summary"));
    // The folded prior-summary line survives in the new summary.
    assert.ok(compressed[1].content.includes("User: old q"));
    // Only one summary message total (no stacking).
    const summaries = compressed.filter((m) => m.content.startsWith("[Context summary"));
    assert.equal(summaries.length, 1);
  });

  it("never starts the recent window on an orphaned tool result", () => {
    const messages: ChatMessage[] = [
      msg("user", "q0"),
      msg("assistant", "a0"),
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "q2"),
      msg("assistant", "a2"),
      msg("user", "q3"),
      msg("assistant", "a3"),
      msg("user", "q4"),
      { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", content: "tool output", tool_call_id: "t" },
      msg("user", "q5"),
      msg("assistant", "a5"),
    ];
    // keepRecent=3 makes the raw split land on the tool message (index 10),
    // which must be backed up so the tool stays attached to its tool_call.
    const compressed = compressConversation(messages, 3);
    // The recent window must not begin with a tool message.
    const recentStart = compressed.find((m) => m.role !== "system");
    assert.ok(recentStart);
    assert.notEqual(recentStart.role, "tool");
    // The tool message stays attached to its assistant tool_call.
    const toolIdx = compressed.findIndex((m) => m.role === "tool");
    assert.ok(toolIdx > 0);
    assert.equal(compressed[toolIdx - 1].role, "assistant");
  });
});

describe("buildContextSummary", () => {
  it("produces one labeled line per non-system message", () => {
    const summary = buildContextSummary([
      msg("system", "persona"),
      msg("user", "What is the node map?"),
      msg("assistant", "It is a diagram of your homelab."),
    ]);
    assert.ok(summary.startsWith("[Context summary"));
    assert.ok(summary.includes("User: What is the node map?"));
    assert.ok(summary.includes("Assistant: It is a diagram of your homelab."));
    assert.ok(!summary.includes("persona"));
  });

  it("truncates long lines", () => {
    const summary = buildContextSummary([msg("user", "x".repeat(300))]);
    const line = summary.split("\n").find((l) => l.startsWith("- User:"));
    assert.ok(line);
    assert.ok(line!.length < 140);
    assert.ok(line!.endsWith("…"));
  });

  it("caps the number of points", () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg("user", `q${i}`));
    const summary = buildContextSummary(messages, 10);
    const bullets = summary.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, 10);
    // Keeps the most recent points.
    assert.ok(summary.includes("q39"));
    assert.ok(!summary.includes("q0"));
  });
});

describe("formatTokenCount", () => {
  it("formats small counts as integers", () => {
    assert.equal(formatTokenCount(999), "999");
  });

  it("formats thousands with one decimal under 10k", () => {
    assert.equal(formatTokenCount(9830), "9.8k");
  });

  it("formats large counts as rounded thousands", () => {
    assert.equal(formatTokenCount(98304), "98k");
  });

  it("handles invalid input", () => {
    assert.equal(formatTokenCount(Number.NaN), "0");
    assert.equal(formatTokenCount(-5), "0");
  });
});
