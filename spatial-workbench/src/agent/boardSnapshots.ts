import type { CompactNode } from "./canvasManifest";

export const BOARD_SNAPSHOTS_KEY = "homelabSpatialWorkbench.boardSnapshots.v1";

export interface BoardSnapshot {
  id: string;
  name: string;
  createdAt: number;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export function loadBoardSnapshots(): BoardSnapshot[] {
  try {
    const raw = window.localStorage.getItem(BOARD_SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BoardSnapshot[];
    return Array.isArray(parsed) ? parsed.filter((snapshot) => snapshot?.id && snapshot?.name && Array.isArray(snapshot.elements)) : [];
  } catch (_error) {
    return [];
  }
}

export function saveBoardSnapshot(name: string, state: Omit<BoardSnapshot, "id" | "name" | "createdAt">): BoardSnapshot[] {
  const normalized = name.trim();
  if (!normalized) return loadBoardSnapshots();
  const current = loadBoardSnapshots();
  const existing = current.find((snapshot) => snapshot.name.toLowerCase() === normalized.toLowerCase());
  const snapshot: BoardSnapshot = {
    id: existing?.id ?? `drawing-${Date.now()}`,
    name: normalized,
    createdAt: Date.now(),
    ...state,
  };
  const next = existing
    ? current.map((item) => (item.id === existing.id ? snapshot : item))
    : [snapshot, ...current];
  window.localStorage.setItem(BOARD_SNAPSHOTS_KEY, JSON.stringify(next.slice(0, 50)));
  return next.slice(0, 50);
}

export function deleteBoardSnapshot(id: string): BoardSnapshot[] {
  const next = loadBoardSnapshots().filter((snapshot) => snapshot.id !== id);
  window.localStorage.setItem(BOARD_SNAPSHOTS_KEY, JSON.stringify(next));
  return next;
}
