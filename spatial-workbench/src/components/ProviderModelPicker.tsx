import { useEffect, useState } from "react";

export type CatalogProvider = {
  id: string;
  name: string;
  connected: boolean;
  models: Array<{ id: string; name: string }>;
  default_model?: string;
  custom?: boolean;
  base_url?: string;
};

type Catalog = {
  providers: CatalogProvider[];
  current: { provider: string; model: string };
  available: boolean;
  stale: boolean;
  warning?: string;
};

export function useProviderCatalog(engine: "hermes" | "opencode", active: boolean) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void fetch(`/api/model-catalog?engine=${engine}${revision ? "&refresh=1" : ""}`, { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Provider catalog could not be loaded");
      if (!controller.signal.aborted) setCatalog(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(String(failure));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [engine, active, revision]);
  return { catalog, loading, warning: error || catalog?.warning || "", refresh: () => setRevision(current => current + 1) };
}

export function ProviderModelPicker({ providers, providerId, modelId, onChange, worker = false, allowCustom = false }: {
  providers: CatalogProvider[];
  providerId: string;
  modelId: string;
  onChange: (provider: string, model: string, selected?: CatalogProvider) => void;
  worker?: boolean;
  allowCustom?: boolean;
}) {
  const [manualProvider, setManualProvider] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const choices = allowCustom && !providers.some(provider => provider.id === "custom")
    ? [...providers, { id: "custom", name: "Custom endpoint", connected: false, custom: true, models: [] }]
    : providers;
  const selected = choices.find(provider => provider.id === providerId);
  const models = selected?.models || [];
  const knownModel = models.some(model => model.id === modelId);
  return <>
    <label>Provider<select aria-label="Provider" value={manualProvider ? "__manual__" : providerId} onChange={event => {
      if (event.target.value === "__manual__") { setManualProvider(true); return; }
      const provider = choices.find(choice => choice.id === event.target.value);
      setManualProvider(false); setManualModel(false);
      onChange(event.target.value, provider?.default_model || provider?.models[0]?.id || modelId, provider);
    }}>
      {!selected && <option value={providerId}>{providerId || "Select provider"}</option>}
      {choices.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.connected ? worker ? " (main connected)" : " (connected)" : ""}</option>)}
      <option value="__manual__">Other provider...</option>
    </select></label>
    {manualProvider && <label>Provider ID<input required maxLength={80} value={providerId} onChange={event => onChange(event.target.value, modelId)} /></label>}
    <label>Model<select aria-label="Model" value={!manualModel && knownModel ? modelId : "__manual__"} onChange={event => {
      if (event.target.value === "__manual__") { setManualModel(true); return; }
      setManualModel(false); onChange(providerId, event.target.value, selected);
    }}>
      {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      <option value="__manual__">Enter model ID...</option>
    </select></label>
    {(manualModel || !knownModel) && <label>Model ID<input required maxLength={200} value={modelId} onChange={event => onChange(providerId, event.target.value, selected)} /></label>}
  </>;
}