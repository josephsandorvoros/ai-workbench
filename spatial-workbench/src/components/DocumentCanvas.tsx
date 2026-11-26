import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { compatClient, type CanvasDocument, type CanvasDocumentVersion, type CanvasItemKind, type WorkspaceEntry } from "../api/compatClient";
import { CANVAS_DOCUMENT_CREATED_EVENT, CANVAS_PROJECT_FILE_LINKED_EVENT } from "../agent/chatSessions";
import type { ActiveCanvasContext } from "../agent/activeCanvasContext";
import { Markdown } from "./Markdown";
import { DEFAULT_HTML_ARTIFACT } from "../agent/htmlArtifact";
import { ErrorBoundary } from "./ErrorBoundary";
import { DEFAULT_SLIDES, DEFAULT_SPREADSHEET, officeKindLabel } from "../office/officeModels";
// Load Mermaid before Monaco's AMD loader; its fastdom dependency otherwise registers anonymous AMD modules.
import { MermaidPreview } from "./MermaidPreview";

const VisualDiagram = lazy(() => import("./DiagramCanvas").then((module) => ({ default: module.VisualDiagram })));
const SpreadsheetCanvas = lazy(() => import("./SpreadsheetCanvas").then((module) => ({ default: module.SpreadsheetCanvas })));
const SlidesCanvas = lazy(() => import("./SlidesCanvas").then((module) => ({ default: module.SlidesCanvas })));
const DEFAULT_MERMAID = "flowchart LR\n  A[Start] --> B[Next step]";
const DEFAULT_VISUAL = JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {} });

function itemLabel(kind: CanvasItemKind) {
  if (kind === "spreadsheet" || kind === "slides") return officeKindLabel(kind);
  return kind === "html" ? "HTML" : kind === "mermaid" ? "Mermaid diagram" : kind === "excalidraw" ? "Visual diagram" : "Document";
}

function defaultContent(kind: CanvasItemKind): string {
  if (kind === "spreadsheet") return JSON.stringify(DEFAULT_SPREADSHEET);
  if (kind === "slides") return JSON.stringify(DEFAULT_SLIDES);
  if (kind === "html") return DEFAULT_HTML_ARTIFACT;
  if (kind === "mermaid") return DEFAULT_MERMAID;
  if (kind === "excalidraw") return DEFAULT_VISUAL;
  return "";
}

