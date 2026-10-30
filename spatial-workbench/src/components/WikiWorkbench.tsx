import { useEffect, useRef, useState } from "react";
import { compatClient, type CapabilityState, type WikiEntry, type WikiSearchResult } from "../api/compatClient";
import { CollabHint } from "./CollabHint";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

type WikiStatus = CapabilityState | "idle";
type WikiViewMode = "view" | "edit";

function parentPath(path: string) {
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (!clean) return "";
  const parts = clean.split("/");
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes: number | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusToCapability(status: WikiStatus): CapabilityState {
  if (status === "idle") return "degraded";
  return status;
}

// Pull unique [[wikilink]] targets out of markdown, skipping code blocks and
// in-page anchors ([[#Heading]]). Mirrors the parsing in remarkWikilinks.
function extractWikiLinkTargets(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  const targets = new Set<string>();
  const re = /\[\[([^\[\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutFences)) !== null) {
    const raw = match[1].trim();
    if (raw.startsWith("#")) continue;
    const target = raw.split("|", 1)[0].trim();
    if (target) targets.add(target);
  }
  return [...targets];
}

export function WikiWorkbench() {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [treeEntries, setTreeEntries] = useState<Record<string, WikiEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [filePath, setFilePath] = useState("index.md");
  const [content, setContent] = useState("");
  /** Last known on-disk text, used to spot agent edits without stomping unsaved work. */
  const [savedContent, setSavedContent] = useState("");
  const [loadedPath, setLoadedPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WikiSearchResult[]>([]);
  const [status, setStatus] = useState<WikiStatus>("idle");
  const [message, setMessage] = useState("Load a wiki file or browse the configured wiki root.");
  const [viewMode, setViewMode] = useState<WikiViewMode>("view");
  const [resolvedLinks, setResolvedLinks] = useState<Record<string, string>>({});
  const [unresolvedLinks, setUnresolvedLinks] = useState<Record<string, boolean>>({});
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Resolve an Obsidian-style [[wikilink]] target to a wiki file path so the
  // rendered viewer can make cross-references clickable.
  async function resolveLink(target: string) {
    const key = target.trim();
    if (!key || resolvedLinks[key] || unresolvedLinks[key]) return;
    try {
      const result = await compatClient.resolveWikiLink(key, filePath);
      if (result.ok && result.path) {
        setResolvedLinks((prev) => ({ ...prev, [key]: result.path as string }));
      } else {
        setUnresolvedLinks((prev) => ({ ...prev, [key]: true }));
      }
    } catch (_error) {
      setUnresolvedLinks((prev) => ({ ...prev, [key]: true }));
    }
  }

  function handleWikiLinkClick(target: string) {
    const path = resolvedLinks[target];
    if (path) {
      void loadFile(path);
      return;
    }
    // Not resolved yet — kick off resolution, then load once it lands.
    void compatClient.resolveWikiLink(target, filePath).then((result) => {
      if (result.ok && result.path) {
        setResolvedLinks((prev) => ({ ...prev, [target]: result.path as string }));
        void loadFile(result.path as string);
      } else {
        setUnresolvedLinks((prev) => ({ ...prev, [target]: true }));
        setStatus("error");
        setMessage(`No wiki page matches [[${target}]]`);
      }
    });
  }

  async function loadTree(path = currentPath) {
    setStatus("degraded");
    setMessage(`Loading /${path}`);
    try {
      const result = await compatClient.listWiki(path);
      setCurrentPath(result.path || "");
      setEntries(result.items || []);
      setTreeEntries((current) => ({ ...current, [result.path || ""]: result.items || [] }));
      setExpandedPaths((current) => new Set(current).add(result.path || ""));
      setStatus("available");
      setMessage(`Browsing /${result.path || ""}`.replace(/\/$/, ""));
    } catch (error) {
      setStatus("error");
      setMessage(`Browse failed: ${error}`);
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
        const result = await compatClient.listWiki(path);
        setTreeEntries((current) => ({ ...current, [result.path || path]: result.items || [] }));
      } catch (error) {
        setStatus("error");
        setMessage(`Browse failed: ${error}`);
        return;
      }
    }
    setExpandedPaths((current) => new Set(current).add(path));
  }

  function renderTree(items: WikiEntry[], depth = 0): React.ReactNode {
    return items.map((entry) => {
      const expanded = expandedPaths.has(entry.path);
      return (
        <div className="project-tree-node" key={entry.path}>
          <div className="project-tree-row-wrap">
            <button
              className={`project-tree-row ${entry.is_dir ? "directory" : "file"} ${filePath === entry.path ? "selected" : ""}`}
              type="button"
              style={{ paddingLeft: `calc(var(--space-sm) + ${depth} * var(--space-md))` }}
              aria-expanded={entry.is_dir ? expanded : undefined}
              title={entry.path}
              onClick={() => (entry.is_dir ? void toggleDirectory(entry.path) : void loadFile(entry.path))}
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
              onClick={() => downloadWikiEntry(entry)}
            >
              <Icon name="download" size={13} />
            </button>
          </div>
          {entry.is_dir && expanded && treeEntries[entry.path] ? (
            <div className="project-tree-children">{renderTree(treeEntries[entry.path], depth + 1)}</div>
          ) : null}
        </div>
      );
    });
  }

  function downloadWikiEntry(entry: WikiEntry) {
    const anchor = document.createElement("a");
    anchor.href = compatClient.wikiDownloadUrl(entry.path);
    anchor.download = entry.is_dir ? `${entry.name}.zip` : entry.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setStatus("available");
    setMessage(`Downloading ${entry.is_dir ? `folder ${entry.name}.zip` : entry.name}`);
  }

  async function loadFile(path = filePath) {
    const cleanPath = path.trim();
    if (!cleanPath) {
      setStatus("error");
      setMessage("Enter a wiki file path.");
      return;
    }

    setStatus("degraded");
    setMessage(`Loading ${cleanPath}`);
    try {
      const result = await compatClient.readWikiFile(cleanPath);
      setFilePath(result.path);
      setContent(result.content || "");
      setSavedContent(result.content || "");
      setLoadedPath(result.path);
      setStatus("available");
      setMessage(`Loaded ${result.path} (${formatBytes(result.size_bytes)})`);
      // Pre-resolve any [[wikilinks]] in the page so the viewer can make them
      // clickable without a round-trip on first click.
      const targets = extractWikiLinkTargets(result.content || "");
      targets.forEach((target) => void resolveLink(target));
    } catch (error) {
      setStatus("error");
      setMessage(`Load failed: ${error}`);
    }
  }

  async function saveFile() {
    const cleanPath = filePath.trim();
    if (!cleanPath) {
      setStatus("error");
      setMessage("Enter a wiki file path before saving.");
      return;
    }

    setStatus("degraded");
    setMessage(`Saving ${cleanPath}`);
    try {
      const result = await compatClient.writeWikiFile(cleanPath, content);
      setSavedContent(content);
      setLoadedPath(result.path);
      setStatus("available");
      setMessage(`Saved ${result.path} (${formatBytes(result.size_bytes)})`);
      const directory = parentPath(result.path);
      if (treeEntries[directory]) {
        const refreshed = await compatClient.listWiki(directory);
        setTreeEntries((current) => ({ ...current, [refreshed.path || directory]: refreshed.items || [] }));
        if ((refreshed.path || directory) === currentPath) {
          setEntries(refreshed.items || []);
        }
      }
    } catch (error) {
      setStatus("error");
      setMessage(`Save failed: ${error}`);
    }
  }

  async function createNewPage() {
    const raw = window.prompt("New wiki page path (e.g. notes/my-page.md):", filePath);
    if (raw === null) return;
    const cleanPath = raw.trim();
    if (!cleanPath) {
      setStatus("error");
      setMessage("Enter a wiki page path.");
      return;
    }
    const path = cleanPath.endsWith(".md") || cleanPath.endsWith(".markdown") || cleanPath.endsWith(".txt")
      ? cleanPath
      : `${cleanPath}.md`;
    setStatus("degraded");
    setMessage(`Creating ${path}`);
    try {
      const result = await compatClient.writeWikiFile(path, `# ${path.split("/").pop()?.replace(/\.(md|markdown|txt)$/i, "") || path}\n`);
      setFilePath(result.path);
      await loadTree(parentPath(result.path));
      await loadFile(result.path);
      setStatus("available");
      setMessage(`Created ${result.path}`);
    } catch (error) {
      setStatus("error");
      setMessage(`Create failed: ${error}`);
    }
  }

  function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function uploadFile(file: File) {
    const dir = parentPath(loadedPath || filePath) || "";
    const targetPath = dir ? `${dir}/${file.name}` : file.name;
    setStatus("degraded");
    setMessage(`Uploading ${file.name}`);
    try {
      const contentBase64 = await readAsBase64(file);
      const result = await compatClient.uploadWikiFile(targetPath, contentBase64);
      await loadTree(parentPath(result.path));
      setStatus("available");
      setMessage(`Uploaded ${result.path} (${formatBytes(result.size_bytes)})`);
    } catch (error) {
      setStatus("error");
      setMessage(`Upload failed: ${error}`);
    }
  }

  const dirty = content !== savedContent;

  // Surface agent edits to the open note, but never discard unsaved user work.
  useEffect(() => {
    if (!loadedPath || dirty) return;
    let live = true;
    const timer = window.setInterval(async () => {
      try {
        const result = await compatClient.readWikiFile(loadedPath);
        if (!live || result.content === savedContent) return;
        setContent(result.content || "");
        setSavedContent(result.content || "");
        setMessage(`${loadedPath} updated on disk.`);
      } catch (_error) {
        // A transient read failure should not clear the editor.
      }
    }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [loadedPath, dirty, savedContent]);

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    setStatus("degraded");
    setMessage(`Searching for ${query}`);
    try {
      const result = await compatClient.searchWiki(query, 10);
      setSearchResults(result.items || []);
      setStatus("available");
      setMessage(`Found ${result.items.length} wiki matches.`);
    } catch (error) {
      setStatus("error");
      setMessage(`Search failed: ${error}`);
    }
  }

  useEffect(() => {
    void loadTree("");
  }, []);

  return (
    <section className="wiki-workbench" aria-label="Wiki workbench">
      <div className="wiki-header">
        <div>
          <h2>Wiki Workbench</h2>
          <p className="muted">Browse, read, search, and update wiki notes through the companion API.</p>
        </div>
        <span className={`status-pill ${statusToCapability(status)}`}>{statusToCapability(status)}</span>
      </div>

      <div className="wiki-grid">
        <aside className="wiki-browser" aria-label="Wiki file browser">
          <div className="project-tree wiki-tree" role="tree" aria-label="Wiki files and folders">
            {entries.length === 0 ? (
              <p className="muted">No wiki entries loaded.</p>
            ) : (
              renderTree(entries)
            )}
          </div>
        </aside>

        <section className="wiki-editor-shell">
          <div className="wiki-file-controls">
            <input
              aria-label="Wiki file path"
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder="index.md"
            />
            <button className="btn secondary" type="button" onClick={() => loadFile()}>
              Load
            </button>
            <button className="btn secondary" type="button" onClick={() => void createNewPage()} title="Create a new wiki page">
              New
            </button>
            <button className="btn secondary" type="button" onClick={() => uploadInputRef.current?.click()} title="Upload a file into the wiki">
              Upload
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              style={{ display: "none" }}
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
                event.target.value = "";
              }}
            />
            <button className="btn" type="button" onClick={saveFile} disabled={!dirty}>
              {dirty ? "Save *" : "Save"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => loadedPath && downloadWikiEntry({ name: loadedPath.split("/").pop() || loadedPath, path: loadedPath, is_dir: false })}
              disabled={!loadedPath}
              title="Download this file"
            >
              Download
            </button>
            <div className="wiki-view-toggle" role="group" aria-label="Wiki view mode">
              <button
                className={`btn secondary ${viewMode === "view" ? "active" : ""}`}
                type="button"
                aria-pressed={viewMode === "view"}
                onClick={() => setViewMode("view")}
              >
                View
              </button>
              <button
                className={`btn secondary ${viewMode === "edit" ? "active" : ""}`}
                type="button"
                aria-pressed={viewMode === "edit"}
                onClick={() => setViewMode("edit")}
              >
                Edit
              </button>
            </div>
          </div>
          {loadedPath ? <CollabHint dirty={dirty} target="this note" /> : null}
          {viewMode === "view" ? (
            <div className="wiki-viewer" aria-label="Wiki markdown viewer">
              {content ? (
                <Markdown content={content} onWikiLinkClick={handleWikiLinkClick} />
              ) : (
                <p className="muted">Select or load a wiki file to read it here.</p>
              )}
            </div>
          ) : (
            <textarea
              aria-label="Wiki editor"
              className="wiki-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Select or load a wiki file to edit."
            />
          )}
          {/* Only surface the status line on errors — routine "Browsing /
              Loaded ..." messages are noise the user doesn't need. */}
          {status === "error" && (
            <p className={`wiki-status ${statusToCapability(status)}`} aria-live="polite">
              {message}
            </p>
          )}
        </section>
      </div>

      <section className="wiki-search" aria-label="Wiki search">
        <div className="wiki-file-controls">
          <input
            aria-label="Wiki search query"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void runSearch();
              }
            }}
            placeholder="Search wiki notes"
          />
          <button className="btn secondary" type="button" onClick={runSearch}>
            Search
          </button>
        </div>
        <div className="wiki-search-results">
          {searchResults.length === 0 ? (
            <p className="muted">No search results yet.</p>
          ) : (
            searchResults.map((result) => (
              <button className="wiki-search-result" key={result.path} type="button" onClick={() => loadFile(result.path)}>
                <strong>{result.path}</strong>
                <span>{result.snippet}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </section>
  );
}