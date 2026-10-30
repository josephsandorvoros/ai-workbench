import type { CapabilityState } from "./compatClient";

export type RuntimeMode = "browser-remote" | "tauri-desktop";
export type CapabilitySource = "http" | "tauri" | "planned" | "hybrid";

export interface CapabilityDescriptor {
  id: string;
  label: string;
  source: CapabilitySource;
  browserState: CapabilityState;
  tauriState: CapabilityState;
  browserDetail: string;
  tauriDetail: string;
}

export function detectRuntimeMode(): RuntimeMode {
  return "__TAURI_INTERNALS__" in (globalThis as Record<string, unknown>)
    ? "tauri-desktop"
    : "browser-remote";
}

export function describeRuntimeMode(mode: RuntimeMode) {
  if (mode === "tauri-desktop") {
    return {
      label: "Tauri Desktop Mode",
      detail: "Native filesystem, shell, and stream events can be enabled through Tauri commands.",
    };
  }

  return {
    label: "Browser Remote Mode",
    detail: "Remote-safe features come from the same-origin companion API; native desktop commands stay disabled.",
  };
}

export const capabilityRegistry: CapabilityDescriptor[] = [
  {
    id: "compat-api",
    label: "Remote Companion API",
    source: "http",
    browserState: "available",
    tauriState: "available",
    browserDetail: "Dashboard API provides stats, workspace files, agent data, shared artifacts, and chat-session persistence.",
    tauriDetail: "Uses the same companion API alongside native desktop capabilities.",
  },
  {
    id: "native-runtime",
    label: "Native Runtime",
    source: "tauri",
    browserState: "unavailable",
    tauriState: "available",
    browserDetail: "Unavailable in browser mode by design.",
    tauriDetail: "Available through Tauri commands when the desktop shell launches with a display.",
  },
  {
    id: "workspace",
    label: "Workspace Files",
    source: "hybrid",
    browserState: "available",
    tauriState: "degraded",
    browserDetail: "Wiki, project files, HTML artifacts, and shared workbench state use companion API routes.",
    tauriDetail: "Uses companion API now; native filesystem commands remain available for desktop-only operations.",
  },
  {
    id: "spatial-board",
    label: "Spatial Board",
    source: "hybrid",
    browserState: "available",
    tauriState: "available",
    browserDetail: "Excalidraw board has local persistence, named snapshots, compact manifest, and agent visual tools.",
    tauriDetail: "Same board surface with companion persistence and native desktop runtime available.",
  },
  {
    id: "agent-loop",
    label: "Agent Tool Loop",
    source: "hybrid",
    browserState: "available",
    tauriState: "available",
    browserDetail: "API streaming, shared Hermes context, Plan/Ask/Auto policy, board tools, HTML artifact tools, and session restore.",
    tauriDetail: "Same agent loop with native shell commands available through Tauri.",
  },
  {
    id: "shared-state",
    label: "Shared Workbench State",
    source: "http",
    browserState: "available",
    tauriState: "available",
    browserDetail: "Dashboard persists artifacts and chat sessions under ~/.hermes/spatial-workbench/state.json.",
    tauriDetail: "Uses the same VM-hosted state API, with local browser fallback.",
  },
];

export function getCapabilityView(mode: RuntimeMode) {
  return capabilityRegistry.map((capability) => ({
    ...capability,
    state: mode === "tauri-desktop" ? capability.tauriState : capability.browserState,
    detail: mode === "tauri-desktop" ? capability.tauriDetail : capability.browserDetail,
  }));
}