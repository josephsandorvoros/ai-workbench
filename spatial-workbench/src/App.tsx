import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { detectRuntimeMode, getCapabilityView } from "./api/capabilityRegistry";
import { compatClient, type AppConfig, type CanvasDocument, type CapabilityState, type NodeStats, type StatsSourceResponse } from "./api/compatClient";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { SourceControlWorkbench } from "./components/SourceControlWorkbench";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WikiWorkbench } from "./components/WikiWorkbench";
import { AgentWorkbench } from "./components/AgentWorkbench";
import { SessionsWorkbench } from "./components/SessionsWorkbench";
import { AgentChat } from "./components/AgentChat";
import { DocumentCanvas } from "./components/DocumentCanvas";
import type { ActiveCanvasContext } from "./agent/activeCanvasContext";
import { CANVAS_ITEM_CREATED_EVENT } from "./agent/chatSessions";
import { CanvasCreationTracker } from "./agent/canvasCreationTracker";
import { useMobileChat } from "./lib/useMobileChat";
import { GuardrailsWorkbench } from "./components/GuardrailsWorkbench";
import { JobsBoard } from "./components/JobsBoard";
import { FreeModelsMenu } from "./components/FreeModelsMenu";
import { HelpMenu } from "./components/HelpMenu";
import { TerminalWorkbench, countUpdates, loadUpdates } from "./components/TerminalWorkbench";
import type { UpdatesStatus } from "./api/compatClient";
import {
  executeShellCommand,
  getDesktopRuntimeInfo,
  getRuntimeConfig,
  startShellCommandStream,
  startWorkspaceWatch,
  stopWorkspaceWatch,
  subscribeShellCommandOutput,
  subscribeWorkspaceFileEvents,
  type DesktopRuntimeInfo,
  type RuntimeConfig,
  type ShellCommandResult,
  type ShellCommandStreamEvent,
  type WorkspaceFileEvent,
} from "./api/tauriCommands";

// Node stats are cached server-side for 3s (dashboard_server.py stats_ttl_seconds).
// Polling at the same cadence keeps the hero metrics near-live without hammering the SSH fetch.
const STATS_POLL_MS = 3000;

interface CapabilityCardProps {
  label: string;
  state: CapabilityState;
  detail: string;
}

function CapabilityCard({ label, state, detail }: CapabilityCardProps) {
  return (
    <article className="capability-card">
      <div>
        <h3>{label}</h3>
        <p>{detail}</p>
      </div>
      <span className={`status-pill ${state}`}>{state}</span>
    </article>
  );
}

function formatPercent(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }
  return `${value.toFixed(1)}%`;
}

function formatTemperature(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }
  return `${value.toFixed(1)} C`;
}

function formatCapacity(gbValue: number | undefined) {
  if (typeof gbValue !== "number" || !Number.isFinite(gbValue)) {
    return "--";
  }
  return gbValue >= 1000 ? `${(gbValue / 1024).toFixed(1)} TB` : `${gbValue.toFixed(0)} GB`;
}

function firstTemperature(temperatures: Record<string, number> | undefined) {
  if (!temperatures) {
    return undefined;
  }
  return temperatures.thermal_zone0 ?? Object.values(temperatures)[0];
}

function gpuMemoryPercent(stats: NodeStats | null) {
  const used = stats?.gpu?.memory_used_gb;
  const total = stats?.gpu?.memory_total_gb;
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) {
    return stats?.gpu?.memory_percent ?? undefined;
  }
  return (used / total) * 100;
}

interface MetricPillProps {
  label: string;
  value: string;
  reading?: number | null;
  detail?: string;
}

type WorkspaceTab = "documents" | "sessions" | "project" | "source-control" | "jobs" | "board" | "wiki" | "agent" | "terminal" | "guardrails";

const SpatialBoard = lazy(() => import("./components/SpatialBoard").then((module) => ({ default: module.SpatialBoard })));

