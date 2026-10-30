# Workbench TODO

Deferred ideas recorded on October 6, 2026. These are future work, not features currently available or changes scheduled for implementation.

## User-Added Tools

- [ ] Add a way to create and configure user-defined tools.
- [ ] Support adding web tools as well as other custom tools.
- [ ] Allow editing and removing user-added tools.
- [ ] Keep the Workbench's built-in tools read-only and protected from user deletion.

Distinguish built-in tools from user-added tools in the interface. Work out how custom tools are registered with the relevant agent or browser execution path, including permissions and any required credentials.

## External Git Repositories

Goal: let a user keep working in the Workbench while making a project portable to and from an external Git host, so the VM is not the only place the project exists. Build on the Projects view's existing local Git preview, sensitive-file warnings, confirmation, initialization, and initial-commit flow.

### Project setup and connection

- [ ] Support connecting an existing local project to a remote, cloning a remote project into the workspace, and initializing a new local project for a remote.
- [ ] Accept standard Git remote URLs for GitHub, GitLab, Forgejo, and other Git-compatible hosts; show the repository URL, provider/host, default remote, and selected branch.
- [ ] Validate remote reachability and repository identity before changing project state. Explain whether a remote is empty, already contains commits, or has unrelated history, and provide a deliberate path for each case.
- [ ] Keep repository configuration per project. Disconnecting a remote must not delete local files or Git history.

### Authentication and safety

- [ ] Support public read access without credentials and authenticated access for private repositories and pushes. Design for HTTPS tokens first and assess SSH-key support without requiring credentials to be embedded in remote URLs.
- [ ] Keep credentials write-only and server-side, scoped to the Workbench instance or project as appropriate. Never return secrets to the browser, save them in Git config/URLs, expose them in process arguments, or include them in logs/errors. Show credential-set status and offer explicit replacement/removal.
- [ ] Run Git operations with bounded timeouts/output and validated project paths/remotes. Reject unsafe protocols and local/host paths unless explicitly supported; protect against hooks, submodules, symlinks, and repository-controlled configuration executing code or escaping the selected project.
- [ ] Before publishing, review the exact outgoing commits and file changes, including untracked files. Warn on likely credentials/private data and provide ignore/exclude controls; require explicit confirmation before the first publish and each push.

### Daily workflow

- [ ] Show current branch, remote/upstream, clean/modified/untracked state, ahead/behind counts, last fetch/push, and actionable Git errors in Projects.
- [ ] Support creating and switching branches, inspecting diffs, staging/unstaging selected files, writing commit messages, and creating local commits. Preserve the current workspace editor and file-conflict checks.
- [ ] Support explicit fetch and push. Offer pull by fast-forward when safe, and a clear merge/rebase choice when histories diverge. Never force-push or overwrite local edits by default.
- [ ] Provide a conflict-resolution flow that identifies affected files, preserves the pre-sync state, presents base/local/remote content, and requires the user to resolve and confirm before completing the merge/rebase. Do not silently discard uncommitted work.
- [ ] Make network sync user-initiated and visible. Background workers/jobs may edit local worktrees and use the existing review/local-merge flow, but must never push, pull, or change remotes without a separate explicit user action.

### Portability and recovery

- [ ] Make it straightforward to verify that the latest intended commit reached the remote and to recover the project on another machine by cloning it there.
- [ ] Provide a portable export path (for example, Git bundle or archive) for cases where a remote is unavailable or the user wants a local copy outside the VM.
- [ ] Keep local project files and history after push or disconnect. If offering removal of a VM copy later, require a separate explicit action after verifying a recoverable remote/export and explain what will be deleted.
- [ ] Document remote setup, credential handling, publish/pull behavior, conflict recovery, and migration off the VM.

### Delivery and acceptance

- [ ] Deliver in stages: (1) status + remote connection and clone, (2) reviewed local commits + authenticated push, (3) fetch/fast-forward and conflict-safe pull, (4) branch management and portability export/recovery.
- [ ] Add backend contract tests for path/remote validation, secret redaction, timeouts, stale previews, dirty trees, failed auth/network operations, and non-destructive sync; add frontend tests for review/confirm/error/conflict states.
- [ ] Verify with local bare remotes and isolated test repositories, including a public-read simulation, authenticated push, divergent histories, interrupted operations, and projects containing likely secrets. Do not test against or mutate a live user repository without explicit authorization.
- [ ] Preserve worker worktrees, local merge behavior, and projects that are not connected to a remote. Do not deploy or publish the feature without separate authorization.

## Deferred Font Update

Recorded October 30, 2026; explicitly deferred by the maintainer.

- [ ] Replace the legacy Liberation Sans asset with a verified appropriately licensed release, preserve its notices, and check existing Excalidraw scenes, text layout, and exports before shipping the replacement. See [the license review](THIRD_PARTY_NOTICES.md) for the current file's provenance and outstanding review items. Do not mark the overall review approved merely because this work is deferred.

## Further Ideas

Add more deferred requests here as they come up.