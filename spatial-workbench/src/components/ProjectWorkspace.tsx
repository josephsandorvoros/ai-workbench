import Editor, { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { updateAgentProvider, useAgentProvider } from "../agent/agentStore";
import { compatClient, type AppPreviewSession, type CapabilityState, type WorkspaceEntry, type WorkspaceGitPreview } from "../api/compatClient";
import { formatWorkspaceJson, workspaceFileKind, WORKSPACE_PREVIEW_MAX_BYTES } from "../agent/workspacePreview";
import { DEFAULT_HTML_ARTIFACT } from "../agent/htmlArtifact";
import { prepareAttachment } from "../agent/attachments";
import { CollabHint } from "./CollabHint";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

type WorkspaceStatus = CapabilityState | "idle";
type AppPreviewRef = Pick<AppPreviewSession, "session_id" | "path" | "port" | "view_url">;

interface OpenFile {
  path: string;
  content: string;
  sizeBytes: number;
  modifiedTs: number;
}

type ConflictState = "current" | "changed" | "deleted" | "error";

const WATCH_INTERVAL_MS = 5000;

function parentPath(path: string) {
  const isAbsolute = path.startsWith("/");
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (!clean) return isAbsolute ? "/" : "";
  const parts = clean.split("/");
  parts.pop();
  const joined = parts.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

/** Render a path for display: workspace root as "/", absolute paths as-is. */
function displayPath(path: string) {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function formatBytes(bytes: number | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function languageForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "plaintext";
}

function statusToCapability(status: WorkspaceStatus): CapabilityState {
  if (status === "idle") return "degraded";
  return status;
}

export function ProjectWorkspace({ focusPath, focusRequest }: { focusPath?: string; focusRequest?: number }) {
  const agentProvider = useAgentProvider();
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [treeEntries, setTreeEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [conflictState, setConflictState] = useState<ConflictState>("current");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<WorkspaceStatus>("idle");
  const [message, setMessage] = useState("Browse any directory on this host and open a text/code file.");
  /** When set, the editor shows a side-by-side diff of this baseline vs the current buffer. */
  const [diffBaseline, setDiffBaseline] = useState<{ content: string; label: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [creatingFileBusy, setCreatingFileBusy] = useState(false);
  const [newFileError, setNewFileError] = useState("");
  const [gitSetupOpen, setGitSetupOpen] = useState(false);
  const [gitSetupPath, setGitSetupPath] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [gitPreview, setGitPreview] = useState<WorkspaceGitPreview | null>(null);
  const [gitConfirmFiles, setGitConfirmFiles] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitSetupMessage, setGitSetupMessage] = useState("");
  const [viewMode, setViewMode] = useState<"view" | "edit">("view");
  const [mediaUrl, setMediaUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [imageFit, setImageFit] = useState(true);
  const [previewBackground, setPreviewBackground] = useState<"light" | "dark" | "checker">("light");
  const [previewSetupOpen, setPreviewSetupOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState("");
  const [previewCommand, setPreviewCommand] = useState('python3 -m http.server "$PORT" --bind 127.0.0.1');
  const [previewPort, setPreviewPort] = useState("8000");
  const [terminalAuthRequired, setTerminalAuthRequired] = useState(false);
  const [tokenSetupOpen, setTokenSetupOpen] = useState(false);
  const [terminalTokenDraft, setTerminalTokenDraft] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErrorMessage, setPreviewErrorMessage] = useState("");
  const [previewSession, setPreviewSession] = useState<AppPreviewRef | null>(() => {
    try {
      const requestedId = new URLSearchParams(window.location.search).get("preview");
      if (requestedId && /^[a-f0-9-]{36}$/i.test(requestedId)) {
        return {
          session_id: requestedId,
          path: "",
          port: 0,
          view_url: `/api/app-preview/view/${encodeURIComponent(requestedId)}/`,
        };
      }
      const saved = window.sessionStorage.getItem("spatial-workbench.app-preview");
      return saved ? JSON.parse(saved) as AppPreviewRef : null;
    } catch {
      return null;
    }
  });
  const [previewStatus, setPreviewStatus] = useState<AppPreviewSession | null>(() => previewSession ? {
    ...previewSession,
    command: "",
    running: true,
    ready: false,
    exit_code: null,
    started_at: Date.now(),
  } : null);
  const [previewLogs, setPreviewLogs] = useState("");
  const importFileInput = useRef<HTMLInputElement | null>(null);
  const fileTree = useRef<HTMLDivElement | null>(null);
  const tokenDialogRef = useRef<HTMLDialogElement | null>(null);
  const openSequence = useRef(0);
  const treeRevision = useRef(0);
  const previewLogOffset = useRef(0);

  const editorLanguage = useMemo(() => languageForPath(openFile?.path || ""), [openFile?.path]);
  const fileKind = openFile ? workspaceFileKind(openFile.path) : "text";
  const editable = ["text", "json", "html", "markdown"].includes(fileKind);
  const hasTextPreview = ["json", "html", "markdown"].includes(fileKind);
  const displayedContent = useMemo(() => fileKind === "json" && viewMode === "view"
    ? formatWorkspaceJson(editorContent) : editorContent, [fileKind, viewMode, editorContent]);

  useEffect(() => {
    let active = true;
    void compatClient.getConfig().then((config) => {
      if (active) setTerminalAuthRequired(config.terminal_auth_required);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const dialog = tokenDialogRef.current;
    if (!dialog) return;
    if (tokenSetupOpen && !dialog.open) dialog.showModal();
    else if (!tokenSetupOpen && dialog.open) dialog.close();
  }, [tokenSetupOpen]);

  useEffect(() => {
    try {
      if (previewSession) window.sessionStorage.setItem("spatial-workbench.app-preview", JSON.stringify({
        session_id: previewSession.session_id,
        path: previewSession.path,
        port: previewSession.port,
        view_url: previewSession.view_url,
      }));
      else window.sessionStorage.removeItem("spatial-workbench.app-preview");
    } catch {}
  }, [previewSession]);

  useEffect(() => {
    const session = previewSession;
    if (!session) return;
    const sessionId = session.session_id;
    let cancelled = false;
    let loading = false;
    async function refreshPreview() {
      if (cancelled || loading) return;
      loading = true;
      try {
        const [status, logs] = await Promise.all([
          compatClient.getAppPreviewStatus(sessionId, agentProvider.terminalToken),
          compatClient.getAppPreviewLogs(sessionId, previewLogOffset.current, agentProvider.terminalToken),
        ]);
        if (cancelled) return;
        setPreviewStatus(status);
        if (logs.data) {
          previewLogOffset.current = logs.next_offset;
          setPreviewLogs((current) => `${current}${logs.data}`.slice(-30000));
        }
      } catch (error) {
        if (!cancelled) {
          const message = String(error);
          setPreviewErrorMessage(message);
          if (message.includes("Preview session not found")) {
            setPreviewSession(null);
            setPreviewStatus(null);
            setPreviewLogs("");
            setPreviewErrorMessage("");
            const url = new URL(window.location.href);
            if (url.searchParams.get("preview") === sessionId) {
              url.searchParams.delete("preview");
              window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
            }
          }
        }
      } finally {
        loading = false;
      }
    }
    void refreshPreview();
    const timer = window.setInterval(() => void refreshPreview(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [previewSession?.session_id, agentProvider.terminalToken]);

  async function startAppPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreviewBusy(true);
    setPreviewErrorMessage("");
    setPreviewLogs("");
    previewLogOffset.current = 0;
    try {
      const result = await compatClient.startAppPreview(
        previewPath.trim(), previewCommand.trim(), Number(previewPort), agentProvider.terminalToken,
      );
      setPreviewSession(result);
      setPreviewStatus(result);
      setPreviewSetupOpen(false);
    } catch (error) {
      setPreviewErrorMessage(String(error));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function stopAppPreview() {
    if (!previewSession || previewBusy) return;
    setPreviewBusy(true);
    setPreviewErrorMessage("");
    try {
      await compatClient.stopAppPreview(previewSession.session_id, agentProvider.terminalToken);
      const url = new URL(window.location.href);
      if (url.searchParams.get("preview") === previewSession.session_id) {
        url.searchParams.delete("preview");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      setPreviewSession(null);
      setPreviewStatus(null);
      setPreviewSetupOpen(false);
    } catch (error) {
      setPreviewErrorMessage(String(error));
    } finally {
      setPreviewBusy(false);
    }
  }

  function saveTerminalToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = terminalTokenDraft.trim();
    if (!token) return;
    updateAgentProvider({ terminalToken: token });
    setTerminalTokenDraft("");
    setTokenSetupOpen(false);
  }

  async function createFile(name: string, content: string) {
    const segments = name.trim().split("/");
    if (!name.trim() || name.startsWith("/") || name.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      setStatus("error");
      setMessage("Enter a relative file path without dot or parent-directory segments.");
      return false;
    }
    const path = `${currentPath ? `${currentPath.replace(/\/$/, "")}/` : ""}${name.trim()}`;
    try {
      await compatClient.createWorkspaceFile(path, content);
      await loadTree(currentPath);
      await refreshDirectory(parentPath(path));
      if (!dirty) {
        await openWorkspaceFile(path);
        setViewMode("edit");
      }
      return true;
    } catch (error) {
      setStatus("error");
      setMessage(`File creation failed: ${error}`);
      setNewFileError(String(error));
      return false;
    }
  }

  async function submitNewFile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingFileBusy) return;
    const name = newFileName.trim();
    const segments = name.split("/");
    if (!name || name.startsWith("/") || name.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      setNewFileError("Enter a relative file path without dot or parent-directory segments.");
      return;
    }
    setCreatingFileBusy(true);
    setNewFileError("");
    try {
      const content = /\.html?$/i.test(name) ? DEFAULT_HTML_ARTIFACT : /\.json$/i.test(name) ? "{}\n" : "";
      if (await createFile(name, content)) {
        setCreatingFile(false);
        setNewFileName("");
      }
    } finally {
      setCreatingFileBusy(false);
    }
  }

  async function importFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setStatus("error");
      setMessage("Import exceeds the 10 MB upload limit.");
      return;
    }
    setStatus("degraded");
    setMessage(`Importing ${file.name}`);
    try {
      const imported = await prepareAttachment(file, (filename, contentBase64) => compatClient.importWorkspaceFile(filename, contentBase64));
      await loadTree("");
      if (!dirty) await openWorkspaceFile(imported.path);
      else {
        setStatus("available");
        setMessage(`Imported ${file.name}. Your unsaved editor changes are unchanged.`);
      }
    } catch (error) {
      setStatus("error");
      setMessage(`Import failed: ${error}`);
    }
  }

  async function loadTree(path = currentPath) {
    const revision = ++treeRevision.current;
    setStatus("degraded");
    setMessage(`Loading ${displayPath(path)}`);
    try {
      const result = await compatClient.listWorkspace(path);
      if (revision !== treeRevision.current) return;
      setCurrentPath(result.path || "");
      setEntries(result.items || []);
      setTreeEntries((current) => ({ ...current, [result.path || ""]: result.items || [] }));
      setExpandedPaths((current) => new Set(current).add(result.path || ""));
      setStatus("available");
      setMessage(`Browsing ${displayPath(result.path || "")}`);
    } catch (error) {
      if (revision !== treeRevision.current) return;
      setStatus("error");
      setMessage(`Workspace browse failed: ${error}`);
    }
  }

  async function createWorkspaceDirectory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFolderName.trim();
    const segments = name.split("/");
    if (!name || name.startsWith("/") || name.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      setStatus("error");
      setMessage("Enter a relative folder path without empty, dot, or parent-directory segments.");
      return;
    }
    const path = `${currentPath ? `${currentPath.replace(/\/$/, "")}/` : ""}${name}`;
    setStatus("degraded");
    setMessage(`Creating ${path}`);
    try {
      await compatClient.createWorkspaceDirectory(path);
      setNewFolderName("");
      setCreatingFolder(false);
      setGitSetupPath(path);
      setGitPreview(null);
      setGitConfirmFiles(false);
      setGitSetupMessage("");
      setGitSetupOpen(true);
      await loadTree(currentPath);
    } catch (error) {
      setStatus("error");
      setMessage(`Folder creation failed: ${error}`);
    }
  }

  async function previewGitInitialization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGitBusy(true);
    setGitPreview(null);
    setGitConfirmFiles(false);
    setGitSetupMessage("");
    try {
      const result = await compatClient.previewWorkspaceGit(gitSetupPath.trim(), gitBranch.trim() || "main");
      setGitPreview(result.preview);
    } catch (error) {
      setGitSetupMessage(`Preview failed: ${error}`);
    } finally {
      setGitBusy(false);
    }
  }

  async function initializeGitRepository() {
    if (!gitPreview) return;
    setGitBusy(true);
    setGitSetupMessage("");
    try {
      const result = await compatClient.initializeWorkspaceGit(
        gitPreview.path, gitPreview.branch, gitPreview.inventory_hash, gitConfirmFiles,
      );
      setGitSetupMessage(`Initialized ${result.path} on ${result.branch}. ${result.commit}`);
      setGitPreview(null);
      setGitConfirmFiles(false);
      await loadTree(currentPath);
    } catch (error) {
      setGitSetupMessage(`Git initialization failed: ${error}`);
      setGitPreview(null);
      setGitConfirmFiles(false);
    } finally {
      setGitBusy(false);
    }
  }

  async function toggleDirectory(path: string) {
    if (expandedPaths.has(path)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }

    if (!treeEntries[path]) {
      try {
        const result = await compatClient.listWorkspace(path);
        setTreeEntries((current) => ({ ...current, [result.path || path]: result.items || [] }));
      } catch (error) {
        setStatus("error");
        setMessage(`Workspace browse failed: ${error}`);
        return;
      }
    }
    setExpandedPaths((current) => new Set(current).add(path));
  }

  function renderTree(path: string, items: WorkspaceEntry[], depth = 0): React.ReactNode {
    return items.map((entry) => {
      const expanded = expandedPaths.has(entry.path);
      return (
        <div className="project-tree-node" key={entry.path}>
          <div className="project-tree-row-wrap">
            <button
              className={`project-tree-row ${entry.is_dir ? "directory" : "file"} ${openFile?.path === entry.path ? "selected" : ""}`}
              type="button"
              style={{ paddingLeft: `calc(var(--space-sm) + ${depth} * var(--space-md))` }}
              aria-expanded={entry.is_dir ? expanded : undefined}
              title={entry.path}
              onClick={() => (entry.is_dir ? void toggleDirectory(entry.path) : void openWorkspaceFile(entry.path))}
            >
              <span className="project-tree-chevron" aria-hidden="true">
                {entry.is_dir ? <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} /> : null}
              </span>
              <span className="project-tree-icon" aria-hidden="true">
                <Icon name={entry.is_dir ? (expanded ? "folder-open" : "folder") : "file"} size={15} />
              </span>
              <span className="project-tree-name">{entry.name}</span>
              {!entry.is_dir ? <small>{formatBytes(entry.size_bytes)}</small> : null}
            </button>
            <button
              className="project-tree-download"
              type="button"
              title={entry.is_dir ? `Download ${entry.name} as .zip` : `Download ${entry.name}`}
              aria-label={entry.is_dir ? `Download folder ${entry.name}` : `Download ${entry.name}`}
              onClick={() => downloadWorkspaceEntry(entry)}
            >
              <Icon name="download" size={13} />
            </button>
              <button
                className="project-tree-delete"
                type="button"
                title={`Delete ${entry.is_dir ? "folder " : ""}${entry.name}`}
                aria-label={`Delete ${entry.is_dir ? "folder " : ""}${entry.name}`}
                onClick={() => void deleteWorkspaceFile(entry.path, entry.is_dir)}
              >
                <Icon name="trash" size={13} />
              </button>
          </div>
          {entry.is_dir && expanded && treeEntries[entry.path] ? (
            <div className="project-tree-children">{renderTree(entry.path, treeEntries[entry.path], depth + 1)}</div>
          ) : null}
        </div>
      );
    });
  }

  async function openWorkspaceFile(path: string) {
    if (dirty && !window.confirm("Discard your unsaved changes and open another file?")) return;
    const sequence = ++openSequence.current;
    setStatus("degraded");
    setMessage(`Opening ${path}`);
    try {
      const kind = workspaceFileKind(path);
      const result = ["text", "json", "html", "markdown"].includes(kind)
        ? await compatClient.readWorkspaceFile(path)
        : { ...await compatClient.getWorkspaceFileStatus(path), content: "" };
      if (sequence !== openSequence.current) return;
      setOpenFile({
        path: result.path,
        content: result.content || "",
        modifiedTs: result.modified_ts,
        sizeBytes: result.size_bytes,
      });
      setEditorContent(result.content || "");
      setDirty(false);
      setConflictState("current");
      setDiffBaseline(null);
      setViewMode("view");
      setImageFit(true);
      setMediaUrl("");
      setPreviewError("");
      setStatus("available");
      setMessage(`Opened ${result.path} (${formatBytes(result.size_bytes)})`);
    } catch (error) {
      if (sequence !== openSequence.current) return;
      setStatus("error");
      setMessage(`Open failed: ${error}`);
    }
  }

  useEffect(() => {
    setMediaUrl("");
    setPreviewError("");
    if (!openFile || editable || fileKind === "binary") return;
    if (openFile.sizeBytes > WORKSPACE_PREVIEW_MAX_BYTES) {
      setPreviewError("File exceeds the 32 MB preview limit. Download it to view.");
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    const path = openFile.path;
    async function loadMedia() {
      try {
        const response = await fetch(compatClient.workspaceDownloadUrl(path), { signal: controller.signal });
        if (!response.ok) throw new Error(`File unavailable (${response.status})`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.size > WORKSPACE_PREVIEW_MAX_BYTES) throw new Error("File exceeds the 32 MB preview limit.");
        objectUrl = URL.createObjectURL(blob);
        setMediaUrl(objectUrl);
      } catch (error) {
        if (!controller.signal.aborted) setPreviewError(String(error));
      }
    }
    void loadMedia();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [openFile?.path, openFile?.modifiedTs, openFile?.sizeBytes, editable, fileKind]);

  async function refreshDirectory(directory: string) {
    if (!treeEntries[directory]) return;
    const revision = treeRevision.current;
    const refreshed = await compatClient.listWorkspace(directory);
    if (revision !== treeRevision.current) return;
    setTreeEntries((current) => ({ ...current, [refreshed.path || directory]: refreshed.items || [] }));
    if ((refreshed.path || directory) === currentPath) {
      setEntries(refreshed.items || []);
    }
  }

  /** Trigger a browser download of a workspace file or folder (zipped server-side). */
  function downloadWorkspaceEntry(entry: WorkspaceEntry) {
    const anchor = document.createElement("a");
    anchor.href = compatClient.workspaceDownloadUrl(entry.path);
    anchor.download = entry.is_dir ? `${entry.name}.zip` : entry.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setStatus("available");
    setMessage(`Downloading ${entry.is_dir ? `folder ${entry.name}.zip` : entry.name}`);
  }

  async function deleteWorkspaceFile(path: string, isDirectory = false) {
    if (isDirectory) {
      const name = path.split("/").filter(Boolean).pop() || path;
      if (window.prompt(`Delete folder ${path} and ALL its contents?\n\nThe complete folder will be moved to a recovery backup. Unsaved edits inside it will be discarded.\n\nType ${name} to confirm:`) !== name) return;
    } else if (!window.confirm(`Delete ${path}?\n\nThe companion API keeps a timestamped backup.`)) return;

    ++treeRevision.current;
    setStatus("degraded");
    setMessage(`Deleting ${path}`);
    try {
      await compatClient.deleteWorkspaceFile(path, isDirectory);
      ++treeRevision.current;
      ++openSequence.current;
      const insideDeletedPath = (candidate: string) => candidate === path || (isDirectory && candidate.startsWith(`${path}/`));
      if (openFile && insideDeletedPath(openFile.path)) {
        setOpenFile(null);
        setEditorContent("");
        setDirty(false);
        setConflictState("current");
        setDiffBaseline(null);
      }
      setTreeEntries((current) => Object.fromEntries(Object.entries(current).filter(([directory]) => !insideDeletedPath(directory))));
      setExpandedPaths((current) => new Set([...current].filter((directory) => !insideDeletedPath(directory))));
      if (insideDeletedPath(currentPath)) await loadTree(parentPath(path));
      else {
        await refreshDirectory(parentPath(path));
        await loadTree(currentPath);
      }
      setStatus("available");
      setMessage(`Deleted ${path}. Backup created by companion API.`);
    } catch (error) {
      setStatus("error");
      setMessage(`Delete failed: ${error}`);
    }
  }

  /** Compare what's now on disk (e.g. an agent edit) against the version in the editor. */
  async function showDiskDiff() {
    if (!openFile) return;
    try {
      const latest = await compatClient.readWorkspaceFile(openFile.path);
      setEditorContent(latest.content || "");
      setOpenFile({
        path: latest.path,
        content: latest.content || "",
        modifiedTs: latest.modified_ts,
        sizeBytes: latest.size_bytes,
      });
      setDirty(false);
      setConflictState("current");
      setDiffBaseline({ content: openFile.content, label: "version you opened" });
      setMessage(`Showing changes to ${latest.path} since you opened it.`);
    } catch (error) {
      setStatus("error");
      setMessage(`Diff failed: ${error}`);
    }
  }

  async function saveWorkspaceFile() {
    if (!openFile || !editable) {
      setStatus("error");
      setMessage("Open a workspace file before saving.");
      return;
    }

    setStatus("degraded");
    setMessage(`Checking ${openFile.path} before save`);
    try {
      const latest = await compatClient.getWorkspaceFileStatus(openFile.path);
      const changed = latest.modified_ts !== openFile.modifiedTs || latest.size_bytes !== openFile.sizeBytes;
      const force = changed
        ? window.confirm("This file changed on disk after you opened it. Overwrite it with the editor contents?")
        : false;

      if (changed && !force) {
        setConflictState("changed");
        setStatus("blocked");
        setMessage("Save cancelled because the file changed on disk.");
        return;
      }

      const result = await compatClient.writeWorkspaceFile(
        openFile.path,
        editorContent,
        openFile.modifiedTs,
        openFile.sizeBytes,
        force,
      );
      setOpenFile({
        path: result.path,
        content: editorContent,
        modifiedTs: result.modified_ts,
        sizeBytes: result.size_bytes,
      });
      setDirty(false);
      setConflictState("current");
      setDiffBaseline(null);
      setStatus("available");
      setMessage(`Saved ${result.path} (${formatBytes(result.size_bytes)}). Backup created by companion API.`);
      await refreshDirectory(parentPath(result.path));
    } catch (error) {
      setStatus("error");
      setMessage(`Save failed: ${error}`);
    }
  }

  useEffect(() => {
    void loadTree("");
  }, []);

  useEffect(() => {
    if (!focusPath) return;
    let cancelled = false;
    let frame = 0;
    const revision = treeRevision.current;
    const directories: string[] = [];
    let directory = focusPath;
    while (directory && directory !== "/") {
      directories.unshift(directory);
      directory = parentPath(directory);
    }
    async function expandFocusedFolder() {
      try {
        for (const path of directories) {
          const result = await compatClient.listWorkspace(path);
          if (cancelled || revision !== treeRevision.current) return;
          setTreeEntries((current) => ({ ...current, [result.path || path]: result.items || [] }));
        }
        setExpandedPaths((current) => new Set([...current, "", ...directories]));
        frame = window.requestAnimationFrame(() => {
          const row = [...(fileTree.current?.querySelectorAll<HTMLButtonElement>(".project-tree-row") || [])].find((entry) => entry.title === focusPath);
          row?.scrollIntoView({ block: "nearest" });
        });
      } catch (error) {
        if (cancelled || revision !== treeRevision.current) return;
        setStatus("error");
        setMessage(`Could not open job folder: ${error}`);
      }
    }
    void expandFocusedFolder();
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [focusPath, focusRequest]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const directories = [...expandedPaths].filter((path) => {
      if (path === currentPath) return true;
      const prefix = currentPath.endsWith("/") || !currentPath ? currentPath : `${currentPath}/`;
      if (!path.startsWith(prefix)) return false;
      let ancestor = parentPath(path);
      while (ancestor !== currentPath) {
        if (!expandedPaths.has(ancestor)) return false;
        const parent = parentPath(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
      return expandedPaths.has(currentPath);
    });
    if (!directories.includes(currentPath)) directories.unshift(currentPath);

    async function refreshVisibleDirectories() {
      if (cancelled || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      const revision = treeRevision.current;
      try {
        await Promise.all(directories.map(async (directory) => {
          try {
            const result = await compatClient.listWorkspace(directory);
            if (cancelled || revision !== treeRevision.current) return;
            const path = result.path ?? directory;
            const items = result.items || [];
            setTreeEntries((current) => ({ ...current, [path]: items }));
            if (path === currentPath) setEntries(items);
          } catch {}
        }));
      } finally {
        refreshing = false;
      }
    }

    const refresh = () => { void refreshVisibleDirectories(); };
    const interval = window.setInterval(refresh, WATCH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [currentPath, expandedPaths]);

  useEffect(() => {
    if (!openFile) return;

    let cancelled = false;

    async function checkFileStatus() {
      if (!openFile) return;
      try {
        const result = await compatClient.getWorkspaceFileStatus(openFile.path);
        if (cancelled) return;
        const changed = result.modified_ts !== openFile.modifiedTs || result.size_bytes !== openFile.sizeBytes;
        setConflictState(changed ? "changed" : "current");
      } catch (error) {
        if (cancelled) return;
        setConflictState(String(error).includes("404") ? "deleted" : "error");
      }
    }

    const interval = window.setInterval(() => {
      void checkFileStatus();
    }, WATCH_INTERVAL_MS);
    void checkFileStatus();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [openFile]);

  return (
    <section className="project-workspace" aria-label="Project workspace">
      <div className="workspace-section-header">
        <div>
          <h2>Project Workspace</h2>
          <p className="muted">System-wide file explorer — open any directory on this host, edit with Monaco.</p>
        </div>
        <div className="project-header-actions">
          {terminalAuthRequired && <button className="btn secondary small" type="button" onClick={() => {
            setTerminalTokenDraft("");
            setTokenSetupOpen((open) => !open);
          }}>{agentProvider.terminalToken ? "Replace terminal token" : "Set terminal token"}</button>}
          <span className={`status-pill ${statusToCapability(status)}`}>{statusToCapability(status)}</span>
        </div>
      </div>

      <dialog ref={tokenDialogRef} className="app-preview-token-dialog" aria-labelledby="preview-token-title"
        onCancel={() => setTokenSetupOpen(false)}
        onClose={() => setTokenSetupOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setTokenSetupOpen(false); }}>
        <form className="app-preview-token-setup" onSubmit={(event) => saveTerminalToken(event)}>
          <div className="app-preview-heading">
            <strong id="preview-token-title">Terminal access</strong>
            <p>Save the token for this browser session. This only authorizes preview controls; it does not start an app.</p>
          </div>
          <label>Terminal access token<input
            type="password"
            autoComplete="off"
            autoFocus
            value={terminalTokenDraft}
            onChange={(event) => setTerminalTokenDraft(event.target.value)}
            placeholder={agentProvider.terminalToken ? "Enter replacement token" : "Required by this Workbench"}
            required
          /></label>
          <div className="project-git-actions">
            <button className="btn primary small" type="submit" disabled={!terminalTokenDraft.trim()}>Save token</button>
            <button className="btn secondary small" type="button" onClick={() => { setTokenSetupOpen(false); setTerminalTokenDraft(""); }}>Cancel</button>
          </div>
        </form>
      </dialog>

      <div className="project-workspace-grid">
        <aside className="project-browser" aria-label="Project file browser">
          <div className="project-browser-toolbar">
            <button className="btn secondary small" type="button" onClick={() => { setCreatingFolder(!creatingFolder); setCreatingFile(false); setNewFolderName(""); }} disabled={creatingFileBusy}>
              <Icon name="folder" size={14} /> New folder
            </button>
            <button className="btn secondary small" type="button" onClick={() => {
              setCreatingFile(!creatingFile);
              setCreatingFolder(false);
              setNewFileName("");
              setNewFileError("");
            }} disabled={creatingFileBusy}><Icon name="file" size={14} /> New file</button>
            <button className="btn secondary small" type="button" title="Refresh folder" aria-label="Refresh folder" onClick={() => void loadTree(currentPath)}><Icon name="refresh" size={14} /> Refresh</button>
            <button className="btn secondary small" type="button" title="Import file" aria-label="Import file" onClick={() => importFileInput.current?.click()}><Icon name="upload" size={14} /> Import file</button>
            <input ref={importFileInput} type="file" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.currentTarget.value = "";
            }} />
            <button className="btn secondary small" type="button" onClick={() => {
              setGitSetupOpen(!gitSetupOpen);
              setGitSetupPath(currentPath);
              setGitPreview(null);
              setGitConfirmFiles(false);
              setGitSetupMessage("");
            }}>Initialize Git</button>
          </div>
          {creatingFile && <form className="project-create-folder" onSubmit={(event) => void submitNewFile(event)}>
            <label htmlFor="project-new-file">New file path</label>
            <div><input id="project-new-file" value={newFileName} onChange={(event) => setNewFileName(event.target.value)} maxLength={180} placeholder="notes.txt" autoFocus disabled={creatingFileBusy} aria-invalid={Boolean(newFileError)} aria-describedby={newFileError ? "project-new-file-error" : undefined} />
              <button className="btn primary small" type="submit" disabled={creatingFileBusy || !newFileName.trim()}>{creatingFileBusy ? "Creating..." : "Create"}</button>
              <button className="btn secondary small" type="button" disabled={creatingFileBusy} onClick={() => { setCreatingFile(false); setNewFileError(""); }}>Cancel</button>
            </div>
            {newFileError && <p id="project-new-file-error" className="jobs-error" role="alert">{newFileError}</p>}
          </form>}
          {creatingFolder && <form className="project-create-folder" onSubmit={(event) => void createWorkspaceDirectory(event)}>
            <label htmlFor="project-new-folder">New folder path under {displayPath(currentPath)}</label>
            <div><input id="project-new-folder" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} maxLength={180} placeholder="projects/board-smoke" autoFocus />
              <button className="btn primary small" type="submit" disabled={!newFolderName.trim()}>Create</button>
              <button className="btn secondary small" type="button" onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}>Cancel</button>
            </div>
          </form>}
          {gitSetupOpen && <div className="project-git-setup">
            <form onSubmit={(event) => void previewGitInitialization(event)}>
              <label>Repository path<input value={gitSetupPath} onChange={(event) => setGitSetupPath(event.target.value)} placeholder="projects/my-project" required /></label>
              <label>Initial branch<input value={gitBranch} onChange={(event) => setGitBranch(event.target.value)} maxLength={120} required /></label>
              <div className="project-git-actions"><button className="btn secondary small" type="submit" disabled={gitBusy}>Review files</button><button className="btn secondary small" type="button" onClick={() => { setGitSetupOpen(false); setGitPreview(null); }}>Close</button></div>
            </form>
            {gitPreview && <div className="project-git-preview">
              <strong>{gitPreview.path} · branch {gitPreview.branch}</strong>
              {gitPreview.file_count === 0 ? <p>This folder is empty. Initialization will add a starter README and initial commit.</p> : <>
                <p>{gitPreview.files.length} file(s) will be committed · {formatBytes(gitPreview.size_bytes)} total{gitPreview.ignored_file_count ? ` · ${gitPreview.ignored_file_count} ignored file(s) excluded` : ""}</p>
                {gitPreview.sensitive_files.length > 0 && <p className="project-git-warning">Review carefully: likely sensitive files are included: {gitPreview.sensitive_files.join(", ")}</p>}
                <details className="project-git-file-list" open><summary>Files to include</summary>
                  <ul>{gitPreview.files.slice(0, 100).map((file) => <li key={file}>{file}</li>)}</ul>
                  {gitPreview.files.length > 100 && <p>Showing first 100 of {gitPreview.files.length} files.</p>}
                </details>
                <label className="project-git-confirm"><input type="checkbox" checked={gitConfirmFiles} onChange={(event) => setGitConfirmFiles(event.target.checked)} /> I reviewed these files and want them in the initial commit.</label>
              </>}
              <button className="btn primary small" type="button" onClick={() => void initializeGitRepository()} disabled={gitBusy || (gitPreview.file_count > 0 && !gitConfirmFiles)}>{gitBusy ? "Initializing..." : "Initialize and commit"}</button>
            </div>}
            {gitSetupMessage && <p className={gitSetupMessage.startsWith("Git initialization failed") || gitSetupMessage.startsWith("Preview failed") ? "jobs-error" : "project-git-success"} role="status">{gitSetupMessage}</p>}
          </div>}
          <div ref={fileTree} className="project-tree" role="tree" aria-label="Files and folders">
            {entries.length === 0 ? (
              <p className="muted">No workspace entries loaded.</p>
            ) : (
              renderTree(currentPath, entries)
            )}
          </div>
        </aside>

        <section className="monaco-shell" aria-label="Monaco editor">
          <div className="monaco-header">
            <div>
              <h3>{openFile?.path || "No file open"}{dirty ? " *" : ""}</h3>
              <p>{openFile ? `${editable ? editorLanguage : fileKind} · ${formatBytes(openFile.sizeBytes)}${editable ? ` · ${dirty ? "unsaved" : "saved"}` : ""}` : "Select a file from the explorer."}</p>
            </div>
            <div className="monaco-actions">
              {hasTextPreview && <div className="wiki-view-toggle" role="group" aria-label="File view mode">
                <button className={viewMode === "view" ? "active" : ""} type="button" onClick={() => { setDiffBaseline(null); setViewMode("view"); }}>View</button>
                <button className={viewMode === "edit" ? "active" : ""} type="button" onClick={() => setViewMode("edit")}>Edit</button>
              </div>}
              {fileKind === "json" && viewMode === "edit" && <button className="btn secondary" type="button" onClick={() => {
                const formatted = formatWorkspaceJson(editorContent);
                setEditorContent(formatted);
                setDirty(formatted !== openFile?.content);
              }}>Format JSON</button>}
              {fileKind === "image" && <div className="wiki-view-toggle" role="group" aria-label="Image size">
                <button className={imageFit ? "active" : ""} type="button" onClick={() => setImageFit(true)}>Fit</button>
                <button className={!imageFit ? "active" : ""} type="button" onClick={() => setImageFit(false)}>Actual size</button>
              </div>}
              {(fileKind === "html" || fileKind === "image") && <div className="job-preview-backgrounds" role="group" aria-label="Preview background">
                {(["light", "dark", "checker"] as const).map((background) => <button key={background} type="button" className={`job-preview-swatch ${background} ${previewBackground === background ? "selected" : ""}`} aria-label={`${background} preview background`} aria-pressed={previewBackground === background} title={`${background} background`} onClick={() => setPreviewBackground(background)} />)}
              </div>}
              {openFile ? <span className={`file-watch-pill ${conflictState}`}>{conflictState}</span> : null}
              {diffBaseline ? (
                <button className="btn secondary" type="button" onClick={() => setDiffBaseline(null)}>
                  Exit diff
                </button>
              ) : (
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => openFile && setDiffBaseline({ content: openFile.content, label: "last saved" })}
                  disabled={!openFile || !editable || !dirty}
                  title="Compare your unsaved edits against the last saved version"
                >
                  Diff
                </button>
              )}
              <button
                className="btn secondary"
                type="button"
                onClick={() => openFile && downloadWorkspaceEntry({ name: openFile.path.split("/").pop() || openFile.path, path: openFile.path, is_dir: false })}
                disabled={!openFile}
                title="Download this file"
              >
                Download
              </button>
              {previewSession ? (
                <button className="btn danger" type="button" onClick={() => void stopAppPreview()} disabled={previewBusy}>
                  <Icon name="stop" size={14} /> {previewBusy ? "Stopping..." : "Stop app"}
                </button>
              ) : (
                <button className="btn secondary" type="button" onClick={() => {
                  setPreviewPath(currentPath.startsWith("/") ? "" : currentPath);
                  setPreviewErrorMessage("");
                  setPreviewSetupOpen((open) => !open);
                }} disabled={dirty} title={dirty ? "Save or discard editor changes before running the saved project files" : "Start a project app for live preview"}>
                  <Icon name="play" size={14} /> Run app
                </button>
              )}
              <button
                className="btn danger"
                type="button"
                onClick={() => openFile && void deleteWorkspaceFile(openFile.path)}
                disabled={!openFile}
              >
                Delete
              </button>
              <button className="btn secondary" type="button" onClick={saveWorkspaceFile} disabled={!openFile || !editable || !dirty}>
                Save
              </button>
            </div>
          </div>
          {previewSetupOpen && !previewSession && <form className="app-preview-setup" onSubmit={(event) => void startAppPreview(event)}>
            <div className="app-preview-heading">
              <strong>Run a project app</strong>
              <p>The process can access workspace files and the agent container network. Preview JavaScript also runs in your browser and may contact services your browser can reach. Only run code you trust.</p>
            </div>
            <label>Project folder<input value={previewPath} onChange={(event) => setPreviewPath(event.target.value)} placeholder="projects/my-app" required /></label>
            <div className="app-preview-command-row">
              <label>Port<input type="number" min="1024" max="65535" value={previewPort} onChange={(event) => setPreviewPort(event.target.value)} required /></label>
              <label>Start command<input value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} maxLength={2000} required /></label>
            </div>
            <p className="muted">The default serves static files. The process receives <code>$PORT</code> and <code>$PREVIEW_BASE</code>; keep servers bound to <code>127.0.0.1</code>. WebSocket hot reload is not supported yet.</p>
            {terminalAuthRequired && !agentProvider.terminalToken && <p className="app-preview-auth-notice">
              Set the terminal token using <strong>Set terminal token</strong> above before starting apps or asking the agent to start a preview.
            </p>}
            <div className="project-git-actions">
              <button className="btn primary small" type="submit" disabled={previewBusy || dirty || (terminalAuthRequired && !agentProvider.terminalToken)}>{previewBusy ? "Starting..." : "Start preview"}</button>
              <button className="btn secondary small" type="button" onClick={() => setPreviewSetupOpen(false)} disabled={previewBusy}>Cancel</button>
            </div>
          </form>}
          {previewErrorMessage && <p className="app-preview-error" role="alert">{previewErrorMessage}</p>}
          {openFile && editable ? <CollabHint dirty={dirty} target="this file" /> : null}
          {openFile && conflictState !== "current" ? (
            <div className={`conflict-banner ${conflictState}`} role="status">
              <span>
                {conflictState === "changed"
                  ? "This file changed on disk since it was opened."
                  : conflictState === "deleted"
                    ? "This file is no longer available on disk."
                    : "Unable to verify this file's current disk state."}
              </span>
              {conflictState === "changed" && editable ? (
                <button className="btn secondary" type="button" onClick={() => void showDiskDiff()}>
                  View changes
                </button>
              ) : null}
              <button className="btn secondary" type="button" onClick={() => openWorkspaceFile(openFile.path)}>
                Reload
              </button>
            </div>
          ) : null}
          {previewSession ? (
            <div className="app-preview-pane">
              <div className="app-preview-status">
                <span className={`status-pill ${previewStatus?.ready ? "available" : previewStatus?.running ? "degraded" : "error"}`}>
                  {previewStatus?.ready ? "Preview ready" : previewStatus?.running ? "Starting app..." : "App stopped"}
                </span>
                <span className="muted">{previewSession.path} · port {previewSession.port}</span>
              </div>
              {previewStatus?.ready ? (
                <iframe
                  title={`Live preview of ${previewSession.path}`}
                  src={previewSession.view_url}
                  sandbox="allow-scripts allow-forms"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="app-preview-waiting">{previewStatus?.running ? "Waiting for the app to listen on its port..." : "The app process exited. Check its output below."}</div>
              )}
              <details className="app-preview-logs" open>
                <summary>App output</summary>
                <pre>{previewLogs || "Waiting for output..."}</pre>
              </details>
            </div>
          ) : openFile && !editable ? (
            <div className={`workspace-file-preview ${imageFit ? "fit" : "actual"} ${previewBackground}`}>
              {fileKind === "binary" ? <p className="muted">No built-in preview for this file type. Download it to open in another application.</p>
                : previewError ? <p role="alert">{previewError}</p>
                  : !mediaUrl ? <p className="muted">Loading preview...</p>
                    : fileKind === "image" ? <img src={mediaUrl} alt={openFile.path.split("/").pop() || "Workspace image"} onError={() => setPreviewError("Image preview unavailable. Download the original file.")} />
                      : fileKind === "pdf" ? <object data={mediaUrl} type="application/pdf" aria-label={openFile.path}><p className="muted">PDF preview unavailable. Download the original file.</p></object>
                        : fileKind === "audio" ? <audio src={mediaUrl} controls onError={() => setPreviewError("Audio format unsupported by this browser. Download the original file.")} />
                          : <video src={mediaUrl} controls onError={() => setPreviewError("Video format unsupported by this browser. Download the original file.")} />}
            </div>
          ) : diffBaseline ? (
            <>
              <p className="diff-legend muted">
                Left: {diffBaseline.label} · Right: current buffer{dirty ? " (unsaved)" : ""}
              </p>
              <div className="monaco-editor-host">
                <DiffEditor
                  height="100%"
                  language={editorLanguage}
                  theme="vs-dark"
                  original={diffBaseline.content}
                  modified={editorContent}
                  loading={<p className="muted">Loading diff...</p>}
                  options={{
                    fontSize: 13,
                    minimap: { enabled: false },
                    readOnly: true,
                    renderSideBySide: true,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                  }}
                />
              </div>
            </>
          ) : openFile && viewMode === "view" && fileKind === "html" ? (
            <div className={`workspace-file-preview ${previewBackground}`}><iframe title={`Preview of ${openFile.path}`} sandbox="allow-scripts" srcDoc={editorContent} /></div>
          ) : openFile && viewMode === "view" && fileKind === "markdown" ? (
            <div className="workspace-file-preview markdown"><Markdown content={editorContent} /></div>
          ) : (
          <div className="monaco-editor-host">
          <Editor
            height="100%"
            language={editorLanguage}
            path={openFile ? `${openFile.path}${fileKind === "json" && viewMode === "view" ? ".formatted-view" : ""}` : "workspace://empty.txt"}
            theme="vs-dark"
            value={displayedContent}
            loading={<p className="muted">Loading editor...</p>}
            onChange={(value) => {
              if (fileKind === "json" && viewMode === "view") return;
              setEditorContent(value || "");
              setDirty(Boolean(openFile && (value || "") !== openFile.content));
            }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              readOnly: !openFile || (fileKind === "json" && viewMode === "view"),
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
          </div>
          )}
        </section>
      </div>

      {status === "error" ? (
        <p className={`wiki-status ${statusToCapability(status)}`} role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}