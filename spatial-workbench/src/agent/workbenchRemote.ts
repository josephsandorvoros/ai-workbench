import { compatClient } from "../api/compatClient";

export interface RemoteArtifactRef {
  name: string;
  updatedAt: number;
}

export interface RemoteWorkbenchState {
  artifact: unknown;
  artifacts: RemoteArtifactRef[];
  chat_sessions: unknown[];
}

export async function loadRemoteWorkbenchState(): Promise<RemoteWorkbenchState | null> {
  try {
    const state = await compatClient.getWorkbenchState();
    return state.ok
      ? {
          artifact: state.artifact,
          artifacts: Array.isArray(state.artifacts) ? state.artifacts : [],
          chat_sessions: state.chat_sessions,
        }
      : null;
  } catch (_error) {
    return null;
  }
}

export async function loadRemoteArtifact(name: string): Promise<{ name: string; html: string; updatedAt: number } | null> {
  try {
    const result = await compatClient.getWorkbenchArtifact(name);
    return result.ok && result.artifact ? result.artifact : null;
  } catch (_error) {
    return null;
  }
}

export async function saveRemoteWorkbenchField(field: "artifact" | "chat_sessions", value: unknown) {
  try {
    const current = await compatClient.getWorkbenchState();
    await compatClient.saveWorkbenchState({
      artifact: field === "artifact" ? value : current.artifact,
      chat_sessions: field === "chat_sessions" ? (Array.isArray(value) ? value : []) : current.chat_sessions,
    });
  } catch (_error) {
    // Browser-only storage remains available if the dashboard API is unavailable.
  }
}
