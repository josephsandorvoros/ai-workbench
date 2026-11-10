## Reuse a worker role

In **Job Board**, open **Worker profiles** and create a named profile. Set role instructions, model or endpoint, skills, and a permission preset. Choose it for a new job or override a planned subtask's profile.

Worker profiles are separate from saved chat/provider profiles. Choose **Worker default**, **OpenCode provider**, or **Custom endpoint**. An explicit profile key variable must exist; a missing named key fails the launch rather than silently using another key. A hosted profile on a different provider does not inherit the default provider's key.

The profile selects the worker's model, instructions, and permissions, not its execution isolation. New jobs choose **Docker sandbox** or **Herdr sessions** separately. Both runtimes preserve profile snapshots; Herdr uses persistent OpenCode sessions with private configuration, but shares the agent user's filesystem and network. See [Security & sandboxing](#help/security).

Profile edits do not rewrite existing job snapshots. Key rotation is resolved when a worker launches. Guarded/trusted presets remain limited by the deployment's permission policy: a trusted profile cannot override a stricter deployment-wide bound.

## Repository worktrees

For a project job, select a Git repository inside the workspace and its local base branch. Each worker attempt receives a separate worktree and branch. Workers commit their changes there; they do not automatically push or merge into the base branch.

1. Wait for the job and worker to complete.
2. Inspect the worker's project changes, committed patch, and any uncommitted changes.
3. Review and test the result as appropriate for the project.
4. Choose **Merge to base** only when you want the local merge and the base repository is clean and checked out on the configured branch.
5. Choose **Push & create PR/MR** when you want the worker branch pushed to the configured HTTPS remote and a provider review request opened. Confirm the action; it does not merge the request.

Merging and publishing are real remote/local repository mutations, not previews. Publishing requires a saved host token with write access to the repository and a completed worker with no uncommitted changes. It pushes directly to `origin`; automatic fork creation is not supported. A pushed branch is not force-updated; if request creation fails, retrying checks for an existing request before creating another.

## Attempts and cleanup

Retries create a new attempt while retaining previous logs, configuration, branch information, and reported usage. Review the latest attempt when deciding what to merge. Unmerged branches are retained rather than silently discarded.

Replying to a paused Herdr worker continues its current session and attempt; it is not a retry. Read the worker log before responding to a question or approval dialog. Herdr usage is currently unavailable, so token/spend budgets are disabled for that runtime. Completed Herdr sessions remain inspectable until their job is archived or deleted; stopping an active worker preserves its last screen and attempt history.

Job deletion can refuse uncommitted work and only safely removes job-owned worktrees. Preserve important branches and files before cleanup. See [Updates & backups](#help/maintenance).