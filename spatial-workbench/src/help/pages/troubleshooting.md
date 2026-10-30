## The interface cannot be reached

For a loopback install, start the SSH tunnel on the computer running your browser, keep it open, and use its local browser URL. An SSH authentication prompt is for the VM account, not the terminal API token. Check the tunnel's local port and the deployment's bind address before changing exposure or firewall settings.

With a reverse proxy, check its authentication, allowed clients, and upstream address. Proxy configuration belongs to the proxy host; it may be separate from the app host. Do not expose the app port publicly as a workaround. See [Security & sandboxing](#help/security).

## Chat fails or uses the wrong model

Check the active provider label and the intended section in **Agent Workbench**. Hermes chat, main OpenCode, and workers are configured independently.

- **401 / 403:** confirm the selected endpoint's saved key and its access policy. A missing Hermes Gateway key is a server configuration issue, not a direct-model key issue.
- **429:** check the provider's account-wide rate limits and free-tier availability. Retrying repeatedly may not help.
- **Connection refused / timeout:** check reachability from the agent host, the URL and `/v1` path, and the running model service.
- **Model not found:** discover the endpoint's current IDs or check its catalogue. A tracker listing is not a connection configuration.

Do not post API keys or full private configuration into a chat while troubleshooting. Use [Models & connections](#help/connections).

## A job waits, fails, or produces no file

Open its detail drawer. **Needs input** waits for an answer; **Planned** may wait for approval. Read the worker's latest attempt, log, and error before retrying.

Confirm Jobs sandboxing is enabled and running. For a private worker endpoint, check `SANDBOX_ALLOW_LAN`; worker `localhost` is not the host. A missing explicitly named profile key fails the launch. Inspect dependencies and upstream artifacts when a downstream task is blocked.

Deliverables must be under the worker's `artifacts/` directory. Other files can still be visible in **Projects**. Retry is a new attempt and can consume additional usage. See [Jobs](#help/jobs) and [Worker profiles](#help/worker-profiles).

## Saving reports a conflict

Another browser or an agent may have changed the file on disk. Compare the versions and preserve your unsaved edits before reloading. Do not overwrite a newer file just to clear the warning.

## A preview or board update is missing

Check source files as well as the rendered preview. HTML frames are sandboxed; a full application may need a backend and assets that a preview does not provide. For the board, check the companion API and whether the selected agent has board tools configured.

For apps with a server, use **Run app** or the agent's managed preview tool, then follow the Workbench preview link. A remote agent's `http://127.0.0.1:<port>` points to your computer when opened in your browser; it is not the remote app. Read **App output** and check the selected command, port, and loopback binding. A listening port only proves readiness, not that every app route works. Sessions expire after an API/container restart or idle cleanup; start a new preview rather than reusing an old link.

If the page loads but an API call or asset fails, check whether it uses a root-absolute URL from an external script or stylesheet. HTML URL rewriting covers common cases, not every framework. WebSockets/HMR and origin-dependent storage or cookie workflows are not supported by this preview. See [Projects](#help/projects).

## Hermes CLI or updates fail

If TUI works but typing `hermes` fails with an old interpreter path, open a new shell and inspect `command -v hermes`. Managed appliance login shells should prefer `/opt/workbench/bin/hermes`, not a persistent shim targeting a removed release. An administrator should inspect launcher paths and runtime selection before changing data or restarting services.

The upstream `hermes update` command may reject Docker; use **Terminal -> Versions -> Hermes Agent -> Update** instead. Failed preparation leaves the current runtime selected; failed activation attempts automatic recovery. Recovery history is retained in the runtime API, not shown as a standing Versions warning. Check actual agent/service health separately.

## Free models are empty or stale

Use Refresh in **Free AI** and check the source timestamp and stale warning. The tracker needs outbound access to its public metadata sources, not your model API key. A Zen model also needs current zero-cost Models.dev metadata. See [Free model tracker](#help/free-models).

## Terminal or resource readings fail

Terminal-token authentication is separate from site access and SSH. Use the current token through your secure administration process. For metrics, check the selected Monitor source and configured statistics service; missing sensors are not proof that the model is down.

Before restarting services, inspect relevant agent/web logs, preserve active work, and follow your administrator's change process. The [Deployment reference](#help/deployment-reference) is included for detailed configuration checks.