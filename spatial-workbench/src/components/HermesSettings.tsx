import { useEffect, useState } from "react";
import { getAgentProvider } from "../agent/agentStore";
import { Icon } from "./Icon";
import { ProviderModelPicker, useProviderCatalog } from "./ProviderModelPicker";

type Connection = { provider: string; model: string; base_url: string; override_set: boolean };
type Settings = { connection: Connection; api_key_set: boolean; restart_required?: boolean };
type Runtime = {
  supported: boolean;
  release: string;
  rollback_available: boolean;
  operation: { state: string; step: string };
};
type Draft = Connection & { api_key: string; clear_key: boolean };

async function request<Result>(path: string, body?: object): Promise<Result> {
  const token = getAgentProvider().terminalToken;
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Terminal-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.message || "Hermes management requires the updated companion API");
  return result;
}

export function HermesSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = runtime?.operation.state === "running";
  const disabled = busy || running;
  const discovery = useProviderCatalog("hermes", open);
  const [catalogProvider, setCatalogProvider] = useState("");

  useEffect(() => {
    let live = true;
    void request<Settings>("/api/hermes-settings").then(result => {
      if (live) setSettings(result);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const result = await request<Runtime>("/api/hermes-runtime");
        if (live) setRuntime(result);
      } catch (failure) {
        if (live) setError(String(failure));
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [open]);

  function load(result: Settings) {
    setSettings(result);
    setDraft({ ...result.connection, api_key: "", clear_key: false });
    setCatalogProvider(result.connection.provider);
  }

  async function toggle() {
    if (open) { setOpen(false); setDraft(null); return; }
    setOpen(true); setBusy(true); setError(""); setNotice("");
    try { load(await request<Settings>("/api/hermes-settings")); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  async function applySaved() {
    if (!window.confirm("Restart Hermes to apply the saved settings? Active Workbench chats, jobs using Hermes, and messaging integrations may be interrupted.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setRuntime(await request<Runtime>("/api/hermes-runtime", { action: "apply", confirm: true }));
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  function update(patch: Partial<Draft>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    setNotice("");
  }

  return <section className="agent-endpoint-section hermes-management" aria-label="Hermes inference and runtime settings">
    <div className="agent-endpoint-heading"><h3>Hermes inference &amp; runtime</h3>
      <button className="btn secondary small" type="button" disabled={busy} aria-expanded={open} onClick={() => void toggle()}>
        <Icon name="gear" size={14} /> {open ? "Close" : "Configure"}
      </button>
    </div>
    <div className="agent-provider-bar"><span className="muted small"><strong>{settings?.connection.model || "Not configured"}</strong>{settings ? ` · ${settings.connection.provider}` : ""}</span></div>
    {open && <div className="opencode-settings-editor">
      <div className="provider-catalog-status">
        <button className="btn secondary small" type="button" disabled={discovery.loading} onClick={discovery.refresh}><Icon name="refresh" size={14} />Refresh providers</button>
        {discovery.loading && <span className="muted small" role="status">Loading providers...</span>}
        {discovery.warning && <span className="muted small" role="status">{discovery.warning}</span>}
        {discovery.catalog?.current.model && <span className="muted small">Runtime default: {discovery.catalog.current.provider}/{discovery.catalog.current.model}</span>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <p className="muted small" role="status">{notice}</p>}
      {draft && <form className="jobs-profile-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError(""); setNotice("");
        try {
          load(await request<Settings>("/api/hermes-settings", {
            provider: draft.provider, model: draft.model, base_url: draft.provider === "custom" ? draft.base_url : "",
            ...(draft.clear_key ? { api_key: "" } : draft.api_key ? { api_key: draft.api_key } : {}),
          }));
          setNotice("Saved. Apply to restart Hermes with these settings.");
        } catch (failure) { setError(String(failure)); }
        finally { setBusy(false); }
      }}>
        <fieldset className="opencode-connection" disabled={disabled}>
          <legend>Inference provider</legend>
          <div className="jobs-profile-fields">
            <ProviderModelPicker providers={discovery.catalog?.providers || []} providerId={catalogProvider || draft.provider} modelId={draft.model} allowCustom onChange={(providerId, modelId, selected) => {
              const provider = selected?.custom ? "custom" : providerId;
              const routeChanged = (catalogProvider || draft.provider) !== providerId;
              setCatalogProvider(providerId);
              update({ provider, model: modelId, ...(routeChanged ? { base_url: selected?.base_url || "", api_key: "", clear_key: false } : {}) });
            }} />
            {draft.provider === "custom" && <label>Endpoint URL<input type="url" required value={draft.base_url} onChange={event => update({ base_url: event.target.value, api_key: "", clear_key: false })} /></label>}
          </div>
          <label>API key<input type="password" autoComplete="new-password" disabled={draft.clear_key} value={draft.api_key} placeholder={settings?.api_key_set && draft.provider === settings.connection.provider && draft.base_url === settings.connection.base_url ? "Saved key (unchanged)" : "Optional"} onChange={event => update({ api_key: event.target.value })} /></label>
          <label className="opencode-clear-key"><input type="checkbox" checked={draft.clear_key} onChange={event => update({ clear_key: event.target.checked, api_key: "" })} />Clear key for this connection</label>
        </fieldset>
        <div className="jobs-profile-actions">
          <button className="btn primary small" type="submit" disabled={disabled}><Icon name="check" size={14} />Save</button>
          <button className="btn secondary small" type="button" disabled={disabled || !settings?.connection.override_set} onClick={async () => {
            if (!window.confirm("Reset Hermes inference settings to the deployment defaults? Apply is required to restart Hermes.")) return;
            setBusy(true); setError("");
            try { load(await request<Settings>("/api/hermes-settings", { reset: true })); setNotice("Defaults restored. Apply to restart Hermes."); }
            catch (failure) { setError(String(failure)); }
            finally { setBusy(false); }
          }}><Icon name="arrow-left" size={14} />Reset</button>
          <button className="btn secondary small" type="button" disabled={disabled || !runtime?.supported} onClick={() => void applySaved()}><Icon name="refresh" size={14} />Apply Saved</button>
        </div>
      </form>}
      {runtime && !runtime.supported && <p className="muted small" role="status">Applying settings requires the updated Workbench agent image. Saved settings take effect on the next Hermes restart.</p>}
    </div>}
  </section>;
}