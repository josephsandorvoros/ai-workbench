/**
 * Workbench settings stored on the companion API (so they follow the user
 * across browsers). Secrets are write-only: the server keeps them and adds
 * them to proxied model requests; the browser only learns whether one is set.
 */

import type { AgentProviderConfig, SavedProviderProfile } from "./providers";

export interface ServerSettings {
  provider?: Partial<AgentProviderConfig> | null;
  profiles?: SavedProviderProfile[] | null;
  tools?: unknown[] | null;
  speech?: SpeechServiceSettings | null;
}

export interface SpeechServiceSettings {
  stt_url: string;
  tts_url: string;
  stt_url_override_set: boolean;
  tts_url_override_set: boolean;
  stt_token_set: boolean;
  tts_token_set: boolean;
}

export interface SpeechServiceSettingsPatch {
  stt_url?: string | null;
  tts_url?: string | null;
}

export const SETTINGS_LOADED_EVENT = "spatial-workbench:settings-loaded";

let lastLoaded: ServerSettings | null = null;

export function getLoadedServerSettings(): ServerSettings | null {
  return lastLoaded;
}

export async function fetchServerSettings(): Promise<ServerSettings | null> {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) return null;
    const payload = (await response.json()) as ServerSettings & { ok?: boolean };
    if (payload.ok === false) return null;
    lastLoaded = payload;
    window.dispatchEvent(new CustomEvent(SETTINGS_LOADED_EVENT));
    return payload;
  } catch (_error) {
    return null;
  }
}

let pending: ServerSettings = {};
let flushTimer = 0;
type SaveResult = { ok: boolean; apiKeySet?: boolean };
type SettingsWrite = Omit<ServerSettings, "speech"> & {
  speech?: SpeechServiceSettingsPatch | null;
  provider_key?: { endpoint: string; value: string };
};
let writes: Promise<unknown> = Promise.resolve();

function writeSettings(body: SettingsWrite): Promise<SaveResult> {
  const operation = writes.catch(() => undefined).then(async () => {
    const response = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as SaveResult;
    if (!response.ok || !result.ok) throw new Error("Could not save the agent connection");
    return result;
  });
  writes = operation;
  return operation;
}

export function saveServerSettingsNow(patch: SettingsWrite): Promise<SaveResult> {
  window.clearTimeout(flushTimer);
  const body = { ...pending, ...patch };
  pending = {};
  const { provider_key: _key, speech: _speechPatch, ...publicBody } = body;
  lastLoaded = { ...(lastLoaded ?? {}), ...publicBody };
  return writeSettings(body);
}

/** Debounced partial save (provider / profiles / tools). */
export function saveServerSettings(patch: ServerSettings) {
  pending = { ...pending, ...patch };
  lastLoaded = { ...(lastLoaded ?? {}), ...patch };
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    const body = pending;
    pending = {};
    void writeSettings(body).catch(() => undefined);
  }, 500);
}

async function postSecret(body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch("/api/settings/secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; set?: boolean };
    return Boolean(response.ok && payload.ok && payload.set);
  } catch (_error) {
    return false;
  }
}

/** Store (or clear, with null) a secret; resolves to whether it is now set. */
export function setServerSecret(name: string, value: string | null, endpoint?: string): Promise<boolean> {
  return postSecret({ name, value, ...(endpoint !== undefined ? { endpoint } : {}) });
}

export function copyServerSecret(from: string, to: string, endpoint?: string): Promise<boolean> {
  return postSecret({ name: to, copy_from: from, ...(endpoint !== undefined ? { endpoint } : {}) });
}
