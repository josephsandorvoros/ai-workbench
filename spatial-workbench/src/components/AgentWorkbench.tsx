import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteProviderProfile,
  endpointFor,
  loadProviderProfiles,
  providerLabel,
  saveProviderProfile,
  type AgentProviderConfig,
  type SavedProviderProfile,
} from "../agent/providers";
import {
  PROVIDER_SETTINGS_READY_EVENT,
  applyProviderProfile,
  clearProviderApiKey,
  getAgentProvider,
  switchAgentProvider,
  useAgentProvider,
  updateAgentProvider,
} from "../agent/agentStore";
import {
  fetchAgentMemory,
  fetchAgentSkills,
  fetchAgentStatus,
  fetchAgentTools,
  fetchModels,
  type AgentMemoryFile,
  type AgentSkill,
  type AgentStatus,
  type AgentTool,
} from "../agent/agentData";
import { compatClient } from "../api/compatClient";
import { OpenCodeSettings } from "./OpenCodeSettings";
import { HermesSettings } from "./HermesSettings";
import { SpeechServiceSettingsPanel } from "./SpeechServiceSettingsPanel";
import { chatConnection, connectionPreset, type ChatConnection } from "../agent/providerConnections";
import { LOCAL_VISUAL_TOOLS } from "../agent/boardTools";
import { isMutatingTool } from "../agent/toolCallSummary";
import type { HermesToolSchema } from "../agent/hermesClient";
import { Markdown } from "./Markdown";

export interface AgentWorkbenchProps {
  status?: string;
}

