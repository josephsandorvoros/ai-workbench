/**
 * Client for the dashboard's agent-data endpoints.
 *
 * These endpoints read local agent state (Hermes + OpenCode) from the
 * dashboard host: running status, skills, memory files, and recent
 * sessions/messages. All data is read-only and served by
 * dashboard_server.py under /api/agent/*.
 */

export interface AgentStatus {
  ok: boolean;
  hermes: {
    running: boolean;
    pid: number | null;
    version: string | null;
    gateway: string | null;
    platforms: Record<string, string>;
  };
  opencode: {
    running: boolean;
    pid: number | null;
    db_exists: boolean;
  };
}

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  source: "hermes" | "hermes-bundled" | "opencode";
}

export interface AgentMemoryFile {
  name: string;
  path: string;
  size: number;
  modified: number;
  content: string;
  truncated: boolean;
}

export interface AgentSession {
  source: "hermes" | "opencode";
  id: string;
  workbench_chat_id?: string;
  title: string;
  model: string | null;
  message_count: number | null;
  started_at: number | null;
  last_activity_at: number | null;
  cwd: string | null;
  archived: boolean;
}

export interface AgentSessionMessage {
  role: string;
  content: string;
  timestamp: number | null;
}

/** One tool from the Hermes agent registry (built-in or MCP server). */
export interface AgentTool {
  name: string;
  description: string;
  toolset: string;
  parameters: Record<string, unknown>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Agent data request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function fetchAgentStatus(): Promise<AgentStatus> {
  return getJson<AgentStatus>("/api/agent/status");
}

export function fetchAgentSkills(): Promise<{ ok: boolean; count: number; skills: AgentSkill[] }> {
  return getJson<{ ok: boolean; count: number; skills: AgentSkill[] }>("/api/agent/skills");
}

export function fetchAgentMemory(): Promise<{ ok: boolean; count: number; files: AgentMemoryFile[] }> {
  return getJson<{ ok: boolean; count: number; files: AgentMemoryFile[] }>("/api/agent/memory");
}

export function fetchAgentTools(): Promise<{
  ok: boolean;
  builtin_count: number;
  mcp_count: number;
  builtin: AgentTool[];
  mcp: AgentTool[];
}> {
  return getJson<{ ok: boolean; builtin_count: number; mcp_count: number; builtin: AgentTool[]; mcp: AgentTool[] }>(
    "/api/agent/tools",
  );
}

export function fetchAgentSessions(limit = 25): Promise<{ ok: boolean; count: number; sessions: AgentSession[] }> {
  return getJson<{ ok: boolean; count: number; sessions: AgentSession[] }>(
    `/api/agent/sessions?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function fetchAgentSessionMessages(
  source: string,
  sessionId: string,
  limit = 40,
): Promise<{ ok: boolean; count: number; messages: AgentSessionMessage[]; message?: string }> {
  return getJson<{ ok: boolean; count: number; messages: AgentSessionMessage[]; message?: string }>(
    `/api/agent/session/messages?source=${encodeURIComponent(source)}&session_id=${encodeURIComponent(sessionId)}&limit=${encodeURIComponent(String(limit))}`,
  );
}

/**
 * Fetch model names from an OpenAI-compatible endpoint (GET /models).
 * Metadata-only call — safe to run against local models.
 */
export async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  if (!base) return [];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const response = await fetch(`${base}/models`, { headers });
  if (!response.ok) {
    throw new Error(`Model list request failed (${response.status})`);
  }
  // Two wire formats are in play:
  //  - llama.cpp / Ollama:  { "models": [ { "id" | "name", ... } ] }
  //  - OpenAI / Hermes gateway: { "data": [ { "id", ... } ] }
  const raw = (await response.json()) as {
    models?: Array<{ id?: string; name?: string }>;
    data?: Array<{ id?: string; name?: string }>;
  };
  const entries = raw.models ?? raw.data ?? [];
  const names = entries
    .map((model) => model.name ?? model.id ?? "")
    .filter((name): name is string => Boolean(name));
  return Array.from(new Set(names));
}

export interface ModelContextInfo {
  ok: boolean;
  context_length: number;
  source: string;
  model?: string;
}

/**
 * Fetch the model's context window (in tokens) from the dashboard backend.
 *
 * The backend probes the local llama.cpp server's `/props` endpoint for the
 * authoritative `n_ctx` value and falls back to a conservative default when
 * the probe fails. Used to size the context meter and trigger auto-compression.
 */
export function fetchModelContext(): Promise<ModelContextInfo> {
  return getJson<ModelContextInfo>("/api/model/context");
}
