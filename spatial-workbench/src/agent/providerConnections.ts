import type { AgentProviderConfig } from "./providers.ts";

export type ChatConnection = "gateway" | "openai" | "local" | "custom" | "hermes-cli" | "opencode-cli";

export function chatConnection(config: AgentProviderConfig): ChatConnection {
  if (config.kind === "hermes") return "hermes-cli";
  if (config.kind === "opencode") return "opencode-cli";
  const base = config.baseUrl.replace(/\/+$/, "");
  if (base === "/hermes-gw") return "gateway";
  if (base === "https://api.openai.com/v1") return "openai";
  if (base === "/llm") return "local";
  return "custom";
}

export function connectionPreset(current: AgentProviderConfig, connection: ChatConnection): AgentProviderConfig {
  const cli = connection === "hermes-cli" || connection === "opencode-cli";
  return {
    kind: connection === "hermes-cli" ? "hermes" : connection === "opencode-cli" ? "opencode" : "api",
    baseUrl: connection === "gateway" ? "/hermes-gw" : connection === "openai" ? "https://api.openai.com/v1" : connection === "local" ? "/llm" : "",
    model: connection === "gateway" ? "hermes-agent" : connection === "openai" ? "gpt-4o-mini" : "",
    apiKey: "",
    apiKeySet: false,
    cliPath: connection === "hermes-cli" ? "hermes" : connection === "opencode-cli" ? "opencode" : "",
    workdir: "",
    cliArgs: "",
    terminalToken: current.terminalToken,
    cliTimeoutSeconds: 300,
    shareHermesContext: false,
    agentMode: "ask",
    allowLocalBoard: !cli && connection !== "gateway",
    allowWebFetch: !cli && connection !== "gateway",
  };
}