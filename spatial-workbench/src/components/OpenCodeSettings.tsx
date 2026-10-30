import { useEffect, useState } from "react";
import { getAgentProvider, switchAgentProvider, updateAgentProvider, useAgentProvider } from "../agent/agentStore";
import { connectionPreset } from "../agent/providerConnections";
import { Icon } from "./Icon";
import { ProviderModelPicker, useProviderCatalog } from "./ProviderModelPicker";

type Connection = { model: string; base_url: string; api_key_set: boolean };
type Configuration = { main: Connection; worker: Connection; key_variables: string[]; warning?: string };
type Draft = Connection & { endpoint_mode: "provider" | "custom"; api_key: string; clear_key: boolean };

export async function saveOpenCodeSettings(payload: object): Promise<Configuration> {
  const token = getAgentProvider().terminalToken;
  const response = await fetch("/api/opencode-settings", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Terminal-Token": token } : {}) },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || "Could not save OpenCode settings");
  return result;
}

export function OpenCodeSettings({ role }: { role: "main" | "worker" }) {
  const provider = useAgentProvider();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reloadMain, setReloadMain] = useState(false);
  const [summary, setSummary] = useState<Connection | null>(null);
  const discovery = useProviderCatalog("opencode", open);

  useEffect(() => {
    let live = true;
    void fetch("/api/opencode-settings").then(async (response) => {
      const result = await response.json();
      if (live && response.ok && result.ok) setSummary(result[role]);
    }).catch(() => {});
    return () => { live = false; };
  }, [role]);

  function loadDraft(config: Configuration) {
    const connection = config[role];
    setSummary(connection);
    setDraft({ ...connection, endpoint_mode: connection.base_url ? "custom" : "provider", api_key: "", clear_key: false });
  }

  async function toggle() {
    if (open) { setOpen(false); setDraft(null); return; }
    setOpen(true); setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/opencode-settings");
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not load OpenCode settings");
      loadDraft(result);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  function update(patch: Partial<Draft>) {
    setSaved(false);
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  const title = role === "main" ? "Main OpenCode endpoints" : "Worker OpenCode endpoints";
  return <section className="agent-endpoint-section opencode-settings" aria-label={title}>
    <div className="agent-endpoint-heading"><h3>{title}</h3>
      <button className="btn secondary small" type="button" onClick={() => void toggle()} aria-expanded={open}>
        <Icon name="gear" size={14} /> {open ? "Close settings" : "Settings"}
      </button>
    </div>
    <div className="agent-provider-bar"><span className="muted small"><strong>{summary?.model || "Not configured"}</strong>{summary?.base_url ? ` @ ${summary.base_url}` : ""}</span></div>
    {open && <div className="opencode-settings-editor">
      <div className="provider-catalog-status">
        <button className="btn secondary small" type="button" disabled={discovery.loading} onClick={discovery.refresh}><Icon name="refresh" size={14} />Refresh providers</button>
        {discovery.loading && <span className="muted small" role="status">Loading providers...</span>}
        {discovery.warning && <span className="muted small" role="status">{discovery.warning}</span>}
        {role === "main" && discovery.catalog?.current.model && <span className="muted small">Runtime default: {discovery.catalog.current.provider}/{discovery.catalog.current.model}</span>}
        {role === "worker" && <span className="muted small">Main runtime catalog; worker authentication is separate.</span>}
      </div>
      {busy && !draft && <span role="status">Loading...</span>}
      {error && <div className="alert error" role="alert">{error}</div>}
      {draft && <form className="jobs-profile-form" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError(""); setSaved(false);
        try {
          if (role === "main" && reloadMain && !window.confirm("Reload the main OpenCode server? Active OpenCode sessions may be interrupted.")) return;
          const result = await saveOpenCodeSettings({
            [role]: { model: draft.model, base_url: draft.endpoint_mode === "custom" ? draft.base_url : "",
              ...(draft.clear_key ? { api_key: "" } : draft.api_key ? { api_key: draft.api_key } : {}) },
            reload_main: role === "main" && reloadMain,
          });
          loadDraft(result); setSaved(true); setError(result.warning || "");
        } catch (failure) { setError(String(failure)); }
        finally { setBusy(false); }
      }}>
        <fieldset className="opencode-connection">
          <legend>{role === "main" ? "Main model" : "Default worker model"}</legend>
          <div className="jobs-profile-fields">
            <label>Endpoint<select value={draft.endpoint_mode} onChange={(event) => update({ endpoint_mode: event.target.value as Draft["endpoint_mode"] })}>
              <option value="provider">OpenCode provider</option><option value="custom">Custom endpoint</option>
            </select></label>
            {draft.endpoint_mode === "provider" ? <ProviderModelPicker
              providers={discovery.catalog?.providers || []}
              providerId={draft.model.split("/")[0]}
              modelId={draft.model.includes("/") ? draft.model.slice(draft.model.indexOf("/") + 1) : ""}
              worker={role === "worker"}
              onChange={(providerId, modelId) => update({ model: `${providerId}/${modelId}`, ...(providerId !== draft.model.split("/")[0] ? { api_key: "", clear_key: false } : {}) })}
            /> : <label>Model ID<input required maxLength={200} value={draft.model} onChange={(event) => update({ model: event.target.value })} /></label>}
            {draft.endpoint_mode === "custom" && <label>Endpoint URL<input required type="url" value={draft.base_url} onChange={(event) => update({ base_url: event.target.value })} /></label>}
          </div>
          <label>API key<input type="password" autoComplete="new-password" disabled={draft.clear_key} value={draft.api_key} placeholder={draft.api_key_set ? "Key configured (unchanged)" : "No key configured"} onChange={(event) => update({ api_key: event.target.value })} /></label>
          <label className="opencode-clear-key"><input type="checkbox" checked={draft.clear_key} onChange={(event) => update({ clear_key: event.target.checked, api_key: "" })} /> Clear key</label>
        </fieldset>
        {role === "main" && <>
          <button className="btn secondary small" type="button" onClick={() => void switchAgentProvider(connectionPreset(getAgentProvider(), "opencode-cli")).catch((failure) => setError(String(failure)))}>Use OpenCode for agent chat</button>
          {provider.kind === "opencode" && <>
            <label>CLI path<input value={provider.cliPath} onChange={(event) => updateAgentProvider({ cliPath: event.target.value })} /></label>
            <label>Working directory<input value={provider.workdir} onChange={(event) => updateAgentProvider({ workdir: event.target.value })} /></label>
            <label>Extra CLI args<input value={provider.cliArgs} onChange={(event) => updateAgentProvider({ cliArgs: event.target.value })} /></label>
            <label>Terminal token<input type="password" autoComplete="off" value={provider.terminalToken} onChange={(event) => updateAgentProvider({ terminalToken: event.target.value })} /></label>
          </>}
          <label className="opencode-clear-key"><input type="checkbox" checked={reloadMain} onChange={(event) => setReloadMain(event.target.checked)} /> Reload running OpenCode server</label>
        </>}
        <div className="jobs-profile-actions"><button className="btn primary small" type="submit" disabled={busy}>Save settings</button>
          <button className="btn secondary small" type="button" disabled={busy} onClick={async () => {
            if (!window.confirm(`Reset ${role === "main" ? "main OpenCode" : "default workers"} to the deployment settings?`)) return;
            setBusy(true); setError("");
            try { loadDraft(await saveOpenCodeSettings({ reset: [role] })); setSaved(true); }
            catch (failure) { setError(String(failure)); }
            finally { setBusy(false); }
          }}>Reset to deployment defaults</button>{saved && <span role="status">Saved</span>}</div>
      </form>}
    </div>}
  </section>;
}