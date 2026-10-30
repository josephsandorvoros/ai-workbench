# API Contracts

Created: 2026-09-11

This document is the active contract reference for the AI Workbench companion API. The Python server remains the browser/remote API while native Tauri replacements are optional.

## Contract Rules

- Preserve response shapes until a versioned replacement is introduced.
- Preserve clear JSON error responses with `ok: false` where the current route provides them.
- Keep private LAN calls, local paths, webhook URLs, and tokens server-side.
- Preserve browser/container compatibility for routes that remain useful remotely.
- Preserve terminal and restart auth behavior when `TERMINAL_API_TOKEN` is configured.
- Preserve wiki and artifact path containment rules.
- Add or update `tests/test_api_contracts.py` whenever a route shape or compatibility rule changes.

## Route Summary

| Route | Method | Compatibility role | Preserve for |
| --- | --- | --- | --- |
| `/api/config` | GET | Browser-visible config without secrets | Web dashboard, Tauri compat client, container health/context |
| `/api/stats` | GET | AI node stats snapshot or degraded state | Node Monitor, remote browser mode, companion service |
| `/api/stats/source` | GET/POST | Read or persist the selected Workbench-host/configured-monitor stats source | Header monitor selector |
| `/api/free-models` | GET | Cached public Zen/API model catalogues, optional `refresh=1` | Header free model tracker |
| `/api/speech/voices` | GET | Server-authenticated speech voice list; bearer token stays in companion settings | Agent chat voice selector |
| `/api/speech/transcriptions` | POST | Bounded raw microphone audio; server forwards multipart `file` to configured STT wrapper | Push-to-talk transcript |
| `/api/speech/synthesize` | POST | Bounded JSON text/voice request; returns a size-limited, validated WAV from configured TTS wrapper | Spoken assistant replies |
| `/api/chat-providers` | GET | Available chat provider discovery | Provider picker, future agent chat migration |
| `/api/hermes/chat/{open,prompt,command,interrupt,steer,respond,close}` | POST | Hermes Gateway chat. The companion keeps one live `hermes serve` session (and agent) per Workbench chat over the private loopback WebSocket, like the messaging gateway does per Discord channel; idle sessions close after `HERMES_LIVE_IDLE_SECONDS` (default 1800). Existing chats resume `workbench-<chatId>`; new chats get a Hermes-created session remembered in `HERMES_HOME/spatial-workbench/hermes_sessions.json` (0600). `prompt` takes `text` + optional image data URLs and returns the event `cursor`; `command` runs any slash command on the same live session and returns `type` `output`, `send` (prompt to run as the next turn) or `prefill`; `respond` answers a pending approval (`once`/`session`/`always`/`deny`). Session token never reaches the browser | Gateway-backed Agent chat |
| `/api/hermes/chat/events?chat_id=&after=&wait=` | GET | Long-poll (max 25 s) of the chat's live events after `after`: `message.*`, `reasoning.delta`, `tool.*`, `status.update`, `session.usage`, `approval.request`, `request.cancel`, `error`, `connection.closed`; returns `cursor`, `running`, `closed`, `truncated` | Gateway-backed Agent chat streaming/reconnect |
| `/api/chat/session` | POST | Lightweight provider session creation | Event recording and transition compatibility |
| `/api/events/recent` | GET | Recent activity feed | UI activity panel and future audit trail |
| `/api/workflows` | GET | Workflow definitions and configured state | Workflow panel and agent workflow tools |
| `/api/workflows/{workflow_id}` | POST | Workflow dispatch | Post generator, webhook actions, future agent tool calls |
| `/api/workflows/status` | GET | Workflow job polling | Job status UI and artifact handoff |
| `/api/workflows/artifacts` | GET | Recent generated HTML artifact list | Artifact panel and distribution workflows |
| `/api/workflows/download` | GET | Download artifact produced by a job | User artifact retrieval |
| `/api/workflows/download-artifact` | GET | Download artifact by file name | Recent artifact retrieval |
| `/api/terminal/start` | POST | Start CLI or Hermes TUI session | Legacy terminal fallback, parity target for Tauri |
| `/api/terminal/active` | GET | Latest active terminal discovery | Browser reattach behavior |
| `/api/terminal/output` | GET | Offset-based terminal output polling | Legacy terminal streaming fallback |
| `/api/terminal/input` | POST | Terminal input forwarding | Legacy terminal interaction fallback |
| `/api/terminal/resize` | POST | Terminal PTY resize | xterm.js rendering parity |
| `/api/terminal/close` | POST | Terminal process cleanup | Session lifecycle parity |
| `/api/wiki/list` | GET | Wiki tree listing | Wiki workbench and future knowledge context |
| `/api/workbench/state` | GET/POST | Shared HTML artifact and chat-session state on the Hermes host | AI Workbench Artifacts and Agent sessions |
| `/api/wiki/read` | GET | Wiki document read | Wiki editor and Hermes context tools |
| `/api/wiki/write` | POST | Wiki document write with backup/event | Wiki editor and controlled agent writes |
| `/api/wiki/upload` | POST | Binary-safe file upload into the wiki (any type) | Wiki workbench upload button |
| `/api/wiki/search` | GET | Simple bounded text search | Wiki search and Hermes retrieval tools |
| `/api/wiki/download` | GET | Scoped file/folder download (folders zipped) | Browser download buttons in the wiki workbench |
| `/api/workspace/list` | GET | Scoped project tree listing | Browser project explorer and future context selection |
| `/api/workspace/read` | GET | Scoped text/code file read | Monaco read view and future file context tools |
| `/api/workspace/status` | GET | Scoped file metadata check | Browser polling watcher and conflict detection |
| `/api/workspace/download` | GET | Scoped file/folder download (folders zipped) | Browser download buttons in the project explorer |
| `/api/workspace/write` | POST | Scoped text/code file write with conflict checks | Controlled Monaco saves and future guarded agent edits |
| `/api/jobs` | GET/POST | Job board list and create | Jobs board UI |
| `/api/jobs/{id}` | GET | Single job with subtasks and events | Jobs board UI |
| `/api/jobs/{id}/{action}` | POST | Job actions: answer, approve, move, stop, retry, archive | Jobs board UI |
| `/api/jobs/{id}/subtasks/{n}/log` | GET | Raw worker log (JSON lines) | Jobs drawer log view |
| `/api/jobs/{id}/subtasks/{n}/stream` | GET | Worker log/status updates as Server-Sent Events | Jobs drawer live log view |
| `/api/jobs/{id}/subtasks/{n}/retry` | POST | Retry a failed/timed-out worker, requeue dependency-cascade descendants, and retain attempt history | Jobs drawer retry action |
| `/api/jobs/{id}/subtasks/{n}/project` | GET | Inspect changed files, bounded committed/working patches, and worktree status for the latest project attempt | Jobs drawer project review |
| `/api/jobs/{id}/subtasks/{n}/merge` | POST | Explicitly merge a clean worker branch into its configured local base branch | Jobs drawer project review |
| `/api/jobs/{id}/comms` | GET | Worker clarification threads | Jobs drawer comms view |
| `/api/worker-profiles` | GET/POST | List or save reusable worker profiles | Jobs board profile manager |
| `/api/opencode-settings` | GET/POST | Read effective main/worker defaults; persist endpoint/model choices and write-only keys | Agent Workbench settings and Jobs profile keys |
| `/api/hermes-settings` | GET/POST | Read/persist Hermes's own inference provider/model/endpoint with write-only scoped keys | Hermes inference settings in Agent Workbench |
| `/api/model-catalog?engine=hermes\|opencode&refresh=1` | GET | Read normalized runtime provider/model inventory and connected-provider metadata | Agent Workbench provider/model selectors |
| `/api/hermes-runtime` | GET/POST | Read managed runtime/progress; explicitly apply settings, install a tagged release, or roll back | Settings apply in Agent Workbench; release management in Terminal |
| `/api/worker-profiles/{id}/delete` | POST | Delete a profile without changing existing job/attempt snapshots | Jobs board profile manager |
| `/api/server/restart` | POST | Guarded process restart request | Admin panel only |

