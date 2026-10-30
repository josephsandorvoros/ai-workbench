import assert from "node:assert/strict";
import test from "node:test";

import { HermesClient, parseSseFrame } from "./hermesClient.ts";

test("starts and checks a Hermes run without a streaming request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(requests.length === 1
      ? { run_id: "run_123", status: "started" }
      : { run_id: "run_123", status: "completed", output: "Done" }), { status: requests.length === 1 ? 202 : 200 });
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    assert.deepEqual(await client.startRun({ role: "user", content: "Hello" }, "chat-one"), { run_id: "run_123", status: "started" });
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      model: "hermes-agent", session_id: "chat-one", input: [{ role: "user", content: "Hello" }],
    });
    assert.equal((await client.getRun("run_123")).output, "Done");
    assert.equal(requests[1].url, "/hermes-gw/runs/run_123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the final run status after the event stream closes", async () => {
  const originalFetch = globalThis.fetch;
  const statuses: string[] = [];
  let statusCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/events")) {
      return new Response('data: {"event":"tool.started","name":"terminal"}\n\ndata: {"event":"message.delta","delta":"Working"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    statusCalls += 1;
    return new Response(JSON.stringify({ run_id: "run_123", status: statusCalls === 1 ? "running" : "completed", output: "Finished" }));
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    const deltas: string[] = [];
    const final = await client.waitForRun("run_123", { onDelta: (text) => deltas.push(text), onStatus: (text) => statuses.push(text) });
    assert.equal(final.output, "Finished");
    assert.deepEqual(deltas, ["Working"]);
    assert.deepEqual(statuses, ["Running terminal"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovers from a dropped event stream and a transient status failure", async () => {
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/events")) throw new TypeError("Disconnected");
    statusCalls += 1;
    if (statusCalls === 2) throw new TypeError("Network offline");
    return new Response(JSON.stringify({ run_id: "run_123", status: statusCalls === 3 ? "completed" : "running", output: "Recovered" }));
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    const statuses: string[] = [];
    assert.equal((await client.waitForRun("run_123", { onStatus: (text) => statuses.push(text) })).output, "Recovered");
    assert.deepEqual(statuses, ["Reconnecting to Hermes..."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops a server run with POST rather than aborting the watcher", async () => {
  const originalFetch = globalThis.fetch;
  let method = "";
  globalThis.fetch = async (_input, init) => {
    method = init?.method || "";
    return new Response('{"run_id":"run_123","status":"stopping"}');
  };
  try {
    await new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" }).stopRun("run_123");
    assert.equal(method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queues mid-turn guidance and reports runs that no longer accept it", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  let rejectSteer = false;
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return rejectSteer
      ? new Response('{"error":{"message":"Run is not currently accepting steer input"}}', { status: 409 })
      : new Response('{"accepted":true}');
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    assert.equal((await client.steerRun("run_123", "Focus on the tests")).accepted, true);
    assert.deepEqual(JSON.parse(body), { input: "Focus on the tests" });
    rejectSteer = true;
    await assert.rejects(client.steerRun("run_123", "Too late"), /not currently accepting/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reattaches after the initial status request is offline", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("Offline");
    return new Response(JSON.stringify({ run_id: "run_123", status: "completed", output: "Restored" }));
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    assert.equal((await client.waitForRun("run_123", {})).output, "Restored");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parses Hermes reasoning and content SSE frames", () => {
  const reasoning: string[] = [];
  const statuses: string[] = [];
  const content: string[] = [];
  const usage: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [];
  const context: Array<{ contextUsed: number; contextMax: number; contextPercent: number; source: string; estimated: boolean }> = [];
  const callbacks = {
    onDelta: (chunk: string) => content.push(chunk),
    onReasoning: (chunk: string) => reasoning.push(chunk),
    onStatus: (status: string) => statuses.push(status),
    onUsage: (tokens: { promptTokens: number; completionTokens: number; totalTokens: number }) => usage.push(tokens),
    onContext: (metrics: { contextUsed: number; contextMax: number; contextPercent: number; source: string; estimated: boolean }) => context.push(metrics),
  };

  const reasoningDelta = parseSseFrame(
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
    callbacks,
  );
  const statusDelta = parseSseFrame(
    'event: hermes.status\ndata: {"kind":"agent","text":"Running tool"}',
    callbacks,
  );
  const contentDelta = parseSseFrame(
    'data: {"choices":[{"delta":{"content":"LIVE_OK"}}]}',
    callbacks,
  );
  const usageDelta = parseSseFrame(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168},"hermes_context":{"context_used":12345,"context_max":98304,"context_percent":13,"context_source":"provider_usage","context_estimated":false}}',
    callbacks,
  );

  assert.equal(reasoningDelta, "");
  assert.deepEqual(reasoning, ["thinking"]);
  assert.deepEqual(statuses, ["Running tool"]);
  assert.equal(contentDelta, "LIVE_OK");
  assert.deepEqual(content, ["LIVE_OK"]);
  assert.equal(usageDelta, "");
  assert.deepEqual(usage, [{ promptTokens: 123, completionTokens: 45, totalTokens: 168 }]);
  assert.deepEqual(context, [{
    contextUsed: 12345,
    contextMax: 98304,
    contextPercent: 13,
    source: "provider_usage",
    estimated: false,
  }]);
});

test("reuses and captures the Hermes API session ID on streamed chat", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  let requestHeaders: Headers | undefined;
  const sessionIds: string[] = [];
  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response([
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), {
      headers: {
        "Content-Type": "text/event-stream",
        "X-Hermes-Session-Id": "server-session-id",
      },
    });
  };
  try {
    const client = new HermesClient({ baseUrl: "/hermes-gw", model: "hermes-agent" });
    const text = await client.chatStream(
      [{ role: "user", content: "Hello" }],
      { onDelta: () => undefined, onSessionId: (sessionId) => sessionIds.push(sessionId) },
      { sessionId: "previous-session-id", workbenchChatId: "workbench-chat-1" },
    );
    assert.equal(text, "answer");
    assert.equal(requestHeaders?.get("X-Hermes-Session-Id"), "previous-session-id");
    assert.equal(requestHeaders?.get("X-Workbench-Chat-Id"), "workbench-chat-1");
    assert.deepEqual(sessionIds, ["server-session-id"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});