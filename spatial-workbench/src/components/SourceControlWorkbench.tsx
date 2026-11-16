import { useEffect, useState } from "react";
import { compatClient, type WorkspaceGitCommit, type WorkspaceGitOperation, type WorkspaceGitRepository, type WorkspaceGitStatus, type WorkspaceGitTag } from "../api/compatClient";
import { Icon } from "./Icon";

function isLikelySecretPath(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  return name.startsWith(".env") || name.includes("secret") || name.includes("credential")
    || [".pem", ".key", ".p12", ".pfx"].some((extension) => name.endsWith(extension));
}

function changedPaths(status: WorkspaceGitStatus) {
  return status.changes.flatMap((change) => [change.path, ...(change.related_path ? [change.related_path] : [])]);
}

export function SourceControlWorkbench({ active, initialPath, onOpenProjects }: {
  active: boolean;
  initialPath: string;
  onOpenProjects: () => void;
}) {
  const [repositories, setRepositories] = useState<WorkspaceGitRepository[]>([]);
  const [repositoriesBusy, setRepositoriesBusy] = useState(false);
  const [repositoriesLoaded, setRepositoriesLoaded] = useState(false);
  const [repositoryLoadError, setRepositoryLoadError] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [message, setMessage] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [history, setHistory] = useState<WorkspaceGitCommit[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");
  const [tags, setTags] = useState<WorkspaceGitTag[]>([]);
  const [tagsBusy, setTagsBusy] = useState(false);
  const [tagsMessage, setTagsMessage] = useState("");
  const [releaseTagName, setReleaseTagName] = useState("");
  const [releaseTagMessage, setReleaseTagMessage] = useState("");

  useEffect(() => {
    if (!active) return;
    void loadRepositories(initialPath);
  }, [active, initialPath]);

  async function loadStatus(path = repositoryPath.trim()): Promise<boolean> {
    if (!path) {
      setMessage("Select a repository to inspect its changes.");
      return false;
    }
    setStatusBusy(true);
    setMessage("");
    try {
      const result = await compatClient.getWorkspaceGitStatus(path);
      setStatus(result.status);
      setRepositoryPath(result.status.path);
      setSelectedPaths(new Set());
      setSelectedBranch(result.status.branch);
      setAuthorName((current) => current || result.status.author_name);
      setAuthorEmail((current) => current || result.status.author_email);
      void loadHistory(result.status.path);
      void loadTags(result.status.path);
      return true;
    } catch (error) {
      setStatus(null);
      setHistory([]);
      setTags([]);
      setMessage(`Could not load Git status: ${error}`);
      return false;
    } finally {
      setStatusBusy(false);
    }
  }

  async function loadRepositories(preferredPath = "") {
    setRepositoriesBusy(true);
    setRepositoriesLoaded(false);
    setRepositoryLoadError("");
    setMessage("");
    try {
      const result = await compatClient.getWorkspaceGitRepositories();
      setRepositories(result.repositories);
      const preferred = preferredPath.trim().replace(/\/+$/, "");
      const selectedRepository = result.repositories
        .filter((repository) => preferred === repository.path || preferred.startsWith(`${repository.path}/`))
        .sort((left, right) => right.path.length - left.path.length)[0]
        ?? result.repositories.find((repository) => repository.path === repositoryPath)
        ?? null;
      if (selectedRepository) {
        setRepositoryPath(selectedRepository.path);
        void loadStatus(selectedRepository.path);
      } else {
        setRepositoryPath("");
        setStatus(null);
        setHistory([]);
        setHistoryMessage("");
        setTags([]);
        setTagsMessage("");
      }
    } catch (error) {
      setRepositories([]);
      setRepositoryPath("");
      setStatus(null);
      setRepositoryLoadError(String(error));
      setMessage(`Could not load Git repositories: ${error}`);
    } finally {
      setRepositoriesBusy(false);
      setRepositoriesLoaded(true);
    }
  }

  async function loadHistory(path: string) {
    setHistoryBusy(true);
    setHistoryMessage("");
    try {
      const result = await compatClient.getWorkspaceGitHistory(path);
      setHistory(result.commits);
    } catch (error) {
      setHistory([]);
      setHistoryMessage(`Could not load commit history: ${error}`);
    } finally {
      setHistoryBusy(false);
    }
  }

  async function loadTags(path: string) {
    setTagsBusy(true);
    setTagsMessage("");
    try {
      const result = await compatClient.getWorkspaceGitTags(path);
      setTags(result.tags);
    } catch (error) {
      setTags([]);
      setTagsMessage(`Could not load release tags: ${error}`);
    } finally {
      setTagsBusy(false);
    }
  }

  function setChangeSelected(change: WorkspaceGitStatus["changes"][number], checked: boolean) {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(change.path);
      else next.delete(change.path);
      return next;
    });
  }

  async function runOperation(action: WorkspaceGitOperation, tagName = releaseTagName.trim()) {
    if (!status) return;
    const sensitivePaths = [...selectedPaths].filter(isLikelySecretPath);
    if (action === "commit" && selectedPaths.size === 0) {
      setMessage("Select at least one changed file to commit.");
      return;
    }
    if (action === "stage" && stagePaths.length === 0) {
      setMessage("Select one or more unstaged files to stage.");
      return;
    }
    if (action === "unstage" && unstagePaths.length === 0) {
      setMessage("Select one or more staged files to unstage.");
      return;
    }
    if (action === "commit_staged" && stagedCount === 0) {
      setMessage("Stage one or more files before committing.");
      return;
    }
    if (action === "create_tag" && (!tagName || !releaseTagMessage.trim())) {
      setMessage("Enter a tag name and release message.");
      return;
    }
    if (action === "create_tag" && !status.clean) {
      setMessage("Commit or discard working-tree changes before creating a release tag.");
      return;
    }
    if (action === "push_tag" && !tagName) {
      setMessage("Choose a tag to push.");
      return;
    }
    const confirmation = action === "commit"
      ? `${selectedPaths.size} selected path(s) in ${status.path}${sensitivePaths.length
        ? ` include likely secret files: ${sensitivePaths.join(", ")}. Verify these are safe to commit.\n\n`
        : "?\n\n"}Continue?`
      : action === "stage"
        ? `Stage ${stagePaths.length} selected path(s) in ${status.path}${stageSensitivePaths.length
          ? `, including likely secret files: ${stageSensitivePaths.join(", ")}. Verify these are safe to commit.\n\n`
          : "?\n\n"}Continue?`
        : action === "unstage"
          ? `Unstage ${unstagePaths.length} selected path(s) in ${status.path}?\n\nContinue?`
          : action === "commit_staged"
            ? `Commit all staged changes in ${status.path}${stagedSensitivePaths.length
              ? `, including likely secret files: ${stagedSensitivePaths.join(", ")}. Verify these are safe to commit.\n\n`
              : "?\n\n"}Continue?`
            : action === "switch_branch"
              ? `Switch from ${status.branch || "detached HEAD"} to ${selectedBranch}?`
      : action === "pull_ff"
        ? `Fetch and fast-forward ${status.branch} from ${status.upstream}?`
        : action === "push"
          ? `Push committed changes from ${status.branch} to ${status.remote_host}?`
          : action === "create_tag"
            ? `Create annotated tag ${tagName} on ${status.branch || "detached HEAD"} in ${status.path}?\n\n${releaseTagMessage.trim()}`
            : `Push tag ${tagName} to ${status.remote_host}?`;
    if (!window.confirm(confirmation)) return;

    setOperationBusy(true);
    setMessage("");
    try {
      const result = await compatClient.runWorkspaceGitOperation({
        action,
        path: status.path,
        confirm: true,
        ...(["commit", "stage", "unstage"].includes(action) ? {
          paths: action === "stage" ? stagePaths : action === "unstage" ? unstagePaths : [...selectedPaths],
        } : {}),
        ...(["commit", "commit_staged"].includes(action) ? {
          ...(action === "commit" ? { paths: [...selectedPaths] } : {}),
          message: commitMessage,
          author_name: authorName,
          author_email: authorEmail,
          confirm_sensitive: action === "commit_staged" ? stagedSensitivePaths.length > 0 : sensitivePaths.length > 0,
        } : {}),
        ...(action === "stage" ? { confirm_sensitive: stageSensitivePaths.length > 0 } : {}),
        ...(action === "switch_branch" ? { branch: selectedBranch } : {}),
        ...(action === "create_tag" ? { tag_name: tagName, tag_message: releaseTagMessage.trim() } : {}),
        ...(action === "push_tag" ? { tag_name: tagName } : {}),
      });
      const successMessage = ["commit", "commit_staged"].includes(action) && "commit" in result.result
        ? `Created ${result.result.commit}: ${result.result.message}`
        : action === "stage" ? "Changes staged."
          : action === "unstage" ? "Changes unstaged."
            : action === "switch_branch" ? `Switched to ${selectedBranch}.`
              : action === "pull_ff" ? "Fast-forward pull completed."
                : action === "push" ? "Push completed."
                  : action === "create_tag" ? `Created release tag ${tagName}.`
                    : `Pushed release tag ${tagName} to ${status.remote_host}.`;
      if (action === "commit" || action === "commit_staged") setCommitMessage("");
      if (action === "create_tag") {
        setReleaseTagName("");
        setReleaseTagMessage("");
      }
      if (await loadStatus(status.path)) setMessage(successMessage);
    } catch (error) {
      setMessage(`Git ${action} failed: ${error}`);
    } finally {
      setOperationBusy(false);
    }
  }

  const stagedChanges = status?.changes.filter((change) => change.staged) ?? [];
  const unstagedChanges = status?.changes.filter((change) => change.unstaged) ?? [];
  const stagedCount = stagedChanges.length;
  const unstagedCount = unstagedChanges.length;
  const selectedSensitive = [...selectedPaths].some(isLikelySecretPath);
  const selectedUnstagedChanges = unstagedChanges.filter((change) => selectedPaths.has(change.path));
  const selectedStagedChanges = stagedChanges.filter((change) => selectedPaths.has(change.path));
  const stagePaths = selectedUnstagedChanges.flatMap((change) => [change.path, ...(change.related_path ? [change.related_path] : [])]);
  const unstagePaths = selectedStagedChanges.flatMap((change) => [change.path, ...(change.related_path ? [change.related_path] : [])]);
  const stageSensitivePaths = stagePaths.filter(isLikelySecretPath);
  const stagedSensitivePaths = stagedChanges.flatMap((change) => [change.path, ...(change.related_path ? [change.related_path] : [])]).filter(isLikelySecretPath);

  return (
    <section className="source-control-workbench" aria-label="Source Control">
      <header className="source-control-header">
        <div>
          <p className="eyebrow">Repository workspace</p>
          <h2>Source Control</h2>
          <p>Review changes, choose what to commit, and sync with the remote.</p>
        </div>
        <div className="source-control-repository-form">
          <label htmlFor="source-control-repository">Git repository</label>
          <div>
            <select
              id="source-control-repository"
              value={repositoryPath}
              onChange={(event) => {
                const path = event.target.value;
                setRepositoryPath(path);
                setStatus(null);
                setHistory([]);
                setMessage("");
                if (path) void loadStatus(path);
              }}
              disabled={repositoriesBusy || repositories.length === 0}
            >
              <option value="">{repositoriesBusy ? "Loading repositories..." : "Select a repository"}</option>
              {repositories.map((repository) => (
                <option key={repository.path} value={repository.path}>
                  {repository.path}{repository.branch ? ` · ${repository.branch}` : ""}
                </option>
              ))}
            </select>
            <button
              className="btn secondary small"
              type="button"
              disabled={repositoriesBusy || statusBusy}
              onClick={() => void loadRepositories(status?.path || repositoryPath || initialPath)}
            >
              <Icon name="refresh" size={14} /> {repositoriesBusy ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      {status ? (
        <div className="source-control-body">
          <section className="source-control-repo-summary" aria-label="Repository status">
            <div className="source-control-branch">
              <Icon name="branch" size={17} />
              <strong>{status.branch || "detached HEAD"}</strong>
              <span>{status.path}</span>
            </div>
            <div className="source-control-sync">
              <span>{status.upstream || "No upstream configured"}</span>
              {status.upstream && <span>{status.ahead ?? 0} ahead · {status.behind ?? 0} behind</span>}
              <span>{status.remote_host ? `origin · ${status.remote_transport} · ${status.remote_host}` : "No supported origin remote"}</span>
            </div>
            <div className="source-control-sync-actions">
              <label className="source-control-branch-picker">
                <select
                  aria-label="Switch branch"
                  value={selectedBranch}
                  onChange={(event) => setSelectedBranch(event.target.value)}
                  disabled={status.branches.length < 2 || !status.clean || operationBusy || statusBusy}
                >
                  {status.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </label>
              <button
                className="btn secondary small"
                type="button"
                disabled={operationBusy || statusBusy || !status.clean || !selectedBranch || selectedBranch === status.branch}
                onClick={() => void runOperation("switch_branch")}
              >
                Switch
              </button>
              <button
                className="btn secondary small"
                type="button"
                disabled={operationBusy || statusBusy || !status.upstream || !status.clean}
                onClick={() => void runOperation("pull_ff")}
                title={!status.clean ? "Commit or stash working-tree changes before pulling." : undefined}
              >
                Pull
              </button>
              <button
                className="btn secondary small"
                type="button"
                disabled={operationBusy || statusBusy || !status.remote_host || !status.branch}
                onClick={() => void runOperation("push")}
              >
                Push
              </button>
            </div>
          </section>

          <div className="source-control-content">
            <section className="source-control-changes" aria-labelledby="source-control-changes-heading">
              <div className="source-control-section-heading">
                <div>
                  <h3 id="source-control-changes-heading">Changes</h3>
                  <span>{status.changes.length} file{status.changes.length === 1 ? "" : "s"}</span>
                </div>
                {status.changes.length > 0 && <div>
                  <button className="source-control-text-button" type="button" onClick={() => setSelectedPaths(new Set(changedPaths(status)))}>
                    Select all
                  </button>
                  <button className="source-control-text-button" type="button" onClick={() => setSelectedPaths(new Set())}>
                    Clear
                  </button>
                </div>}
              </div>
              {status.changes.length ? (
                <>
                  {selectedSensitive && <p className="source-control-warning" role="alert">
                    Selected filenames may contain secrets. Review their contents before committing.
                  </p>}
                  {stagedCount > 0 && <p className="source-control-note">
                    {stagedCount} staged · {unstagedCount} unstaged.
                  </p>}
                  <div className="source-control-index-actions">
                    <button className="btn secondary small" type="button" disabled={operationBusy || stagePaths.length === 0} onClick={() => void runOperation("stage")}>
                      Stage selected{stagePaths.length ? ` (${stagePaths.length})` : ""}
                    </button>
                    <button className="btn secondary small" type="button" disabled={operationBusy || unstagePaths.length === 0} onClick={() => void runOperation("unstage")}>
                      Unstage selected{unstagePaths.length ? ` (${unstagePaths.length})` : ""}
                    </button>
                  </div>
                  <ul className="source-control-change-list">
                    {status.changes.map((change) => (
                      <li key={`${change.path}:${change.related_path || ""}`}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedPaths.has(change.path)}
                            onChange={(event) => setChangeSelected(change, event.target.checked)}
                            disabled={change.conflicted}
                          />
                          <span className="source-control-status-code">{change.status}</span>
                          <span className="source-control-change-path">
                            <span>{change.path}</span>
                            {change.related_path && <small>from {change.related_path}</small>}
                            {change.conflicted && <small className="source-control-conflict">conflict</small>}
                          </span>
                          <span className="source-control-change-state">
                            {change.staged && change.unstaged ? "staged + modified" : change.staged ? "staged" : "modified"}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="source-control-clean">
                  <span aria-hidden="true">✓</span>
                  <strong>Working tree clean</strong>
                  <p>No changes to commit.</p>
                </div>
              )}
            </section>

            <form className="source-control-commit" onSubmit={(event) => {
              event.preventDefault();
              void runOperation("commit_staged");
            }}>
              <div className="source-control-section-heading">
                <div>
                  <h3>Commit</h3>
                  <span>{stagedCount} staged</span>
                </div>
              </div>
              <label htmlFor="source-control-message">Message</label>
              <textarea
                id="source-control-message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Describe this change"
                maxLength={2000}
                rows={3}
                disabled={status.changes.length === 0}
              />
              <details className="source-control-author" open={!authorName || !authorEmail}>
                <summary>Commit author</summary>
                <label>Name<input value={authorName} onChange={(event) => setAuthorName(event.target.value)} required /></label>
                <label>Email<input type="email" value={authorEmail} onChange={(event) => setAuthorEmail(event.target.value)} required /></label>
              </details>
              <button
                className="btn primary source-control-commit-button"
                type="submit"
                disabled={operationBusy || statusBusy || !commitMessage.trim() || !authorName.trim() || !authorEmail.trim()
                  || stagedCount === 0 || status.changes.some((change) => change.conflicted)}
              >
                {operationBusy ? "Working..." : `Commit staged${stagedCount ? ` (${stagedCount})` : ""}`}
              </button>
            </form>
            <section className="source-control-history" aria-labelledby="source-control-history-heading">
              <div className="source-control-section-heading">
                <div>
                  <h3 id="source-control-history-heading">Commit history</h3>
                  <span>{historyBusy ? "Loading..." : `${history.length} recent`}</span>
                </div>
                <button className="source-control-text-button" type="button" disabled={historyBusy} onClick={() => void loadHistory(status.path)}>
                  Refresh
                </button>
              </div>
              {historyMessage && <p className="source-control-message error" role="status">{historyMessage}</p>}
              {!historyBusy && !historyMessage && history.length === 0 ? (
                <p className="source-control-note">No commits yet.</p>
              ) : (
                <ol className="source-control-history-list">
                  {history.map((commit) => (
                    <li key={commit.commit}>
                      <code>{commit.commit.slice(0, 8)}</code>
                      <span className="source-control-history-subject">{commit.subject}</span>
                      <span className="source-control-history-author">{commit.author}</span>
                      <time dateTime={commit.authored_at}>{new Date(commit.authored_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section className="source-control-tags" aria-labelledby="source-control-tags-heading">
              <div className="source-control-section-heading">
                <div>
                  <h3 id="source-control-tags-heading">Release tags</h3>
                  <span>{tagsBusy ? "Loading..." : `${tags.length} local`}</span>
                </div>
                <button className="source-control-text-button" type="button" disabled={tagsBusy} onClick={() => void loadTags(status.path)}>
                  Refresh
                </button>
              </div>
              <form className="source-control-tag-form" onSubmit={(event) => {
                event.preventDefault();
                void runOperation("create_tag");
              }}>
                <label htmlFor="source-control-tag-name">Tag name</label>
                <input
                  id="source-control-tag-name"
                  value={releaseTagName}
                  onChange={(event) => setReleaseTagName(event.target.value)}
                  placeholder="v1.0.0"
                  maxLength={200}
                  required
                  disabled={!status.clean || operationBusy || statusBusy}
                />
                <label htmlFor="source-control-tag-message">Release message</label>
                <textarea
                  id="source-control-tag-message"
                  value={releaseTagMessage}
                  onChange={(event) => setReleaseTagMessage(event.target.value)}
                  placeholder="Summarize this release"
                  maxLength={2000}
                  rows={2}
                  required
                  disabled={!status.clean || operationBusy || statusBusy}
                />
                <button className="btn secondary small" type="submit" disabled={!status.clean || operationBusy || statusBusy
                  || !releaseTagName.trim() || !releaseTagMessage.trim()}>
                  Create annotated tag
                </button>
              </form>
              {tagsMessage && <p className="source-control-message error" role="status">{tagsMessage}</p>}
              {tags.length ? (
                <ul className="source-control-tag-list">
                  {tags.map((tag) => (
                    <li key={tag.name}>
                      <div>
                        <strong>{tag.name}</strong>
                        <span>{tag.subject || "No release message"}</span>
                        {tag.commit && <code>{tag.commit}</code>}
                      </div>
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={!status.remote_host || operationBusy || statusBusy}
                        onClick={() => void runOperation("push_tag", tag.name)}
                        title={!status.remote_host ? "Configure an origin remote before pushing tags." : undefined}
                      >
                        Push tag
                      </button>
                    </li>
                  ))}
                </ul>
              ) : !tagsBusy && !tagsMessage ? (
                <p className="source-control-note">No release tags yet.</p>
              ) : null}
            </section>
          </div>
        </div>
      ) : (
        <div className="source-control-empty">
          <Icon name="branch" size={26} />
          <h3>{repositoriesBusy || !repositoriesLoaded
            ? "Finding repositories"
            : repositoryLoadError
              ? "Could not load repositories"
              : repositories.length
                ? "Choose a repository"
                : "No Git repositories found"}</h3>
          <p>{repositoriesBusy || !repositoriesLoaded
            ? "Searching projects/ for Git repositories."
            : repositoryLoadError
              ? "Refresh the repository list to try again."
              : repositories.length
                ? "Select a repository above to review its changes."
                : "Create or clone a Git repository under projects/ to use Source Control."}</p>
          {repositoriesLoaded && !repositoryLoadError && !repositories.length && <button className="btn secondary small" type="button" onClick={onOpenProjects}>
            Open Projects
          </button>}
        </div>
      )}
      {message && <p className={`source-control-message ${message.startsWith("Could not") || message.startsWith("Git ") ? "error" : ""}`} role="status">{message}</p>}
    </section>
  );
}