type ContextTab = "skills" | "memory" | "tools" | "browser-tools";

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function AgentWorkbench({ status = "available" }: AgentWorkbenchProps) {
  // Provider settings (shared live with the Agent chat panel).
  const providerConfig = useAgentProvider();
  const connection = chatConnection(providerConfig);
  const gatewaySelected = connection === "gateway";
  const [showSettings, setShowSettings] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [providerProfiles, setProviderProfiles] = useState<SavedProviderProfile[]>(() => loadProviderProfiles());
  const [providerProfileName, setProviderProfileName] = useState("");
  const [gatewayConfigured, setGatewayConfigured] = useState<boolean | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const modelsRequest = useRef(0);
  const connectionRequest = useRef(0);

  // Agent context data (skills / memory).
  const [contextTab, setContextTab] = useState<ContextTab>("skills");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [memoryFiles, setMemoryFiles] = useState<AgentMemoryFile[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  // File editor (skills + memory).
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingOriginal, setEditingOriginal] = useState<{ modifiedTs: number; sizeBytes: number } | null>(null);
  const [editingDirty, setEditingDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [fileViewMode, setFileViewMode] = useState<"view" | "edit">("view");

  // Browser tool inspector (read-only view of the tools handed to the model).
  const [selectedBrowserTool, setSelectedBrowserTool] = useState<HermesToolSchema | null>(null);

  // Hermes agent tools (read-only registry view).
  const [hermesTools, setHermesTools] = useState<{ builtin: AgentTool[]; mcp: AgentTool[] }>({ builtin: [], mcp: [] });
  const [hermesToolsLoading, setHermesToolsLoading] = useState(false);
  const [hermesToolsError, setHermesToolsError] = useState<string | null>(null);
  const [selectedHermesTool, setSelectedHermesTool] = useState<AgentTool | null>(null);
  const [hermesToolFilter, setHermesToolFilter] = useState("");

  const patchProvider = useCallback((patch: Partial<AgentProviderConfig>) => {
    updateAgentProvider(patch);
  }, []);

  // Server settings arrive after first render: pick up synced profiles.
  useEffect(() => {
    const onReady = () => {
      setProviderProfiles(loadProviderProfiles());
    };
    window.addEventListener(PROVIDER_SETTINGS_READY_EVENT, onReady);
    return () => window.removeEventListener(PROVIDER_SETTINGS_READY_EVENT, onReady);
  }, []);

  const refreshContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);
    try {
      const [status, skillData, memoryData] = await Promise.allSettled([
        fetchAgentStatus(),
        fetchAgentSkills(),
        fetchAgentMemory(),
      ]);
      if (status.status === "fulfilled") setAgentStatus(status.value);
      if (skillData.status === "fulfilled") setSkills(skillData.value.skills);
      if (memoryData.status === "fulfilled") setMemoryFiles(memoryData.value.files);
      if (
        status.status === "rejected" &&
        skillData.status === "rejected" &&
        memoryData.status === "rejected"
      ) {
        setContextError("Agent data endpoints are unreachable (is the dashboard API running?).");
      }
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);


  const loadHermesTools = useCallback(async () => {
    setHermesToolsLoading(true);
    setHermesToolsError(null);
    try {
      const data = await fetchAgentTools();
      setHermesTools({ builtin: data.builtin, mcp: data.mcp });
    } catch (error) {
      setHermesToolsError(error instanceof Error ? error.message : "Failed to load Hermes tools.");
    } finally {
      setHermesToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHermesTools();
  }, [loadHermesTools]);

  const handleFetchModels = useCallback(async () => {
    const request = ++modelsRequest.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const endpoint = endpointFor(providerConfig);
      const names = await fetchModels(endpoint.baseUrl, endpoint.apiKey);
      if (request !== modelsRequest.current) return;
      setModelOptions(names);
      if (names.length === 0) setModelsError("Endpoint returned no models.");
    } catch (error) {
      if (request === modelsRequest.current) setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === modelsRequest.current) setModelsLoading(false);
    }
  }, [providerConfig]);

  useEffect(() => {
    if (!gatewaySelected) { setGatewayConfigured(null); return; }
    let live = true;
    setGatewayConfigured(null);
    void fetch("/api/gateway-api").then(async (response) => {
      const data = await response.json() as { ok?: boolean; configured?: boolean; chat_configured?: boolean };
      if (live) {
        const chatReady = Boolean(response.ok && data.ok && data.chat_configured);
        setGatewayConfigured(chatReady);
        if (!chatReady) setModelsError("Hermes Gateway chat is not configured on this server (HERMES_DASHBOARD_SESSION_TOKEN for hermes serve is missing).");
        else if (!data.configured) setModelsError("Chat is ready. Model discovery and Jobs also need the Hermes API server key (API_SERVER_KEY), which is not configured.");
      }
    }).catch(() => {
      if (live) { setGatewayConfigured(false); setModelsError("Hermes Gateway is selected, but its configuration could not be checked."); }
    });
    return () => { live = false; };
  }, [gatewaySelected]);

  const handleConnectionChange = useCallback(async (selected: ChatConnection) => {
    const request = ++connectionRequest.current;
    modelsRequest.current += 1;
    setModelsLoading(false); setModelsError(null); setConnectionBusy(true); setShowSettings(true);
    setModelOptions(selected === "gateway" ? ["hermes-agent"] : selected === "openai" ? ["gpt-4o-mini", "gpt-4o"] : []);
    try {
      await switchAgentProvider(connectionPreset(getAgentProvider(), selected));
    } catch (error) {
      if (request === connectionRequest.current) setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === connectionRequest.current) setConnectionBusy(false);
    }
  }, []);

  const handleSaveProvider = useCallback(() => {
    const name = providerProfileName.trim();
    if (!name) return;
    setProviderProfiles(saveProviderProfile(name, providerConfig));
    setProviderProfileName("");
  }, [providerConfig, providerProfileName]);

  const handleLoadProvider = useCallback((profile: SavedProviderProfile) => {
    modelsRequest.current += 1;
    connectionRequest.current += 1;
    setModelsLoading(false); setConnectionBusy(false);
    applyProviderProfile(profile);
    setModelOptions([profile.config.model]);
    setModelsError(null);
  }, []);

  const handleDeleteProvider = useCallback((profile: SavedProviderProfile) => {
    if (!window.confirm(`Delete provider profile "${profile.name}"?`)) return;
    setProviderProfiles(deleteProviderProfile(profile.id));
  }, []);

  // ---- File editor (skills + memory) -------------------------------------

  const openEditor = useCallback(async (path: string) => {
    setEditorBusy(true);
    setEditorMessage(`Loading ${path}…`);
    try {
      const result = await compatClient.readWorkspaceFile(path);
      setEditingPath(result.path);
      setEditingContent(result.content || "");
      setEditingOriginal({ modifiedTs: result.modified_ts, sizeBytes: result.size_bytes });
      setEditingDirty(false);
      setFileViewMode("view");
      setSelectedHermesTool(null);
      setEditorMessage(`Editing ${result.path}`);
    } catch (error) {
      setEditingPath(null);
      setEditorMessage(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setEditorBusy(false);
    }
  }, []);

  const closeEditor = useCallback(() => {
    setEditingPath(null);
    setEditingContent("");
    setEditingOriginal(null);
    setEditingDirty(false);
    setFileViewMode("view");
    setSelectedHermesTool(null);
    setEditorMessage(null);
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editingPath || !editingOriginal) return;
    setEditorBusy(true);
    setEditorMessage(`Saving ${editingPath}…`);
    try {
      const latest = await compatClient.getWorkspaceFileStatus(editingPath);
      const changed =
        latest.modified_ts !== editingOriginal.modifiedTs || latest.size_bytes !== editingOriginal.sizeBytes;
      const force = changed
        ? window.confirm("This file changed on disk after you opened it. Overwrite it with the editor contents?")
        : false;
      if (changed && !force) {
        setEditorMessage("Save cancelled because the file changed on disk.");
        setEditorBusy(false);
        return;
      }
      const result = await compatClient.writeWorkspaceFile(
        editingPath,
        editingContent,
        editingOriginal.modifiedTs,
        editingOriginal.sizeBytes,
        force,
      );
      setEditingOriginal({ modifiedTs: result.modified_ts, sizeBytes: result.size_bytes });
      setEditingDirty(false);
      setEditorMessage(`Saved ${result.path}`);
      void refreshContext();
    } catch (error) {
      setEditorMessage(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setEditorBusy(false);
    }
  }, [editingPath, editingOriginal, editingContent, refreshContext]);

  const deleteEditorFile = useCallback(async () => {
    if (!editingPath) return;
    if (!window.confirm(`Delete ${editingPath}? A backup is kept by the companion API.`)) return;
    setEditorBusy(true);
    setEditorMessage(`Deleting ${editingPath}…`);
    try {
      await compatClient.deleteWorkspaceFile(editingPath);
      closeEditor();
      void refreshContext();
    } catch (error) {
      setEditorMessage(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setEditorBusy(false);
    }
  }, [editingPath, closeEditor, refreshContext]);

  const createNewFile = useCallback(
    async (source: "skills" | "memory") => {
      const hermesHome = await compatClient
        .getConfig()
        .then((config) => config.hermes_home)
        .catch(() => undefined);
      const defaultDir = `${hermesHome || "~/.hermes"}/${source === "skills" ? "skills" : "memories"}`;
      const path = window.prompt(`Full path for the new ${source} file:`, `${defaultDir}/new-${source}.md`);
      if (!path || !path.trim()) return;
      const clean = path.trim();
      setEditorBusy(true);
      setEditorMessage(`Creating ${clean}…`);
      compatClient
        .createWorkspaceFile(clean, "")
        .then(() => openEditor(clean))
        .catch((error) => {
          setEditorMessage(`Create failed: ${error instanceof Error ? error.message : String(error)}`);
          setEditorBusy(false);
        });
    },
    [openEditor],
  );

  const tabs: Array<[ContextTab, string]> = [
    ["skills", `Skills (${skills.length})`],
    ["memory", `Memory (${memoryFiles.length})`],
    ["tools", `Tools (${hermesTools.builtin.length + hermesTools.mcp.length})`],
    ["browser-tools", `Browser tools (${LOCAL_VISUAL_TOOLS.length})`],
  ];

  const filteredHermesTools = (() => {
    const query = hermesToolFilter.trim().toLowerCase();
    const all = [...hermesTools.builtin, ...hermesTools.mcp];
    if (!query) return all;
    return all.filter(
      (tool) =>
        tool.name.toLowerCase().includes(query) ||
        tool.toolset.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query),
    );
  })();

  return (
    <section className="agent-workbench" aria-label="Agent context editor">
      {/* Green zone: header + provider bar + (expandable) provider settings. */}
      <div className="agent-header">
        <div className="workspace-section-header">
          <div>
            <h2>Agent Workbench</h2>
            <p className="muted">Configure the provider and manage skills, memory, and tool schemas.</p>
          </div>
          <span className={`status-pill ${status}`}>{status}</span>
        </div>

      </div>
      <div className="agent-endpoint-sections">
        <section className="agent-endpoint-section" aria-label="Hermes agent endpoints">
        <div className="agent-endpoint-heading">
          <h3>Hermes agent endpoints</h3>
          <button className="btn secondary small" type="button" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}>
            {showSettings ? "Close settings" : "Settings"}
          </button>
        </div>
        <label className="agent-connection-picker">Connection
          <select value={connection} onChange={(event) => void handleConnectionChange(event.target.value as ChatConnection)}>
            <option value="gateway">Hermes Gateway</option>
            <option value="openai">OpenAI API</option>
            <option value="local">Local model API</option>
            <option value="custom">Custom API endpoint</option>
            <option value="hermes-cli">Hermes CLI</option>
            {connection === "opencode-cli" && <option value="opencode-cli" disabled>Main OpenCode selected</option>}
          </select>
        </label>
        <div className="agent-provider-bar">
          <span className="muted small">
            <strong>{providerConfig.kind === "opencode" ? "OpenCode chat selected" : providerLabel(providerConfig)}</strong>
          </span>
          {connectionBusy && <span className="muted small" role="status">Saving...</span>}
        </div>
        {modelsError && <div className="agent-connection-error" role="alert">{modelsError}</div>}

      {showSettings && (
        <div className="agent-provider-settings">
          <div className="provider-field-row">
            {gatewaySelected ? (
              <>
                <label>Gateway route<input className="input-field" readOnly value={providerConfig.baseUrl} /></label>
                <label>Gateway model<input className="input-field" readOnly value={providerConfig.model} /></label>
                <div className="muted small" role="status">{gatewayConfigured === null ? "Checking Hermes gateway..." : gatewayConfigured ? "Hermes live chat configured on server" : "Hermes live chat unavailable on server"}</div>
              </>
            ) : providerConfig.kind === "api" ? (
              <>
                <label>
                  Base URL
                  <input
                    className="input-field"
                    value={providerConfig.baseUrl}
                    onChange={(e) => patchProvider({ baseUrl: e.target.value })}
                    placeholder="/llm"
                  />
                </label>
                <label>
                  Model
                  <div className="model-picker">
                    <select
                      className="input-field"
                      value={modelOptions.includes(providerConfig.model) ? providerConfig.model : ""}
                      onChange={(e) => patchProvider({ model: e.target.value })}
                    >
                      <option value="" disabled>
                        {modelOptions.length > 0 ? "Select a model…" : "No models loaded"}
                      </option>
                      {modelOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn secondary small"
                      type="button"
                      onClick={handleFetchModels}
                      disabled={modelsLoading || !providerConfig.baseUrl.trim()}
                    >
                      {modelsLoading ? "Loading…" : "Fetch models"}
                    </button>
                  </div>
                  <input
                    className="input-field"
                    value={providerConfig.model}
                    onChange={(e) => patchProvider({ model: e.target.value })}
                    placeholder="Model name (or use Fetch models)"
                  />
                </label>
                <label>
                  API Key (optional, stored on the server)
                  <span className="input-with-action">
                    <input
                      className="input-field"
                      type="password"
                      autoComplete="off"
                      value={providerConfig.apiKey}
                      onChange={(e) => patchProvider({ apiKey: e.target.value })}
                      placeholder={providerConfig.apiKeySet ? "•••••••• saved — type to replace" : "none"}
                    />
                    {providerConfig.apiKeySet ? (
                      <button className="btn secondary small" type="button" onClick={clearProviderApiKey}>
                        Clear
                      </button>
                    ) : null}
                  </span>
                </label>
              </>
            ) : providerConfig.kind === "hermes" ? (
              <>
                <label>
                  CLI Path
                  <input
                    className="input-field"
                    value={providerConfig.cliPath}
                    onChange={(e) => patchProvider({ cliPath: e.target.value })}
                    placeholder={providerConfig.kind === "hermes" ? "hermes" : "opencode"}
                  />
                </label>
                <label>
                  Working Directory
                  <input
                    className="input-field"
                    value={providerConfig.workdir}
                    onChange={(e) => patchProvider({ workdir: e.target.value })}
                    placeholder="Defaults to the server's workspace root"
                  />
                </label>
                <label>
                  Extra CLI Args
                  <input
                    className="input-field"
                    value={providerConfig.cliArgs}
                    onChange={(e) => patchProvider({ cliArgs: e.target.value })}
                    placeholder="-m provider/model"
                  />
                </label>
                <label>
                  Terminal Token (only if required; kept for this browser session)
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="off"
                    value={providerConfig.terminalToken}
                    onChange={(e) => patchProvider({ terminalToken: e.target.value })}
                    placeholder="TERMINAL_API_TOKEN"
                  />
                </label>
              </>
            ) : null}
          </div>
          <div className="provider-actions">
            {providerProfiles.length > 0 && (
              <div className="saved-provider-profiles" aria-label="Saved provider profiles">
                <span className="muted small">Saved</span>
                {providerProfiles.map((profile) => (
                  <span className="saved-provider-profile" key={profile.id}>
                    <button className="btn secondary small" type="button" onClick={() => handleLoadProvider(profile)}>
                      {profile.name}
                    </button>
                    <button
                      className="saved-provider-delete"
                      type="button"
                      title={`Delete ${profile.name}`}
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => handleDeleteProvider(profile)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="provider-save-profile">
              <input
                className="input-field compact"
                value={providerProfileName}
                onChange={(event) => setProviderProfileName(event.target.value)}
                placeholder="Name this provider"
                aria-label="New provider profile name"
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSaveProvider();
                }}
              />
              <button className="btn secondary small" type="button" onClick={handleSaveProvider} disabled={!providerProfileName.trim()}>
                Save provider
              </button>
            </div>
            <button className="btn secondary small" type="button" onClick={refreshContext}>
              {contextLoading ? "Refreshing…" : "Refresh Agent Data"}
            </button>
            {providerConfig.kind === "api" && !gatewaySelected && <>
            <label className="context-toggle">
              <input
                type="checkbox"
                checked={providerConfig.shareHermesContext}
                disabled={gatewaySelected}
                onChange={(event) => patchProvider({ shareHermesContext: event.target.checked })}
              />
              Share Hermes context with external APIs
            </label>
            <label className="context-toggle">
              <input
                type="checkbox"
                checked={providerConfig.allowLocalBoard}
                disabled={gatewaySelected}
                onChange={(event) => patchProvider({ allowLocalBoard: event.target.checked })}
              />
              Allow local board and artifact tools
            </label>
            <label className="context-toggle">
              <input
                type="checkbox"
                checked={providerConfig.allowWebFetch}
                disabled={gatewaySelected}
                onChange={(event) => patchProvider({ allowWebFetch: event.target.checked })}
              />
              Allow web fetch (read-only)
            </label>
            <label className="context-toggle">
              Mode
              <select
                className="input-field compact"
                value={providerConfig.agentMode}
                onChange={(event) => patchProvider({ agentMode: event.target.value as AgentProviderConfig["agentMode"] })}
              >
                <option value="plan">Plan</option>
                <option value="ask">Ask before changes</option>
                <option value="auto">Auto approve</option>
              </select>
            </label>
            <span className="muted small">
              {providerConfig.kind === "api"
                ? "API mode uses an OpenAI-compatible endpoint. Changes apply live to the Agent chat panel."
                : "CLI mode runs a one-shot agent turn; the harness executes its own tools. In browser mode the terminal token is required."}
            </span>
            </>}
          </div>
        </div>
      )}
        </section>
        <HermesSettings />
        <OpenCodeSettings role="main" />
        <OpenCodeSettings role="worker" />
        <SpeechServiceSettingsPanel />
      </div>

      {/* Left pane = the skills/memory/tools list; right pane =
          the edit/view pane for whatever is selected. */}
      <div className="agent-context-grid">
      <div className="context-editor">
        <div className="context-tabs" role="tablist" aria-label="Agent context tabs">
          {tabs.map(([tab, label]) => (
            <button
              key={tab}
              role="tab"
              aria-selected={contextTab === tab}
              className={`context-tab-btn ${contextTab === tab ? "active" : ""}`}
              type="button"
              onClick={() => setContextTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>

        {contextError && (
          <div className="alert error" style={{ padding: "var(--space-sm)", fontSize: "var(--font-size-xs)" }}>
            {contextError}
          </div>
        )}

        {contextTab === "skills" && (
          <div className="context-panel-body">
            <div className="context-toolbar">
              <button className="btn primary small" type="button" onClick={() => createNewFile("skills")}>
                + New skill
              </button>
              <span className="muted small">Skills live in ~/.hermes/skills — click one to edit.</span>
            </div>
            {skills.length === 0 ? (
              <p className="muted small">No skills found in local hermes/opencode skill directories.</p>
            ) : (
              <ul className="context-list">
                {skills.map((skill) => (
                  <li key={`${skill.source}-${skill.name}`} className="context-list-item">
                    <button
                      type="button"
                      className="context-session-btn"
                      onClick={() => void openEditor(skill.path)}
                    >
                      <div className="context-list-title">
                        <strong>{skill.name}</strong>
                        <span className="context-source-tag">{skill.source}</span>
                      </div>
                      <p className="muted small">{skill.description}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {contextTab === "memory" && (
          <div className="context-panel-body">
            <div className="context-toolbar">
              <button className="btn primary small" type="button" onClick={() => createNewFile("memory")}>
                + New memory file
              </button>
            </div>
            {memoryFiles.length === 0 ? (
              <p className="muted small">No memory files found.</p>
            ) : (
              <ul className="context-list">
                {memoryFiles.map((file) => (
                  <li key={file.path} className="context-list-item">
                    <button
                      type="button"
                      className="context-session-btn"
                      onClick={() => void openEditor(file.path)}
                    >
                      <div className="context-list-title">
                        <strong>{file.name}</strong>
                        <span className="muted small">
                          {file.size} bytes{file.truncated ? " (truncated)" : ""}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {contextTab === "tools" && (
          <div className="context-panel-body">
            <div className="context-toolbar">
              <span className="muted small">
                Hermes agent tools (read-only) — click one to view its schema.
              </span>
            </div>

            <div className="context-toolbar">
              <input
                className="input-field compact"
                type="search"
                placeholder="Filter by name, toolset, or description…"
                value={hermesToolFilter}
                onChange={(e) => setHermesToolFilter(e.target.value)}
                aria-label="Filter Hermes tools"
              />
              <button className="btn secondary small" type="button" onClick={() => void loadHermesTools()}>
                Refresh
              </button>
            </div>
            {hermesToolsError && (
              <div className="alert error" style={{ padding: "var(--space-sm)", fontSize: "var(--font-size-xs)" }}>
                {hermesToolsError}
              </div>
            )}
            {hermesToolsLoading && hermesTools.builtin.length === 0 && hermesTools.mcp.length === 0 ? (
              <p className="muted small">Loading Hermes tool registry…</p>
            ) : (
              <ul className="context-list">
                {filteredHermesTools.map((tool) => (
                  <li key={`${tool.toolset}-${tool.name}`} className="context-list-item">
                    <button
                      type="button"
                      className={`context-session-btn ${selectedHermesTool?.name === tool.name ? "selected" : ""}`}
                      onClick={() => {
                        if (editingPath) closeEditor();
                        setSelectedBrowserTool(null);
                        setSelectedHermesTool(tool);
                      }}
                    >
                      <div className="context-list-title">
                        <strong>
                          <code>{tool.name}</code>
                        </strong>
                        <span className="context-source-tag">{tool.toolset}</span>
                      </div>
                      <p className="muted small">{tool.description}</p>
                    </button>
                  </li>
                ))}
                {filteredHermesTools.length === 0 && (
                  <li className="context-list-item">
                    <p className="muted small">No Hermes tools match the filter.</p>
                  </li>
                )}
              </ul>
            )}

          </div>
        )}

        {contextTab === "browser-tools" && (
          <div className="context-panel-body">
            <div className="context-toolbar">
              <span className="muted small">
                Read-only. These are the exact tools handed to the model on the direct-API path; the browser executes
                them against the companion API. The Hermes gateway ignores them and uses its own server-side tools.
              </span>
            </div>

            <ul className="context-list">
              {LOCAL_VISUAL_TOOLS.map((tool) => (
                <li key={tool.name} className="context-list-item">
                  <button
                    type="button"
                    className={`context-session-btn ${selectedBrowserTool?.name === tool.name ? "selected" : ""}`}
                    onClick={() => {
                      if (editingPath) closeEditor();
                      setSelectedHermesTool(null);
                      setSelectedBrowserTool(tool);
                    }}
                  >
                    <div className="context-list-title">
                      <strong>
                        <code>{tool.name}</code>
                      </strong>
                      {!isMutatingTool(tool.name) && <span className="context-source-tag">read-only</span>}
                    </div>
                    <p className="muted small">{tool.description}</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="agent-editor-pane">
        {editingPath ? (
        <div className="file-editor">
          <div className="file-editor-header">
            <div>
              <h3>
                {baseName(editingPath)}
                {editingDirty ? " *" : ""}
              </h3>
              <p className="muted small">{editingPath}</p>
            </div>
            <div className="file-editor-actions">
              <button
                className="btn primary small"
                type="button"
                onClick={() => void saveEditor()}
                disabled={editorBusy || fileViewMode === "view" || !editingDirty}
              >
                {editorBusy ? "Saving…" : "Save"}
              </button>
              <div className="wiki-view-toggle" role="group" aria-label="File view mode">
                <button
                  className={`btn secondary ${fileViewMode === "view" ? "active" : ""}`}
                  type="button"
                  aria-pressed={fileViewMode === "view"}
                  onClick={() => setFileViewMode("view")}
                >
                  View
                </button>
                <button
                  className={`btn secondary ${fileViewMode === "edit" ? "active" : ""}`}
                  type="button"
                  aria-pressed={fileViewMode === "edit"}
                  onClick={() => setFileViewMode("edit")}
                >
                  Edit
                </button>
              </div>
              {memoryFiles.find((file) => file.name === "SOUL.md")?.path !== editingPath && (
                <button className="btn danger small" type="button" onClick={() => void deleteEditorFile()} disabled={editorBusy}>
                  Delete
                </button>
              )}
            </div>
          </div>
          {fileViewMode === "view" ? (
            <div className="file-viewer" aria-label="File viewer">
              <Markdown content={editingContent} />
            </div>
          ) : (
            <textarea
              className="file-editor-textarea"
              value={editingContent}
              spellCheck={false}
              onChange={(e) => {
                setEditingContent(e.target.value);
                setEditingDirty(true);
              }}
            />
          )}
          {editorMessage && <p className={`file-editor-status ${editorBusy ? "busy" : ""}`}>{editorMessage}</p>}
        </div>
        ) : selectedBrowserTool ? (
          <div className="tool-schema-viewer">
            <div className="file-editor-header">
              <div>
                <h3>
                  <code>{selectedBrowserTool.name}</code>
                </h3>
                <p className="muted small">
                  Browser tool ·{" "}
                  <span className="context-source-tag">
                    {isMutatingTool(selectedBrowserTool.name) ? "needs approval in ask mode" : "read-only"}
                  </span>
                </p>
              </div>
            </div>
            <p className="tool-schema-description">{selectedBrowserTool.description || "No description."}</p>
            <h4 className="context-section-title">Parameters (JSON Schema)</h4>
            <pre className="tool-schema-json">{JSON.stringify(selectedBrowserTool.parameters, null, 2)}</pre>
          </div>
        ) : selectedHermesTool ? (
          <div className="tool-schema-viewer">
            <div className="file-editor-header">
              <div>
                <h3>
                  <code>{selectedHermesTool.name}</code>
                </h3>
                <p className="muted small">
                  Hermes tool · <span className="context-source-tag">{selectedHermesTool.toolset}</span>
                </p>
              </div>
              <div className="file-editor-actions">
                <button className="btn primary small" type="button" disabled title="Hermes tools are read-only">
                  Save
                </button>
                <div className="wiki-view-toggle" role="group" aria-label="Tool view mode">
                  <button className="btn secondary active" type="button" aria-pressed={true}>
                    View
                  </button>
                  <button className="btn secondary" type="button" aria-pressed={false} disabled title="Hermes tools are read-only">
                    Edit
                  </button>
                </div>
                <button className="btn danger small" type="button" disabled title="Hermes tools are read-only">
                  Delete
                </button>
              </div>
            </div>
            <p className="tool-schema-description">{selectedHermesTool.description || "No description."}</p>
            <h4 className="context-section-title">Parameters (JSON Schema)</h4>
            <pre className="tool-schema-json">{JSON.stringify(selectedHermesTool.parameters, null, 2)}</pre>
          </div>
        ) : (
          <div className="agent-editor-empty">
            <p className="muted">Select a skill, memory file, session, or tool on the left to edit it here.</p>
          </div>
        )}
      </div>
      </div>
    </section>
  );
}
