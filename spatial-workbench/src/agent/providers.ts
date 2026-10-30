import { executeShellCommand, getRuntimeConfig } from "../api/tauriCommands";

/**
 * Agent provider configuration for AI Workbench.
 *
 * Three harnesses are supported:
 *  - "api":     any OpenAI-compatible endpoint (the local Hermes model,
 *               Ollama, vLLM, llama.cpp, or a remote API).
 *  - "hermes":  the local Hermes agent CLI, run one-shot per turn.
 *  - "opencode": the local OpenCode CLI, run one-shot per turn.
 *
 * CLI harnesses execute through the Tauri desktop shell when available,
 * otherwise through the dashboard terminal API (which requires the
 * terminal token).
 */

export type ProviderKind = "api" | "hermes" | "opencode";
export type AgentMode = "plan" | "ask" | "auto";

export interface AgentProviderConfig {
  kind: ProviderKind;
  /** API harness: base URL of the OpenAI-compatible API (e.g. "/llm" or "http://host:port/v1"). */
  baseUrl: string;
  /** API harness: model name. */
  model: string;
  /** API harness: optional bearer token. */
  apiKey: string;
  /** CLI harnesses: executable path. */
  cliPath: string;
  /** CLI harnesses: working directory for the agent. */
  workdir: string;
  /** CLI harnesses: extra flags appended before the prompt (e.g. "-m provider/model"). */
  cliArgs: string;
  /** Dashboard terminal token (only needed for CLI harnesses in browser mode). */
  terminalToken: string;
  /** Max seconds to wait for a CLI harness turn. */
  cliTimeoutSeconds: number;
  /** Whether external API providers receive shared Hermes context. */
  shareHermesContext: boolean;
  /** Tool execution policy shared by agent harnesses. */
  agentMode: AgentMode;
  /** Allow API providers to call tools that mutate the local Spatial Board. */
  allowLocalBoard: boolean;
  /** Allow API providers to fetch public web pages (read-only web_fetch tool). */
  allowWebFetch: boolean;
  /** Server reports an API key is stored for this provider (the key never reaches the browser). */
  apiKeySet?: boolean;
}

export const DEFAULT_PROVIDER_CONFIG: AgentProviderConfig = {
  kind: "api",
  baseUrl: "/llm",
  model: "",
  apiKey: "",
  cliPath: "",
  workdir: "",
  cliArgs: "",
  terminalToken: "",
  cliTimeoutSeconds: 300,
  shareHermesContext: true,
  agentMode: "ask",
  allowLocalBoard: true,
  allowWebFetch: true,
};

const STORAGE_KEY = "homelabSpatialWorkbench.agentProvider.v1";
const PROFILES_STORAGE_KEY = "homelabSpatialWorkbench.agentProviderProfiles.v1";
const TERMINAL_TOKEN_SESSION_KEY = "homelabSpatialWorkbench.terminalToken";

export interface SavedProviderProfile {
  id: string;
  name: string;
  config: AgentProviderConfig;
}

/** Remove fields that must never be persisted in the browser or sent in settings. */
export function scrubProviderConfig(config: Partial<AgentProviderConfig>): Partial<AgentProviderConfig> {
  const { apiKey: _apiKey, terminalToken: _token, ...rest } = config;
  return rest;
}

/** Legacy browser-stored keys found at startup, to be moved to the server once. */
export const legacySecrets: { provider?: string; profiles: Record<string, string> } = { profiles: {} };

function readSessionToken(): string {
  try {
    return window.sessionStorage.getItem(TERMINAL_TOKEN_SESSION_KEY) ?? "";
  } catch (_error) {
    return "";
  }
}

export function loadProviderConfig(): AgentProviderConfig {
  let parsed: Partial<AgentProviderConfig> = {};
  try {
    parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AgentProviderConfig>;
  } catch (_error) {
    parsed = {};
  }
  if (parsed.apiKey) legacySecrets.provider = parsed.apiKey;
  const token = readSessionToken() || parsed.terminalToken || "";
  return { ...DEFAULT_PROVIDER_CONFIG, ...scrubProviderConfig(parsed), apiKey: "", terminalToken: token };
}

