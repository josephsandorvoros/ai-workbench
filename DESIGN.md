# DESIGN.md

## Product Context
HybridCloudHQ AI Dashboard is an operational control surface for homelab AI infrastructure. Users are operators who prioritize legibility, response clarity, and fast action under load.

## Source Inputs Merged
This document merges two inputs:
1. HybridCloudHQ brand guidance
2. Current AI Workbench styling in `spatial-workbench/src/styles.css`

## Unified Visual Direction
Content-first control room:
- Dark, modern, and understated
- Calm density over decorative noise
- Technical but human
- Clear status hierarchy with restrained emphasis

Distinctiveness should come from composition, spacing rhythm, and typographic hierarchy, not ornamental gradients or loud effects.

## Canonical Brand System

### Core Colors
Use HybridCloudHQ brand palette as source of truth.

- Background: #0f1113
- Surface: #121417
- Text: #ffffff
- Muted Slate: #9aa3b2
- Border: rgba(255, 255, 255, 0.04)
- Violet: #7c3aed
- Pink: #ff6bb5
- Soft Purple: #a78bfa
- Slate Highlight: #475569
- Deep Ink: #0b0d10

### Typography
- Headings: Inter, system-ui, Segoe UI, Arial, Helvetica, sans-serif
- Body: Inter, system-ui, Segoe UI, Arial, Helvetica, sans-serif
- Mono-only zones: terminal and code-like inputs

Avoid decorative display fonts in product UI surfaces.

### Voice
- Friendly but not playful
- Technical but not sterile
- Readable at a glance

## Token Contract for AI Workbench
Use CSS custom properties in :root as the only styling source of truth.

### Required Token Groups
- Background tokens: --color-bg-primary, --color-bg-secondary, --color-bg-tertiary, --color-bg-card
- Text tokens: --color-text-primary, --color-text-secondary, --color-text-muted
- Border tokens: --color-border, --color-border-strong
- Semantic tokens: --color-accent-primary, --color-accent-secondary, --color-accent-success, --color-accent-warning, --color-accent-danger
- Terminal tokens: --terminal-bg, --terminal-fg, --terminal-cursor
- Typography tokens: --font-family-sans, --font-family-mono, --font-size-xs through --font-size-xl
- Spacing tokens: --space-xs through --space-2xl

### Exact Token Map (Current Production)
These values should match the Workbench CSS unless a brand update is approved.

#### Color tokens
- --color-bg-primary: #0f1113
- --color-bg-secondary: #0f1113
- --color-bg-tertiary: #121417
- --color-bg-card: #121417
- --color-border: rgba(255, 255, 255, 0.04)
- --color-border-strong: rgba(71, 85, 105, 0.72)
- --color-text-primary: #ffffff
- --color-text-secondary: #c6ceda
- --color-text-muted: #9aa3b2
- --color-accent-primary: #7c3aed
- --color-accent-secondary: #ff6bb5
- --color-accent-soft: #a78bfa
- --color-accent-success: #a78bfa
- --color-accent-warning: #ffb866
- --color-accent-danger: #ff6b8a
- --terminal-bg: #0b0d10
- --terminal-fg: #ffffff
- --terminal-cursor: #a78bfa

#### Typography tokens
- --font-family-display: Inter, system-ui, Segoe UI, Arial, Helvetica, sans-serif
- --font-family-sans: Inter, system-ui, Segoe UI, Arial, Helvetica, sans-serif
- --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace

#### Motion and shape tokens
- --border-radius-sm: 6px
- --border-radius-md: 10px
- --border-radius-lg: 14px
- --transition-fast: 120ms ease
- --transition-normal: 200ms ease

### Mapping Rule
If a proposed component style cannot be expressed using existing tokens, add or revise a token first. Do not hard-code values directly in component rules.

