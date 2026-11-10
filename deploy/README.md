# AI Workbench — single-VM appliance

Two containers:

| Service | Image | What it runs |
|---|---|---|
| `agent` | `spatial-workbench-agent` | Upstream [Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway (OpenAI-compatible API on :8642), OpenCode CLI, and the workbench companion API (:8080), all supervised by s6 so they share `HERMES_HOME`. |
| `web` | `spatial-workbench-web` | The built UI served by Caddy on :1420. Caddy also proxies `/api` → agent, `/hermes-gw` → Hermes gateway, and `/llm` → `LLM_BASE_URL`. |

Volumes: `hermes-data` (Hermes state, skills, memory, secrets, OpenCode config) and `workspace` (`/workspace/projects`, `/workspace/wiki`).

## Deploy on a new VM

Requirements: Linux (Ubuntu/Debian for automatic Docker installation), Docker Engine with the Compose plugin, and an OpenAI-compatible model endpoint that the VM can reach. `LLM_BASE_URL` and `LLM_MODEL` configure Hermes, which is required for chat, job planning, and collation. OpenCode coding and Jobs workers default independently to `opencode/big-pickle` when no OpenCode model/endpoint is selected.

### Interactive installer (Ubuntu / Debian)

Download the CLI installer from the current main branch and run it as your normal SSH user (not via `curl | sudo bash`). By default it installs the floating `latest` images and fetches the matching Compose files from `main`:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/josephsandorvoros/ai-workbench/main/deploy/install.sh && bash install.sh
```

To choose a specific release instead, set `WORKBENCH_INSTALL_TAG` when launching the script (the Compose files are then fetched from that version tag):

```bash
WORKBENCH_INSTALL_TAG=v0.1.48 bash install.sh
```

The script asks for the Hermes model URL (include `/v1`), model ID, optional key, image tag, and SSH destination. It then configures **main OpenCode** and **default job workers independently**: choose `provider` for a hosted provider/model, `hermes` to reuse the Hermes endpoint (with an independently selectable model), or `custom` for another OpenAI-compatible URL/model/key. API keys are hidden when entered interactively. Herdr is the default Jobs runtime and the installer leaves the Docker-in-Docker worker sandbox off unless you opt in at its prompt. When enabled, Docker workers are offered alongside Herdr, which remains the default for new jobs. For custom worker endpoints, the installer asks for sandbox LAN exceptions only when Docker workers are enabled. Defaults are: image tag `latest`, `JOB_WORKER_RUNTIME=herdr`, `JOBS_SANDBOX=0`, Hermes terminal sandbox off (`AGENT_SANDBOX=0`), and both OpenCode models `opencode/big-pickle`. The installer validates and activates Compose's `sandbox` profile only when Docker workers are enabled. It installs Docker Engine and Compose from Docker's official apt repository only when absent (Ubuntu/Debian), writes `/opt/spatial-workbench/.env` as mode `0600`, validates the selected pull-only Compose files, pulls images, starts the stack, and checks the UI. To preview prompts/defaults without downloading, writing files, or running Docker, use `bash install.sh --dry-run`.

The UI binds to `127.0.0.1` on the VM. To open it, create an SSH tunnel from a terminal on the computer where you will use the browser (Windows Command Prompt/PowerShell or a local terminal), not from a shell already connected to the VM:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 18420:127.0.0.1:1420 user@<vm-ip-or-hostname>
```

Replace `user@<vm-ip-or-hostname>` with the SSH account and an IP/hostname your computer can resolve. At the password prompt, enter that VM account's SSH password or use your SSH key; this is **not** the Workbench terminal API token. If asked to trust the VM host key, verify its fingerprint before accepting. Leave the command window open; with `-N`, a successful tunnel stays connected without showing a shell prompt. Open `http://127.0.0.1:18420` in a browser on that same computer. Port `18420` is the local side of the tunnel, chosen to avoid collisions with local port `1420`; if it is already in use, choose another free high local port and use it in both the SSH command and browser URL. The VM-side port remains `1420`.

The model URL must be reachable **from the VM**. The installer intentionally does not expose the UI publicly or configure HTTPS. Existing install directories are never overwritten. Installer files are root-owned under `/opt/spatial-workbench` with directory mode `0700`; use `sudo docker compose --project-directory /opt/spatial-workbench --env-file /opt/spatial-workbench/.env -f /opt/spatial-workbench/docker-compose.yml ...` for maintenance.

### Manual Compose

```bash
mkdir spatial-workbench && cd spatial-workbench
# copy docker-compose.yml and .env.example from this directory
cp .env.example .env
$EDITOR .env        # set LLM_BASE_URL and LLM_MODEL
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
docker compose logs -f agent   # wait for "[workbench-bootstrap] ..." and the gateway to start
```

These commands use Herdr for Jobs and do not start DinD. To add isolated Docker workers, set `JOBS_SANDBOX=1` and `JOB_HERDR_ENABLED=1`, then add `docker-compose.jobs.yml` and `--profile sandbox` to each Compose command. Portainer: use `docker-compose.yml` alone for the default Herdr setup; add `docker-compose.jobs.yml` and set the `sandbox` Compose profile (for example `COMPOSE_PROFILES=sandbox`) only when enabling Docker workers. Set `AGENT_SANDBOX`, `JOBS_SANDBOX`, `JOB_WORKER_RUNTIME`, `JOB_HERDR_ENABLED`, `LLM_BASE_URL`, and `LLM_MODEL` explicitly in stack environment variables. The manual Compose bind default is also loopback-only; change `WORKBENCH_BIND` only when you have restricted network access and authentication in place.

Open `http://<vm>:1420`. In **Provider Settings** click **Use Hermes Gateway** to chat with the full Hermes agent, or use the default `/llm` endpoint for the raw model.

On first boot the agent container:
- generates `API_SERVER_KEY` (Hermes gateway) and `TERMINAL_API_TOKEN` (workbench terminal/CLI mode) unless you set them in `.env`,
- configures Hermes from saved inference overrides, falling back to `LLM_BASE_URL` / `LLM_MODEL` deployment defaults,
- configures OpenCode from `OPENCODE_MODEL` / `OPENCODE_CUSTOM_*` (defaulting to `opencode/big-pickle`; set `OPENCODE_MODEL=local/<LLM_MODEL>` to use the Hermes model endpoint) and starts `opencode serve` on `127.0.0.1:4096` inside the container,
- creates `/workspace/projects` and a starter wiki.

The terminal token is needed for CLI-mode harnesses. Read it with:

```bash
sudo docker compose --project-directory /opt/spatial-workbench --env-file /opt/spatial-workbench/.env -f /opt/spatial-workbench/docker-compose.yml exec agent cat /opt/data/workbench.env
```

## Optional voice chat

The dashboard can use separate STT and TTS services. Set only `SPEECH_STT_URL` and `SPEECH_TTS_URL` in the companion agent's Portainer environment (or private deployment environment), for example `http://192.0.2.20:8081` and `http://192.0.2.20:8082` (documentation addresses; replace with your service host). These are base URLs, not paths to `/openapi.json`. The deployed agent container must be able to reach those addresses; a repository checkout on the speech host does not configure or prove connectivity from the companion container.

Provision the `speech:stt` and `speech:tts` bearer tokens in **Agent Workbench → Speech services → Settings** or directly through the companion's existing write-only secret configuration. They are stored in `/opt/data/spatial-workbench/settings.json` inside this installation's Hermes data volume with mode `0600` and are never returned to the browser. Do not add token values to `.env`, commit them, or paste them into chat. The repository and `.env.example` intentionally contain no speech tokens. URL overrides are instance-wide; **Use deployment URLs** returns to the stack variables.

The web browser calls only the same-origin `/api/speech/*` routes. Microphone access requires the dashboard to be open through HTTPS or localhost. STT is limited to an 8 MiB recording, one concurrent request, and a 90-second upstream timeout; TTS has corresponding text/output caps and a separate single-request limit. Speak-replies is opt-in. A zero voice count is shown as a warning, not evidence that a voice was discovered. The current wrapper's TTS OpenAPI advertises JSON while this integration expects WAV, so verify this contract before relying on audio playback. Voice blends are not exposed.

## Resource monitor

The header shows CPU, RAM, disk, GPU, and temperatures. By default it reports the machine running the stack (from inside the container, so no GPU). To monitor a different machine — typically the one running your model — run [Glances](https://github.com/nicolargo/glances) there in web-server mode and set `GLANCES_URL`:

```bash
# on the machine to monitor
pip install 'glances[web]' && glances -w --disable-webui        # serves the REST API on :61208
# stack variable
GLANCES_URL=http://192.168.1.50:61208
```

Glances API v4 and v3 are both supported. Use whatever host port you published (61208 by default). Glances has no auth, so keep it on a trusted network. It reports GPU memory as a percentage, so the VRAM pill shows usage without absolute GB. With several GPUs, the first NVIDIA one is shown; override with `GLANCES_GPU_ID` (e.g. `nvidia0`).

Running Glances in Docker on an NVIDIA machine needs the `-full` image and GPU access, otherwise only integrated GPUs appear:

```yaml
services:
  glances:
    image: nicolargo/glances:latest-full
    restart: unless-stopped
    pid: host
    ports: ["61208:61208"]
    environment:
      GLANCES_OPT: "-w --disable-webui"
    volumes:
      - /etc/os-release:/etc/os-release:ro
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, utility]
```

## OpenCode model

OpenCode can use a different model than Hermes, e.g. to keep coding tasks off a single local GPU or to use a separate API plan:

| Goal | Variables |
|---|---|
| Main and worker defaults | both default independently to `opencode/big-pickle` |
| Same endpoint as Hermes | `OPENCODE_MODEL=local/<LLM_MODEL>` |
| Free hosted OpenCode model | `OPENCODE_MODEL=opencode/big-pickle` |
| Your own provider plan | `OPENCODE_MODEL=anthropic/claude-sonnet-4-5` + `ANTHROPIC_API_KEY=...` (also `OPENAI_`, `OPENROUTER_`, `GEMINI_`, `OPENCODE_API_KEY`) |
| Another OpenAI-compatible server | `OPENCODE_CUSTOM_BASE_URL=http://host:port/v1`, `OPENCODE_MODEL=<model>`, optional `OPENCODE_CUSTOM_API_KEY` |
| Different worker endpoint/model | `WORKER_BASE_URL=http://host:port/v1`, `WORKER_MODEL=<model>`, optional `WORKER_API_KEY` |
| Paid hosted worker provider | `WORKER_MODEL=openai/<model>`, `WORKER_API_KEY=...` (or the corresponding provider-specific key) |

Custom endpoint model IDs are used exactly, including IDs such as `org/coder`; the `custom/` OpenCode provider prefix is added automatically. `OPENCODE_MAIN_API_KEY` can supply a key for the main instance's selected hosted provider. Workers receive only their selected endpoint/provider key, not Hermes state or all provider credentials.

### After deployment

Open **Agent Workbench** for three independent sections: **Hermes agent endpoints**, **Main OpenCode endpoints**, and **Worker OpenCode endpoints**. The Hermes section retains gateway/API selection, Hermes CLI connection settings, and saved chat provider profiles. The main OpenCode section configures its model/endpoint/key and can select OpenCode for agent chat; its CLI controls appear there when OpenCode chat is active. The worker section configures job-worker defaults, while per-task worker profiles remain in Jobs. Each OpenCode section saves only its own settings. Select an OpenCode provider or a custom endpoint, enter the model ID and optional key, and save. A blank key field preserves the existing key; **Clear key** explicitly removes it. Keys are write-only and persisted with mode `0600` under the Hermes data volume, never returned by settings APIs or stored in browser localStorage.

The Hermes section's always-visible **Connection** selector explicitly offers **Hermes Gateway**, **OpenAI API**, **Local model API**, **Custom API endpoint**, and **Hermes CLI**. Selecting a connection resets its URL/model, CLI fields, and connection-specific flags together while preserving the browser session's terminal token. Gateway displays the managed `/hermes-gw` route, `hermes-agent` model, and server gateway-key status; it does not display a direct-model API-key field or browser-only tool controls. If the server has no gateway key, Gateway remains selected with an explicit warning instead of silently keeping the previous connection. Direct-model API keys are stored per endpoint, so returning to OpenAI restores its own key status without copying that key into Gateway or another API. Pending typed keys are saved for their original endpoint atomically during a switch, and older model-list requests cannot overwrite a newer preset selection.

Saved choices override deployment environment defaults on subsequent boots. **Reset to deployment defaults** removes the saved override and default key for that section only. Worker changes apply to future launches, not running workers. New CLI sessions read the main configuration; to apply it to the existing headless server, select **Reload running OpenCode server** and confirm. Reloading can interrupt active OpenCode sessions. If the running version cannot reload via its API, settings remain saved and the UI reports that a manual server reload is needed.

In **Worker profiles**, choose **Worker default**, **OpenCode provider**, or **Custom endpoint**. Profiles may use different endpoints and model IDs for coding, research, and other roles. A profile can reference a key variable such as `WORKER_CODER_API_KEY` for either a custom endpoint or a supported hosted provider; enter/rotate/clear its value in the profile's write-only key field. Built-in worker key mappings support `opencode`, `openai`, `anthropic`, `openrouter`, and `google`; for other authenticated providers, use their OpenAI-compatible custom endpoint. The value is stored server-side, while profiles and job snapshots contain only the variable name. Alternatively, explicitly pass that variable into the agent service's Compose environment. An explicitly named key that is missing fails the worker launch rather than falling back to a different key. A hosted profile on a different provider does not inherit the default worker's key. Profile edits do not change existing job snapshots; key rotation is resolved at launch time.

For private inference, configure Hermes, main OpenCode, worker defaults, and any profile overrides to use private model servers. The managed main configuration sets both `model` and `small_model` to the selected default, disables conversation sharing and automatic updates; custom worker configurations select their configured model and disable sharing. Neither main OpenCode nor workers impose a provider allowlist, so OpenCode's normal provider choices remain available. Existing managed main allowlists are removed when its configuration is regenerated. Workers still receive only their selected endpoint/provider credentials. Set `UPDATE_CHECK=0` to disable Workbench version checks. This is private inference configuration, not an air-gap: installation still downloads images/packages, and enabled agent tools may access the network.

Docker workers cannot reach LAN model servers unless those server IPs/CIDRs are explicitly allowed in `SANDBOX_ALLOW_LAN`. Changing endpoint settings after deployment does **not** change sandbox firewall rules. Add a narrowly scoped exception through your normal deployment process when using a new LAN server. Docker worker `localhost` refers to its worker container. Herdr workers share the agent container's network, so their `localhost` refers to that container; sandbox LAN rules do not apply to them.

Boot and post-deployment saves share the same configuration writer. It manages the `local`/`custom` providers, selected model/auxiliary model, enabled providers, sharing/update policy, and a file-referenced main key in `/opt/data/.config/opencode/opencode.json`; other user configuration is preserved. Profile endpoint columns are added without rewriting existing profile rows; older profiles inherit the worker endpoint default. Retain the data volume when updating or rolling back; older code ignores the added columns.

## Sandbox (optional)

Hermes' own terminal and the Jobs worker daemon are separate controls. You can run Hermes directly, delegate to isolated workers, or enable both:

| Mode | Settings | Hermes shell commands | Jobs / sub-agents | Use it when |
|---|---|---|---|---|
| Direct Hermes + Herdr Jobs (default) | `AGENT_SANDBOX=0`, `JOBS_SANDBOX=0`, `JOB_WORKER_RUNTIME=herdr` | Run in the Hermes agent container. | Persistent OpenCode workers run in the agent container. | You want the default delegated workflow without a Docker-in-Docker daemon. |
| Herdr + optional isolated Jobs | `AGENT_SANDBOX=0`, `JOBS_SANDBOX=1`, `JOB_WORKER_RUNTIME=herdr`, `JOB_HERDR_ENABLED=1` | Run in the Hermes agent container. | New jobs default to Herdr and may select isolated Docker workers. | You want Herdr by default with Docker isolation available when needed. |
| Isolate both | `AGENT_SANDBOX=1`, `JOBS_SANDBOX=1`, `JOB_WORKER_RUNTIME=docker` | Hermes terminal commands also run in temporary containers on the sandbox daemon. | Jobs default to isolated Docker workers. | You want Hermes shell commands and delegated workers to use Docker isolation. |

The sandbox does not make Hermes powerless: it can still plan, use its non-shell tools, and manage Jobs. `AGENT_SANDBOX` controls only Hermes' own terminal backend; `JOBS_SANDBOX` controls whether Jobs may start Docker sandbox workers. Herdr Jobs remain available with `JOBS_SANDBOX=0`. The installer includes the Jobs overlay and activates the `sandbox` Compose profile only when Docker workers are enabled. Manual Compose deployments must do both; Portainer deployments add the overlay and set `COMPOSE_PROFILES=sandbox`. The CLI tab's shell remains in the agent container in every mode.

### Turn the sandbox on or off

For a Compose deployment, edit the deployment `.env`. `JOBS_SANDBOX=1` must be paired with the `sandbox` Compose profile; setting the environment variable alone does not start a profiled service. The default Herdr-only setup is:

```env
AGENT_SANDBOX=0
JOBS_SANDBOX=0
JOB_WORKER_RUNTIME=herdr
JOB_HERDR_ENABLED=0
```

To offer optional isolated Docker workers alongside the Herdr default, set:

```env
AGENT_SANDBOX=0
JOBS_SANDBOX=1
JOB_WORKER_RUNTIME=herdr
JOB_HERDR_ENABLED=1
```

Apply the change by selecting the matching Compose files and recreating the stack:

```bash
# JOBS_SANDBOX=1; keep Herdr as the default and offer both runtimes
docker compose --profile sandbox -f docker-compose.yml -f docker-compose.jobs.yml up -d --remove-orphans
# JOBS_SANDBOX=0; Herdr-only
docker compose -f docker-compose.yml up -d --remove-orphans
```

In Portainer, set `AGENT_SANDBOX`, `JOBS_SANDBOX`, `JOB_WORKER_RUNTIME`, and `JOB_HERDR_ENABLED`; add the Jobs overlay and `COMPOSE_PROFILES=sandbox` only when `JOBS_SANDBOX=1`, then use your approved stack-update procedure. `JOBS_SANDBOX=0` disables Docker worker execution, not Herdr workers. `AGENT_SANDBOX` controls only Hermes' own terminal backend. Named volumes are retained when the sandbox service is omitted. Finish existing Docker jobs before disabling their runtime; existing jobs are not silently migrated to Herdr.

After changing modes, verify agent logs show `Hermes terminal backend -> local` or `-> docker` according to `AGENT_SANDBOX`. For Docker Jobs, check `JOBS_SANDBOX=1` and the sandbox service. For Herdr Jobs, confirm the named server is running and **Herdr sessions** is available in the new-job runtime selector. Test a small job before important work.

When Hermes terminal isolation is enabled, its shell commands execute in worker containers instead of the agent container. Docker Jobs drop all capabilities and use process/CPU/memory limits on a **separate** Docker-in-Docker daemon, not the host Docker daemon. Herdr Jobs do not use this Docker boundary; see the limitations below.

To isolate both Hermes commands and Jobs workers, set:

```env
AGENT_SANDBOX=1
JOBS_SANDBOX=1
```

| | |
|---|---|
| Daemon | `sandbox` service (`docker:dind`, privileged), TLS on port 2376; only the agent holds the client certificates |
| Files | Workers see `/workspace` (your projects); the sandbox mounts the same volumes at the same paths as the agent |
| Network | Internet yes, LAN no: 10/8, 172.16/12, 192.168/16, link-local and CGNAT are blocked inside the sandbox's own network namespace (nothing is changed on your host). Allow specific hosts with `SANDBOX_ALLOW_LAN=192.168.1.50/32` |
| Workers | `SANDBOX_IMAGE` (default Python + Node), `SANDBOX_CPU`, `SANDBOX_MEMORY_MB` |
| Cleanup | Unused images/containers older than `SANDBOX_PRUNE_HOURS` (24) are pruned hourly; Hermes reaps idle workers; workers left over from before an agent restart are removed at startup (so config changes always apply) |

The CLI tab shows the sandbox status and has a **Sandbox** button (`docker ps` against the sandbox). The workbench's own CLI tab and shell tool keep running in the agent container. Turning `AGENT_SANDBOX` off switches Hermes to its local backend on the next boot. `JOBS_SANDBOX` independently starts or omits the sandbox service for delegated workers.

Workers don't run a model — Hermes decides what to run. To let a worker do its own coding with a free hosted model, have Hermes run e.g. `npx opencode-ai run -m opencode/big-pickle "..."` inside it (internet only, no LAN needed).

## Jobs (Hermes plans, OpenCode workers execute)

Docker execution requires `JOBS_SANDBOX=1`. Herdr runs persistent OpenCode agents in the primary agent container and is the default runtime for new jobs. Each new job snapshots its selected execution runtime; existing jobs remain on their saved runtime. A job moves through **Inbox → Review → (Needs input) → Planned → Running → (Replanning) → Collating → Done** (or Failed / Stopped). *Replanning* only appears when the tighter loop is on (below).

### Herdr Local Pilot

Herdr is included in the base agent image and Compose service; it does not require a Herdr overlay, additional published port, or a separate container. The optional `herdr-server` supervisor starts when `JOB_WORKER_RUNTIME=herdr` or `JOB_HERDR_ENABLED=1`. Availability in the Jobs board is a readiness check of that running named server, not merely the presence of a binary or flag.

The CLI tab's **Herdr TUI** button opens an authenticated PTY client for the same configured Jobs session. It requires an already-running server and does not launch a replacement. **Detach** closes only that terminal client; existing worker panes continue running. Keyboard input and terminal resizing use the existing terminal API.

In token-auth mode, configure the existing CLI terminal token before replying to workers; the Jobs controls reuse that token. Proxy-auth mode continues to rely on the secured upstream proxy. The input endpoint never bypasses the terminal authentication policy. Do not paste the token into chat, logs, or a job description.

The Jobs board groups internal states into Queue, Planning, Running, Needs attention, Review, and Finished. Select **Herdr sessions** when creating a new job. Worker model/profile choices remain independent of the execution runtime.

For the existing local app, install the pinned Herdr 0.9.5 binary and start its named headless server with `herdr --session workbench-jobs server`. Start the server with a clean environment containing only HOME, PATH, and locale settings; PATH must include the actual OpenCode executable. Do not copy provider keys into the server environment. Restart only the local companion API to load changed Python code; the existing Vite frontend reads source changes. No second dashboard instance is required.

The default image deployment sets `JOB_WORKER_RUNTIME=herdr`. To offer Docker workers as an additional runtime, enable `JOBS_SANDBOX=1`, activate the sandbox profile, and set `JOB_HERDR_ENABLED=1`. `JOB_HERDR_SESSION` defaults to `workbench-jobs`. The agent image installs checksummed Herdr 0.9.5 and supervises its headless server as the agent user. Do not switch existing/running jobs between runtimes or delete their volumes.

Herdr workers have private HOME/configuration directories and provider key files outside the project tree. They are still trusted processes sharing the agent user's filesystem and network; these directories are not a hard security boundary. Docker CPU/memory/PID limits and sandbox LAN restrictions do not apply to Herdr workers. Concurrency limits, job timeout, plan approval, and explicit Git merges remain enforced.

When a worker pauses, open its log and use **Reply to worker**, **Escape**, or **Enter** to interact with its existing session. Prompts are refused while the agent is busy, blocked in a dialog, or its state is unknown. Inspect before responding to a permission dialog; a key press can approve an action. The Workbench never retries an uncertain prompt automatically. Native terminal embedding is follow-up work; the pilot exposes the current terminal screen through the existing log view.

An idle/done Herdr status is not job completion. A worker must write a matching per-attempt completion record with a summary and verification notes. Worker sessions remain available after completion and are closed when the job is archived/deleted. Token and spend budgets are not supported for Herdr yet: usage is shown as unavailable rather than fabricated zero values. Preserve explicit verification/review before accepting output.

Local validation covered real Hermes planning/collation, real OpenCode workers, in-session replies without another attempt, dependency artifact handoff, scoped stop with retained logs, API-restart recovery, and the embedded CLI TUI at desktop widths. Container-image execution and final binary/dependency licensing review were not validated by those local checks. Complete the image and deployment gates separately before relying on the pilot in production.

1. **Review.** Hermes reviews the request and asks questions only when it is genuinely unclear. You can attach up to five files (10 MB each, 20 MB total); copies are stored in `/workspace/jobs/<job-id>/inputs/`. Hermes sees text excerpts, and worker instructions can refer to `../inputs/<filename>`.
2. **Plan.** Hermes splits the work into up to `MAX_WORKERS_PER_JOB` subtasks. Subtasks are independent by default and run in parallel; when one genuinely needs another's output (e.g. "write the module" then "test the module"), it declares that with `depends_on` — a list of the 0-based indices it needs. The engine keeps the graph a DAG (out-of-range, self, and cyclic references are dropped) and runs subtasks in topological order, so a dependent subtask starts only after its dependencies finish. As a safety net, if a subtask's instructions reference another subtask's output in prose but leave `depends_on` empty, Hermes is asked once to re-emit the plan with the field filled in. With `JOB_PLAN_APPROVAL=1` (default), the job waits in *Planned* until you approve (or edit) the plan.
3. **Run.** Docker subtasks run `opencode run` in their own `spatial-workbench-worker` container on the sandbox daemon. Herdr subtasks run in persistent OpenCode sessions in the agent container. Select up to five Hermes user skills per job to copy their skill files (excluding hidden files and symlinks) into `/workspace/jobs/<job-id>/skills`; OpenCode discovers that snapshot without receiving Hermes state or credentials. Files land in `/workspace/jobs/<job-id>/subtask-N/`, and logs in `.../.logs/`.
  - **Worker profiles.** Create profiles separately from chat/provider profiles. A profile stores role instructions, OpenCode model/runtime, up to five Hermes skills, and a guarded/trusted permission preset. Choose a default profile when creating a job or override it per planned subtask. The job and each worker attempt keep a configuration snapshot; profile edits do not rewrite existing jobs. The deployment-wide `JOB_AUTO_APPROVE=0` remains the upper permission bound, even for a trusted profile.
  - **Project worktrees.** Optionally select a Git repository inside `/workspace` and a local base branch. Each worker attempt gets an isolated worktree and branch; workers commit there and never push or merge automatically. After completion, inspect changed files and explicitly merge a clean worker branch into the configured base branch, or explicitly push and create a pull/merge request from the Jobs review controls. Remote publish requires a PAT with write access to the origin and does not create forks. The base repository must be clean and checked out at the configured base branch for local merge. Unmerged branches are preserved; deleting a job refuses uncommitted work and only removes job-owned worktrees safely.
   - **Upstream handoff.** A subtask with dependencies gets the upstream subtasks' artifact paths and contents in its prompt, and a copy of each upstream `artifacts/` directory is staged into its own workdir under `upstream/subtask-N/artifacts/`. OpenCode's `read`/`write` tools are scoped to the worker's own workdir, so reading a sibling subtask directory is auto-rejected (`external_directory`); the staged copy is what the worker reads.
   - **Clarifications.** Workers are one-shot and cannot wait for a reply. If a worker is truly blocked it writes `comms/question.json` in its own workdir and stops; the engine hands the question to Hermes, which writes a decisive `comms/answer.json`, and the worker is re-queued with the answer. This repeats up to `JOB_COMMS_MAX_ROUNDS` (default 3) rounds, after which the subtask fails. The thread is visible via `GET /api/jobs/<id>/comms`.
  - **Attempts, logs, and budgets.** Failed or timed-out workers can be retried individually; each attempt retains its status, log, profile snapshot, project branch, and OpenCode-reported token/cost totals. Optional per-job token and USD spend caps stop queued workers after completed usage crosses a cap. Already-running workers are allowed to finish. Spend enforcement depends on cost reported by the selected provider.
4. **Collate.** Workers put user-facing deliverables in their own `artifacts/` subdirectory, leaving intermediate files outside it. When every subtask has finished, Hermes collates the results into a final summary. **Open files in Projects** in the Jobs drawer expands the job folder in the workspace tree, including deliverables, logs, and intermediate files. There is no separate Artifacts tab.

Each job lives in `/workspace/jobs/<job-id>/` (a timestamped, collision-free id). When a job finishes, the engine writes `<title>.txt` into that folder (e.g. `Pieter Teeling 2.txt`) so you can tell what a folder is without digging through the id:

```
title: Pieter Teeling 2
id: 20260930-005145-26bce9
```

### Tighter loop (optional)

With `JOB_TIGHTER_LOOP=1`, after each wave of workers finishes the job moves to *Replanning* instead of straight to collating: Hermes reviews the results and either finishes the job or appends a new wave of subtasks that build on what is done (indices continue across waves, so a new subtask may `depends_on` an earlier one). Waves are capped at `JOB_MAX_WAVES` (default 3); when the cap is reached or Hermes says the job is complete, it collates.

### Moving jobs

A job can be moved between stages from the board (or `POST /api/jobs/<id>/move`): back to *Inbox* to re-review (drops the plan, keeps subtask history), to *Planned* to re-approve the existing plan, or to *Running* to re-run the planned subtasks (fresh queue, old results kept for reference).

| Variable | Default | |
|---|---|---|
| `WORKER_MODEL` | `opencode/big-pickle` | Any OpenCode model id. The free `opencode/*` models need no key, but their providers may log prompts. |
| `WORKER_IMAGE` | `<prefix>/spatial-workbench-worker:<tag>` | Pulled by the sandbox on first use |
| `JOB_PLAN_APPROVAL` | `1` | `0` = start workers as soon as the plan exists |
| `JOB_AUTO_APPROVE` | `0` | `1` = workers may run any command. `0` blocks `git push`, `sudo`, `curl … \| sh`, `dd`, `mkfs`, `rm -rf /` |
| `MAX_PARALLEL_JOBS` / `MAX_WORKERS_PER_JOB` / `MAX_WORKERS_TOTAL` | `2` / `3` / `4` | Concurrency caps |
| `WORKER_CPU` / `WORKER_MEMORY_MB` / `JOB_TIMEOUT_MINUTES` | `1` / `1536` / `30` | Per-worker limits and per-job wall-clock limit |
| `JOB_TIGHTER_LOOP` / `JOB_MAX_WAVES` | `0` / `3` | Tighter loop: after each wave, Hermes reviews results and may append a new wave (see above) |
| `JOB_COMMS_MAX_ROUNDS` | `3` | Max clarification rounds before a blocked worker's subtask fails |

Worker profiles use `GET/POST /api/worker-profiles` and `POST /api/worker-profiles/<id>/delete`. Jobs can include `profile_id`, `project_path`, `base_branch`, `token_budget`, and `cost_budget` in `POST /api/jobs`. API: `GET /api/jobs/<id>/subtasks/<n>/stream` streams log updates as SSE; `POST /api/jobs/<id>/subtasks/<n>/retry` retries an eligible worker; `GET /api/jobs/<id>/subtasks/<n>/project` inspects the latest project attempt; `POST /api/jobs/<id>/subtasks/<n>/merge` explicitly merges its clean branch locally. Existing actions remain `POST /api/jobs/<id>/{answer,approve,move,stop,retry,archive}` and `GET /api/jobs/<id>/comms`.

## Shared Spatial Board

The Spatial Board scene is stored in the agent data volume and mirrored to each browser. The UI keeps a local browser copy as a fallback, while the companion API exposes `GET/POST /api/board` for reading and replacing a scene and `POST /api/board/command` for semantic `add_node`, `add_arrow`, and `clear` operations. The board refreshes from the shared scene while open, so API-side edits appear without a page reload.

Agents that can reach the companion API can control the board by reading `/api/board` and posting a command. Browser-local visual tools use the same endpoint and retain their same-browser fallback when the API is unavailable. The gateway agent itself must be configured with HTTP tools that can call these routes; the endpoint alone does not register tools in Hermes.

## Terminal and updates

The **Terminal** workspace is a shell inside the agent container, with shortcuts for Hermes TUI and OpenCode. Terminal-token mode requires the installation's token; proxy-auth mode trusts the upstream authentication boundary. New login shells prefer `/opt/workbench/bin/hermes`, the recovery-aware launcher, over stale persistent user-local shims. Versions shows installed/latest versions and update-method guidance; a header indicator appears when something is out of date.

| Component | How it updates |
|---|---|
| OpenCode | Use its **Update** button. The appliance installs into the persistent `hermes-data` volume and attempts to restart the headless server. A later image with the same or newer OpenCode drops the override. Workers remain independent. |
| Hermes Agent | Use **Check now**, then its **Update** button for a managed runtime update. The upstream `hermes update` command is not this updater and may refuse Docker installations. |
| Workbench image and system dependencies | Re-pull the appropriate Workbench image and redeploy through the deployment process. Re-pulling the same image does not refresh its upstream Hermes base. |
| Sandbox | Re-pull the sandbox image and redeploy through the deployment process. |

Hermes and OpenCode Update buttons stay visible, but are disabled when current or unsupported. There is no Roll Back button; automatic Hermes activation recovery remains enabled. Finish active work and back up data before confirming component updates or redeploys.

Set `UPDATE_CHECK=0` to disable the version checks.

### Hermes inference and runtime

In **Agent Workbench -> Hermes inference & runtime -> Configure**, select Hermes's provider, exact model ID, optional API key, and endpoint URL for `custom`. This is a separate column beside **Hermes agent endpoints**, **Main OpenCode endpoints**, **Worker OpenCode endpoints**, and **Speech services** at wide desktop sizes. These are the inference settings used by Hermes itself, not the separate Workbench **Connection** selector. Built-in providers can retain their existing Hermes authentication; entering a key saves an explicit provider credential. Blank preserves the key for the same connection; **Clear key for this connection** clears the Workbench-managed key, not credentials independently supplied through environment or OAuth.

**Save** writes private, instance-wide settings without restarting services. **Apply Saved** explicitly restarts the managed Hermes gateway and private `hermes serve` processes. Active chats, messaging integrations, and jobs using Hermes may be interrupted; finish them first. Saved choices override `LLM_*` defaults on subsequent boots. **Reset** restores the deployment defaults and the pre-override Hermes model/provider configuration; apply when ready.

The updated agent image enables runtime management. Existing installations need one normal image upgrade before these controls work; local non-container installations report runtime management as unavailable. No host Docker socket or Portainer credentials are needed.

In **Terminal -> Versions**, **Check now** refreshes the component versions and retrieves the latest Hermes release tag. **Update** in the **Hermes Agent** row uses that checked tag; progress and failures appear in the same row's status column. There is no separate runtime panel or version input. The updater downloads only from the fixed NousResearch repository, checks out that exact tag's commit, and prepares an independent virtual environment using its frozen dependency lock. Dependency preparation uses a separate home directory. The selected image runtime keeps running during preparation. Releases live under `/opt/data/spatial-workbench/hermes-runtime/releases`. Files persist when the data volume is retained, but a virtualenv can depend on Python files supplied by the image; image upgrades can invalidate that runtime. New CLI sessions, tools, bundled skills, gateway, and private chat endpoint resolve the same selected release through the managed launcher.

Activation checks the gateway's HTTP health route and the private chat WebSocket protocol without inference. Failure triggers recovery to the prior runtime and pre-activation `config.yaml` / `.env`. An activation interrupted by container shutdown is recovered at next startup. Runtime availability checks execute both Python and Hermes; unavailable selections fall back to an available previous runtime or the image runtime. Recovery history remains in the runtime API without a standing Versions warning. Recovery does not reverse arbitrary database migrations, restore conversations, or downgrade OS libraries. Back up the Hermes and workspace volumes before updating; incompatible Python/system dependencies can still require a new appliance image. Prepared releases are retained and consume data-volume space.

### Managed project previews

In **Projects -> Run app**, choose a workspace-relative folder, command, and local port. The default serves static files with Python on port `8000`. Commands receive `PORT` and `PREVIEW_BASE`; bind servers to `127.0.0.1`. The companion tracks readiness/output and proxies the app through `/api/app-preview/view/<session-id>/` on the existing Workbench port. Use the returned `/?tab=project&preview=<session-id>` link, not a loopback URL copied from the server log. No host port publication or upstream reverse-proxy change is required.

Direct API chat can invoke local preview tools when its browser tool loop is enabled. Hermes Gateway uses the bundled Workbench MCP `start_app_preview` / `stop_app_preview` tools; appliance bootstrap configures their server-side credentials. In terminal-token mode, browser users save their separate session token with **Set terminal token** in the Projects header; this does not start an app.

These are trusted-code development processes on the agent container, not isolated Jobs workers. The browser iframe uses an opaque sandbox origin, not network isolation. HTML root-relative URLs are rewritten for common cases; framework-generated URLs, external JavaScript/CSS, storage, and cookie workflows may need app changes. WebSockets/HMR are not supported. **Stop app** ends the process group. API/container restarts discard sessions; idle previews are stopped after two hours without activity. A stale preview link clears back to the editor. Previews are not production hosting.

## Security

The workbench has no application login by default. Anyone who reaches port 1420 can drive the agent and its tools inside the `agent` container. The installer and sample Compose file bind to loopback (`127.0.0.1`) by default; use SSH forwarding unless you have deliberately secured network access. To make it reachable from another host, select an authentication and network boundary first:

| Setup | Set |
|---|---|
| SSH-only access (recommended default) | Keep `WORKBENCH_BIND=127.0.0.1`; use the printed SSH tunnel. |
| Reverse proxy on another host | Set `WORKBENCH_BIND=0.0.0.0`, firewall the port to the proxy, and set `WORKBENCH_ALLOWED_CLIENTS=<proxy IP>` (plus admin IPs if needed). Add authentication at the proxy or use Caddy basic auth. |
| Direct LAN access with a password | Set `WORKBENCH_BIND=0.0.0.0`, `WORKBENCH_AUTH_USER`, and `WORKBENCH_AUTH_PASSWORD_HASH`; restrict the port to trusted clients with a host firewall or `WORKBENCH_ALLOWED_CLIENTS`. |
| Additional lock on terminal/shell API | `WORKBENCH_AUTH=token` (requires `TERMINAL_API_TOKEN`). This protects terminal endpoints only; it does not replace UI authentication or network restrictions. |

These controls combine. All are plain stack variables — the web container builds its config at startup. `WORKBENCH_ALLOWED_CLIENTS` checks the direct peer (not `X-Forwarded-For`), so list the proxy's IP, not the end user's address. Do not rely on `WORKBENCH_AUTH=proxy` alone: that setting trusts an upstream proxy to authenticate users but does not add authentication in Caddy.

What stays out of the browser:
- **API keys** (Hermes gateway key, `LLM_API_KEY`, keys you enter in Provider Settings) are stored server-side (`/opt/data/spatial-workbench/settings.json`, mode 600) and added to requests by the server-side proxies. The browser only sees "key saved".
- **Settings** (provider, saved profiles, browser tools, chat sessions) live on the server, so they follow you to any browser.
- **Terminal token** (token mode only) is kept in the browser session, not in local storage.

Only port 1420 is published, bound to loopback by default. The Hermes gateway and companion API are reachable only on the internal Compose network. When enabled, the Jobs sandbox uses a privileged Docker-in-Docker container; workers are isolated from the host Docker daemon, but the sandbox itself is a powerful component. Keep its management ports unpublished and review any `SANDBOX_ALLOW_LAN` exceptions carefully.