/** Cache non-secret settings locally (offline/Tauri fallback); the token lives for this browser session only. */
export function saveProviderConfig(config: AgentProviderConfig) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scrubProviderConfig(config)));
    if (config.terminalToken) window.sessionStorage.setItem(TERMINAL_TOKEN_SESSION_KEY, config.terminalToken);
    else window.sessionStorage.removeItem(TERMINAL_TOKEN_SESSION_KEY);
  } catch (_error) {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function readLegacyProfiles(): SavedProviderProfile[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROFILES_STORAGE_KEY) ?? "[]") as SavedProviderProfile[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((profile) => profile && typeof profile.name === "string" && profile.config)
      .map((profile) => {
        if (profile.config.apiKey) legacySecrets.profiles[profile.id] = profile.config.apiKey;
        return { ...profile, config: { ...DEFAULT_PROVIDER_CONFIG, ...scrubProviderConfig(profile.config), apiKey: "", terminalToken: "" } };
      });
  } catch (_error) {
    return [];
  }
}

let profilesCache: SavedProviderProfile[] = readLegacyProfiles();

export function clearLegacyProviderStorage() {
  try {
    window.localStorage.removeItem(PROFILES_STORAGE_KEY);
  } catch (_error) {
    // ignore
  }
}

/** Replace the in-memory profile list (after loading settings from the server). */
export function setProviderProfiles(profiles: SavedProviderProfile[]) {
  profilesCache = profiles.map((profile) => ({
    ...profile,
    config: { ...DEFAULT_PROVIDER_CONFIG, ...scrubProviderConfig(profile.config), apiKey: "", terminalToken: "" },
  }));
}

export function loadProviderProfiles(): SavedProviderProfile[] {
  return profilesCache;
}

function persistProfiles() {
  void import("./serverSettings").then(({ saveServerSettings }) =>
    saveServerSettings({
      profiles: profilesCache.map((profile) => ({ ...profile, config: scrubProviderConfig(profile.config) as AgentProviderConfig })),
    }),
  );
}

export function saveProviderProfile(name: string, config: AgentProviderConfig): SavedProviderProfile[] {
  const normalizedName = name.trim();
  if (!normalizedName) return profilesCache;
  const existing = profilesCache.find((profile) => profile.name.toLowerCase() === normalizedName.toLowerCase());
  const nextProfile: SavedProviderProfile = {
    id: existing?.id ?? `provider-${Date.now()}`,
    name: normalizedName,
    config: { ...config, apiKey: "", terminalToken: "" },
  };
  profilesCache = existing
    ? profilesCache.map((profile) => (profile.id === existing.id ? nextProfile : profile))
    : [...profilesCache, nextProfile];
  persistProfiles();
  void import("./serverSettings").then(({ copyServerSecret, setServerSecret }) =>
    config.apiKeySet ? copyServerSecret("provider", `profile:${nextProfile.id}`) : setServerSecret(`profile:${nextProfile.id}`, null),
  );
  return profilesCache;
}

export function deleteProviderProfile(id: string): SavedProviderProfile[] {
  profilesCache = profilesCache.filter((profile) => profile.id !== id);
  persistProfiles();
  return profilesCache;
}

/**
 * Where the browser should send API requests. Absolute endpoints with a
 * server-held key go through the companion API proxy, which adds the key.
 */
export function endpointFor(config: AgentProviderConfig): { baseUrl: string; apiKey?: string } {
  if (/^https?:\/\//i.test(config.baseUrl) && config.apiKeySet) {
    return { baseUrl: "/api/proxy/provider" };
  }
  return { baseUrl: config.baseUrl, apiKey: config.apiKey || undefined };
}

export function providerLabel(config: AgentProviderConfig): string {
  switch (config.kind) {
    case "api":
      return `API · ${config.model || "no model"} @ ${config.baseUrl || "no endpoint"}`;
    case "hermes":
      return `Hermes CLI · ${config.cliPath || "hermes"}`;
    case "opencode":
      return `OpenCode CLI · ${config.cliPath || "opencode"}`;
  }
}