const workspaceTabs: Array<{
  id: WorkspaceTab;
  label: string;
  detail: string;
  icon: string;
}> = [
  {
    id: "documents",
    label: "Documents",
    detail: "Write and revisit documents linked to chats and projects.",
    icon: "M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6m-6 4h6",
  },
  {
    id: "project",
    label: "Projects",
    detail: "Project explorer and Monaco file view.",
    icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  },
  {
    id: "sessions",
    label: "Sessions",
    detail: "Browse and manage saved conversations.",
    icon: "M4 5h16v12H7l-3 3V5Zm4 4h8m-8 4h5",
  },
  {
    id: "source-control",
    label: "Source Control",
    detail: "Review repository changes, commit selected files, and sync with origin.",
    icon: "M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 3v18m0-12c0 3 12 3 12 3v3",
  },
  {
    id: "jobs",
    label: "Job Board",
    detail: "Review plans, track workers, and inspect completed jobs.",
    icon: "M4 5h16v14H4V5Zm3 3h4v3H7V8Zm6 1h4m-10 5h4v3H7v-3Zm6 1h4",
  },
  {
    id: "board",
    label: "Spatial Board",
    detail: "Excalidraw canvas with local persistence and compact context manifest.",
    icon: "M4 4h16v16H4V4Zm4 4h3v3H8V8Zm5 5h3v3h-3v-3Z",
  },
  {
    id: "wiki",
    label: "Wiki",
    detail: "Wiki browse, edit, save, and search through companion routes.",
    icon: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm2 0v12m3-9h7m-7 4h7",
  },
  {
    id: "agent",
    label: "Agent Workbench",
    detail: "Agent endpoints, skills, memory, sessions, and tools.",
    icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm7 10l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9L19 13Z",
  },
  {
    id: "terminal",
    label: "Terminal",
    detail: "Shell on the agent host: Hermes, OpenCode, and in-place updates.",
    icon: "M4 5h16v14H4V5Zm3 4l3 3-3 3m5 0h5",
  },
  {
    id: "guardrails",
    label: "Policy Settings",
    detail: "Execution policy controls, approval queue, and audit log.",
    icon: "M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3Zm-3 9l2.2 2.2L15.5 10",
  },
];

const WORKSPACE_TAB_STORAGE_KEY = "homelabSpatialWorkbench.activeWorkspaceTab";

function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return Boolean(value && workspaceTabs.some((tab) => tab.id === value));
}

function getInitialWorkspaceTab(): WorkspaceTab {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("tab");
    if (fromUrl === "chat") return "sessions";
    if (fromUrl === "artifacts") return "project";
    if (isWorkspaceTab(fromUrl)) return fromUrl;
    const fromStorage = window.localStorage.getItem(WORKSPACE_TAB_STORAGE_KEY);
    if (fromStorage === "chat") return "sessions";
    if (fromStorage === "artifacts") return "project";
    if (isWorkspaceTab(fromStorage)) return fromStorage;
  } catch (_error) {
    // Ignore restricted storage or URL access.
  }
  return "project";
}

function persistWorkspaceTab(tab: WorkspaceTab) {
  try {
    window.localStorage.setItem(WORKSPACE_TAB_STORAGE_KEY, tab);
  } catch (_error) {
    // Ignore restricted storage access.
  }
}

function MetricPill({ label, value, reading, detail, status }: MetricPillProps & { status?: "warning" | "critical" }) {
  const statusText = status === "critical" ? "Critical" : status === "warning" ? "High" : "";
  const fill = typeof reading === "number" && Number.isFinite(reading) ? Math.min(100, Math.max(0, reading)) : 0;
  return (
    <span className={`metric-gauge${status ? ` ${status}` : ""}`} aria-label={`${label}: ${value}${statusText ? `, ${statusText} usage` : ""}`} title={`${label}: ${value}${detail ? ` (${detail})` : ""}${statusText ? ` - ${statusText} usage` : ""}`}>
      <span className="metric-gauge-dial">
        <svg viewBox="0 0 72 58" aria-hidden="true">
          <path className="metric-gauge-track" d="M14.8 53.2 A30 30 0 1 1 57.2 53.2" pathLength="100" />
          <path className="metric-gauge-fill" d="M14.8 53.2 A30 30 0 1 1 57.2 53.2" pathLength="100" strokeDasharray="100 100" strokeDashoffset={100 - fill} visibility={fill > 0 ? "visible" : "hidden"} />
        </svg>
        <strong className="metric-gauge-value">{value}</strong>
      </span>
      <span className="metric-gauge-label">{label}</span>
    </span>
  );
}

