import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchModels } from "./agentData.ts";

/**
 * fetchModels must understand both /models wire formats:
 *  - llama.cpp / Ollama:  { "models": [ { "id" | "name" } ] }
 *  - OpenAI / Hermes gateway: { "data": [ { "id" } ] }
 * The gateway bug: it returns `data`, so the old parser (models-only)
 * produced an empty list and the slash menu showed no /model: items.
 */

function mockFetch(body: unknown, ok = true, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response);
  return () => {
    globalThis.fetch = original;
  };
}

test("fetchModels parses llama.cpp / Ollama `models` format", async () => {
  const restore = mockFetch({
    models: [
      { id: "Qwen3.8-27B", name: "Qwen3.8-27B" },
      { id: "llama-3", name: "llama-3" },
    ],
  });
  try {
    const names = await fetchModels("/llm");
    assert.deepEqual(names, ["Qwen3.8-27B", "llama-3"]);
  } finally {
    restore();
  }
});

test("fetchModels parses OpenAI / gateway `data` format", async () => {
  const restore = mockFetch({
    object: "list",
    data: [{ id: "hermes-agent", object: "model", owned_by: "hermes" }],
  });
  try {
    const names = await fetchModels("/hermes-gw", "some-key");
    assert.deepEqual(names, ["hermes-agent"]);
  } finally {
    restore();
  }
});

test("fetchModels prefers `name` over `id` and dedupes", async () => {
  const restore = mockFetch({
    models: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Alpha" },
      { id: "c" },
    ],
  });
  try {
    const names = await fetchModels("/llm");
    assert.deepEqual(names, ["Alpha", "c"]);
  } finally {
    restore();
  }
});

test("fetchModels returns [] when neither key is present", async () => {
  const restore = mockFetch({ object: "list" });
  try {
    const names = await fetchModels("/llm");
    assert.deepEqual(names, []);
  } finally {
    restore();
  }
});

test("fetchModels throws on non-2xx", async () => {
  const restore = mockFetch({ error: "nope" }, false, 401);
  try {
    await assert.rejects(() => fetchModels("/hermes-gw"), /401/);
  } finally {
    restore();
  }
});