export function DocumentCanvas({ chatId, headerSlot, active, onContextChange, projectMode, activeProjectPath, projectContent, onOpenProjects, onOpenProjectFile, onOpenDocuments, createdItem, openCreatedRequest, onCreatedItemOpened }: {
  chatId: string | null;
  headerSlot: HTMLElement | null;
  active: boolean;
  onContextChange: (context: ActiveCanvasContext) => void;
  projectMode: boolean;
  activeProjectPath?: string;
  projectContent: ReactNode;
  onOpenProjects: () => void;
  onOpenProjectFile: (path: string) => void;
  onOpenDocuments: () => void;
  createdItem: CanvasDocument | null;
  openCreatedRequest: number;
  onCreatedItemOpened: () => void;
}) {
  const [documents, setDocuments] = useState<CanvasDocument[]>([]);
  const [selected, setSelected] = useState<CanvasDocument | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [editorPending, setEditorPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] = useState<CanvasItemKind>("markdown");
  const [chooseKind, setChooseKind] = useState(false);
  const [location, setLocation] = useState<"chat" | "project">("chat");
  const [project, setProject] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [view, setView] = useState<"chat" | "project">("chat");
  const [preview, setPreview] = useState(false);
  const [htmlPreviewOnly, setHtmlPreviewOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFilesError, setProjectFilesError] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string[]>([""]);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [openMenu, setOpenMenu] = useState<"new" | "related" | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const relatedButton = useRef<HTMLButtonElement>(null);
  const projectFilesSequence = useRef(0);
  const dirty = Boolean(selected && (editorPending || title !== selected.title || content !== selected.content));
  const latest = useRef({ selected, dirty, busy });
  latest.current = { selected, dirty, busy };

  useEffect(() => {
    if (!active) setOpenMenu(null);
  }, [active]);

  useEffect(() => {
    if (!openMenu) return;
    function dismiss(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target)) setOpenMenu(null);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      (openMenu === "new" ? newButton : relatedButton).current?.focus();
      setOpenMenu(null);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu !== "related" || view !== "project") return;
    let active = true;
    setWorkspaceEntries([]);
    setWorkspaceLoading(true);
    setWorkspaceError("");
    void compatClient.listWorkspace(workspacePath[workspacePath.length - 1]).then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error("The workspace is unavailable.");
      setWorkspaceEntries(result.items);
    }).catch((reason: unknown) => {
      if (active) setWorkspaceError(`Could not load project files: ${reason instanceof Error ? reason.message : String(reason)}`);
    }).finally(() => {
      if (active) setWorkspaceLoading(false);
    });
    return () => { active = false; };
  }, [openMenu, view, workspacePath, workspaceRefresh]);

  useEffect(() => {
    onContextChange(selected
      ? { space: "Documents", detail: title, content, dirty, documentId: selected.id, revision: selected.revision, kind: selected.kind ?? "markdown" }
      : { space: "Documents", detail: "No document open" });
  }, [selected, title, content, dirty, onContextChange]);

  const refresh = useCallback(async () => {
    try {
      const result = await compatClient.listCanvasDocuments();
      if (!result.ok) throw new Error("The document library is unavailable.");
      setDocuments(result.documents);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!createdItem || createdItem.chat_id !== chatId) return;
    setDocuments((current) => [createdItem, ...current.filter((doc) => doc.id !== createdItem.id)]);
  }, [createdItem, chatId]);

  useEffect(() => {
    if (!openCreatedRequest || !createdItem || createdItem.chat_id !== chatId) return;
    if (selectDocument(createdItem)) onCreatedItemOpened();
  }, [openCreatedRequest]);

  useEffect(() => {
    let active = true;
    async function refreshProjectFiles() {
      const sequence = ++projectFilesSequence.current;
      if (!chatId) {
        setProjectFiles([]);
        return;
      }
      try {
        const result = await compatClient.getCanvasProjectFiles(chatId);
        if (active && sequence === projectFilesSequence.current) {
          setProjectFiles(result.files);
          setProjectFilesError("");
        }
      } catch (reason) {
        if (active && sequence === projectFilesSequence.current) setProjectFilesError(`Could not load linked files: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    setProjectFiles([]);
    void refreshProjectFiles();
    const onLinked = (event: Event) => {
      if ((event as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) void refreshProjectFiles();
    };
    window.addEventListener(CANVAS_PROJECT_FILE_LINKED_EVENT, onLinked);
    return () => { active = false; window.removeEventListener(CANVAS_PROJECT_FILE_LINKED_EVENT, onLinked); };
  }, [chatId]);

  async function unlinkProjectFile(path: string) {
    if (!chatId) return;
    const sequence = ++projectFilesSequence.current;
    try {
      const result = await compatClient.updateCanvasProjectFile(chatId, path, "unlink");
      if (sequence === projectFilesSequence.current) setProjectFiles(result.files);
      setProjectFilesError("");
    } catch (reason) {
      setProjectFilesError(`Could not unlink file: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let inFlight = false;
    async function sync() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await compatClient.listCanvasDocuments();
        if (!active) return;
        const current = latest.current;
        if (!current.selected || current.busy) return;
        const remote = result.documents.find((doc) => doc.id === current.selected?.id);
        if (!remote) {
          setSyncError("The open document is no longer in the library.");
          return;
        }
        setSyncError("");
        if (remote.revision >= current.selected.revision) setDocuments(result.documents);
        if (remote.revision > current.selected.revision) {
          if (current.dirty) {
            setExternalChange(true);
          } else {
            setSelected(remote);
            setTitle(remote.title);
            setContent(remote.content);
            setExternalChange(false);
          }
        }
      } catch (reason) {
        if (active) setSyncError(`Could not check for document updates: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        inFlight = false;
      }
    }
    const timer = window.setInterval(() => void sync(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selected?.id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function selectDocument(document: CanvasDocument) {
    if (projectMode && selected?.id === document.id && selected.revision === document.revision) {
      onOpenDocuments();
      return true;
    }
    if (dirty && !window.confirm("Discard your unsaved document changes?")) return false;
    onOpenDocuments();
    setSelected(document);
    setTitle(document.title);
    setContent(document.content);
    setEditorPending(false);
    setCreating(false);
    setError("");
    setExternalChange(false);
    setShowHistory(false);
    if (document.kind === "html" || document.kind === "mermaid") { setPreview(true); setHtmlPreviewOnly(true); }
    return true;
  }

  async function createDocument(selectedProject: string | null, kind = creatingKind) {
    if (!chatId || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await compatClient.saveCanvasDocument({
        title: kind === "html" ? "Untitled HTML" : `Untitled ${itemLabel(kind).toLowerCase()}`,
        content: defaultContent(kind), chat_id: chatId,
        project: selectedProject, kind,
      });
      setDocuments((current) => [result.document, ...current]);
      setSelected(result.document);
      setTitle(result.document.title);
      setContent(result.document.content);
      setEditorPending(false);
      setCreating(false);
      if (kind === "html" || kind === "mermaid") { setPreview(true); setHtmlPreviewOnly(true); }
      setView("chat");
      window.dispatchEvent(new CustomEvent(CANVAS_DOCUMENT_CREATED_EVENT, { detail: { chatId } }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveDocument() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await compatClient.saveCanvasDocument({
        id: selected.id, revision: selected.revision, title, content,
        chat_id: selected.chat_id, project: selected.project, kind: selected.kind ?? "markdown",
      });
      setSelected(result.document);
      setTitle(result.document.title);
      setContent(result.document.content);
      setDocuments((current) => [result.document, ...current.filter((doc) => doc.id !== selected.id)]);
      setExternalChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(version: CanvasDocumentVersion) {
    if (!selected || busy || (dirty && !window.confirm("Discard your unsaved changes and restore this version?"))) return;
    setBusy(true);
    setError("");
    try {
      const result = await compatClient.saveCanvasDocument({
        id: selected.id, revision: selected.revision, title: version.title, content: version.content,
        chat_id: selected.chat_id, project: selected.project, kind: selected.kind ?? "markdown", source: "restore",
      });
      setSelected(result.document);
      setTitle(result.document.title);
      setContent(result.document.content);
      setDocuments((current) => [result.document, ...current.filter((doc) => doc.id !== selected.id)]);
      setExternalChange(false);
      setShowHistory(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function startCreate(chooseLocation = false, kind: CanvasItemKind = "markdown") {
    if (dirty && !window.confirm("Discard your unsaved document changes?")) return;
    onOpenDocuments();
    const previous = documents.find((doc) => doc.chat_id === chatId);
    if (previous && !chooseLocation) {
      void createDocument(previous.project, kind);
      return;
    }
    setLocation(previous?.project ? "project" : "chat");
    setCreatingKind(kind);
    setChooseKind(chooseLocation);
    setProject(previous?.project ?? "");
    setCreating(true);
    setSelected(null);
    setError("");
  }

  async function download() {
    const kind = selected?.kind ?? "markdown";
    try {
      const type = kind === "html" ? "text/html" : kind === "excalidraw" ? "application/json" : "text/plain";
      const extension = kind === "html" ? "html" : kind === "mermaid" ? "mmd" : kind === "excalidraw" ? "excalidraw" : "md";
      let blob: Blob;
      if (kind === "spreadsheet") {
        blob = await (await import("../office/officeCanvas")).exportXlsx(content);
      } else if (kind === "slides") {
        blob = await (await import("../office/officeCanvas")).exportPptx(content);
      } else {
        blob = new Blob([content], { type: `${type};charset=utf-8` });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title.trim().replace(/[\\/:*?"<>|]/g, "-") || "document"}.${kind === "spreadsheet" ? "xlsx" : kind === "slides" ? "pptx" : extension}`;
      link.click();
      URL.revokeObjectURL(url);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const projectFolders = [...new Set(documents.flatMap((doc) => doc.project ? [doc.project] : []))].sort((a, b) => a.localeCompare(b));
  const visible = documents.filter((doc) => view === "chat"
    ? doc.chat_id === chatId
    : Boolean(doc.project) && (!projectFilter || doc.project === projectFilter));

  return (
    <div className="document-canvas">
      {headerSlot && createPortal(<div ref={menuRoot} className="canvas-navigation">
        <button ref={newButton} className="canvas-nav-button" type="button" aria-expanded={openMenu === "new"} aria-controls="canvas-new-menu" disabled={!chatId || busy} onClick={() => setOpenMenu(openMenu === "new" ? null : "new")}>+ New <span aria-hidden="true">▾</span></button>
        <button ref={relatedButton} className="canvas-nav-button" type="button" aria-expanded={openMenu === "related"} aria-controls="canvas-related-menu" onClick={() => setOpenMenu(openMenu === "related" ? null : "related")}>Related work <span aria-hidden="true">▾</span></button>
        {openMenu === "new" && <div id="canvas-new-menu" className="canvas-popover canvas-new-menu" aria-label="New Canvas item">
          <strong>New item</strong>
          {([
            ["markdown", "Document"], ["html", "Interactive HTML"], ["excalidraw", "Visual diagram"],
            ["mermaid", "Mermaid diagram"], ["spreadsheet", "Spreadsheet"], ["slides", "Slide deck"],
          ] as const).map(([kind, label]) => <button key={kind} type="button" onClick={() => { setOpenMenu(null); startCreate(false, kind); }}>{label}</button>)}
          <button className="canvas-new-location" type="button" onClick={() => { setOpenMenu(null); startCreate(true); }}>Choose type and location…</button>
        </div>}
        {openMenu === "related" && <div id="canvas-related-menu" className="canvas-popover canvas-related-menu" aria-label="Related work">
          <div className="document-library-heading"><strong>Canvas items</strong><button className="document-refresh" type="button" onClick={() => { void refresh(); setWorkspaceRefresh((current) => current + 1); }}>Refresh</button></div>
          <div className="document-library-filter" role="group" aria-label="Find documents">
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>This chat</button>
            <button type="button" aria-pressed={view === "project"} onClick={() => setView("project")}>Project</button>
          </div>
          {view === "project" && <>
            <label className="document-project-filter">Project files
              <select aria-label="Project files" value="" disabled={workspaceLoading} onChange={(event) => {
                const value = event.target.value;
                if (value === "up") setWorkspacePath((current) => current.slice(0, -1));
                else {
                  const entry = workspaceEntries[Number(value)];
                  if (!entry) return;
                  if (entry.is_dir) setWorkspacePath((current) => [...current, entry.path]);
                  else { setOpenMenu(null); onOpenProjectFile(entry.path); }
                }
              }}>
                <option value="">{workspaceLoading ? "Loading files..." : `Browse ${workspacePath[workspacePath.length - 1] || "workspace"}`}</option>
                {workspacePath.length > 1 && <option value="up">../ (parent folder)</option>}
                {workspaceEntries.map((entry, index) => <option key={entry.path} value={index}>{entry.name}{entry.is_dir ? "/" : ""}</option>)}
              </select>
            </label>
            {workspaceError && <p className="document-error" role="alert">{workspaceError} Use Refresh to try again.</p>}
            <label className="document-project-filter">Canvas item folder
              <select aria-label="Canvas item folder" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
                <option value="">All project items</option>
                {projectFolders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
              </select>
            </label>
          </>}
          <div className="document-list">
            {visible.map((doc) => <button key={doc.id} type="button" disabled={busy} aria-current={!projectMode && selected?.id === doc.id ? "true" : undefined} className={!projectMode && selected?.id === doc.id ? "selected" : ""} onClick={() => { setOpenMenu(null); selectDocument(doc); }}><strong>{doc.title}</strong><span>{doc.kind && doc.kind !== "markdown" ? `${itemLabel(doc.kind)} · ` : ""}{doc.project || "Chat draft"}</span></button>)}
            {visible.length === 0 && <p>No documents here yet.</p>}
          </div>
          <div className="document-library-heading"><strong>Linked project files</strong><button className="document-refresh" type="button" onClick={() => { setOpenMenu(null); onOpenProjects(); }}>Browse files</button></div>
          {projectFilesError && <p className="document-error" role="alert">{projectFilesError}</p>}
          <div className="document-list project-linked-files">
            {projectFiles.map((path) => <div key={path} className="project-linked-file">
              <button type="button" title={path} aria-current={projectMode && activeProjectPath === path ? "true" : undefined} className={projectMode && activeProjectPath === path ? "selected" : ""} onClick={() => { setOpenMenu(null); onOpenProjectFile(path); }}>{path}</button>
              <button type="button" aria-label={`Unlink ${path} from chat`} title="Remove from this chat" onClick={() => void unlinkProjectFile(path)}>Remove</button>
            </div>)}
            {projectFiles.length === 0 && <p>Open a project file to link it to this chat.</p>}
          </div>
        </div>}
      </div>, headerSlot)}
      <section className="document-editor" aria-label="Document editor" hidden={projectMode} id="workspace-panel-documents">
        {error && <p className="document-error" role="alert">{error}</p>}
        {syncError && <p className="document-error" role="alert">{syncError}</p>}
        {externalChange && <p className="document-error" role="alert">This document changed elsewhere. Your unsaved edits are preserved; copy or download them before reopening the updated document.</p>}
        {creating ? <form className="document-empty" onSubmit={(event) => { event.preventDefault(); void createDocument(location === "project" ? project : null); }}>
          <h2>New {itemLabel(creatingKind).toLowerCase()}</h2>
          <p>Choose where to keep this item. It will also be linked to this conversation.</p>
          {chooseKind && <label>Item type<select value={creatingKind} onChange={(event) => setCreatingKind(event.target.value as CanvasItemKind)}><option value="markdown">Document</option><option value="html">Interactive HTML</option><option value="excalidraw">Visual diagram</option><option value="mermaid">Mermaid diagram</option><option value="spreadsheet">Spreadsheet</option><option value="slides">Slide deck</option></select></label>}
          <label>Location<select value={location} onChange={(event) => setLocation(event.target.value === "project" ? "project" : "chat")}><option value="chat">Chat draft</option><option value="project">Project</option></select></label>
          {location === "project" && <label>Project folder<input value={project} onChange={(event) => setProject(event.target.value)} placeholder="projects/my-project" required /></label>}
          <div className="document-actions"><button className="btn" type="submit" disabled={busy || !chatId}>{busy ? "Creating..." : creatingKind === "markdown" || creatingKind === "html" ? "Create document" : `Create ${itemLabel(creatingKind).toLowerCase()}`}</button><button className="btn secondary" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
        </form> : selected ? <>
          <header className="document-toolbar">
            <div className="document-heading">
              <label className="document-title-label">Title<input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={busy} /></label>
              <div className="document-meta">{selected.project ? `Project: ${selected.project}` : "Chat draft"} · {dirty ? "Unsaved" : "Saved"}{selected.chat_id !== chatId ? " · Opened from another chat" : ""}</div>
            </div>
            <div className="document-actions">
              {(!selected.kind || selected.kind === "markdown") && <button className="btn secondary" type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "Hide preview" : "Preview"}</button>}
              {(selected.kind === "html" || selected.kind === "mermaid") && <div className="document-view-toggle" role="group" aria-label="Source and preview">
                <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Source</button>
                <button type="button" aria-pressed={preview && !htmlPreviewOnly} onClick={() => { setPreview(true); setHtmlPreviewOnly(false); }}>Split</button>
                <button type="button" aria-pressed={preview && htmlPreviewOnly} onClick={() => { setPreview(true); setHtmlPreviewOnly(true); }}>Preview</button>
              </div>}
              <button className="btn secondary" type="button" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>History</button>
              <button className="btn secondary" type="button" onClick={() => void download()}>{selected.kind === "spreadsheet" ? "Export XLSX" : selected.kind === "slides" ? "Export PPTX" : "Download"}</button>
              <button className="btn" type="button" onClick={() => void saveDocument()} disabled={!dirty || busy || !title.trim()}>{busy ? "Saving..." : "Save"}</button>
            </div>
            {selected.kind === "html" && <div className="document-meta document-security-note">Interactive preview runs in an isolated frame and can access the network.</div>}
          </header>
          {showHistory && <div className="document-history" aria-label="Document version history">
            {selected.versions?.length ? selected.versions.map((version) => <button key={version.id} type="button" disabled={busy} onClick={() => void restoreVersion(version)}>Restore revision {version.revision} · {new Date(version.updated_at).toLocaleString()}</button>) : <span>No earlier versions yet.</span>}
          </div>}
          <div className={`document-writing-area${preview ? " with-preview" : ""}`}>
            {selected.kind === "excalidraw" ? <ErrorBoundary key={`${selected.id}-${selected.revision}`} label="Visual diagram">
              <Suspense fallback={<p className="document-meta">Loading diagram editor...</p>}>
                <VisualDiagram content={content} onChange={setContent} disabled={busy} />
              </Suspense>
            </ErrorBoundary> : selected.kind === "spreadsheet" ? <ErrorBoundary key={`${selected.id}-${selected.revision}`} label="Spreadsheet editor">
              <Suspense fallback={<p className="document-meta">Loading spreadsheet editor...</p>}>
                <SpreadsheetCanvas content={content} onChange={setContent} onPendingChange={setEditorPending} disabled={busy} />
              </Suspense>
            </ErrorBoundary> : selected.kind === "slides" ? <ErrorBoundary key={`${selected.id}-${selected.revision}`} label="Slide editor">
              <Suspense fallback={<p className="document-meta">Loading slide editor...</p>}>
                <SlidesCanvas content={content} onChange={setContent} disabled={busy} />
              </Suspense>
            </ErrorBoundary> : <>
            <textarea hidden={(selected.kind === "html" || selected.kind === "mermaid") && preview && htmlPreviewOnly} aria-label={selected.kind === "html" ? "HTML source" : selected.kind === "mermaid" ? "Mermaid source" : "Document Markdown"} value={content} onChange={(event) => setContent(event.target.value)} placeholder={selected.kind === "html" ? "Write HTML..." : selected.kind === "mermaid" ? "Write Mermaid..." : "Start writing in Markdown..."} spellCheck disabled={busy} />
            {preview && (selected.kind === "html"
              ? <iframe className="document-html-preview" title="Interactive HTML preview" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={content} />
              : selected.kind === "mermaid"
              ? <Suspense fallback={<p className="document-meta">Loading diagram preview...</p>}><MermaidPreview content={content} /></Suspense>
              : <div className="document-preview" aria-label="Document preview"><Markdown content={content} /></div>)}
            </>}
          </div>
        </> : <div className="document-empty"><h2>Make something in Canvas</h2><p>Use <strong>New</strong> to create an item, or open something from <strong>Related work</strong>. Your work stays available with its chat or project.</p></div>}
      </section>
      <section className="document-project-panel" hidden={!projectMode} id="workspace-panel-project" aria-label="Project workspace">{projectContent}</section>
    </div>
  );
}