## Stable Payload Notes

### Free Model Catalogue

`GET /api/free-models` returns `{ok: true, sections: {zen, api}, refresh_seconds: 86400}`. Each section contains `models`, `snapshot_at`, `fetched_at`, `stale`, and `error`. Each model contains `id`, `name`, `provider`, HTTPS `url`, token limits (`context`, `output`), `input_modalities`, `output_modalities`, nullable booleans (`tools`, `reasoning`), `rate_limit`, `expires`, nullable `rank`/`health`, and `answering_now`. Missing metadata is represented by null or an empty value, never a guessed capability.

`refresh=1` (or `refresh=true`) bypasses the 24-hour in-memory cache. The companion server starts a background checker at startup and repeats every 24 hours without requiring browser requests; it stops on server shutdown. Sources are fetched independently from fixed public HTTPS URLs with time/size limits. A failed source returns its previous successful models with `stale: true` and an error; on first-load failure its list is empty. Zen entries require live catalogue membership and zero input/output pricing in Models.dev, excluding deprecated entries. API entries use the ClawLabs tracker order by rank then context; known expired entries are excluded. `health` and `answering_now` describe the upstream snapshot, not Workbench inference probes. The endpoint needs no model API keys and does not execute inference or change settings.

### Voice Chat Services

`GET /api/settings` returns `speech` with effective `stt_url` / `tts_url`, `*_url_override_set`, and `*_token_set` booleans; token values are never returned. `POST /api/settings` accepts URL-only `{speech: {stt_url?, tts_url?}}` patches. Null/empty removes an override and falls back to `SPEECH_STT_URL` / `SPEECH_TTS_URL` from the companion environment. The UI saves and resets these as instance-wide settings.

