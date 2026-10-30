import { useEffect, useRef, useState } from "react";

import { updateAgentProvider, useAgentProvider } from "../agent/agentStore";
import type { AgentMode } from "../agent/providers";
import { Icon } from "./Icon";

const MODES: { value: AgentMode; label: string; hint: string }[] = [
  { value: "plan", label: "Plan", hint: "Propose changes, never execute" },
  { value: "ask", label: "Ask", hint: "Ask before mutating the board" },
  { value: "auto", label: "Auto", hint: "Execute tools without asking" },
];

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Keep the latest callback in a ref so the effect below can subscribe
  // once (stable deps) instead of re-subscribing on every render — callers
  // pass an inline lambda, which would otherwise change identity each render.
  const callbackRef = useRef(onOutside);
  callbackRef.current = onOutside;
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) callbackRef.current();
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, []);
  return ref;
}

/**
 * Compact model picker for the chat input bar (VS Code style): shows the
 * active model, opens a dropdown of models from the active endpoint.
 */
export function ModelPicker({ models }: { models: string[] }) {
  const config = useAgentProvider();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));

  const label = config.kind === "api" ? config.model || "no model" : config.kind;

  return (
    <div className="chat-picker" ref={ref}>
      <button
        className="chat-picker-btn"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Active model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chat-picker-icon" aria-hidden>
          <Icon name="hexagon" size={14} />
        </span>
        <span className="chat-picker-label">{label}</span>
        <span className="chat-picker-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="chat-picker-menu" role="listbox" aria-label="Models">
          {models.length === 0 && <div className="chat-picker-empty">No models at this endpoint</div>}
          {models.map((model) => (
            <button
              key={model}
              className={`chat-picker-item ${model === config.model ? "active" : ""}`}
              type="button"
              role="option"
              aria-selected={model === config.model}
              onClick={() => {
                updateAgentProvider({ model });
                setOpen(false);
              }}
            >
              <span>{model}</span>
              {model === config.model ? <span className="chat-picker-check">✓</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact agent-mode picker (Plan / Ask / Auto) for the chat input bar.
 */
export function ModePicker() {
  const config = useAgentProvider();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const current = MODES.find((mode) => mode.value === config.agentMode) ?? MODES[1];

  return (
    <div className="chat-picker" ref={ref}>
      <button
        className="chat-picker-btn"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Agent mode"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chat-picker-icon" aria-hidden>
          <Icon name="bolt" size={14} />
        </span>
        <span className="chat-picker-label">{current.label}</span>
        <span className="chat-picker-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="chat-picker-menu" role="listbox" aria-label="Agent mode">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              className={`chat-picker-item ${mode.value === config.agentMode ? "active" : ""}`}
              type="button"
              role="option"
              aria-selected={mode.value === config.agentMode}
              onClick={() => {
                updateAgentProvider({ agentMode: mode.value });
                setOpen(false);
              }}
            >
              <span className="chat-picker-item-main">
                <span>{mode.label}</span>
                <span className="chat-picker-item-hint">{mode.hint}</span>
              </span>
              {mode.value === config.agentMode ? <span className="chat-picker-check">✓</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
