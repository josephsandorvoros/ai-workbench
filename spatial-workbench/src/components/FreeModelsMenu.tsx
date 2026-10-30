import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFreeModels, type FreeModel, type FreeModelsResponse } from "../api/compatClient";
import { Icon, type IconName } from "./Icon";

const SOURCES = [
  { key: "zen", label: "OpenCode Zen", url: "https://opencode.ai/docs/zen/#pricing" },
  { key: "api", label: "Free API models", url: "https://github.com/ClawLabsAI/free-ai-models" },
] as const;

function tokens(value: number | null) {
  if (!value) return "Unknown";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M` : `${Math.round(value / 1000)}K`;
}

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not fetched" : date.toLocaleString();
}

function Capability({ icon, label }: { icon: IconName; label: string }) {
  return <span className="free-model-capability" title={label} aria-label={label}><Icon name={icon} size={14} /></span>;
}

function ModelRow({ model, copy }: { model: FreeModel; copy: (model: FreeModel) => void }) {
  return (
    <li className="free-model-row">
      <a className="free-model-link" href={model.url} target="_blank" rel="noopener noreferrer"
        onContextMenu={(event) => { event.preventDefault(); copy(model); }} title={`${model.id}\n${model.rate_limit}`}>
        <span className="free-model-name">{model.rank && <small>#{model.rank}</small>}{model.name}</span>
        <span className="free-model-meta" title={`Tool calling: ${model.tools === null ? "unknown" : model.tools ? "yes" : "no"}; reasoning: ${model.reasoning === null ? "unknown" : model.reasoning ? "yes" : "no"}`}><span>{model.provider}</span>
          {model.input_modalities.map((modality) => <Capability key={modality}
            icon={modality === "image" ? "image" : modality === "file" ? "file" : modality === "text" ? "note" : modality === "audio" ? "audio" : "video"}
            label={`${modality === "image" ? "Vision" : modality.charAt(0).toUpperCase() + modality.slice(1)} input`} />)}
          {model.tools === true && <Capability icon="gear" label="Tool calling" />}
          {model.reasoning === true && <Capability icon="bolt" label="Reasoning" />}
          {model.output_modalities.filter((modality) => modality !== "text").map((modality) => <span key={modality} className="free-model-output">{modality} output</span>)}
        </span>
        <span className="free-model-limits">{model.rate_limit || "Rate limit unknown"}</span>
        {(model.health || model.expires || model.answering_now) && <span className={`free-model-health ${model.health || ""}`}>
          {model.answering_now ? "Tracker: answering now" : model.health === "ok" ? "Tracker: up" : model.health === "sick" ? "Tracker: degraded" : model.health === "dead" ? "Tracker: down" : ""}
          {model.expires && ` / Retires ${model.expires}`}
        </span>}
        <span className="free-model-context" title={`Context: ${model.context?.toLocaleString() || "unknown"} tokens; max output: ${model.output?.toLocaleString() || "unknown"} tokens`}>
          <strong>{tokens(model.context)}</strong><small>context</small><small>{tokens(model.output)} out</small>
        </span>
      </a>
      <button className="free-model-icon-btn" type="button" title={`Copy model ID: ${model.id}`} aria-label={`Copy model ID: ${model.id}`} onClick={() => copy(model)}><Icon name="copy" size={15} /></button>
    </li>
  );
}

export function FreeModelsMenu() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FreeModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 80, left: 12 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await fetchFreeModels(force);
      if (mountedRef.current) setData(result);
    } catch {
      if (mountedRef.current) setError("Free model tracker unavailable. Try refreshing.");
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 24 * 60 * 60 * 1000);
    return () => { mountedRef.current = false; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!open) return;
    function positionPanel() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: Math.min(rect.bottom + 8, window.innerHeight - 180), left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(560, window.innerWidth - 24) - 12)) });
    }
    function outside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    positionPanel();
    panelRef.current?.focus();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", positionPanel);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", positionPanel); };
  }, [open]);

  async function copy(model: FreeModel) {
    try {
      await navigator.clipboard.writeText(model.id);
      setNotice(`Copied ${model.id}`);
    } catch {
      setNotice(`Clipboard unavailable. Model ID: ${model.id}`);
    }
  }

  function topModel() {
    const top = data?.sections.api.models.find((model) => model.rank !== null);
    setNotice(top ? `Top-ranked free API model: ${top.name} / #${top.rank} (tracker snapshot ${timestamp(data?.sections.api.snapshot_at || "")})` : "No ranked free API model in the current snapshot.");
  }

  const count = data ? data.sections.zen.models.length + data.sections.api.models.length : null;
  const stale = data && Object.values(data.sections).some((section) => section.stale);
  return (
    <div className="free-model-menu" ref={rootRef}>
      <button ref={buttonRef} className="free-model-pill" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="free-model-panel"
        title="Free AI models: click to browse, middle-click to refresh, right-click for top-ranked model"
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void refresh(true); } }}
        onContextMenu={(event) => { event.preventDefault(); topModel(); }}>
        <Icon name="hexagon" size={16} /><span>Free AI</span><strong>{count ?? (loading ? "..." : "--")}</strong>
        {(stale || error) && <span className="free-model-stale" title="Some model data is unavailable or stale">!</span>}
        <Icon name="chevron-down" size={12} />
      </button>
      {notice && <div className="free-model-notice" role="status">{notice}</div>}
      {open && <div ref={panelRef} id="free-model-panel" className="free-model-panel" role="dialog" aria-label="Free AI models" tabIndex={-1}
        style={{ top: position.top, left: position.left, maxHeight: `min(650px, calc(100dvh - ${position.top + 12}px))` }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); }
          if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey && !event.altKey && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); void refresh(true); }
        }}>
        <div className="free-model-panel-head"><h2>Free AI models</h2><span>{count ?? 0} tracked</span>
          <button className="free-model-icon-btn" type="button" disabled={loading} title="Refresh models" aria-label="Refresh models" onClick={() => void refresh(true)}><Icon name="refresh" /></button>
          <button className="free-model-icon-btn" type="button" title="Close free models" aria-label="Close free models" onClick={() => { setOpen(false); buttonRef.current?.focus(); }}><Icon name="x" /></button>
        </div>
        <input className="free-model-search" aria-label="Filter free models" placeholder="Filter models" value={query} onChange={(event) => setQuery(event.target.value)} />
        {loading && <div className="free-model-message" role="status">Refreshing catalogues...</div>}
        {error && <div className="free-model-message free-model-stale" role="alert">{error}</div>}
        <div className="free-model-scroll">{SOURCES.map((source) => {
          const section = data?.sections[source.key];
          const models = section?.models.filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query.toLowerCase().trim())) || [];
          return <section key={source.key} className="free-model-section" aria-label={source.label}>
            <div className="free-model-section-head"><h3>{source.label} <small>{section?.models.length ?? 0}</small></h3>
              <a href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.label} source`} aria-label={`${source.label} source`}><Icon name="globe" size={15} /></a>
            </div>
            <div className="free-model-snapshot">{source.key === "api" ? "Snapshot" : "Checked"}: {timestamp(section?.snapshot_at || section?.fetched_at || "")}</div>
            {source.key === "zen" && <div className="free-model-message">Free offers may end. Provider terms and data policies apply.</div>}
            {section?.stale && <div className="free-model-message free-model-stale" role="status">{section.error}{section.models.length > 0 ? "; showing cached models" : ""}</div>}
            <ul className="free-model-list">{models.map((model) => <ModelRow key={model.id} model={model} copy={(value) => void copy(value)} />)}</ul>
            {!models.length && !loading && <div className="free-model-message">{query ? "No matching models" : "No models available"}</div>}
          </section>;
        })}</div>
      </div>}
    </div>
  );
}