Speech bearer tokens are accepted only through the write-only `speech:stt` / `speech:tts` names on `POST /api/settings/secret` and stored in the existing mode-`0600` settings file. They are never in the general settings payload, URL patches, browser persistence, or deployment environment. Empty token fields mean keep the saved secret; clear actions send null explicitly.

Browser audio goes only to the same-origin companion routes. Transcription accepts at most 8 MiB and supported WebM, Ogg, MP4, WAV, MPEG, or FLAC bodies; TTS accepts at most 4,000 text characters and returns at most 16 MiB of WAV. STT and TTS each allow one in-flight request; additional requests fail promptly with 503. Upstream requests time out after 90 seconds (voice discovery after 10 seconds). The browser displays an editable transcript and requires an explicit Send. Assistant speech is generated after completed replies only; code blocks are omitted from speech text. Voice blends are not exposed.

The current TTS wrapper's OpenAPI describes the successful `/v1/tts` response as JSON, while its deployment contract says it returns WAV; the companion rejects non-WAV responses and reports this mismatch. `/voices` has reported an empty list on health checks; an empty list is surfaced rather than treated as a working voice catalogue. Do not consider voice verified until tokens are securely provisioned and independent STT/TTS requests succeed. Speech processing is separate from Hermes; this integration does not add voice/model calls to the existing Hermes stream.

### Chat Connection Settings

`POST /api/settings` continues accepting partial provider/profile/tool settings and additionally returns `apiKeySet` for the active direct-API connection. Provider keys are scoped to their exact normalized endpoint URL; changing endpoints stashes/restores only that endpoint's key. `/hermes-gw` always reports the direct-provider `apiKeySet` as false because its gateway key is resolved separately by the server.

Optional write-only `provider_key: {endpoint, value}` atomically saves a pending typed key for its original endpoint alongside the new provider selection. It is never returned by settings APIs. `POST /api/settings/secret` accepts an optional `endpoint` for provider-key writes/copies and rejects a late request if the active endpoint changed. Saved provider profiles are applied before their key is copied to the newly selected endpoint. Existing settings files and profile secrets remain supported.

### Hermes Settings And Runtime

