import { useSyncExternalStore } from "react";

import {
  type AgentProviderConfig,
  type SavedProviderProfile,
  DEFAULT_PROVIDER_CONFIG,
  clearLegacyProviderStorage,
  legacySecrets,
  loadProviderConfig,
  loadProviderProfiles,
  saveProviderConfig,
  scrubProviderConfig,
  setProviderProfiles,
} from "./providers";
import { copyServerSecret, fetchServerSettings, saveServerSettings, saveServerSettingsNow, setServerSecret } from "./serverSettings";

/**
 * Shared agent provider store.
 *
 * Both the AgentWorkbench (main panel) and the AgentChat side panel read
 * from this store, so switching harness/endpoint/model in one place applies
 * live everywhere. The source of truth is the companion API's settings;
 * API keys are write-only there and never kept in the browser.
 */

type Listener = () => void;

/** Fired once server settings (provider, profiles, tools) have been applied. */
export const PROVIDER_SETTINGS_READY_EVENT = "spatial-workbench:provider-settings-ready";

let config: AgentProviderConfig = loadProviderConfig();
const listeners = new Set<Listener>();
let secretTimer = 0;
let connectionVersion = 0;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getAgentProvider(): AgentProviderConfig {
  return config;
}

function commit(next: AgentProviderConfig, syncServer = true) {
  config = next;
  saveProviderConfig(next);
  if (syncServer) saveServerSettings({ provider: scrubProviderConfig(next) });
  emit();
}

export function setAgentProvider(next: AgentProviderConfig) {
  window.clearTimeout(secretTimer);
  commit(next);
  // A typed key is held in memory only until it is handed to the server.
  if (next.apiKey) {
    const typed = next.apiKey;
    secretTimer = window.setTimeout(() => {
      if (config.apiKey !== typed || config.baseUrl !== next.baseUrl) return;
      void saveServerSettingsNow({ provider: scrubProviderConfig(config) }).then(async () => {
        if (config.apiKey !== typed || config.baseUrl !== next.baseUrl) return;
        const isSet = await setServerSecret("provider", typed, next.baseUrl);
        if (config.apiKey === typed && config.baseUrl === next.baseUrl) commit({ ...config, apiKey: "", apiKeySet: isSet }, false);
      }).catch(() => undefined);
    }, 800);
  }
}

export function updateAgentProvider(patch: Partial<AgentProviderConfig>) {
  setAgentProvider({ ...config, ...patch });
}

export async function switchAgentProvider(next: AgentProviderConfig): Promise<boolean> {
  window.clearTimeout(secretTimer);
  const previous = config;
  const version = ++connectionVersion;
  commit(next, false);
  const saved = await saveServerSettingsNow({ provider: scrubProviderConfig(next),
    ...(previous.kind === "api" && previous.apiKey && previous.baseUrl.replace(/\/+$/, "") !== "/hermes-gw"
      ? { provider_key: { endpoint: previous.baseUrl, value: previous.apiKey } } : {}),
  });
  if (version !== connectionVersion || config.kind !== next.kind || config.baseUrl !== next.baseUrl) return false;
  commit({ ...config, apiKeySet: Boolean(saved.apiKeySet) }, false);
  return true;
}

export function clearProviderApiKey() {
  window.clearTimeout(secretTimer);
  const endpoint = config.baseUrl;
  commit({ ...config, apiKey: "", apiKeySet: false }, false);
  void saveServerSettingsNow({ provider: scrubProviderConfig(config) }).then(() => setServerSecret("provider", null, endpoint)).then(() => {
    if (config.baseUrl === endpoint) commit({ ...config, apiKey: "", apiKeySet: false }, false);
  }).catch(() => undefined);
}

/** Switch to a saved profile, including its server-held key. */
export function applyProviderProfile(profile: SavedProviderProfile) {
  const { apiKeySet, ...rest } = profile.config;
  const next = { ...config, ...rest, apiKey: "", apiKeySet: false, terminalToken: config.terminalToken };
  void switchAgentProvider(next).then(async (current) => {
    if (!current || next.kind !== "api" || next.baseUrl.replace(/\/+$/, "") === "/hermes-gw") return;
    const isSet = await copyServerSecret(`profile:${profile.id}`, "provider", next.baseUrl);
    if (config.kind === next.kind && config.baseUrl === next.baseUrl && config.model === next.model) {
      commit({ ...config, apiKeySet: isSet }, false);
    }
  }).catch(() => undefined);
}

async function hydrateFromServer() {
  const server = await fetchServerSettings();
  if (!server) return; // Offline / Tauri without the companion API: keep the local cache.
  if (server.provider) {
    config = { ...DEFAULT_PROVIDER_CONFIG, ...server.provider, apiKey: "", terminalToken: config.terminalToken };
    saveProviderConfig(config);
  } else {
    saveServerSettings({ provider: scrubProviderConfig(config) });
  }
  if (server.profiles && server.profiles.length > 0) {
    setProviderProfiles(server.profiles);
  } else if (loadProviderProfiles().length > 0) {
    saveServerSettings({ profiles: loadProviderProfiles() });
  }
  // One-time move of keys that older versions kept in localStorage.
  if (legacySecrets.provider && !config.apiKeySet) {
    const isSet = await setServerSecret("provider", legacySecrets.provider);
    config = { ...config, apiKeySet: isSet };
  }
  for (const [id, key] of Object.entries(legacySecrets.profiles)) {
    await setServerSecret(`profile:${id}`, key);
  }
  legacySecrets.provider = undefined;
  legacySecrets.profiles = {};
  clearLegacyProviderStorage();
  emit();
  window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_READY_EVENT));
}

if (typeof window !== "undefined") void hydrateFromServer();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AgentProviderConfig {
  return config;
}

/** React hook: live provider config shared across all agent panels. */
export function useAgentProvider(): AgentProviderConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
