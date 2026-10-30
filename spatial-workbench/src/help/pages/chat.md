## Start a conversation

Choose a connection in **Agent Workbench**, then use **Chat** or the right-hand Agent panel. The provider label shows the active connection and model. Use **New chat** for a fresh conversation and **Load chat** to revisit a saved one.

**Hermes Gateway** talks to the full Hermes agent, including its server-side tools, skills, and memory. **OpenAI API**, **Local model API**, and **Custom API endpoint** talk to the chosen model directly. The tools available through these paths are different. See [Models & connections](#help/connections).

## Add context

Use the context control or type `@` to choose supported context sources. Attach relevant files or images when the chosen connection supports them. Review attached context before sending: it may be transmitted to your model provider.

## Commands

Type `/` to see the command menu. It can include local commands, available skills, saved profiles, and models discovered from the active endpoint.

| Command | Purpose |
| --- | --- |
| `/help` | Show chat command help |
| `/new` | Start a fresh chat |
| `/clear` | Clear the current conversation |
| `/provider` | Show the active connection |
| `/tools` | List browser-local tools |
| `/stop` | Stop the current browser request |

Selecting a skill inserts an editable instruction into the message. Selecting a model or provider profile changes the chat connection; it does not change job-worker defaults.

## Modes, approvals, and stopping

The chat mode selector offers **Plan**, **Ask**, and **Auto**. With **Hermes Gateway**, it also answers Hermes' dangerous-command approvals: **Ask** shows inline Approve/Deny on the tool card, **Auto** approves once, and **Plan** denies. Hermes decides which commands need approval from its own `approvals` settings. OpenCode sessions keep their own permission settings; see [Security & sandboxing](#help/security).

**Stop** interrupts the current Hermes turn (Gateway) or cancels the Workbench's request (other connections). Clearing a conversation does not undo files or commands that already ran.

With **Hermes Gateway**, each chat keeps one live Hermes session, like a Discord channel: slash commands (`/model`, `/usage`, `/compress`, `/<skill-name>`, ...) and messages reach the same agent. `/new`, `/clear`, `/stop`, and `/provider` stay Workbench commands. A chat's agent closes after 30 idle minutes and is rebuilt from history on the next message; reloading the page mid-turn picks the turn back up.

The context meter estimates conversation size. When supported, older turns are summarized before sending as the conversation approaches the model's context limit; the visible transcript is retained. Estimates are not exact token accounting.

For mobile access, use an existing Hermes chat integration such as Discord. Its session and permission handling belong to Hermes, not the browser chat controls.