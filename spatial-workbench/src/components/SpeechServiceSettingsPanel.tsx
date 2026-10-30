import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchServerSettings, saveServerSettingsNow, setServerSecret, type SpeechServiceSettings } from "../agent/serverSettings";
import { Icon } from "./Icon";

type Service = "stt" | "tts";

const EMPTY_SETTINGS: SpeechServiceSettings = {
  stt_url: "", tts_url: "", stt_url_override_set: false, tts_url_override_set: false,
  stt_token_set: false, tts_token_set: false,
};

export function SpeechServiceSettingsPanel() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SpeechServiceSettings>(EMPTY_SETTINGS);
  const [urls, setUrls] = useState({ stt: "", tts: "" });
  const [tokens, setTokens] = useState({ stt: "", tts: "" });
  const [clearTokens, setClearTokens] = useState({ stt: false, tts: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const result = await fetchServerSettings();
    if (!result) throw new Error("Could not load companion settings");
    const speech = result.speech || EMPTY_SETTINGS;
    setSettings(speech);
    setUrls({ stt: speech.stt_url, tts: speech.tts_url });
    setTokens({ stt: "", tts: "" });
    setClearTokens({ stt: false, tts: false });
  }, []);

  useEffect(() => {
    let active = true;
    void reload().catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : "Could not load speech settings");
    });
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveServerSettingsNow({ speech: {
        stt_url: urls.stt.trim() || null,
        tts_url: urls.tts.trim() || null,
      } });
      const failures: Service[] = [];
      for (const service of ["stt", "tts"] as const) {
        if (clearTokens[service]) {
          if (!await setServerSecret(`speech:${service}`, null)) failures.push(service);
        } else if (tokens[service]) {
          if (!await setServerSecret(`speech:${service}`, tokens[service])) failures.push(service);
        }
      }
      await reload();
      if (failures.length) throw new Error(`URLs saved, but ${failures.map((service) => service.toUpperCase()).join(" and ")} token change failed.`);
      setMessage("Speech service settings saved for this Workbench instance.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save speech service settings.");
    } finally {
      setBusy(false);
    }
  }

  async function resetUrls() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await saveServerSettingsNow({ speech: { stt_url: null, tts_url: null } });
      await reload();
      setMessage("Using deployment URLs. Saved tokens were not changed.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not reset speech URLs.");
    } finally {
      setBusy(false);
    }
  }

  const status = [
    settings.stt_token_set ? "STT token set" : "STT token needed",
    settings.tts_token_set ? "TTS token set" : "TTS token needed",
  ].join(" · ");

  return <section className="agent-endpoint-section opencode-settings" aria-label="Speech services">
    <div className="agent-endpoint-heading">
      <h3>Speech services</h3>
      <button className="btn secondary small" type="button" onClick={() => { setOpen((current) => !current); setError(""); }} aria-expanded={open}>
        <Icon name="gear" size={14} /> {open ? "Close settings" : "Settings"}
      </button>
    </div>
      <div className="agent-provider-bar">
        <span className="muted small"><strong>STT</strong> {settings.stt_url || "Not configured"}</span>
        <span className="muted small"><strong>TTS</strong> {settings.tts_url || "Not configured"}</span>
        <span className="muted small" role="status">{status}</span>
      </div>
    {open && <form className="opencode-settings-editor" onSubmit={(event) => void save(event)}>
      <p className="muted small">These URLs and credentials apply to this Workbench instance. Tokens are write-only and are never returned to the browser.</p>
      <fieldset className="opencode-connection">
        <legend>Speech-to-text</legend>
        <label>Service base URL
          <input className="input-field" type="url" autoComplete="url" maxLength={500} placeholder="http://host:port" value={urls.stt} onChange={(event) => setUrls((current) => ({ ...current, stt: event.target.value }))} />
        </label>
        <label>Bearer token {settings.stt_token_set ? "(saved; leave blank to keep)" : "(not configured)"}
          <input className="input-field" type="password" autoComplete="new-password" maxLength={1024} placeholder={settings.stt_token_set ? "Saved securely" : "Enter STT token"} value={tokens.stt} disabled={clearTokens.stt} onChange={(event) => setTokens((current) => ({ ...current, stt: event.target.value }))} />
        </label>
        <label className="opencode-clear-key"><input type="checkbox" checked={clearTokens.stt} onChange={(event) => { setClearTokens((current) => ({ ...current, stt: event.target.checked })); setTokens((current) => ({ ...current, stt: "" })); }} /> Clear STT token</label>
      </fieldset>
      <fieldset className="opencode-connection">
        <legend>Text-to-speech</legend>
        <label>Service base URL
          <input className="input-field" type="url" autoComplete="url" maxLength={500} placeholder="http://host:port" value={urls.tts} onChange={(event) => setUrls((current) => ({ ...current, tts: event.target.value }))} />
        </label>
        <label>Bearer token {settings.tts_token_set ? "(saved; leave blank to keep)" : "(not configured)"}
          <input className="input-field" type="password" autoComplete="new-password" maxLength={1024} placeholder={settings.tts_token_set ? "Saved securely" : "Enter TTS token"} value={tokens.tts} disabled={clearTokens.tts} onChange={(event) => setTokens((current) => ({ ...current, tts: event.target.value }))} />
        </label>
        <label className="opencode-clear-key"><input type="checkbox" checked={clearTokens.tts} onChange={(event) => { setClearTokens((current) => ({ ...current, tts: event.target.checked })); setTokens((current) => ({ ...current, tts: "" })); }} /> Clear TTS token</label>
      </fieldset>
      {error && <div className="alert error" role="alert">{error}</div>}
      {message && <div className="muted small" role="status">{message}</div>}
      <div className="jobs-profile-actions">
        <button className="btn primary small" type="submit" disabled={busy}>{busy ? "Saving…" : "Save speech settings"}</button>
        <button className="btn secondary small" type="button" disabled={busy} onClick={() => void resetUrls()}>Use deployment URLs</button>
      </div>
    </form>}
  </section>;
}