`GET /api/hermes-settings` returns `{ok, connection: {provider, model, base_url, override_set}, api_key_set}`. `POST` accepts `{provider, model, base_url, api_key?}` or `{reset: true}`. Omit `api_key` to preserve the same connection's saved key; an empty string clears the managed key. Credentials are scoped to provider and normalized endpoint, stored privately, and never returned. `custom` requires an http(s) endpoint without embedded credentials; built-in provider identifiers remain open-ended. Save returns `restart_required: true` and does not restart anything. Overrides are used by bootstrap before environment defaults; reset restores the original model/provider sections and deployment defaults, not unrelated configuration.

`GET /api/hermes-runtime` returns `{ok, supported, current, release, rollback_available, operation, services}`. `operation` includes `state` (`idle`, `running`, `succeeded`, `failed`, or `interrupted`), safe `step` text, and an optional timestamp. `POST` accepts `{action: "apply" | "update" | "rollback", confirm: true, version?: "<upstream tag>"}` and returns 202 when accepted. `version` is required for update and restricted to numeric release-tag syntax. Auth and explicit confirmation are required. Unsupported local/image versions, invalid requests, and concurrent operations fail before changes. Settings saves share the same operation lock.

The managed runtime stages only fixed-upstream tagged source and frozen dependencies in a separate home/venv. Activation invalidates cached live sessions and checks the gateway health route plus private WebSocket capabilities without inference. Failed activation attempts recovery to the old runtime and pre-activation configuration. Durable activation state permits recovery at next startup after interruption. Runtime rollback does not reverse arbitrary database changes. `GET /api/updates` identifies managed Hermes updates with `action: "managed"` and the exact upstream `tag`; Workbench images still use `repull`. Both mutation routes use terminal authorization in token mode and trust the configured authenticated edge in proxy mode.

### OpenCode Settings

`GET /api/model-catalog?engine=hermes|opencode` returns `{ok, engine, available, stale, source, providers, current, warning?}`. Provider entries contain only public `id`, `name`, `connected`, `models: [{id, name}]`, optional default model, and safe custom endpoint metadata. Hermes uses the authenticated `/api/model/options` picker inventory; OpenCode uses the loopback server's `/provider` and `/config`, with a labeled installed-CLI `models --verbose` fallback. No inference or credential-copy operation occurs. Main OpenCode connected status is not worker authentication. `current` describes the runtime default, not an arbitrary TUI session selection or a changed Workbench draft. Catalogs cache for 60 seconds; `refresh=1` bypasses the cache and requests full Hermes probing. A metadata failure returns a safe warning and a stale prior inventory when available; manual/custom configuration remains usable. Response bodies are bounded, credentials/config objects are never forwarded, and unknown engines are rejected.

`GET /api/opencode-settings` returns `{ok, main, worker, key_variables}`. Each connection contains `model`, `base_url`, and `api_key_set`, never the key itself. `key_variables` lists available `WORKER_*API_KEY` names without values.

`POST /api/opencode-settings` accepts optional `main` and `worker` objects with `model`, `base_url`, and an optional write-only `api_key`. Omit `api_key` to preserve it, or send an empty string to clear it. Optional `keys` maps `WORKER_*API_KEY` variable names to write-only values for profile endpoints. `reset: ["main", "worker"]` removes saved defaults and their saved default keys. `reload_main: true` explicitly requests a loopback `PATCH /global/config` to the OpenCode server; this can interrupt sessions. A failed reload returns `ok: true`, `main_reloaded: false`, and a warning because settings were still saved. Writes require terminal authorization in token mode; proxy mode trusts the deployment's authenticated edge.

Saved settings override deployment defaults across boots. Managed default keys are scoped to role and provider/endpoint; changing routes does not apply a previous custom key to a native OAuth provider. Reset clears that role's managed key scopes. Workers resolve defaults/keys at launch. Profile `base_url: null` (or omitted) inherits the worker default, `base_url: ""` explicitly selects a built-in provider, and an http(s) URL selects a custom endpoint. `api_key_env` optionally names a `WORKER_*API_KEY` credential, never its value. Endpoint URLs reject embedded credentials; profiles snapshot endpoint/model/key references, not secret values.

