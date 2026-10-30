/**
 * Context budgeting for the agent chat.
 *
 * The workbench re-sends the entire conversation on every turn. When the
 * input tokens plus the output budget exceed the model's hard context
 * window, the stream drops mid-generation and the agent appears to "stop on
 * its own". This module tracks how much context a conversation is using and
 * compresses older turns into a rolling summary before we get close to the
 * limit, so long conversations keep working.
 *
 * Everything here is pure (no I/O, no API calls) so it is easy to test and
 * safe to run on every render.
 */

import type { ChatMessage } from "./chatml";

/** Marker prefix for a rolling context-summary system message. */
export const CONTEXT_SUMMARY_PREFIX = "[Context summary";

/**
 * Rough token estimate for a conversation.
 *
 * Uses the common ~4-chars-per-token heuristic for English/mixed text, plus a
 * small per-message overhead to account for ChatML role markers. This is an
 * estimate for budgeting, not an exact tokenizer count.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4 + messages.length * 4);
}

/**
 * Decide whether a conversation should be compressed before the next turn.
 *
 * Returns true when the estimated token count exceeds `threshold` (default
 * 0.7) of the model's context window. A threshold below 1.0 leaves headroom
 * for the model's own output tokens.
 */
export function shouldCompress(
  estimatedTokens: number,
  contextLength: number,
  threshold = 0.7,
): boolean {
  if (contextLength <= 0) return false;
  return estimatedTokens > threshold * contextLength;
}

/**
 * Compress a conversation by collapsing older turns into a single rolling
 * summary system message while keeping the most recent turns intact.
 *
 * - Leading persona / shared-context system messages are preserved verbatim.
 * - A prior rolling summary (if present) is folded into the new summary so
 *   summaries do not stack across repeated compressions.
 * - The most recent `keepRecent` messages are kept intact.
 * - Everything in between is distilled into one summary system message.
 * - The split point is never placed on an orphaned tool result, so a tool
 *   message always stays attached to the assistant tool_call that produced it.
 *
 * Returns the input unchanged when there is nothing worth compressing.
 */
export function compressConversation(
  messages: ChatMessage[],
  keepRecent = 6,
): ChatMessage[] {
  if (messages.length <= keepRecent) return messages;

  // Split leading system messages into persona (keep) and prior summary (fold).
  let leadingSystemCount = 0;
  while (
    leadingSystemCount < messages.length &&
    messages[leadingSystemCount].role === "system"
  ) {
    leadingSystemCount += 1;
  }
  const leadingSystem = messages.slice(0, leadingSystemCount);
  const persona = leadingSystem.filter(
    (message) => !message.content.startsWith(CONTEXT_SUMMARY_PREFIX),
  );
  const priorSummary = leadingSystem.find((message) =>
    message.content.startsWith(CONTEXT_SUMMARY_PREFIX),
  );
  const rest = messages.slice(leadingSystemCount);

  if (rest.length <= keepRecent) return messages;

  let splitIndex = rest.length - keepRecent;
  // Never start the recent window on an orphaned tool result — a tool message
  // must stay attached to the assistant tool_call that produced it.
  while (splitIndex > 0 && rest[splitIndex].role === "tool") {
    splitIndex -= 1;
  }
  if (splitIndex <= 0) return messages;

  const oldMessages = rest.slice(0, splitIndex);
  const recentMessages = rest.slice(splitIndex);

  // Fold the prior summary into the new one so summaries don't stack.
  const summarySource = priorSummary ? [priorSummary, ...oldMessages] : oldMessages;
  const summaryMessage: ChatMessage = {
    role: "system",
    content: buildContextSummary(summarySource),
  };

  return [...persona, summaryMessage, ...recentMessages];
}

/**
 * Distill a set of older messages into a compact, human-readable summary.
 *
 * Each non-system message contributes a single line (its first meaningful
 * line, truncated). A prior rolling summary contributes its own bullet lines
 * so already-distilled context is not lost on repeated compression. The
 * result is capped at `maxPoints` lines.
 */
export function buildContextSummary(messages: ChatMessage[], maxPoints = 24): string {
  const points: string[] = [];
  for (const message of messages) {
    const content = String(message.content ?? "");
    if (content.startsWith(CONTEXT_SUMMARY_PREFIX)) {
      // Fold a prior rolling summary's bullet lines into this one.
      for (const line of extractSummaryLines(content)) points.push(line);
      continue;
    }
    if (message.role === "system") continue;
    const label =
      message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
    const line = firstMeaningfulLine(content);
    if (line) points.push(`${label}: ${line}`);
  }
  const trimmed = points.slice(-maxPoints);
  const body = trimmed.map((point) => `- ${point}`).join("\n");
  return `${CONTEXT_SUMMARY_PREFIX} of ${messages.length} earlier messages]\n${body}`;
}

/** Bullet lines (without the leading "- ") from a prior rolling summary. */
function extractSummaryLines(content: string): string[] {
  return String(content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

/** First non-empty line of a message, truncated to a display-friendly length. */
function firstMeaningfulLine(content: string): string {
  const lines = String(content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Format a token count for compact display (e.g. 98304 -> "98.3k"). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens / 1000;
  if (thousands < 10) return `${thousands.toFixed(1)}k`;
  return `${Math.round(thousands)}k`;
}
