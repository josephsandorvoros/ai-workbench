## Describe the result

Open **Job Board** and select **New job**. Give the job a clear title and describe the outcome, relevant files, constraints, and checks that define success. Add relevant attachments or skills, and choose a worker profile if useful.

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

## Review results

Open the job detail drawer to inspect its workers, logs, attempts, errors, and summary. **Open files in Projects** expands the job's folder inside the root tree. User-facing [deliverables](#help/artifacts) are inside each worker's `artifacts/` directory alongside the rest of the job files.

Failed or timed-out workers can be retried individually. Retrying preserves attempt history, but repeats work and may incur additional provider usage. For blocked work, read the clarification thread and the worker error before retrying blindly.

Moving a job back to an earlier stage can re-review or rerun it. Stopping or archiving a job does not undo files or external actions that already occurred.

## Budgets and prerequisites

Jobs require enabled worker sandboxing, a reachable Hermes model, and a working worker model. Optional **Token budget** and **Spend budget (USD)** apply to reported worker usage. They stop queued work once completed usage crosses the cap; already-running workers may finish. Spend checks depend on the provider reporting cost, so they are not a hard billing ceiling.