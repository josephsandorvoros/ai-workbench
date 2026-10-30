import type { ChatMessage } from "./chatml";

/**
 * OpenAI-compatible chat client for the local Hermes model endpoint.
 *
 * The Hermes agent on this network runs its model through an
 * OpenAI-compatible API (llama.cpp / Ollama style). This client speaks that
 * protocol, including native function/tool calling, so AI Workbench
 * agent tab can be wired to the same model the Hermes agent uses.
 */

export interface HermesClientConfig {
  /** Base URL of the OpenAI-compatible API, e.g. "/llm" (Vite proxy) or "http://host:port/v1". */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface HermesToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface HermesToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface HermesChatResult {
  text: string;
  toolCalls: HermesToolCall[];
  raw: unknown;
}

export interface HermesRunStatus {
  run_id: string;
  status: string;
  output?: string;
  error?: string;
  last_event?: string;
  pending_steer?: string;
}

export interface HermesRunCallbacks {
  onDelta?: (text: string) => void;
  onStatus?: (text: string) => void;
}

export function parseRunEventFrame(frame: string, callbacks: HermesRunCallbacks): void {
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return;
  let event: Record<string, unknown>;
  try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
  if (event.event === "message.delta" && typeof event.delta === "string") callbacks.onDelta?.(event.delta);
  if (event.event === "message.interim" && typeof event.text === "string") callbacks.onStatus?.(event.text);
  if (event.event === "tool.started" && typeof event.name === "string") callbacks.onStatus?.(`Running ${event.name}`);
  if (event.event === "tool.completed" && typeof event.name === "string") callbacks.onStatus?.(`Finished ${event.name}`);
}

export interface HermesChatOptions {
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  workbenchChatId?: string;
  /** Optional external abort signal (e.g. a Stop button). Aborts the in-flight request. */
  signal?: AbortSignal;
}

/**
 * Callbacks for streaming chat. `onDelta` fires for each incremental text
 * chunk as it arrives over SSE; `onStatus` surfaces non-content stream events
 * (e.g. tool/status markers) when the endpoint emits them.
 */
export interface HermesStreamCallbacks {
  onDelta: (chunk: string) => void;
  onStatus?: (status: string) => void;
  onReasoning?: (chunk: string) => void;
  onUsage?: (usage: HermesStreamUsage) => void;
  onContext?: (context: HermesContextUsage) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface HermesStreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface HermesContextUsage {
  contextUsed: number;
  contextMax: number;
  contextPercent: number;
  source: string;
  estimated: boolean;
}

/** Plain string content, or text + image_url parts when images are attached. */
function toApiContent(message: ChatMessage): string | Array<Record<string, unknown>> {
  if (!message.images?.length) return message.content;
  return [
    { type: "text", text: message.content },
    ...message.images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: HermesClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs || 180_000;
  }

  get available() {
    return Boolean(this.baseUrl && this.model);
  }

  private async runRequest<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`${this.baseUrl}/runs${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T & { error?: string | { message?: string } };
    if (!response.ok) {
      const detail = typeof result.error === "string" ? result.error : result.error?.message;
      throw new Error(detail || `Hermes run request failed with ${response.status}`);
    }
    return result;
  }

  startRun(message: ChatMessage, sessionId: string): Promise<{ run_id: string }> {
    return this.runRequest("", {
      model: this.model,
      session_id: sessionId,
      input: [{ role: "user", content: toApiContent(message) }],
    });
  }

  getRun(runId: string): Promise<HermesRunStatus> {
    return this.runRequest(`/${encodeURIComponent(runId)}`);
  }

  async stopRun(runId: string): Promise<void> {
    await this.runRequest(`/${encodeURIComponent(runId)}/stop`, {});
  }

  steerRun(runId: string, text: string): Promise<{ accepted: boolean }> {
    return this.runRequest(`/${encodeURIComponent(runId)}/steer`, { input: text });
  }

  async waitForRun(runId: string, callbacks: HermesRunCallbacks, signal?: AbortSignal): Promise<HermesRunStatus> {
    const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
    const readStatus = async (): Promise<HermesRunStatus> => {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          return await this.getRun(runId);
        } catch (error) {
          if (error instanceof Error && /failed with (400|401|403|404|410)/.test(error.message)) throw error;
          callbacks.onStatus?.("Reconnecting to Hermes...");
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 3000));
        }
      }
    };
    let status = await readStatus();
    if (terminal.has(status.status)) return status;

    try {
      const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { Accept: "text/event-stream", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        signal,
      });
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator;
          while ((separator = findSseSeparator(buffer)) !== null) {
            parseRunEventFrame(buffer.slice(0, separator.index), callbacks);
            buffer = buffer.slice(separator.index + separator.length);
          }
        }
        if (buffer.trim()) parseRunEventFrame(buffer, callbacks);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      status = await readStatus();
      if (terminal.has(status.status)) return status;
      callbacks.onStatus?.(status.last_event || "Hermes is working");
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 3000));
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: HermesToolSchema[],
    options: HermesChatOptions = {},
  ): Promise<HermesChatResult> {
    if (!this.available) {
      throw new Error("Hermes endpoint is not configured.");
    }

    const controller = new AbortController();
    const timeoutHandle = window.setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: toApiContent(message),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
    };

    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Hermes request failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      const raw = (await response.json()) as Record<string, unknown>;
      return parseChatCompletion(raw);
    } finally {
      window.clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Streaming chat via SSE (`stream: true`). Reads the `text/event-stream`
   * body and invokes `onDelta` for each incremental content chunk. Resolves
   * with the full accumulated text once the stream closes.
   *
   * Works with any OpenAI-compatible endpoint that supports SSE, including
   * the Hermes gateway api_server (which also emits `__status__`/
   * `__reasoning__` events surfaced through `onStatus`).
   */
  async chatStream(
    messages: ChatMessage[],
    callbacks: HermesStreamCallbacks,
    options: HermesChatOptions = {},
  ): Promise<string> {
    if (!this.available) {
      throw new Error("Hermes endpoint is not configured.");
    }

    const controller = new AbortController();
    const timeoutHandle = window.setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: toApiContent(message),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(options.sessionId ? { "X-Hermes-Session-Id": options.sessionId } : {}),
          ...(options.workbenchChatId ? { "X-Workbench-Chat-Id": options.workbenchChatId } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Hermes stream request failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
      if (!response.body) {
        throw new Error("Hermes stream response has no body.");
      }
      const sessionId = response.headers.get("X-Hermes-Session-Id")?.trim();
      if (sessionId) callbacks.onSessionId?.(sessionId);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; process complete frames.
        let separatorIndex: { index: number; length: number } | null;
        while ((separatorIndex = findSseSeparator(buffer)) !== null) {
          const frame = buffer.slice(0, separatorIndex.index);
          buffer = buffer.slice(separatorIndex.index + separatorIndex.length);
          const delta = parseSseFrame(frame, callbacks);
          if (delta) fullText += delta;
        }
      }

      // Flush any trailing frame without a terminating blank line.
      if (buffer.trim()) {
        const delta = parseSseFrame(buffer, callbacks);
        if (delta) fullText += delta;
      }

      return fullText;
    } finally {
      window.clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Parse one SSE frame. Returns the content delta (if any) and forwards
 * status/reasoning events to the callbacks.
 */
function findSseSeparator(buffer: string): { index: number; length: number } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex === -1 && crlfIndex === -1) return null;
  if (crlfIndex === -1 || (lfIndex !== -1 && lfIndex < crlfIndex)) {
    return { index: lfIndex, length: 2 };
  }
  return { index: crlfIndex, length: 4 };
}

export function parseSseFrame(frame: string, callbacks: HermesStreamCallbacks): string {
  let data = "";
  let eventName = "message";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  if (!data || data === "[DONE]") return "";

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return "";
  }

  if (eventName === "hermes.status") {
    const status = typeof payload.text === "string" ? payload.text : "";
    if (status) callbacks.onStatus?.(status);
    return "";
  }
  if (eventName === "hermes.tool.progress") {
    const status = typeof payload.label === "string" ? payload.label : "";
    if (status) callbacks.onStatus?.(status);
    return "";
  }

  // Hermes gateway non-content stream events.
  if (typeof payload.__status__ === "string") {
    callbacks.onStatus?.(payload.__status__);
    return "";
  }
  if (typeof payload.__reasoning__ === "string") {
    callbacks.onStatus?.(payload.__reasoning__);
    return "";
  }

  const context = payload.hermes_context;
  if (context && typeof context === "object") {
    const fields = context as Record<string, unknown>;
    const contextUsed = Number(fields.context_used);
    const contextMax = Number(fields.context_max);
    const contextPercent = Number(fields.context_percent);
    if (
      Number.isFinite(contextUsed) && contextUsed >= 0 &&
      Number.isFinite(contextMax) && contextMax > 0 &&
      Number.isFinite(contextPercent) && contextPercent >= 0 && contextPercent <= 100
    ) {
      callbacks.onContext?.({
        contextUsed,
        contextMax,
        contextPercent,
        source: typeof fields.context_source === "string" ? fields.context_source : "unknown",
        estimated: fields.context_estimated === true,
      });
    }
  }

  const usage = payload.usage;
  if (usage && typeof usage === "object") {
    const fields = usage as Record<string, unknown>;
    const promptTokens = Number(fields.prompt_tokens);
    const completionTokens = Number(fields.completion_tokens);
    const totalTokens = Number(fields.total_tokens);
    if ([promptTokens, completionTokens, totalTokens].every((value) => Number.isFinite(value) && value >= 0)) {
      callbacks.onUsage?.({ promptTokens, completionTokens, totalTokens });
    }
  }

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown>;
  const delta = (first.delta ?? {}) as Record<string, unknown>;
  if (typeof delta.reasoning_content === "string") {
    callbacks.onReasoning?.(delta.reasoning_content);
  }
  const content = typeof delta.content === "string" ? delta.content : "";
  if (content) callbacks.onDelta(content);
  return content;
}

function parseChatCompletion(raw: unknown): HermesChatResult {
  if (!raw || typeof raw !== "object") {
    return { text: "", toolCalls: [], raw };
  }

  const payload = raw as Record<string, unknown>;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { text: "", toolCalls: [], raw };
  }

  const first = choices[0] as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const text = typeof message.content === "string" ? message.content : "";

  const toolCalls: HermesToolCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      if (!call || typeof call !== "object") continue;
      const entry = call as Record<string, unknown>;
      const fn = (entry.function ?? {}) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === "string") {
        try {
          args = JSON.parse(fn.arguments) as Record<string, unknown>;
        } catch {
          args = { raw: fn.arguments };
        }
      } else if (fn.arguments && typeof fn.arguments === "object") {
        args = fn.arguments as Record<string, unknown>;
      }
      toolCalls.push({
        id: typeof entry.id === "string" ? entry.id : `call_${toolCalls.length}`,
        name,
        arguments: args,
      });
    }
  }

  return { text, toolCalls, raw };
}