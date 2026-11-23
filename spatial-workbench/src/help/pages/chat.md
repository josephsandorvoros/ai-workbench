## Start a conversation

Choose a connection in **Agent Workbench**, then use the central **Chat**. Tools open in the right-hand **Canvas** without replacing the conversation. The provider label shows the active connection and model. Use **New chat** for a fresh conversation and **Load chat** to revisit a saved one.

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

## Mobile chat and voice

On phones the Workbench shows only chat. Use **New chat**, **Load chat**, the model picker, attachments, and the composer without the desktop tool rail or canvas. Open a desktop-sized screen for projects, Source Control, monitoring, and administration.

The **Speech** selector defaults to **Browser** on mobile and **Speech service** on desktop:

- **Browser dictation:** tap **Talk** to start live transcription. Words appear in the composer as you speak; the composer is read-only while listening so interim results cannot overwrite your edits. Tap **Stop**, review the text, then **Send**. There is no Workbench duration cap. Browsers can stop at pauses or impose their own session limits; tap Talk to continue. Unsupported browsers show an explanation instead of silently uploading audio. Use the keyboard microphone or explicitly choose Speech service.
- **Browser spoken replies:** select a browser/system voice. **Speak replies** remains opt-in; individual replies also have a **Speak reply** action and a stop control. Long replies are spoken in short chunks. Browser autoplay rules can require another tap.
- **Speech service:** uses the installation's configured STT/TTS services. Recordings can run for up to **three minutes**, with the existing **8 MB** upload limit. Transcription starts after Stop; this mode is not streaming.

Browser speech is not guaranteed to be offline or on-device: recognition and some voices may use the browser vendor's online services. Permission, language, and browser support vary. HTTPS or localhost is required for the microphone. Only use the configured server fallback when you want audio/text sent to those services. Spoken replies skip fenced code blocks.