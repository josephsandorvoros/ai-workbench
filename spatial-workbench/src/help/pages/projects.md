## Browse and open files

Open **Projects**. The file tree stays rooted in the workspace; expand folders, including `artifacts/` and `jobs/`, to browse their contents. The file tree refreshes automatically without reloading the page or resetting chat. Paths belong to the agent host or its mounted workspace, not your desktop computer.

HTML and Markdown open in a rendered **View**; use **Edit** for their source. JSON has a formatted read-only view and an explicit **Format JSON** action in Edit mode. Images have Fit/Actual size controls. PDFs, audio, and video use browser-supported previews; unsupported or oversized files remain downloadable.

## Run a project app

In **Projects**, choose **Run app** to start a project from a workspace-relative folder. Enter the start command and the port the app listens on. The default serves static files with `python3 -m http.server "$PORT" --bind 127.0.0.1` on port `8000`; the process receives `PORT` and `PREVIEW_BASE`. Keep the server bound to `127.0.0.1`. The Workbench checks the port, shows process output and readiness, and proxies the app into the editor preview. Use **Stop app** to terminate the process group. Save editor changes before launching; the server uses files on disk.

Starting an app executes its command as the Workbench agent user, not in the Jobs worker sandbox. It can access files and network services available to that user. Preview JavaScript also runs in your browser and can contact services your browser is allowed to reach. Only run code you trust. The browser preview remains in a sandboxed frame with an opaque origin; browser storage, cookies, and other origin-dependent features can need app-specific changes. WebSocket features such as hot-module reload are not supported. The proxy rewrites common root-relative URLs in HTML, including inline fetch calls, but not every URL in external scripts or stylesheets. Configure the app's base path with `PREVIEW_BASE` when its framework supports it.

If terminal authentication is required, use **Set terminal token** in the Projects header, or **Replace terminal token** to change it. The modal saves the token for this browser session without launching an app.

You can also ask the chat agent to start a preview. Provide the project folder, exact start command, and port. Direct API chat uses the local preview tools when its tool loop is enabled, with the selected chat approval policy; Hermes Gateway uses its configured Workbench MCP server and server-side credentials. Follow the returned **Open live preview** link or tool-card action. It opens Projects through the Workbench origin, not your computer's `localhost`. No additional public port is needed.

Previews are temporary: API/container restarts discard sessions, and two hours without preview activity stops the process. Stale session links return Projects to its normal file editor without a standing error. Re-running a project creates a new preview link.

## Edit safely

1. Open the file and inspect its current contents.
2. Make your change in the editor.
3. Save explicitly. An unsaved editor buffer is not the version on disk.
4. If an agent or another browser changed the file, review the conflict or comparison before saving over it. Reloading discards your unsaved changes.

The editor can compare your version with newer disk contents. For repository work done by workers, use [Project review](#help/worker-profiles) rather than assuming the editor's view is a merge review.

## Upload, download, and delete

Use **New file**, **New folder**, or **Import file** to add content. Import accepts any file type, preserves its bytes and filename, and places it in the workspace root. Each import is limited to 10 MB and will not overwrite an existing file. A file download saves that file to your computer; a folder download is packaged as a ZIP. Review the contents before sharing a folder because it may contain source code or private data.

Files and folders have trash controls. Folder deletion requires typing its name and moves the complete folder, including hidden files and nested folders, into the companion's recovery backup storage. The workspace, agent roots, and recovery storage cannot be deleted. Deletion stops if a backup cannot be created. Unsaved edits inside the deleted folder are discarded, and its open file is closed.

Delete does not undo an agent task or stop a running worker. Check the selected path and stop work through the Job Board before deleting a folder still in use. Recovery backups live under `WORKBENCH_BACKUP_DIR/workspace` (by default, the Hermes Workbench backup directory), not in the deleted project.

## Set up a project for workers

Project jobs need a Git repository inside the workspace and a local base branch. If the project is not yet a repository, use the Git setup controls to preview the proposed initialization and review the files before confirming. Do not commit secrets or generated credentials.

Read [Worker profiles & project review](#help/worker-profiles) before allowing workers to change a repository. They work in separate worktrees, and merging is an explicit action.