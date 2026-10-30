## Know where commands run

The **Terminal** workspace is a shell on the agent host. In the appliance deployment it runs inside the agent container, not your desktop shell and not a Jobs worker. The terminal's location does not change when Hermes terminal sandboxing is enabled.

Treat shell commands as real operations. They can modify files and state accessible to the agent container. A running terminal process is not stopped by clearing a chat.

## Authenticate when required

In terminal-token mode, enter the installation's terminal API token when requested. It is stored for the browser session, not as a persistent browser setting. Ask your administrator for the token or retrieve it through your normal secure administration process; do not paste it into chat or a help search.

The terminal token is not an SSH password and not a login for the whole website. Proxy/basic authentication may be a separate access layer. See [Security & sandboxing](#help/security).

## Interactive assistants

Use the terminal shortcuts to open the Hermes TUI or OpenCode when available. Those sessions use the harness's own configuration and permissions. Main OpenCode settings are independent of worker defaults; see [Models & connections](#help/connections).

On managed appliance installs, new login shells prefer the recovery-aware Workbench Hermes launcher over persistent user-local shims. If a shell opened before an update still uses a stale path, open a **New shell** and inspect `command -v hermes`. Do not remove persistent data to repair a launcher path.

## Version information

The Terminal workspace also shows installed and latest versions. An update indicator in the header opens that view. Beside each status, Workbench and Sandbox say **Re-pull and redeploy**; Hermes Agent and OpenCode say **Use the Update button**. Both component Update buttons stay visible and are disabled when current or unsupported. Version checks do not automatically install an update.

Read [Updates & backups](#help/maintenance) before using an update action, especially when conversations or jobs are active.