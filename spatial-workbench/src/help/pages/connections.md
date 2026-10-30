## Connection Settings

Open **Agent Workbench**. The connection sections serve different roles:

| Section | Controls |
| --- | --- |
| Hermes agent endpoints | Interactive Hermes Gateway, direct-model API, or Hermes CLI chat connection |
| Hermes inference & runtime | Provider/model used inside Hermes itself |
| Main OpenCode endpoints | The main OpenCode model and endpoint, including OpenCode chat |
| Worker OpenCode endpoints | Defaults for newly launched job workers |

Changing one section does not automatically update the other two. Hermes uses its own provider/model for chat, planning, and collation. Main OpenCode and workers default independently to `opencode/big-pickle` unless configured otherwise.

## Choose a chat connection

The Hermes **Connection** selector offers **Hermes Gateway**, **OpenAI API**, **Local model API**, **Custom API endpoint**, and **Hermes CLI**.

Gateway runs the full Hermes agent through the companion's private `hermes serve` connection, one live session per chat. The `/hermes-gw` route and server gateway key are still used for model discovery and Jobs, so a missing gateway key must be fixed on the server; pasting a direct-model key into another connection does not fix it.

For a direct API, select the endpoint, model ID, and any required key. OpenAI-compatible URLs generally include `/v1`. The endpoint must be reachable from the machine making the request; browser API paths are proxied by the companion server. Use model discovery where available rather than guessing an ID.

## Save Hermes inference settings

Open the separate **Hermes inference & runtime -> Configure** column beside **Hermes agent endpoints**. Provider and model choices come from Hermes's own picker inventory, including authenticated connections and saved custom endpoints. **Refresh providers** retrieves fresh metadata. Selecting a saved custom endpoint fills its URL; **Other provider...** and **Enter model ID...** retain manual choices. Existing built-in provider authentication remains available. Optional API keys are write-only and scoped to the provider/endpoint. Blank preserves the saved key for the same connection; clearing a saved key does not revoke separate environment or OAuth credentials.

**Save** persists settings without a restart. **Apply Saved** explicitly restarts managed Hermes services and can interrupt active chats, integrations, and jobs. Finish active work first. Saved overrides survive redeploys and take precedence over deployment `LLM_*` defaults. **Reset** restores the deployment defaults; apply when ready.

The separate **Connection** selector controls how Workbench connects for chat; choosing OpenAI there does not reconfigure the provider inside Hermes. Version checks and the Hermes **Update** button live in **Terminal**, not in the inference settings. See [Updates & backups](#help/maintenance).

## Save OpenCode settings

Choose an OpenCode provider or a custom endpoint in the appropriate section. The provider/model dropdowns read the main OpenCode runtime catalog and mark connected providers, including native OAuth providers such as GitHub Copilot when connected in that installation. The installed CLI supplies a labeled fallback when no headless server is reachable. **Refresh providers** reloads metadata. **Other provider...**, **Enter model ID...**, and **Custom endpoint** remain available; discovery does not restrict supported providers.

The **Runtime default** is reported separately from the saved Workbench default. A model selected temporarily in one TUI session does not necessarily change either global default. Worker selectors show the main runtime's model inventory, but a main-instance login does not authenticate worker containers. Worker credentials and native provider support must be provisioned independently; selecting a model does not copy OAuth tokens.

- Leaving the key field blank preserves the key for the same provider/endpoint. Switching providers does not reuse the previous route's managed key. Use **Clear key** to remove it explicitly.
- Saved settings override deployment environment defaults on later boots.
- **Reset to deployment defaults** removes that section's saved override and default key.
- Worker changes apply to future launches, not workers already running.
- New main OpenCode CLI sessions read the saved configuration. **Reload running OpenCode server** may interrupt active sessions; confirm only when ready.

Keys are write-only in the settings API. The browser sees key status, not the saved secret value. Direct chat keys are scoped to the endpoint so switching connections does not reuse another endpoint's key.

## Local servers and private data

Worker `localhost` refers to the worker container, not your model server or the host. A LAN endpoint requires an explicit sandbox exception; changing the endpoint in the UI does not change firewall rules. See [Security & sandboxing](#help/security).

Private model endpoints are not an air-gap: installation, updates, and enabled tools may still access the network. Hosted free models can have different data-retention policies. Check [Free model tracker](#help/free-models) and the provider's terms before using sensitive prompts.

## Speech services

Open **Agent Workbench → Speech services → Settings** to configure STT and TTS for this Workbench instance. Saved URL overrides live in companion settings; **Use deployment URLs** removes the overrides and falls back to `SPEECH_STT_URL` and `SPEECH_TTS_URL`. Leave a token field blank to keep the saved token; use its **Clear** checkbox to remove it.

Tokens are stored server-side as write-only secrets. The browser sees only whether each token is configured, not its value. Separate Workbench installations use separate settings volumes and can have their own services and credentials.

The current adapter expects the configured speech wrappers' API contracts: STT at `/v1/audio/transcriptions` with multipart `file`, Bearer authentication, and JSON `text`; TTS at `/v1/tts` with JSON input and WAV output, plus `/voices`. Changing the URL alone does not adapt another provider such as ElevenLabs. Speech traffic passes through the companion API rather than directly from browser to speech host.