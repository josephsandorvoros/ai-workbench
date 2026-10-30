import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { compatClient, type BoardState } from "../api/compatClient";
import {
  BOARD_COMMAND_EVENT,
  BOARD_REFRESH_EVENT,
  BOARD_STORAGE_KEY,
  compactElement,
  createBoardArrow,
  createBoardElements,
  mergeBoardElements,
  type BoardNodeInput,
  type BoardArrowInput,
  type CompactNode,
} from "../agent/canvasManifest";
import { loadBoardSnapshots, saveBoardSnapshot, type BoardSnapshot } from "../agent/boardSnapshots";

type RawElement = Record<string, unknown>;
type RawAppState = Record<string, unknown>;
type RawFiles = Record<string, unknown>;

interface SavedBoardState {
  elements: RawElement[];
  appState: RawAppState;
  files: RawFiles;
}

type ExcalidrawInitialData = ComponentProps<typeof Excalidraw>["initialData"];

const STORAGE_KEY = BOARD_STORAGE_KEY;

// Per-window layout and transient UI state; sharing them through the server makes other windows draw misaligned.
const LOCAL_ONLY_APP_STATE_KEYS = [
  "width", "height", "offsetTop", "offsetLeft", "collaborators", "selectedElementIds",
  "selectedGroupIds", "editingGroupId", "editingTextElement", "newElement", "resizingElement",
  "selectionElement", "activeTool", "cursorButton", "openMenu", "openPopup", "openSidebar",
  "openDialog", "contextMenu", "toast", "isLoading", "errorMessage", "pasteDialog",
];

function normalizeAppState(appState: RawAppState | undefined): RawAppState {
  const base = (appState && typeof appState === "object" ? { ...appState } : {}) as RawAppState;
  for (const key of LOCAL_ONLY_APP_STATE_KEYS) delete base[key];
  base.collaborators = [];
  return base;
}

function repairTextBindings(elements: RawElement[]): RawElement[] {
  const shapeIds = new Set(elements.filter((element) => element.containerId == null).map((element) => element.id));
  const labelsByContainer = new Map<string, string[]>();
  for (const element of elements) {
    const containerId = typeof element.containerId === "string" ? element.containerId : "";
    if (!containerId || !shapeIds.has(containerId)) continue;
    const labels = labelsByContainer.get(containerId) || [];
    labels.push(String(element.id));
    labelsByContainer.set(containerId, labels);
  }
  return elements.map((element) => {
    const labels = labelsByContainer.get(String(element.id));
    if (!labels || labels.length === 0) return element;
    return {
      ...element,
      boundElements: labels.map((id) => ({ type: "text", id })),
    };
  });
}

// Server-built labels carry estimated positions; Excalidraw only re-centers bound text when it is edited.
export function centerBoundText(elements: RawElement[]): RawElement[] {
  const byId = new Map(elements.map((element) => [String(element.id), element]));
  return elements.map((element) => {
    if (element.type !== "text" || typeof element.containerId !== "string") return element;
    const container = byId.get(element.containerId);
    if (!container || container.isDeleted) return element;
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const x = num(container.x) + num(container.width) / 2 - num(element.width) / 2;
    const y = num(container.y) + num(container.height) / 2 - num(element.height) / 2;
    if (element.x === x && element.y === y && element.textAlign === "center" && element.verticalAlign === "middle") {
      return element;
    }
    return { ...element, x, y, textAlign: "center", verticalAlign: "middle" };
  });
}

function normalizeBoardState(state: SavedBoardState | null | undefined): SavedBoardState | null {
  if (!state || !Array.isArray(state.elements)) return null;
  // Agent-written elements may lack fields Excalidraw reads unconditionally; restore fills them in.
  const restored = restoreElements(
    repairTextBindings(state.elements as RawElement[]) as unknown as Parameters<typeof restoreElements>[0],
    null,
    { refreshDimensions: true, repairBindings: true },
  ) as unknown as RawElement[];
  return {
    elements: centerBoundText(restored),
    appState: normalizeAppState(state.appState),
    files: state.files && typeof state.files === "object" ? (state.files as RawFiles) : {},
  };
}

function loadSavedBoard(): SavedBoardState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedBoardState;
    return normalizeBoardState(parsed);
  } catch (_error) {
    return null;
  }
}

