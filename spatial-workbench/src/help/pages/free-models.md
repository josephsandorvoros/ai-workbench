## Browse free options

Select **Free AI** in the header. The tracker has separate **OpenCode Zen** and **Free API models** sections. Filter by name, provider, or model ID.

Rows show known input capabilities, non-text output capabilities, tool calling and reasoning support, context/output token limits, and provider rate limits. Hover over an icon to see its meaning. Missing metadata is unknown, not proof that a capability is unsupported.

Click a row to open the provider or Zen pricing page. Right-click a row or use its copy button to copy the API model ID. Browsing or copying does not configure a connection; use [Models & connections](#help/connections) to choose it for chat, main OpenCode, or workers.

## Refresh behavior

The companion server checks sources at startup and every **24 hours**, even without an open browser. An open dashboard also reloads its list daily. Source updates are not pushed instantly into the Workbench.

Use **Refresh**, press `R` while the panel is focused, or middle-click the header pill to check immediately. Right-click the pill for the highest-ranked API model in the current tracker snapshot.

If a source is unavailable, its last successful models remain visible with a stale warning. On a first-load failure, that section can be empty. Check the displayed snapshot or checked timestamp before relying on a cached list.

## What the sources mean

API models come from the public [ClawLabs tracker](https://github.com/ClawLabsAI/free-ai-models). Its ranking and health labels describe its published snapshot; Workbench does not send inference probes to test availability.

Zen models must appear in the [live Zen catalogue](https://opencode.ai/zen/v1/models) and have matching [Models.dev](https://models.dev) metadata with zero input and output pricing. Deprecated and known expired entries are excluded. A newly added free Zen model may not appear until its metadata is available too.

If a model is missing, confirm its current ID and free pricing on Zen's site, then try Refresh. A refresh cannot supply metadata that Models.dev has not published. You can configure a confirmed model manually through [Models & connections](#help/connections); do not assume an ID containing "free" proves its price.

Free tiers can change, be rate-limited, or end. Provider limits may be shared across your account. Check pricing and data-handling terms before sending confidential prompts. No model API key is needed merely to browse this tracker.