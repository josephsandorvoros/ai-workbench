/**
 * Compact, model-readable manifest of the Spatial Board canvas.
 * Shared by the SpatialBoard UI and the agent tool executor so both read
 * the same persisted board state.
 */

export interface CompactNode {
  id: string;
  type: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BOARD_STORAGE_KEY = "homelabSpatialWorkbench.board.v1";
export const BOARD_COMMAND_EVENT = "homelabSpatialWorkbench.boardCommand";
export const BOARD_REFRESH_EVENT = "homelabSpatialWorkbench.boardRefresh";

type RawElement = Record<string, unknown>;

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function compactElement(element: RawElement): CompactNode | null {
  if (element.isDeleted === true) return null;
  const type = asString(element.type);
  if (!type || type === "freedraw" || type === "image") return null;

  return {
    id: asString(element.id),
    type,
    text: asString(element.text),
    x: Math.round(asNumber(element.x)),
    y: Math.round(asNumber(element.y)),
    width: Math.round(asNumber(element.width)),
    height: Math.round(asNumber(element.height)),
  };
}

export function loadCanvasManifest(): { nodes: CompactNode[] } {
  try {
    const raw = window.localStorage.getItem(BOARD_STORAGE_KEY);
    if (!raw) return { nodes: [] };
    const parsed = JSON.parse(raw) as { elements?: RawElement[] };
    const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const nodes = elements
      .map(compactElement)
      .filter((node): node is CompactNode => Boolean(node));
    return { nodes: nodes.slice(0, 40) };
  } catch (_error) {
    return { nodes: [] };
  }
}

export interface BoardNodeInput {
  type?: "rectangle" | "ellipse" | "diamond" | "text";
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface BoardArrowInput {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function boardId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBoardElements(node: BoardNodeInput): RawElement[] {
  const x = node.x ?? 120;
  const y = node.y ?? 120;
  const width = node.width ?? 240;
  const height = node.height ?? 100;
  const type = node.type === "text" ? "text" : node.type || "rectangle";
  const shapeId = boardId("agent-shape");
  const labelId = boardId("agent-label");
  const base = {
    angle: 0,
    strokeColor: "#7c3aed",
    backgroundColor: "#211b3d",
    fillStyle: "solid",
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
  };
  if (type === "text") {
    return [{
      ...base, id: shapeId, type: "text", x, y, width, height,
      text: node.text, originalText: node.text, rawText: node.text,
      fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top",
      containerId: null, autoResize: true, lineHeight: 1.25,
    }];
  }
  const shape = {
    ...base, id: shapeId, type, x, y, width, height,
    boundElements: [{ type: "text", id: labelId }],
  };
  const textWidth = Math.max(80, Math.min(width - 24, node.text.length * 10));
  const label = {
    ...base, id: labelId, type: "text", x: x + 12,
    y: y + Math.max(12, height / 2 - 12), width: textWidth, height: 24,
    text: node.text, originalText: node.text, rawText: node.text,
    fontSize: 20, fontFamily: 1, textAlign: "center", verticalAlign: "middle",
    containerId: shapeId, autoResize: true, lineHeight: 1.25,
  };
  return [shape, label];
}

export function createBoardArrow(arrow: BoardArrowInput): RawElement[] {
  const width = arrow.width ?? 180;
  return [{
    id: boardId("agent-arrow"), type: "arrow", x: arrow.x ?? 240, y: arrow.y ?? 170,
    width, height: arrow.height ?? 0, points: [[0, 0], [width, arrow.height ?? 0]],
    text: arrow.text || "", strokeColor: "#ff6bb5", strokeWidth: 2,
    roughness: 1, opacity: 100, angle: 0, isDeleted: false,
    seed: Math.floor(Math.random() * 2 ** 31), version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now(),
  }];
}

export function dispatchBoardCommand(
  command: "add_node" | "add_arrow" | "clear" | "refresh",
  payload?: BoardNodeInput | BoardArrowInput,
) {
  window.dispatchEvent(new CustomEvent(BOARD_COMMAND_EVENT, { detail: { command, node: payload } }));
}

function elementKey(element: RawElement): string | null {
  const id = element.id;
  return typeof id === "string" && id ? id : null;
}

function elementUpdated(element: RawElement): number {
  const value = element.updated;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Merge two Excalidraw element lists by id; the newest `updated` timestamp wins.
 *
 * Excalidraw represents deletions as `isDeleted: true` with a bumped `updated`,
 * so a deleted element naturally wins over an older live copy. This lets the
 * browser and the agent (Hermes) edit the same board concurrently without
 * clobbering each other's changes.
 */
export function mergeBoardElements(
  serverElements: RawElement[],
  incomingElements: RawElement[],
): RawElement[] {
  const merged = new Map<string, RawElement>();
  for (const element of [...serverElements, ...incomingElements]) {
    const key = elementKey(element);
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing || elementUpdated(element) >= elementUpdated(existing)) {
      merged.set(key, element);
    }
  }
  return [...merged.values()];
}
