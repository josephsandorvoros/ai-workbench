import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatConnection, connectionPreset } from "./providerConnections.ts";
import { getLoadedServerSettings, saveServerSettingsNow, setServerSecret } from "./serverSettings.ts";
import type { AgentProviderConfig } from "./providers.ts";

const configured: AgentProviderConfig = {
  kind: "opencode", baseUrl: "https://other.example/v1", model: "old-model", apiKey: "old-key", apiKeySet: true,
  cliPath: "old-cli", cliArgs: "-m old-model", workdir: "/old-workdir", terminalToken: "session-token",
  cliTimeoutSeconds: 900, shareHermesContext: true, agentMode: "auto", allowLocalBoard: true, allowWebFetch: true,
};

describe("chat connection presets", () => {
  it("resets every connection-specific field on an OpenAI to gateway round trip", () => {
    const openai = connectionPreset(configured, "openai");
    const gateway = connectionPreset({ ...openai, apiKey: "openai-key", apiKeySet: true }, "gateway");
    assert.deepEqual(gateway, {
      kind: "api", baseUrl: "/hermes-gw", model: "hermes-agent", apiKey: "", apiKeySet: false,
      cliPath: "", cliArgs: "", workdir: "", terminalToken: "session-token", cliTimeoutSeconds: 300,
      shareHermesContext: false, agentMode: "ask", allowLocalBoard: false, allowWebFetch: false,
    });
    assert.equal(chatConnection(gateway), "gateway");
    assert.equal(openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(openai.model, "gpt-4o-mini");
    assert.equal(openai.shareHermesContext, false);
  });

  it("chooses the correct CLI executable without retaining API state", () => {
    for (const connection of ["hermes-cli", "opencode-cli"] as const) {
      const preset = connectionPreset(configured, connection);
      assert.equal(preset.cliPath, connection === "hermes-cli" ? "hermes" : "opencode");
      assert.equal(preset.baseUrl, "");
      assert.equal(preset.model, "");
      assert.equal(preset.cliArgs, "");
      assert.equal(preset.apiKeySet, false);
      assert.equal(chatConnection(preset), connection);
    }
  });

  it("recognizes configured gateway and API endpoints after reload", () => {
    assert.equal(chatConnection({ ...configured, kind: "api", baseUrl: "/hermes-gw/" }), "gateway");
    assert.equal(chatConnection({ ...configured, kind: "api", baseUrl: "/llm" }), "local");
    assert.equal(chatConnection({ ...configured, kind: "api", baseUrl: "https://api.openai.com/v1/" }), "openai");
    assert.equal(chatConnection({ ...configured, kind: "api" }), "custom");
    assert.equal(connectionPreset(configured, "custom").baseUrl, "");
  });

  it("serializes rapid connection saves so the last choice reaches the server last", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const saved: string[] = [];
    globalThis.window = { clearTimeout: globalThis.clearTimeout } as unknown as typeof window;
    globalThis.fetch = async (_input, init) => {
      saved.push(JSON.parse(String(init?.body)).provider.baseUrl);
      if (saved.length === 1) { markFirstStarted(); await firstResponse; }
      return new Response(JSON.stringify({ ok: true, apiKeySet: false }));
    };
    try {
      const first = saveServerSettingsNow({ provider: connectionPreset(configured, "openai") });
      const second = saveServerSettingsNow({ provider: connectionPreset(configured, "gateway") });
      await firstStarted;
      assert.deepEqual(saved, ["https://api.openai.com/v1"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(saved, ["https://api.openai.com/v1", "/hermes-gw"]);
    } finally {
      releaseFirst();
      globalThis.fetch = originalFetch;
      globalThis.window = originalWindow;
    }
  });

  it("tags write-only key requests with their intended endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: object[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, set: true }));
    };
    try {
      assert.equal(await setServerSecret("provider", "test-key", "https://api.openai.com/v1"), true);
      assert.deepEqual(bodies, [{ name: "provider", value: "test-key", endpoint: "https://api.openai.com/v1" }]);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("does not retain a pending switch key in the public settings cache", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    globalThis.window = { clearTimeout: globalThis.clearTimeout } as unknown as typeof window;
    globalThis.fetch = async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).provider_key.value, "pending-key");
      return new Response(JSON.stringify({ ok: true, apiKeySet: false }));
    };
    try {
      await saveServerSettingsNow({ provider: connectionPreset(configured, "gateway"),
        provider_key: { endpoint: "https://api.openai.com/v1", value: "pending-key" },
      });
      assert.equal(JSON.stringify(getLoadedServerSettings()).includes("pending-key"), false);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window = originalWindow;
    }
  });
});