function saveBoard(state: SavedBoardState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeBoardState(state)));
  } catch (_error) {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function SpatialBoard() {
  const [savedBoard] = useState<SavedBoardState | null>(() => loadSavedBoard());
  const [elements, setElements] = useState<RawElement[]>(savedBoard?.elements || []);
  const elementsRef = useRef<RawElement[]>(savedBoard?.elements || []);
  const [saveState, setSaveState] = useState("Ready");
  const [drawingName, setDrawingName] = useState("");
  const [snapshots, setSnapshots] = useState<BoardSnapshot[]>(() => loadBoardSnapshots());
  const appStateRef = useRef<RawAppState>(savedBoard?.appState || {});
  const filesRef = useRef<RawFiles>(savedBoard?.files || {});
  const apiRef = useRef<unknown>(null);
  const serverReadyRef = useRef(false);
  const serverRevisionRef = useRef<number | null>(null);
  const localBoardRef = useRef(savedBoard ? JSON.stringify(savedBoard) : "");
  const lastServerBoardRef = useRef<string | null>(null);
  const pendingServerBoardRef = useRef<{ state: SavedBoardState; serialized: string } | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  function saveLocalBoard(state: SavedBoardState) {
    const normalized = normalizeBoardState(state);
    if (!normalized) return;
    const serialized = JSON.stringify(normalized);
    if (serialized === localBoardRef.current) return;
    saveBoard(normalized);
    localBoardRef.current = serialized;
  }

  function scheduleServerBoardSave(state: SavedBoardState) {
    if (!serverReadyRef.current) return;
    const normalized = normalizeBoardState(state);
    if (!normalized) return;
    const serialized = JSON.stringify(normalized);
    if (serialized === lastServerBoardRef.current || serialized === pendingServerBoardRef.current?.serialized) return;
    pendingServerBoardRef.current = { state: normalized, serialized };
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const pending = pendingServerBoardRef.current;
      if (!pending) return;
      void compatClient.saveBoard(pending.state as BoardState, undefined, true).then(() => {
        lastServerBoardRef.current = pending.serialized;
        if (pendingServerBoardRef.current?.serialized === pending.serialized) pendingServerBoardRef.current = null;
      }).catch(() => {
        if (pendingServerBoardRef.current?.serialized === pending.serialized) pendingServerBoardRef.current = null;
      });
    }, 600);
  }

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    compatClient.getBoard().then(({ board, revision }) => {
      if (!active) return;
      if (typeof revision === "number") serverRevisionRef.current = revision;
      serverReadyRef.current = true;
      if (board) {
        const normalized = normalizeBoardState(board as SavedBoardState);
        if (normalized) {
          lastServerBoardRef.current = JSON.stringify(normalized);
          const local = loadSavedBoard();
          const merged = local
            ? { ...normalized, elements: mergeBoardElements(local.elements, normalized.elements) }
            : normalized;
          elementsRef.current = merged.elements;
          appStateRef.current = normalized.appState;
          filesRef.current = normalized.files;
          setElements(merged.elements);
          (apiRef.current as { updateScene?: (scene: SavedBoardState) => void } | null)
            ?.updateScene?.(merged);
          saveLocalBoard(merged);
        }
      } else {
        const local = loadSavedBoard();
        if (local) scheduleServerBoardSave(local);
      }
    }).catch(() => {
      serverReadyRef.current = true;
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const refresh = () => {
      void compatClient.getBoard().then(({ board, revision }) => {
        if (!board) return;
        if (typeof revision === "number") serverRevisionRef.current = revision;
        const normalized = normalizeBoardState(board as SavedBoardState);
        if (!normalized) return;
        const merged = mergeBoardElements(elementsRef.current, normalized.elements);
        if (JSON.stringify(merged) === JSON.stringify(elementsRef.current)) return;
        elementsRef.current = merged;
        appStateRef.current = normalized.appState;
        filesRef.current = normalized.files;
        setElements(merged);
        updateBoardScene(merged);
        const mergedState = { elements: merged, appState: normalized.appState, files: normalized.files };
        saveLocalBoard(mergedState);
      }).catch(() => undefined);
    };
    const handle = window.setInterval(refresh, 2000);
    return () => window.clearInterval(handle);
  }, []);

  function updateBoardScene(next: RawElement[]) {
    const api = apiRef.current as { updateScene?: (scene: { elements: unknown[] }) => void } | null;
    api?.updateScene?.({ elements: next });
  }

  // Excalidraw caches its canvas offset and only re-measures on window resize; panel drags and tab switches move it too.
  const canvasShellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = canvasShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      (apiRef.current as { refresh?: () => void } | null)?.refresh?.();
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  function handleSaveDrawing() {
    if (!drawingName.trim()) return;
    setSnapshots(saveBoardSnapshot(drawingName, {
      elements,
      appState: appStateRef.current,
      files: filesRef.current,
    }));
    setDrawingName("");
    setSaveState("Drawing saved");
  }

  function handleLoadDrawing(snapshot: BoardSnapshot) {
    elementsRef.current = snapshot.elements;
    appStateRef.current = snapshot.appState;
    filesRef.current = snapshot.files;
    setElements(snapshot.elements);
    updateBoardScene(snapshot.elements);
    setSaveState(`Loaded ${snapshot.name}`);
  }

  const compactNodes = useMemo(
    () => elements.map(compactElement).filter((node): node is CompactNode => Boolean(node)),
    [elements],
  );

  useEffect(() => {
    if (!savedBoard && elements.length === 0) return;
    const handle = window.setTimeout(() => setSaveState("Saved locally"), 250);
    return () => window.clearTimeout(handle);
  }, [elements.length, savedBoard]);

  useEffect(() => {
    const handleBoardCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command: "add_node" | "add_arrow" | "clear" | "refresh"; node?: BoardNodeInput | BoardArrowInput }>).detail;
      if (!detail) return;
      if (detail.command === "refresh") {
        void compatClient.getBoard().then(({ board, revision }) => {
          if (!board) return;
          if (typeof revision === "number") serverRevisionRef.current = revision;
          const normalized = normalizeBoardState(board as SavedBoardState);
          if (!normalized) return;
          const merged = mergeBoardElements(elementsRef.current, normalized.elements);
          elementsRef.current = merged;
          appStateRef.current = normalized.appState;
          filesRef.current = normalized.files;
          setElements(merged);
          updateBoardScene(merged);
          const mergedState = { elements: merged, appState: normalized.appState, files: normalized.files };
          saveLocalBoard(mergedState);
        }).catch(() => undefined);
        return;
      }
      const additions = detail.command === "add_arrow"
        ? createBoardArrow((detail.node || {}) as BoardArrowInput)
        : createBoardElements((detail.node || { text: "" }) as BoardNodeInput);
      const next = detail.command === "clear" ? [] : [...elementsRef.current, ...additions];
      elementsRef.current = next;
      setElements(next);
      updateBoardScene(next);
      const nextState = { elements: next, appState: appStateRef.current, files: filesRef.current };
      saveLocalBoard(nextState);
      scheduleServerBoardSave(nextState);
      setSaveState("Saved locally");
    };
    window.addEventListener(BOARD_COMMAND_EVENT, handleBoardCommand);
    return () => window.removeEventListener(BOARD_COMMAND_EVENT, handleBoardCommand);
  }, []);

  return (
    <section className="spatial-board" aria-label="Spatial board">
      <div className="workspace-section-header">
        <div>
          <h2>Spatial Board</h2>
          <p className="muted">Sketch architecture, plans, and relationships; the compact manifest is ready for Hermes context.</p>
        </div>
        <span className="status-pill available">available</span>
      </div>

      <div className="board-layout">
        <div className="board-canvas-shell" ref={canvasShellRef}>
          <div className="board-drawing-toolbar">
            <input
              className="input-field compact"
              value={drawingName}
              onChange={(event) => setDrawingName(event.target.value)}
              placeholder="Name this drawing"
              aria-label="Drawing name"
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSaveDrawing();
              }}
            />
            <button className="btn secondary small" type="button" onClick={handleSaveDrawing} disabled={!drawingName.trim()}>
              Save drawing
            </button>
            <select
              className="input-field compact"
              aria-label="Load saved drawing"
              value=""
              onChange={(event) => {
                const snapshot = snapshots.find((item) => item.id === event.target.value);
                if (snapshot) handleLoadDrawing(snapshot);
              }}
            >
              <option value="">Load drawing…</option>
              {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
            </select>
          </div>
          <Excalidraw
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            initialData={(normalizeBoardState(savedBoard) || undefined) as ExcalidrawInitialData}
            theme="dark"
            gridModeEnabled
            UIOptions={{
              canvasActions: {
                changeViewBackgroundColor: false,
                export: false,
                loadScene: false,
                saveAsImage: false,
                toggleTheme: false,
              },
            }}
            onChange={(nextElements, nextAppState, nextFiles) => {
              const nextState = {
                elements: nextElements as unknown as RawElement[],
                appState: normalizeAppState(nextAppState as unknown as RawAppState),
                files: (nextFiles as RawFiles) || {},
              };
              setElements(nextState.elements);
              elementsRef.current = nextState.elements;
              appStateRef.current = nextState.appState;
              filesRef.current = nextState.files;
              setSaveState("Saving...");
              saveLocalBoard(nextState);
              scheduleServerBoardSave(nextState);
            }}
          />
        </div>

        <aside className="board-manifest" aria-label="Compact spatial manifest">
          <div>
            <h3>Context Manifest</h3>
            <p>{compactNodes.length} model-readable nodes</p>
          </div>
          <pre>{JSON.stringify({ nodes: compactNodes.slice(0, 40) }, null, 2)}</pre>
          <p className="wiki-status available" aria-live="polite">{saveState}</p>
        </aside>
      </div>
    </section>
  );
}