### Component-to-Token Mapping Rules
- Body background must be based on --color-bg-primary, --color-bg-secondary, and --terminal-bg.
- Panels must derive from --color-bg-card plus --color-border and --color-border-strong.
- Primary buttons must use --color-accent-primary (and may blend with --color-accent-secondary on hover only).
- Secondary buttons must use --color-bg-tertiary and --color-border.
- Status success/error surfaces must derive from --color-accent-success and --color-accent-danger.
- Meter bars must use accent tokens, not standalone hard-coded hues.
- Terminal JavaScript theme must read --terminal-bg, --terminal-fg, and --terminal-cursor from CSS.

## Component Standards

### Reusable Primitives (Operational)
Use these shared classes in the Workbench instead of inline styles:

- List and message primitives:
	- `artifact-item` for list row shells
	- `muted mb-0` for empty/loading/error text in list regions
- Inline action primitive:
	- `btn secondary btn-inline` for file/path picker actions embedded in list rows
- Spacing utilities (small operational rhythm):
	- `mt-2xs`, `mt-xs`, `mt-sm`, `mb-2xs`, `mb-xs`, `mb-0`
	- `modal-row-stack-top` for stacked action rows in disclosure panels
	- `info-pane-tight` for tightly grouped disclosure sections
- Context-specific reusable surfaces:
	- `wiki-editor-tall` for the dominant wiki editor height contract
	- `event-message` for secondary event-line spacing

Migration rule:
- If the same inline style appears in 3+ places, extract a semantic class and reuse it.
- Empty/loading/error states in dynamic list containers must use shared muted-message rendering utilities in JavaScript.

### Layout
- Use panel-based sections with clear boundaries
- Keep content rail compact and readable
- Preserve asymmetric but intentional column rhythm

### Actions
- Primary action: violet family emphasis
- Secondary action: dark surface with subtle border
- Destructive action: semantic danger tone only
- Do not make every button primary

### Links and Service Items
- No emoji as primary iconography
- Use concise labels and supporting metadata
- Accent color usage should clarify, not decorate

### Status and Feedback
- Use status classes for success and error
- Announce dynamic updates via live regions
- Keep messages concise and operational

### Terminal
- Terminal colors must come from CSS tokens
- Never hard-code terminal colors in JavaScript

## Motion and Interaction
- Use transform and opacity for motion
- Keep easing smooth and restrained
- Respect reduced motion settings
- Avoid bounce/elastic behavior in operational surfaces

## Hardening and Resilience Requirements
- Maintain 44x44 minimum touch targets
- Preserve focus-visible treatment
- Preserve dialog semantics and focus management
- Keep overflow-safe text handling for long i18n strings
- Guard storage and prompt flows against restricted browser environments
- Prevent overlapping polling/network storms during degraded connectivity

## Accessibility Baseline
- WCAG AA contrast for text and controls
- Keyboard navigable full workflow
- Role and aria attributes for dynamic widgets and status regions
- Logical focus order and focus return for modal flows

## Anti-Drift Constraints
- Do not use purple-teal gradient primary buttons
- Do not reintroduce decorative glass blur as a default style treatment
- Do not introduce one-off hard-coded colors in components
- Do not use decorative display typography for dashboard headings
- Do not add visual effects that reduce legibility or status clarity

## Verification Checklist
Run this checklist on every visual refactor:

1. Typography
- Inter is loaded and used for headings and body text.
- No decorative display font appears in operational UI.

2. Token integrity
- Every color used in key UI components resolves from :root tokens.
- Terminal theme colors are read from CSS tokens in JavaScript.

3. Interaction and resilience
- All critical actions keep visible focus styles and 44x44 minimum targets.
- Dynamic status updates remain in aria-live regions.
- Long text, CJK text, and narrow viewport text do not overflow containers.

4. Regression checks
- Script syntax check passes.
- Core workflows still function: terminal start/stop, stats polling, workflow trigger, artifact listing.

## Implementation Notes
- This file is normative for future edits to the AI Workbench frontend surface.
- If a redesign is proposed, update this document first, then apply code changes.