export interface CliTurnResult {
  ok: boolean;
  output: string;
  error?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCliCommand(config: AgentProviderConfig, prompt: string): string {
  // Hermes one-shot is a TOP-LEVEL flag: `hermes -z PROMPT` (prints only the
  // final response text). The `chat` subcommand does NOT accept `-z`, so we
  // must not prefix it with `chat`. OpenCode uses `run`.
  const base =
    config.kind === "hermes"
      ? `${config.cliPath || "hermes"} -z`
      : `${config.cliPath || "opencode"} run`;
  const extra = config.cliArgs.trim();
  return `${base} ${extra ? `${extra} ` : ""}${shellQuote(prompt)}`.trim();
}

async function runViaTauri(config: AgentProviderConfig, prompt: string): Promise<CliTurnResult | null> {
  try {
    const result = await executeShellCommand({
      command: buildCliCommand(config, prompt),
      cwd: config.workdir || undefined,
    });
    if (!result) return null;
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      ok: result.ok,
      output: output.trim() || "(no output)",
      error: result.ok ? undefined : `exit code ${result.exit_code ?? "unknown"}`,
    };
  } catch (_error) {
    return null;
  }
}

async function runViaDashboardTerminal(config: AgentProviderConfig, prompt: string): Promise<CliTurnResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.terminalToken) {
    headers["X-Terminal-Token"] = config.terminalToken;
  }

  const start = await fetch("/api/terminal/start", {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "cli", cols: 200, rows: 50 }),
  });
  if (!start.ok) {
    const body = await start.json().catch(() => ({}));
    return {
      ok: false,
      output: "",
      error: `terminal start failed (${start.status}): ${body.message ?? "check the terminal token"}`,
    };
  }
  const { session_id: sessionId } = (await start.json()) as { session_id: string };

  try {
    const input = await fetch("/api/terminal/input", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        data: `${buildCliCommand(config, prompt)}\n`,
      }),
    });
    if (!input.ok) {
      return { ok: false, output: "", error: `terminal input failed (${input.status})` };
    }

    const deadline = Date.now() + config.cliTimeoutSeconds * 1000;
    let offset = 0;
    let output = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const res = await fetch(
        `/api/terminal/output?session_id=${encodeURIComponent(sessionId)}&offset=${offset}`,
        { headers },
      );
      if (!res.ok) break;
      const payload = (await res.json()) as {
        data?: string;
        next_offset?: number;
        running?: boolean;
        exit_code?: number | null;
      };
      if (payload.data) output += payload.data;
      if (typeof payload.next_offset === "number") offset = payload.next_offset;
      if (payload.running === false) break;
    }

    return {
      ok: true,
      output: output.trim() || "(no output captured)",
    };
  } finally {
    await fetch("/api/terminal/close", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => undefined);
  }
}

/**
 * Run one agent turn through a CLI harness (Hermes or OpenCode).
 * Prefers the Tauri desktop shell; falls back to the dashboard terminal API.
 */
export async function runCliTurn(config: AgentProviderConfig, prompt: string): Promise<CliTurnResult> {
  const viaTauri = await runViaTauri(config, prompt);
  if (viaTauri) return viaTauri;
  return runViaDashboardTerminal(config, prompt);
}

/**
 * Resolve the CLI path for a harness, preferring the Tauri runtime config
 * (which knows the installed Hermes location) over the user-entered value.
 */
export async function resolveCliPath(config: AgentProviderConfig): Promise<string> {
  if (config.cliPath.trim()) return config.cliPath.trim();
  if (config.kind === "hermes") {
    try {
      const runtime = await getRuntimeConfig();
      if (runtime?.hermes_cli_path) return runtime.hermes_cli_path;
    } catch (_error) {
      // Not in Tauri mode; fall through to the bare command name.
    }
  }
  return config.kind === "hermes" ? "hermes" : "opencode";
}
