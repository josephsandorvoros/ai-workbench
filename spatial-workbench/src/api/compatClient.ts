export type CapabilityState =
  | "available"
  | "degraded"
  | "unconfigured"
  | "unavailable"
  | "blocked"
  | "error";

export interface AppConfig {
  ai_node_ssh_target?: string;
  ai_node_stats_url?: string;
  terminal_auth_required: boolean;
  wiki_root?: string;
  workspace_root?: string;
  hermes_home?: string;
  stats_source?: string;
  stats_label?: string;
}

export interface ComponentUpdate {
  current: string | null;
  latest: string | null;
  update_available: boolean;
  action: "repull" | "in-place" | "managed";
  tag?: string;
  error?: string;
}

export interface SandboxStatus {
  ok: boolean;
  enabled: boolean;
  reachable?: boolean;
  containers?: number;
  running?: number;
  images?: number;
  server_version?: string;
  error?: string;
}

export interface UpdatesStatus {
  ok: boolean;
  enabled: boolean;
  checked_at?: number;
  workbench?: ComponentUpdate | null;
  hermes?: ComponentUpdate;
  opencode?: ComponentUpdate;
}

export interface NodeStats {
  status: "ok" | "error" | "warming";
  timestamp?: number;
  source?: string;
  message?: string;
  cpu?: {
    usage_percent?: number;
    core_count?: number;
  };
  memory?: {
    percentage?: number;
    used_gb?: number;
    total_gb?: number;
    available_gb?: number;
  };
  disk?: {
    percentage?: number;
    used_gb?: number;
    total_gb?: number;
    free_gb?: number;
  };
  gpu?: {
    utilization_gpu?: number;
    memory_used_gb?: number;
    memory_total_gb?: number;
    /** Percent-only VRAM usage (e.g. from Glances). */
    memory_percent?: number;
    temperature_gpu?: number;
  } | null;
  temperatures?: Record<string, number>;
  process_count?: number;
}

export interface StatsSourceOption {
  value: "host" | "configured";
  label: string;
}

export interface StatsSourceResponse {
  ok: boolean;
  selected: "host" | "configured";
  source_label: string;
  options: StatsSourceOption[];
}

export interface WikiEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ts?: number;
  size_bytes?: number;
}

export interface WikiListResponse {
  ok: boolean;
  root: string;
  path: string;
  items: WikiEntry[];
}

export interface WikiDocumentResponse {
  ok: boolean;
  path: string;
  content: string;
  modified_ts: number;
  size_bytes: number;
}

export interface WikiSearchResult {
  path: string;
  snippet: string;
}

export interface WikiSearchResponse {
  ok: boolean;
  query: string;
  items: WikiSearchResult[];
}

export interface WikiWriteResponse {
  ok: boolean;
  path: string;
  modified_ts: number;
  size_bytes: number;
}

export interface WikiLinkResolveResponse {
  ok: boolean;
  path?: string;
  message?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ts?: number;
  size_bytes?: number;
}

export interface WorkspaceGitPreview {
  path: string;
  branch: string;
  files: string[];
  sensitive_files: string[];
  ignored_file_count: number;
  file_count: number;
  size_bytes: number;
  inventory_hash: string;
}

export type GitProvider = "github" | "gitlab" | "forgejo";

export interface GitHostConnection {
  host: string;
  provider: GitProvider;
  username: string;
  token_set: boolean;
}

export interface WorkspaceGitClone {
  path: string;
  branch: string;
  remote: string;
  host: string;
}

export interface WorkspaceListResponse {
  ok: boolean;
  root: string;
  path: string;
  items: WorkspaceEntry[];
}

export interface WorkspaceDocumentResponse {
  ok: boolean;
  path: string;
  content: string;
  modified_ts: number;
  size_bytes: number;
}

export interface WorkspaceFileStatusResponse {
  ok: boolean;
  path: string;
  modified_ts: number;
  size_bytes: number;
}

export interface AppPreviewSession {
  session_id: string;
  path: string;
  command: string;
  port: number;
  running: boolean;
  ready: boolean;
  exit_code: number | null;
  started_at: number;
  view_url: string;
}

export interface AppPreviewLogs {
  session_id: string;
  data: string;
  next_offset: number;
  base_offset: number;
  running: boolean;
}

export interface WorkspaceWriteResponse {
  ok: boolean;
  path: string;
  modified_ts: number;
  size_bytes: number;
}

export interface WorkbenchArtifactRef {
  name: string;
  updatedAt: number;
}

export interface WorkbenchStateResponse {
  ok: boolean;
  artifact: unknown;
  artifacts: WorkbenchArtifactRef[];
  chat_sessions: unknown[];
}