function PlannedWorkspacePane({ label, detail, state }: { label: string; detail: string; state: CapabilityState }) {
  return (
    <section className="planned-pane" aria-label={label}>
      <div>
        <h2>{label}</h2>
        <p>{detail}</p>
      </div>
      <span className={`status-pill ${state}`}>{state}</span>
    </section>
  );
}

function formatShellEvent(event: ShellCommandStreamEvent) {
  const chunk = event.chunk.trim() || (event.done ? "done" : "...");
  const exit = event.exit_code === null ? "" : ` exit=${event.exit_code}`;
  return `[${event.stream}${exit}] ${chunk}`;
}

function formatWorkspaceEvent(event: WorkspaceFileEvent) {
  const paths = event.paths.length > 0 ? event.paths.join(", ") : "workspace";
  return `[${event.kind}] ${paths}`;
}

export function App() {
  const mobileChat = useMobileChat();
  const runtimeMode = detectRuntimeMode();
  const capabilityView = getCapabilityView(runtimeMode);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [stats, setStats] = useState<NodeStats | null>(null);
  const [statsSourceInfo, setStatsSourceInfo] = useState<StatsSourceResponse | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [shellProbe, setShellProbe] = useState<ShellCommandResult | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<CapabilityState>("unavailable");
  const [shellStatus, setShellStatus] = useState<CapabilityState>("unavailable");
  const [runtimeLog, setRuntimeLog] = useState<ShellCommandStreamEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<CapabilityState>("unavailable");
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>(() => getInitialWorkspaceTab());
  const [canvasOpen, setCanvasOpen] = useState(() => {
    if (mobileChat) return false;
    const tab = new URLSearchParams(window.location.search).get("tab");
    return isWorkspaceTab(tab) || tab === "artifacts" || tab === "chat";
  });
  const [visitedTabs, setVisitedTabs] = useState<WorkspaceTab[]>(() => canvasOpen ? [activeWorkspaceTab] : []);
  const [lastCanvasView, setLastCanvasView] = useState<"documents" | "project">(
    () => activeWorkspaceTab === "project" ? "project" : "documents",
  );
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasHeaderSlot, setCanvasHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [documentContext, setDocumentContext] = useState<ActiveCanvasContext>({ space: "Documents" });
  const [projectContext, setProjectContext] = useState<ActiveCanvasContext>({ space: "Projects" });
  const [wikiContext, setWikiContext] = useState<ActiveCanvasContext>({ space: "Wiki" });
  const showCanvas = canvasOpen && !mobileChat;
  const canvasTriggerRef = useRef<HTMLButtonElement>(null);
  const [projectFocus, setProjectFocus] = useState<{ path: string; request: number } | null>(null);
  const [projectFileRequest, setProjectFileRequest] = useState<{ path: string; request: number } | null>(null);
  const [projectBrowseRequest, setProjectBrowseRequest] = useState(0);
  const [createdCanvasItem, setCreatedCanvasItem] = useState<CanvasDocument | null>(null);
  const [openCreatedRequest, setOpenCreatedRequest] = useState(0);
  const [canvasItemNotice, setCanvasItemNotice] = useState(false);
  const [canvasSyncError, setCanvasSyncError] = useState("");
  const [sourceControlPath, setSourceControlPath] = useState("");
  const [updates, setUpdates] = useState<UpdatesStatus | null>(null);
  const refreshUpdates = useCallback((force = false) => {
    loadUpdates(force).then(setUpdates).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (mobileChat) return;
    refreshUpdates();
    const timer = window.setInterval(() => refreshUpdates(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refreshUpdates, mobileChat]);
  const updateCount = countUpdates(updates);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<CapabilityState>("unavailable");
  const [watchLog, setWatchLog] = useState<WorkspaceFileEvent[]>([]);

  useEffect(() => {
    if (mobileChat) return;
    let live = true;
    void compatClient.getStatsSource().then((result) => {
      if (live) setStatsSourceInfo(result);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [mobileChat]);

  const [sidePanelWidth, setSidePanelWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem("spatial-workbench.canvasWidth"));
      return Number.isFinite(stored) && stored >= 360 ? stored : 640;
    } catch {
      return 640;
    }
  });
  const [resizing, setResizing] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [canvasMaxWidth, setCanvasMaxWidth] = useState(960);

  useEffect(() => {
    if (mobileChat) return;
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(() => {
      const railWidth = grid.querySelector("nav")?.clientWidth ?? 164;
      const max = Math.max(360, grid.clientWidth - railWidth - 356);
      setCanvasMaxWidth(max);
      setSidePanelWidth((width) => Math.min(width, max));
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [mobileChat]);

  function resizeCanvas(width: number) {
    const next = Math.min(canvasMaxWidth, Math.max(360, width));
    setSidePanelWidth(next);
    try {
      localStorage.setItem("spatial-workbench.canvasWidth", String(next));
    } catch {
      // The canvas remains resizable when browser storage is restricted.
    }
  }

  useEffect(() => {
    let cancelled = false;
    let statsInFlight = false;
    let statsTimer: number | undefined;

    async function loadConfig() {
      try {
        const nextConfig = await compatClient.getConfig();
        if (cancelled) return;
        setConfig(nextConfig);
      } catch (_error) {
        // Config is best-effort; stats polling drives the visible state.
      }
    }

    async function pollStats() {
      if (statsInFlight) return;
      statsInFlight = true;
      try {
        const nextStats = await compatClient.getStats();
        if (cancelled) return;
        setStats(nextStats);
      } catch (_error) {
      } finally {
        statsInFlight = false;
        if (!cancelled) {
          statsTimer = window.setTimeout(pollStats, STATS_POLL_MS);
        }
      }
    }

    async function loadDesktopState() {
      try {
        const [info, nextRuntimeConfig] = await Promise.all([
          getDesktopRuntimeInfo(),
          getRuntimeConfig(),
        ]);
        if (cancelled) return;
        setRuntimeInfo(info);
        setRuntimeConfig(nextRuntimeConfig);
        setDesktopStatus(info ? "available" : "unavailable");
        if (!info) {
          setShellStatus("unavailable");
          return;
        }
        const probe = await executeShellCommand({ command: "printf spatial-runtime-ready" });
        if (cancelled) return;
        setShellProbe(probe);
        setShellStatus(probe?.ok ? "available" : "error");
      } catch (_error) {
        if (cancelled) return;
        setDesktopStatus("error");
        setShellStatus("error");
      }
    }

    void loadConfig();
    if (!mobileChat) {
      void pollStats();
      void loadDesktopState();
    }

    return () => {
      cancelled = true;
      if (statsTimer !== undefined) {
        window.clearTimeout(statsTimer);
      }
    };
  }, [mobileChat]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeShellCommandOutput((event) => {
      setRuntimeLog((current) => [...current, event].slice(-24));
      if (event.done) {
        setStreamStatus(event.exit_code === 0 ? "available" : "error");
      }
    }).then((nextUnsubscribe) => {
      if (disposed) {
        nextUnsubscribe();
        return;
      }
      unsubscribe = nextUnsubscribe;
    });

    return () => {
      disposed = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeWorkspaceFileEvents((event) => {
      setWatchLog((current) => [...current, event].slice(-16));
      setWatchStatus(event.kind === "Error" ? "error" : "available");
    }).then((nextUnsubscribe) => {
      if (disposed) {
        nextUnsubscribe();
        return;
      }
      unsubscribe = nextUnsubscribe;
    });

    return () => {
      disposed = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  async function runStreamProbe() {
    if (!runtimeInfo) {
      setStreamStatus("unavailable");
      return;
    }

    setRuntimeLog([]);
    setStreamStatus("degraded");
    try {
      const jobId = await startShellCommandStream({
        command: "printf 'stream probe start\\n' && printf 'stream probe done\\n'",
      });
      if (!jobId) {
        setStreamStatus("unavailable");
      }
    } catch (_error) {
      setStreamStatus("error");
    }
  }

  async function toggleWorkspaceWatch() {
    if (!runtimeInfo) {
      setWatchStatus("unavailable");
      return;
    }

    if (watchId) {
      try {
        await stopWorkspaceWatch(watchId);
        setWatchId(null);
        setWatchStatus("degraded");
      } catch (_error) {
        setWatchStatus("error");
      }
      return;
    }

    setWatchStatus("degraded");
    try {
      const nextWatchId = await startWorkspaceWatch("");
      setWatchId(nextWatchId);
      setWatchStatus(nextWatchId ? "available" : "unavailable");
    } catch (_error) {
      setWatchStatus("error");
    }
  }

  function selectWorkspaceTab(tab: WorkspaceTab) {
    if (mobileChat) return;
    setActiveWorkspaceTab(tab);
    if (tab === "documents" || tab === "project") setLastCanvasView(tab);
    setVisitedTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setCanvasOpen(true);
    persistWorkspaceTab(tab);
  }

  useEffect(() => {
    function onCreated(event: Event) {
      const detail = (event as CustomEvent<{ chatId: string; document: CanvasDocument }>).detail;
      if (!detail?.document || detail.chatId !== activeChatId) return;
      setCreatedCanvasItem(detail.document);
      const activeDirty = showCanvas && (
        (activeWorkspaceTab === "project" && projectContext.dirty) ||
        (activeWorkspaceTab === "wiki" && wikiContext.dirty)
      );
      if (mobileChat || documentContext.dirty || activeDirty) {
        setCanvasItemNotice(true);
      } else {
        setCanvasItemNotice(false);
        setOpenCreatedRequest((current) => current + 1);
        selectWorkspaceTab("documents");
      }
    }
    window.addEventListener(CANVAS_ITEM_CREATED_EVENT, onCreated);
    return () => window.removeEventListener(CANVAS_ITEM_CREATED_EVENT, onCreated);
  }, [activeChatId, showCanvas, activeWorkspaceTab, projectContext.dirty, wikiContext.dirty, documentContext.dirty, mobileChat]);

  useEffect(() => {
    if (!activeChatId) return;
    const chatId = activeChatId;
    let active = true;
    let inFlight = false;
    const tracker = new CanvasCreationTracker();
    const rememberCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; document: CanvasDocument }>).detail;
      if (detail?.chatId === chatId && detail.document) tracker.remember(detail.document.id);
    };
    async function syncCreatedItems() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await compatClient.listCanvasDocuments();
        if (!result.ok) throw new Error("The document library is unavailable.");
        if (!active) return;
        const created = tracker.update(result.documents, chatId);
        setCanvasSyncError("");
        if (created) {
          window.dispatchEvent(new CustomEvent(CANVAS_ITEM_CREATED_EVENT, { detail: { chatId, document: created } }));
        }
      } catch (reason) {
        if (active) setCanvasSyncError(`Could not check for new Canvas items: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        inFlight = false;
      }
    }
    window.addEventListener(CANVAS_ITEM_CREATED_EVENT, rememberCreated);
    void syncCreatedItems();
    const timer = window.setInterval(() => void syncCreatedItems(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(CANVAS_ITEM_CREATED_EVENT, rememberCreated);
    };
  }, [activeChatId]);

  function closeCanvas() {
    setCanvasOpen(false);
    canvasTriggerRef.current?.focus();
  }

  function openSourceControl(path: string) {
    setSourceControlPath(path);
    selectWorkspaceTab("source-control");
  }

  const statsSource = "AI node monitor";
  async function changeStatsSource(source: StatsSourceResponse["selected"]) {
    try {
      const result = await compatClient.setStatsSource(source);
      setStatsSourceInfo(result);
      const refreshed = await compatClient.getStats();
      setStats(refreshed);
    } catch (_error) {
      // Keep the current monitor selection and metrics visible if the change fails.
    }
  }
  const cpuTemp = firstTemperature(stats?.temperatures);
  const gpuVramPercent = gpuMemoryPercent(stats);
  const hermesDetail = runtimeConfig
    ? `CLI: ${runtimeConfig.hermes_cli_path}; endpoint: ${runtimeConfig.hermes_endpoint_url || "not configured"}`
    : "Runtime config is available in Tauri desktop mode.";
  return (
    <main className="app-shell chat-first-shell">
      <header className="hero-card">
        <div className="hero-title">
          <h1>AI Workbench</h1>
          <p className="hero-tagline">Your models. Your rules.</p>
        </div>
        {!mobileChat && <div className="hero-status">
          <FreeModelsMenu />
          <HelpMenu />
          <button
            ref={canvasTriggerRef}
            className="canvas-trigger"
            type="button"
            aria-expanded={showCanvas}
            aria-controls="workbench-canvas"
            onClick={() => canvasOpen ? closeCanvas() : selectWorkspaceTab(lastCanvasView)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></svg>
            Canvas
          </button>
        </div>}
        {!mobileChat && <div className="hero-metrics" aria-label="Node monitor">
          <MetricPill label="CPU" value={formatPercent(stats?.cpu?.usage_percent)} reading={stats?.cpu?.usage_percent} detail={`${stats?.cpu?.core_count ?? "--"} vCPU`} />
          <MetricPill label="CPU T" value={formatTemperature(cpuTemp)} reading={cpuTemp} detail="Scale: 0-100 C" />
          <MetricPill label="GPU" value={formatPercent(stats?.gpu?.utilization_gpu)} reading={stats?.gpu?.utilization_gpu} detail={stats?.gpu ? "NVIDIA source" : "No GPU data"} />
          <MetricPill
            label="VRAM"
            value={formatPercent(gpuVramPercent)}
            reading={gpuVramPercent}
            detail={stats?.gpu ? `${formatCapacity(stats.gpu.memory_used_gb)} / ${formatCapacity(stats.gpu.memory_total_gb)}` : "No GPU data"}
          />
          <MetricPill label="GPU T" value={formatTemperature(stats?.gpu?.temperature_gpu)} reading={stats?.gpu?.temperature_gpu} detail="Scale: 0-100 C" />
          <MetricPill
            label="RAM"
            value={formatPercent(stats?.memory?.percentage)}
            reading={stats?.memory?.percentage}
            detail={`${formatCapacity(stats?.memory?.used_gb)} / ${formatCapacity(stats?.memory?.total_gb)}`}
          />
          <MetricPill
            label="Disk"
            value={formatPercent(stats?.disk?.percentage)}
            reading={stats?.disk?.percentage}
            detail={`${formatCapacity(stats?.disk?.used_gb)} / ${formatCapacity(stats?.disk?.total_gb)}`}
            status={typeof stats?.disk?.percentage === "number" && stats.disk.percentage >= 95 ? "critical" : typeof stats?.disk?.percentage === "number" && stats.disk.percentage >= 85 ? "warning" : undefined}
          />
          <MetricPill label="Proc" value={typeof stats?.process_count === "number" ? String(stats.process_count) : "--"} detail="Process count; no fixed maximum" />
          <label className="hero-metrics-source" title={statsSourceInfo?.source_label || statsSource}>
            <span>Monitor</span>
            <select aria-label="Stats monitor source" value={statsSourceInfo?.selected || "configured"} onChange={(event) => void changeStatsSource(event.target.value as StatsSourceResponse["selected"])}>
              {(statsSourceInfo?.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              {!statsSourceInfo && <option value="configured">{statsSource}</option>}
            </select>
          </label>
          {updateCount > 0 ? (
            <button
              className="status-pill degraded update-pill"
              type="button"
              title="Updates available — open the CLI tab for details"
              onClick={() => selectWorkspaceTab("terminal")}
            >
              {updateCount} update{updateCount > 1 ? "s" : ""}
            </button>
          ) : null}
        </div>}
      </header>

      <div
        className={`main-grid conversation-layout${showCanvas ? " canvas-open" : ""}${canvasExpanded ? " canvas-expanded" : ""}${resizing ? " resizing" : ""}`}
        ref={gridRef}
        style={{ "--canvas-width": `${sidePanelWidth}px` } as React.CSSProperties}
      >
        {!mobileChat && <nav className="activity-bar" aria-label="Workspace tools">
          <button
            className={`activity-btn conversation-home${!canvasOpen ? " active" : ""}`}
            type="button"
            aria-label="Chat"
            aria-current={!canvasOpen ? "page" : undefined}
            onClick={() => {
              setCanvasOpen(false);
              document.querySelector<HTMLTextAreaElement>(".agent-chat-input")?.focus();
            }}
            title="Chat"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v12H7l-3 3V5Zm4 4h8m-8 4h5" /></svg>
            <span>Chat</span>
          </button>
          <span className="activity-label">Canvas</span>
          {workspaceTabs.map((tab) => (
            <div className="activity-group-item" key={tab.id}>
              {tab.id === "sessions" && <span className="activity-label">Tools</span>}
              <button
                aria-current={canvasOpen && activeWorkspaceTab === tab.id ? "page" : undefined}
                aria-label={tab.label}
                className={`activity-btn ${canvasOpen && activeWorkspaceTab === tab.id ? "active" : ""}`}
                onClick={() => selectWorkspaceTab(tab.id)}
                title={tab.label}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={tab.icon} />
                </svg>
                <span>{tab.label}</span>
              </button>
            </div>
          ))}
          <p className="activity-footer">Your models.<br />Your rules.</p>
        </nav>}

        <section className="conversation-stage" aria-label="Conversation">
          <AgentChat onActiveSessionChange={setActiveChatId} canvasSyncError={canvasSyncError} canvasNotice={canvasItemNotice && createdCanvasItem?.chat_id === activeChatId ? createdCanvasItem.title : undefined} onOpenCanvasItem={() => {
            setOpenCreatedRequest((current) => current + 1);
            selectWorkspaceTab("documents");
          }} canvasContext={!showCanvas ? null
            : activeWorkspaceTab === "documents" ? documentContext
              : activeWorkspaceTab === "project" ? projectContext
                : activeWorkspaceTab === "wiki" ? wikiContext
                  : { space: workspaceTabs.find((tab) => tab.id === activeWorkspaceTab)?.label || "Workspace" }} />
        </section>

        <section
          id="workbench-canvas"
          className="workspace-panel workbench-canvas"
          aria-label="Workspace canvas"
          hidden={!showCanvas}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              if (event.target instanceof Element && event.target.closest("dialog[open], [role='dialog']")) return;
              event.stopPropagation();
              closeCanvas();
            }
          }}
        >
          <div
            className="panel-resize-handle"
            role="separator"
            tabIndex={canvasExpanded ? -1 : 0}
            aria-orientation="vertical"
            aria-label="Resize canvas"
            aria-valuemin={360}
            aria-valuemax={canvasMaxWidth}
            aria-valuenow={sidePanelWidth}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const rect = gridRef.current?.getBoundingClientRect();
              if (rect) resizeCanvas(rect.right - event.clientX);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              setResizing(false);
            }}
            onLostPointerCapture={() => setResizing(false)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                resizeCanvas(sidePanelWidth + (event.key === "ArrowLeft" ? 40 : -40));
              }
            }}
            title="Drag or use arrow keys to resize"
          />
          <header className="canvas-header">
            <div className="canvas-header-main">
              <span className="canvas-heading">{activeWorkspaceTab === "documents" || activeWorkspaceTab === "project"
                ? "Canvas"
                : workspaceTabs.find((item) => item.id === activeWorkspaceTab)?.label}</span>
              <div ref={setCanvasHeaderSlot} className="canvas-header-slot" hidden={activeWorkspaceTab !== "documents" && activeWorkspaceTab !== "project"} />
            </div>
            <div className="canvas-actions">
              <button className="canvas-icon-btn" type="button" aria-label={canvasExpanded ? "Restore canvas size" : "Expand canvas"} aria-pressed={canvasExpanded} onClick={() => setCanvasExpanded((value) => !value)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={canvasExpanded ? "M4 9h5V4m11 11h-5v5M9 9 3 3m12 12 6 6" : "M9 4H4v5m11 11h5v-5M4 4l6 6m10 10-6-6"} /></svg>
              </button>
              <button className="canvas-icon-btn" type="button" aria-label="Close canvas" onClick={closeCanvas}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
          </header>
          <div className="workspace-tab-panels">
            <div className="canvas-content-panel" hidden={activeWorkspaceTab !== "documents" && activeWorkspaceTab !== "project"}>
              {(visitedTabs.includes("documents") || visitedTabs.includes("project")) && <DocumentCanvas
                chatId={activeChatId}
                headerSlot={canvasHeaderSlot}
                active={showCanvas && (activeWorkspaceTab === "documents" || activeWorkspaceTab === "project")}
                onContextChange={setDocumentContext}
                createdItem={createdCanvasItem}
                openCreatedRequest={openCreatedRequest}
                onCreatedItemOpened={() => setCanvasItemNotice(false)}
                projectMode={activeWorkspaceTab === "project"}
                activeProjectPath={projectContext.detail}
                onOpenProjects={() => {
                  setProjectBrowseRequest((current) => current + 1);
                  selectWorkspaceTab("project");
                }}
                onOpenDocuments={() => selectWorkspaceTab("documents")}
                onOpenProjectFile={(path) => {
                  setProjectFileRequest((current) => ({ path, request: (current?.request ?? 0) + 1 }));
                  selectWorkspaceTab("project");
                }}
                projectContent={<ProjectWorkspace
                  chatId={activeChatId}
                  focusPath={projectFocus?.path}
                  focusRequest={projectFocus?.request}
                  openFileRequest={projectFileRequest}
                  browseRequest={projectBrowseRequest}
                  onOpenSourceControl={openSourceControl}
                  onContextChange={setProjectContext}
                />}
              />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "sessions"}
              id="workspace-panel-sessions"
              role="region"
              aria-label="Sessions"
            >
              {visitedTabs.includes("sessions") && <SessionsWorkbench />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "source-control"}
              id="workspace-panel-source-control"
              role="region"
              aria-label="Source Control"
            >
              {visitedTabs.includes("source-control") && <SourceControlWorkbench
                active={showCanvas && activeWorkspaceTab === "source-control"}
                initialPath={sourceControlPath}
                onOpenProjects={() => selectWorkspaceTab("project")}
              />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "wiki"}
              id="workspace-panel-wiki"
              role="region"
              aria-label="Wiki"
            >
              {visitedTabs.includes("wiki") && <WikiWorkbench onContextChange={setWikiContext} />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "board"}
              id="workspace-panel-board"
              role="region"
              aria-label="Spatial Board"
            >
              {visitedTabs.includes("board") && <ErrorBoundary label="Spatial Board">
                <Suspense fallback={<PlannedWorkspacePane label="Spatial Board" detail="Loading canvas..." state="degraded" />}>
                  <SpatialBoard />
                </Suspense>
              </ErrorBoundary>}
            </div>
            <div hidden={activeWorkspaceTab !== "jobs"} id="workspace-panel-jobs" role="region" aria-label="Job Board">
              {visitedTabs.includes("jobs") && <JobsBoard active={showCanvas && activeWorkspaceTab === "jobs"} onOpenFiles={(jobId) => {
                setProjectFocus({ path: `jobs/${jobId}`, request: Date.now() });
                selectWorkspaceTab("project");
              }} />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "agent"}
              id="workspace-panel-agent"
              role="region"
              aria-label="Agent Workbench"
            >
              {visitedTabs.includes("agent") && <AgentWorkbench />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "terminal"}
              id="workspace-panel-terminal"
              role="region"
              aria-label="Terminal"
            >
              {visitedTabs.includes("terminal") && <TerminalWorkbench
                active={showCanvas && activeWorkspaceTab === "terminal"}
                updates={updates}
                onRefreshUpdates={() => refreshUpdates(true)}
              />}
            </div>
            <div
              hidden={activeWorkspaceTab !== "guardrails"}
              id="workspace-panel-guardrails"
              role="region"
              aria-label="Policy Settings"
            >
              {visitedTabs.includes("guardrails") && <GuardrailsWorkbench />}
            </div>
          </div>
        </section>

      </div>
    </main>
  );
}