### Config

`GET /api/config` must continue returning enough information for the UI to show current capability state:

- `ai_node_ssh_target`
- `ai_node_stats_url`
- `terminal_auth_required`
- `wiki_root`

It must not return terminal tokens, webhook URLs, or other secrets.

### Stats

`GET /api/stats` must return either a complete stats snapshot with `status: "ok"` or a degraded JSON object with `status: "error"`, `message`, `source: "ai_node_unavailable"`, and `timestamp`.

The UI and future Tauri client should treat an error payload as a normal degraded state, not as a fatal app failure.

`GET /api/stats/source` returns `selected`, a safe `source_label`, and available `options`. `POST /api/stats/source` accepts `{ "source": "host" | "configured" }`; the choice is persisted in the private Workbench settings file. `configured` is omitted when no remote stats source is configured. Disk usage is visually flagged at 85% and 95%.

### Events

Event items should keep this shape:

- `id`
- `type`
- `message`
- `timestamp`
- `details`

Future audit events should extend `details` rather than changing the top-level shape.

### Workflows

Workflow definitions should keep this shape:

- `id`
- `title`
- `description`
- `configured`
- `url_hint`

Workflow jobs should keep this shape where available:

- `job_id`
- `workflow_id`
- `status`
- `message`
- `prompt`
- `created_at`
- `updated_at`
- `output_file`
- `download_url`

Known job states are `queued`, `running`, `completed`, and `failed`.

### Terminal

Terminal routes are compatibility routes. The Tauri desktop app should eventually replace them with native commands, but the behavior should remain equivalent:

- Start supports `mode: "cli"` and `mode: "tui"`.
- Output uses `session_id`, `offset`, `next_offset`, and `base_offset`.
- Active session lookup returns `active: null` when no session is running.
- Input, resize, and close reject missing or exited sessions cleanly.
- Auth failures return HTTP 401 when `TERMINAL_API_TOKEN` is configured.

### Wiki

Wiki routes must preserve these safety rules:

- All paths resolve under `WIKI_ROOT`.
- Path escapes are rejected.
- Hidden files are skipped by listing and search.
- Read/write/search support `.md`, `.markdown`, and `.txt` files only.
- Listing shows every file (including non-text) so uploaded attachments are visible.
- Existing files are backed up before overwrite.
- Writes append to `log.md` and record a `wiki_write` event.

`POST /api/wiki/upload` accepts `path` and `content_base64` and writes the
decoded bytes to the wiki, mirroring the workspace upload route:

- Any file type is accepted (binary-safe), unlike the text-only write route.
- Parent directories are created as needed; overwrites keep a timestamped backup.
- Uploads larger than 10 MB are rejected (HTTP 413 for oversized bodies, 400
  for decoded content over the cap); path escapes and invalid base64 return 400.
- Uploads append to `log.md` and record a `wiki_upload` event.

`GET /api/wiki/download` accepts a `path` query parameter and streams the
entry as an attachment, mirroring the workspace download route:

- Files are served raw with a guessed `Content-Type` (binary files included,
  unlike the text-only read route).
- Folders are zipped server-side as `<name>.zip` (`application/zip`), honoring
  the same hidden/ignored-entry rules as the listing route.
- Folder downloads larger than 256 MB (raw total) are rejected with HTTP 413.
- Path escapes are rejected with HTTP 400; missing paths return HTTP 404.
- Serves record a `wiki_download` event.

### Artifacts

Artifact routes must preserve these safety rules:

- Legacy workflow artifact routes are retired; HTML artifacts are managed by AI Workbench and the shared state API.
- Path traversal and separator characters are rejected for named artifact downloads.
- Only `.html` and `.htm` files are downloadable.
- Recent artifacts are sorted newest first.

### Workspace

Workspace routes expose a scoped project root for browser/remote mode.

`GET /api/workspace/list` returns:

- `root`
- `path`
- `items`

Workspace item fields:

