## Describe the result

Open **Job Board** and select **New job**. Give the job a clear title and describe the outcome, relevant files, constraints, and checks that define success. Add relevant attachments or skills, and choose a worker profile if useful.

Choose **Docker sandbox** or **Herdr sessions** under Worker runtime. Deployments default new jobs to Herdr; Docker is available only when its sandbox daemon is enabled. Herdr is available only when its configured local server is running. The chosen runtime is saved with the job; changing a default does not move existing jobs between runtimes.

For repository work, expand **Project repository (optional)** and select a Git repository in the workspace plus its local base branch. See [Worker profiles & project review](#help/worker-profiles).

## Follow the plan

| Stage | What happens |
| --- | --- |
| Inbox / Review | Hermes examines the request |
| Needs input | The job waits for your answer to a question |
| Planned | The plan is ready; approval may be required |
| Running | OpenCode workers execute the subtasks |
| Replanning | Optional tighter-loop review adds another wave or finishes the job |
| Collating | Hermes combines the results into a summary |
| Done / Failed / Stopped | Inspect the outcome and retained worker history |

Open the job to read Hermes' questions and the proposed subtasks. Edit the plan when needed. With plan approval enabled, workers wait until you approve. Check the board's **Plan approval** indicator: a deployment with approval disabled can start workers without this pause.

**Needs input** and **Planned** are different stages. Needs input pauses the review for your answer before a final plan is ready; Planned holds a completed plan for review or approval.

Independent subtasks may run in parallel. A subtask that depends on another waits for its prerequisites and receives staged upstream artifacts. Do not rely on workers being able to read sibling directories directly.

The board groups these internal states into Queue, Planning, Running, Needs attention, Review, and Finished. A running job with a paused worker appears under Needs attention without losing its running workflow state.

For Herdr workers, open the log and reply to the existing session instead of retrying the worker. Escape and Enter interact with native agent dialogs; inspect the visible question or approval first. In token-auth mode, these controls use the CLI panel's configured terminal token. A Herdr idle/done indicator is not acceptance of the job: completion requires a matching attempt record with result and verification notes.

## Review results

Open the job detail drawer to inspect its workers, logs, attempts, errors, and summary. **Open files in Projects** expands the job's folder inside the root tree. User-facing [deliverables](#help/artifacts) are inside each worker's `artifacts/` directory alongside the rest of the job files.

Failed or timed-out workers can be retried individually. Retrying preserves attempt history, but repeats work and may incur additional provider usage. For blocked work, read the clarification thread and the worker error before retrying blindly.

Moving a job back to an earlier stage can re-review or rerun it. Stopping or archiving a job does not undo files or external actions that already occurred.

## Budgets and prerequisites

Jobs require a reachable Hermes model and a working worker model. Docker workers require enabled sandboxing; Herdr workers require the named Herdr server and share the agent user's filesystem and network access. Herdr is not a replacement security sandbox.

Optional **Token budget** and **Spend budget (USD)** apply to Docker-reported worker usage. They stop queued work once completed usage crosses the cap; already-running workers may finish. Spend checks depend on the provider reporting cost, so they are not a hard billing ceiling. Herdr does not yet supply verified usage accounting: budgets are disabled and attempt usage is shown as unavailable.