export interface BoardState {
  elements: Record<string, unknown>[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface BoardStateResponse {
  ok: boolean;
  board: BoardState | null;
  revision?: number;
  message?: string;
}

const apiBaseUrl = import.meta.env.VITE_DIRECT_API_BASE_URL || "";

export interface FreeModel {
  id: string;
  name: string;
  provider: string;
  url: string;
  context: number | null;
  output: number | null;
  input_modalities: string[];
  output_modalities: string[];
  tools: boolean | null;
  reasoning: boolean | null;
  rate_limit: string;
  expires: string;
  rank: number | null;
  health: "ok" | "sick" | "dead" | null;
  answering_now: boolean;
}

export interface FreeModelSection {
  models: FreeModel[];
  snapshot_at: string;
  fetched_at: string;
  stale: boolean;
  error: string;
}

export interface FreeModelsResponse {
  ok: boolean;
  sections: Record<"zen" | "api", FreeModelSection>;
  refresh_seconds: number;
}

export function fetchFreeModels(force = false): Promise<FreeModelsResponse> {
  return getJson(`/api/free-models${force ? "?refresh=1" : ""}`);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`POST ${path} returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(`POST ${path} returned an empty or invalid response (HTTP ${response.status})`);
  }
  const result = payload as Record<string, unknown>;
  if (!response.ok || result.ok === false) {
    throw new Error(typeof result.message === "string" ? result.message : `POST ${path} failed with ${response.status}`);
  }
  return payload as T;
}

async function previewRequest<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Terminal-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `${path} failed with ${response.status}`);
  }
  return payload as T;
}

function withQuery(path: string, query: Record<string, string | number>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    params.set(key, String(value));
  });
  return `${path}?${params.toString()}`;
}

export const compatClient = {
  apiBaseUrl: apiBaseUrl || "same-origin /api",
  getConfig: () => getJson<AppConfig>("/api/config"),
  getSandboxStatus: () => getJson<SandboxStatus>("/api/sandbox/status"),
  getUpdates: (refresh = false) => getJson<UpdatesStatus>(refresh ? "/api/updates?refresh=1" : "/api/updates"),
  getStats: () => getJson<NodeStats>("/api/stats"),
  getStatsSource: () => getJson<StatsSourceResponse>("/api/stats/source"),
  setStatsSource: (source: StatsSourceResponse["selected"]) => postJson<StatsSourceResponse>("/api/stats/source", { source }),
  listWiki: (path = "") => getJson<WikiListResponse>(withQuery("/api/wiki/list", { path })),
  readWikiFile: (path: string) => getJson<WikiDocumentResponse>(withQuery("/api/wiki/read", { path })),
  wikiDownloadUrl: (path: string) => `${apiBaseUrl}${withQuery("/api/wiki/download", { path })}`,
  searchWiki: (query: string, limit = 10) => getJson<WikiSearchResponse>(withQuery("/api/wiki/search", { q: query, limit })),
  writeWikiFile: (path: string, content: string) => postJson<WikiWriteResponse>("/api/wiki/write", { path, content }),
  uploadWikiFile: (path: string, contentBase64: string) =>
    postJson<WikiWriteResponse>("/api/wiki/upload", { path, content_base64: contentBase64 }),
  resolveWikiLink: async (target: string, fromPath = ""): Promise<WikiLinkResolveResponse> => {
    try {
      return await getJson<WikiLinkResolveResponse>(
        withQuery("/api/wiki/resolve-link", { target, from: fromPath }),
      );
    } catch (error) {
      // Unresolvable links are not fatal — the viewer renders them as plain text.
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  listWorkspace: (path = "") => getJson<WorkspaceListResponse>(withQuery("/api/workspace/list", { path })),
  readWorkspaceFile: (path: string) => getJson<WorkspaceDocumentResponse>(withQuery("/api/workspace/read", { path })),
  getWorkspaceFileStatus: (path: string) => getJson<WorkspaceFileStatusResponse>(withQuery("/api/workspace/status", { path })),
  writeWorkspaceFile: (
    path: string,
    content: string,
    expectedModifiedTs: number,
    expectedSizeBytes: number,
    force = false,
  ) =>
    postJson<WorkspaceWriteResponse>("/api/workspace/write", {
      path,
      content,
      expected_modified_ts: expectedModifiedTs,
      expected_size_bytes: expectedSizeBytes,
      force,
    }),
  createWorkspaceFile: (path: string, content: string) =>
    postJson<WorkspaceWriteResponse>("/api/workspace/create", { path, content }),
  createWorkspaceDirectory: (path: string) =>
    postJson<{ ok: boolean; path: string }>("/api/workspace/mkdir", { path }),
  previewWorkspaceGit: (path: string, branch = "main") =>
    postJson<{ ok: boolean; preview: WorkspaceGitPreview }>("/api/workspace/git/preview", { path, branch }),
  initializeWorkspaceGit: (path: string, branch: string, inventoryHash: string, confirmExisting: boolean) =>
    postJson<{ ok: boolean; path: string; branch: string; commit: string }>("/api/workspace/git/initialize", {
      path, branch, inventory_hash: inventoryHash, confirm_existing: confirmExisting,
    }),
  getGitHosts: () => getJson<{ ok: boolean; hosts: GitHostConnection[] }>("/api/git/hosts"),
  saveGitHost: (host: string, provider: GitProvider, username: string, token: string) =>
    postJson<{ ok: boolean; hosts: GitHostConnection[] }>("/api/git/hosts", { host, provider, username, token }),
  clearGitHostToken: (host: string, provider: GitProvider, username: string) =>
    postJson<{ ok: boolean; hosts: GitHostConnection[] }>("/api/git/hosts", { host, provider, username, clear_token: true }),
  deleteGitHost: (host: string) => postJson<{ ok: boolean; deleted: string }>("/api/git/hosts/delete", { host }),
  cloneWorkspaceGit: (url: string, destination: string) =>
    postJson<{ ok: boolean } & WorkspaceGitClone>("/api/workspace/git/clone", { url, destination }),
  uploadFile: (filename: string, contentBase64: string) =>
    postJson<{ ok: boolean; path: string; name: string; size: number }>("/api/workspace/upload", {
      filename,
      content_base64: contentBase64,
    }),
  importWorkspaceFile: (filename: string, contentBase64: string, directory = "") =>
    postJson<{ ok: boolean; path: string; name: string; size: number }>("/api/workspace/upload", {
      filename,
      content_base64: contentBase64,
      directory,
    }),
  deleteWorkspaceFile: (path: string, recursive = false) =>
    postJson<{ ok: boolean; path: string; deleted: boolean; is_dir: boolean; backup_path: string }>("/api/workspace/delete", { path, recursive }),
  startAppPreview: (path: string, command: string, port: number, token: string) =>
    previewRequest<{ ok: boolean } & AppPreviewSession>("/api/app-preview/start", token, { path, command, port }),
  getAppPreviewStatus: (sessionId: string, token: string) =>
    previewRequest<{ ok: boolean } & AppPreviewSession>(withQuery("/api/app-preview/status", { session_id: sessionId }), token),
  getAppPreviewLogs: (sessionId: string, offset: number, token: string) =>
    previewRequest<{ ok: boolean } & AppPreviewLogs>(withQuery("/api/app-preview/logs", { session_id: sessionId, offset }), token),
  stopAppPreview: (sessionId: string, token: string) =>
    previewRequest<{ ok: boolean }>("/api/app-preview/stop", token, { session_id: sessionId }),
  /**
   * Direct download URL for a workspace file or folder. Folders are zipped
   * server-side. Open it in a new tab (or assign to an anchor's href) to
   * trigger the browser download.
   */
  workspaceDownloadUrl: (path: string) =>
    `${apiBaseUrl}${withQuery("/api/workspace/download", { path })}`,
  getWorkbenchState: () => getJson<WorkbenchStateResponse>("/api/workbench/state"),
  getWorkbenchArtifact: (name: string) =>
    getJson<{ ok: boolean; artifact: { name: string; html: string; updatedAt: number } | null; message?: string }>(
      withQuery("/api/workbench/artifact", { name }),
    ),
  saveWorkbenchState: (state: { artifact: unknown; chat_sessions: unknown[] }) =>
    postJson<{ ok: boolean }>("/api/workbench/state", state),
  deleteWorkbenchChatSession: (id: string) =>
    postJson<{ ok: boolean; deleted: number; agent_session_deleted: boolean; warning?: string }>(
      "/api/workbench/chat-session/delete", { id },
    ),
  getBoard: () => getJson<BoardStateResponse>("/api/board"),
  saveBoard: (board: BoardState, baseRevision?: number, merge = false) =>
    postJson<{ ok: boolean; revision?: number }>("/api/board", {
      board,
      ...(baseRevision != null ? { base_revision: baseRevision } : {}),
      ...(merge ? { merge: true } : {}),
    }),
  commandBoard: (
    command:
      | "add_node"
      | "add_arrow"
      | "clear"
      | "set_layout"
      | "update_element"
      | "delete_element"
      | "read_full",
    payload?: Record<string, unknown>,
  ) => postJson<BoardStateResponse>("/api/board/command", {
    command,
    ...(command === "add_node" ? { node: payload } : {}),
    ...(command === "add_arrow" ? { arrow: payload } : {}),
    ...(command === "set_layout" ? { elements: payload?.elements } : {}),
    ...(command === "update_element" ? { element: payload?.element } : {}),
    ...(command === "delete_element" ? { id: payload?.id } : {}),
  }),
};