- `name`
- `path`
- `is_dir`
- `modified_ts`
- `size_bytes`

`GET /api/workspace/read` returns:

- `path`
- `content`
- `modified_ts`
- `size_bytes`

`GET /api/workspace/status` returns:

- `path`
- `modified_ts`
- `size_bytes`

`GET /api/workspace/download` accepts a `path` query parameter and streams the
entry as an attachment:

- Files are served raw with a guessed `Content-Type` (binary files included,
  unlike the text-only read route).
- Folders are zipped server-side as `<name>.zip` (`application/zip`), honoring
  the same hidden/ignored-entry rules as the listing route.
- Folder downloads larger than 256 MB (raw total) are rejected with HTTP 413.
- Path escapes are rejected with HTTP 400; missing paths return HTTP 404.

`POST /api/workspace/write` accepts:

- `path`
- `content`
- `expected_modified_ts`
- `expected_size_bytes`
- `force`, optional boolean for confirmed overwrite

Successful writes return:

- `path`
- `modified_ts`
- `size_bytes`

Conflict responses return HTTP 409 with `ok: false`, `message`, and the current file status when available.

Workspace routes must preserve these safety rules:

- All paths resolve under `WORKSPACE_ROOT` or the configured agent-state extra roots.
- Path escapes are rejected.
- Listings include hidden entries, generated directories, and all file extensions.
- Reads are limited to common text/code files.
- Reads larger than 2 MB are rejected.
- Status checks use the same containment rules and support binary files for previews.
- Writes use the same containment and text/code file rules as reads.
- Writes larger than 2 MB are rejected.
- Writes require expected file metadata unless `force` is true.
- Existing files are backed up under `WORKBENCH_BACKUP_DIR/workspace` before overwrite.
- Downloads use the same containment rules; folder zips exclude hidden and ignored entries.
- `POST /api/workspace/upload` accepts `{filename, content_base64, directory?}` with a 10 MB decoded-file limit. Omitting `directory` preserves timestamped attachment uploads; passing `directory: ""` imports into the workspace root. An explicit directory must exist within an allowed root. Import preserves file bytes and names, creates atomically without overwrite, and returns a workspace-relative `path` where applicable.
- `POST /api/workspace/delete` accepts `{path, recursive}`. Files keep their existing deletion contract; directories require the literal boolean `recursive: true`.
- Directory deletion moves the entire tree, including hidden entries and symlinks, into a uniquely named recovery backup. Workspace/agent roots, recovery storage, and direct symlink targets cannot be deleted. A backup failure prevents deletion.
- Successful deletion returns `{ok, path, deleted, is_dir, backup_path}`; `backup_path` identifies the recovery copy on the agent host.

### Jobs

The job board routes are served by the companion API and backed by `jobs_engine.py`. They are only meaningful when `JOBS_SANDBOX=1`; with the sandbox off, creating a job fails when workers would start.

`GET /api/jobs` returns:

- `ok`
- `jobs` — list of jobs, newest first. Each job has `id`, `title`, `description`, `stage`, `detail`, `created_at`, `updated_at`, `questions`, `answers`, `plan`, `summary`, `error`, `attachments`, `skills`, and a `subtasks` list (each with `idx`, `title`, `status`).
- `settings` — public settings only: `worker_model`, `max_parallel_jobs`, `max_workers_per_job`, `max_workers_total`, `job_timeout_minutes`, `plan_gate`, `auto_approve`, `sandbox`.

`GET /api/jobs/{id}` returns `ok` and `job`, where the job additionally carries:

- `subtasks` — full list, each with `idx`, `title`, `instructions`, `status`, `result`, `error`, `depends_on` (0-based indices), `wave`, `exit_code`, `container`, `started_at`, `finished_at`, `rounds`, `profile_snapshot`, and `attempts`.
- Job-level fields may include `profile_id`, `profile_snapshot`, `project_path`, `base_branch`, `token_budget`, and `cost_budget`.
- Each attempt includes its profile snapshot, status/error/timestamps, retained log path, reported input/output tokens and cost, and optional project branch/worktree/merge timestamp.
- `events` — list of `{ts, kind, message}`.

