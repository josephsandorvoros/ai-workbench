import { useCallback, useEffect, useState } from "react";
import {
  fetchAgentSessionMessages,
  fetchAgentSessions,
  type AgentSession,
  type AgentSessionMessage,
} from "../agent/agentData";
import {
  CHAT_SESSIONS_CHANGED_EVENT,
  LOAD_CHAT_SESSION_EVENT,
  deleteSavedChatSession,
  loadSavedChatSessions,
  upsertSavedChatSession,
  type SavedChatMessage,
  type SavedChatSession,
} from "../agent/chatSessions";
import { Markdown } from "./Markdown";

type SessionsStatus = "available" | "degraded" | "error";

export function SessionsWorkbench() {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedChatSession[]>(() => loadSavedChatSessions());
  const [selectedSaved, setSelectedSaved] = useState<SavedChatSession | null>(null);
  const [savedDraft, setSavedDraft] = useState<SavedChatSession | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentSession | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentSessionMessage[]>([]);
  const [savedViewMode, setSavedViewMode] = useState<"view" | "edit">("view");
  const [agentViewMode, setAgentViewMode] = useState<"view" | "edit">("view");
  const [status, setStatus] = useState<SessionsStatus>("degraded");
  const [message, setMessage] = useState("Loading sessions…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchAgentSessions(50);
      setAgentSessions(result.sessions);
      setStatus("available");
      setMessage("");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Failed to load agent sessions.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshSaved = () => setSavedSessions(loadSavedChatSessions());
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, refreshSaved);
    return () => window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, refreshSaved);
  }, [refresh]);

  const selectSaved = (session: SavedChatSession) => {
    setSelectedSaved(session);
    setSavedDraft({ ...session, messages: session.messages.map((item) => ({ ...item })) });
    setSelectedAgent(null);
    setSavedViewMode("view");
  };

  const selectAgent = async (session: AgentSession) => {
    setSelectedAgent(session);
    setSelectedSaved(null);
    setSavedDraft(null);
    setAgentMessages([]);
    setAgentViewMode("view");
    try {
      const result = await fetchAgentSessionMessages(session.source, session.id, 200);
      if (result.ok) setAgentMessages(result.messages);
      else setMessage(result.message || "Failed to load session messages.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load session messages.");
    }
  };

  const saveSaved = () => {
    if (!savedDraft) return;
    const next = upsertSavedChatSession({ ...savedDraft, updatedAt: Date.now() });
    setSavedSessions(next);
    setSelectedSaved(next.find((item) => item.id === savedDraft.id) ?? null);
  };

  const deleteSaved = (id: string) => {
    if (!window.confirm("Delete this saved chat?")) return;
    setSavedSessions(deleteSavedChatSession(id));
    if (selectedSaved?.id === id) {
      setSelectedSaved(null);
      setSavedDraft(null);
    }
  };

  const saveAgent = async () => {
    if (!selectedAgent) return;
    setBusy(true);
    setMessage(`Saving session ${selectedAgent.id}…`);
    try {
      const result = await fetchAgentSessionMessages(selectedAgent.source, selectedAgent.id, 200);
      if (!result.ok) throw new Error(result.message || "Failed to load session messages.");
      const messages: SavedChatMessage[] = result.messages.map((item, index) => ({
        id: `${selectedAgent.source}-${selectedAgent.id}-${index}`,
        role: item.role === "user" ? "user" : "assistant",
        content: item.content,
        timestamp: item.timestamp ?? Date.now(),
      }));
      const next = upsertSavedChatSession({
        id: `agent-${selectedAgent.source}-${selectedAgent.id}`,
        title: selectedAgent.title,
        updatedAt: Date.now(),
        messages,
      });
      setSavedSessions(next);
      setMessage(`Saved “${selectedAgent.title}” to saved chats.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selectedAgent || !window.confirm(`Delete session “${selectedAgent.title}” from ${selectedAgent.source}?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/agent/session/delete?source=${encodeURIComponent(selectedAgent.source)}&session_id=${encodeURIComponent(selectedAgent.id)}`, { method: "POST" });
      const result = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !result.ok) throw new Error(result.message || `Delete failed (${response.status}).`);
      setSelectedAgent(null);
      setAgentMessages([]);
      setMessage(`Deleted session “${selectedAgent.title}”.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const loadSaved = (session: SavedChatSession) => {
    window.dispatchEvent(new CustomEvent(LOAD_CHAT_SESSION_EVENT, { detail: session }));
  };

  const savedAgentCopy = selectedAgent
    ? savedSessions.find((item) => item.id === `agent-${selectedAgent.source}-${selectedAgent.id}`)
    : undefined;

  return (
    <section className="sessions-workbench" aria-label="Chat sessions workbench">
      <div className="wiki-header">
        <div>
          <h2>Chat Sessions</h2>
          <p className="muted">Browse saved chats and conversation history from Hermes and OpenCode.</p>
        </div>
        <div className="sessions-header-actions">
          <span className={`status-pill ${status}`}>{status}</span>
          <button className="btn secondary small" type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>

      <div className="sessions-grid">
        <aside className="sessions-browser" aria-label="Session list">
          <div className="sessions-list">
            <h3 className="context-section-title">Saved chats</h3>
            {savedSessions.length === 0 ? <p className="muted small">No saved chats.</p> : savedSessions.map((session) => (
              <button key={session.id} type="button" className={`context-session-btn ${selectedSaved?.id === session.id ? "selected" : ""}`} onClick={() => selectSaved(session)}>
                <div className="context-list-title"><strong>{session.title || "Untitled chat"}</strong><span className="context-source-tag">workbench</span></div>
                <p className="muted small">{session.messages.length} msgs · {new Date(session.updatedAt).toLocaleString()}</p>
              </button>
            ))}
            <h3 className="context-section-title">Agent history</h3>
            {agentSessions.length === 0 ? <p className="muted small">No recent Hermes/OpenCode sessions found.</p> : agentSessions.map((session) => (
              <button key={`${session.source}-${session.id}`} type="button" className={`context-session-btn ${selectedAgent?.id === session.id && selectedAgent?.source === session.source ? "selected" : ""}`} onClick={() => void selectAgent(session)}>
                <div className="context-list-title"><strong>{session.title}</strong><span className="context-source-tag">{session.source}</span></div>
                <p className="muted small">{session.model ?? "unknown model"}{session.message_count != null ? ` · ${session.message_count} msgs` : ""}</p>
              </button>
            ))}
          </div>
        </aside>

        <section className="sessions-detail" aria-label="Session details">
          {savedDraft ? (
            <div className="session-editor">
              <div className="file-editor-header">
                <div><h3>{savedDraft.title || "Untitled chat"}</h3><p className="muted small">Saved workbench chat · {savedDraft.messages.length} msgs · {new Date(savedDraft.updatedAt).toLocaleString()}</p></div>
                <div className="file-editor-actions">
                  <button className="btn primary small" type="button" onClick={saveSaved} disabled={savedViewMode === "view"}>Save</button>
                  <div className="wiki-view-toggle" role="group" aria-label="Chat view mode">
                    <button className={`btn secondary ${savedViewMode === "view" ? "active" : ""}`} type="button" aria-pressed={savedViewMode === "view"} onClick={() => setSavedViewMode("view")}>View</button>
                    <button className={`btn secondary ${savedViewMode === "edit" ? "active" : ""}`} type="button" aria-pressed={savedViewMode === "edit"} onClick={() => setSavedViewMode("edit")}>Edit</button>
                  </div>
                  <button className="btn danger small" type="button" onClick={() => deleteSaved(savedDraft.id)}>Delete</button>
                  <button className="btn secondary small" type="button" onClick={() => loadSaved(savedDraft)}>Load session</button>
                </div>
              </div>
              {savedViewMode === "view" ? <div className="session-viewer" aria-label="Chat viewer">{savedDraft.messages.length === 0 ? <p className="muted small">This chat has no messages yet.</p> : savedDraft.messages.map((item) => <div key={item.id} className={`chat-bubble role-${item.role === "user" ? "user" : "assistant"}`}><span className="role-label">{item.role.toUpperCase()}</span><pre className="msg-content">{item.content}</pre></div>)}</div> : (
                <div className="session-editor-form">
                  <label>Title<input className="input-field" value={savedDraft.title} onChange={(event) => setSavedDraft({ ...savedDraft, title: event.target.value })} placeholder="Chat title" /></label>
                  <label>Messages (JSON)<textarea className="input-field session-messages-json" rows={14} spellCheck={false} value={JSON.stringify(savedDraft.messages, null, 2)} onChange={(event) => { try { const parsed = JSON.parse(event.target.value) as SavedChatMessage[]; if (!Array.isArray(parsed)) throw new Error("not an array"); setSavedDraft({ ...savedDraft, messages: parsed }); } catch { /* keep last valid state */ } }} /></label>
                </div>
              )}
            </div>
          ) : selectedAgent ? (
            <div className="session-editor">
              <div className="file-editor-header">
                <div><h3>{selectedAgent.title}</h3><p className="muted small">{selectedAgent.source} session · {selectedAgent.model ?? "unknown model"}{selectedAgent.message_count != null ? ` · ${selectedAgent.message_count} msgs` : ""}</p></div>
                <div className="file-editor-actions">
                  <button className="btn primary small" type="button" onClick={() => void saveAgent()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                  <div className="wiki-view-toggle" role="group" aria-label="Session view mode">
                    <button className={`btn secondary ${agentViewMode === "view" ? "active" : ""}`} type="button" aria-pressed={agentViewMode === "view"} onClick={() => setAgentViewMode("view")}>View</button>
                    <button className={`btn secondary ${agentViewMode === "edit" ? "active" : ""}`} type="button" aria-pressed={agentViewMode === "edit"} onClick={() => setAgentViewMode("edit")}>Edit</button>
                  </div>
                  <button className="btn danger small" type="button" onClick={() => void deleteAgent()} disabled={busy}>Delete</button>
                  <button className="btn secondary small" type="button" onClick={() => savedAgentCopy && loadSaved(savedAgentCopy)} disabled={!savedAgentCopy}>Load session</button>
                </div>
              </div>
              {agentViewMode === "view" ? <div className="session-viewer" aria-label="Session viewer">{agentMessages.length === 0 ? <p className="muted small">Loading messages…</p> : agentMessages.map((item, index) => <div key={index} className={`chat-bubble role-${item.role === "user" ? "user" : "assistant"}`}><span className="role-label">{item.role.toUpperCase()}</span><pre className="msg-content">{item.content}</pre></div>)}</div> : <div className="session-editor-form"><label>Title<input className="input-field" value={selectedAgent.title} onChange={(event) => setSelectedAgent({ ...selectedAgent, title: event.target.value })} placeholder="Session title" /></label><p className="muted small">Messages are read from the {selectedAgent.source} database. Save copies them into saved chats.</p></div>}
            </div>
          ) : (
            <div className="agent-editor-empty"><p className="muted">Select a saved chat or agent session from the list.</p></div>
          )}
          {message ? <p className={`file-editor-status ${busy ? "busy" : ""}`} role="status">{message}</p> : null}
        </section>
      </div>
    </section>
  );
}