Job `stage` is one of `inbox`, `review`, `needs_input`, `planned`, `running`, `replanning`, `collating`, `done`, `failed`, `stopped`. Subtask `status` is one of `queued`, `running`, `waiting_input`, `done`, `failed`, `timeout`, `stopped`.

`POST /api/jobs` accepts `title`, `description`, `attachments` (uploaded file paths, max five), `skills` (max five), optional `profile_id`, workspace-relative or absolute `project_path` inside the workspace, `base_branch`, positive `token_budget`, and positive `cost_budget` in USD. It returns the created job (HTTP 201). Workers currently use the OpenCode runtime; profile snapshots are independent from chat/provider profiles.

`POST /api/jobs/{id}/{action}` actions:

- `answer` — body `answers` (list or string); only valid in `needs_input`.
- `approve` — optional body `plan` (edited plan); only valid in `planned`.
- `move` — body `stage` (and optional `note`); allowed targets depend on the current stage (back to `inbox`, to `planned`, or to `running`).
- `stop`, `retry`, `archive` — no body. `retry` is only valid on finished jobs; `archive` only when not active.
- `subtasks/{n}/retry` — retry only a failed or timed-out worker in a finished job; prior attempts are retained.
- `subtasks/{n}/merge` — no body; only completed project workers can merge, and the base repository must be clean and checked out on the configured base branch. This performs a local merge and does not push or create a PR.

`GET /api/jobs/{id}/subtasks/{n}/log` returns `ok` and `log` (raw OpenCode JSON lines, last 400 lines). The `/stream` route emits JSON `data:` events with `log`, `replace`, and `status`. `GET /project` returns changed files, uncommitted files, branch, and merge state. `GET /api/jobs/{id}/comms` returns `ok`, `job_id`, and `threads` (per-subtask clarification history with `pending`, `rounds`, and `entries`).

Worker profiles are independent from chat/provider profiles. `GET /api/worker-profiles` lists them; `POST` creates or updates a profile with `id` (optional), `name`, `instructions`, `runtime` (`opencode`), `model`, `skills` (up to five installed Hermes skill paths), and `permission_preset` (`guarded` or `trusted`). The deployment-wide `JOB_AUTO_APPROVE` setting is always an upper bound on worker permissions. Deleting a profile does not change existing job or attempt snapshots.

Jobs routes must preserve these rules:

- Unknown jobs return HTTP 404 with `ok: false`.
- Invalid actions or stage transitions return HTTP 409 with `ok: false` and a `message`.
- Job files and artifact downloads are contained under the job directory; path escapes are rejected.

## Test Coverage

The current contract suite lives at `tests/test_api_contracts.py` and covers:

- Config response shape and secret omission.
- Chat provider ordering and session event behavior.
- Recent events response shape.
- Workflow listing, missing status, and unknown workflow errors.
- Stats degraded-state response.
- Wiki listing (including non-text files), reading, writing, backup creation, search, and path escape rejection.
- Wiki file/folder downloads (raw file bytes, folder zips, ignored-entry exclusion, path escape rejection).
- Wiki binary uploads (new file, overwrite backup, path escape and invalid-base64 rejection).
- Artifact listing and path traversal rejection.
- Terminal auth and start-mode validation without launching a real shell.
- Workspace listing, reading, ignored entries, path escape rejection, and binary/unsupported extension rejection.
- Workspace file status checks for conflict detection.
- Workspace file/folder downloads (raw file bytes, folder zips, ignored-entry exclusion, path escape rejection).
- Workspace guarded writes, backup creation, and stale-write conflict responses.

Run it with:

```bash
python3 -m unittest tests.test_api_contracts   # from the repository root
```

## Contract Verification

The contract baseline is considered healthy when:

- This API contract document exists.
- Contract tests exist for the current compatibility surface.
- The focused contract test suite passes.
- The main upgrade plan points to this document and test suite.
- Future Tauri work has a stable HTTP reference to preserve or intentionally replace.