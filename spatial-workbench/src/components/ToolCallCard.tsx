import { useState } from "react";

import type { ToolCallRecord } from "../agent/chatSessions";
import { isMutatingTool } from "../agent/toolCallSummary";
import { Icon, type IconName } from "./Icon";

interface ToolCallCardProps {
  call: ToolCallRecord;
  /** Whether the turn is still running (affects pending cards). */
  live: boolean;
  /** Approve a pending mutating tool call (ask mode). */
  onApprove?: (id: string) => void;
  /** Deny a pending mutating tool call (ask mode). */
  onDeny?: (id: string) => void;
}

const STATUS_LABEL: Record<ToolCallRecord["status"], string> = {
  pending: "Waiting for approval",
  running: "Running…",
  done: "Done",
  denied: "Denied",
  error: "Failed",
};

const STATUS_ICONS: Record<Exclude<ToolCallRecord["status"], "running">, IconName> = {
  pending: "gear",
  done: "check",
  denied: "ban",
  error: "x",
};

function toolStatusIcon(status: ToolCallRecord["status"]): IconName {
  return status === "running" ? "gear" : STATUS_ICONS[status];
}

/**
 * A VS Code-style tool-call card: icon + one-line summary, collapsible
 * arguments/output, and inline Approve/Deny for pending mutating calls
 * (replaces the old window.confirm popup).
 */
export function ToolCallCard({ call, live, onApprove, onDeny }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const mutating = isMutatingTool(call.name);
  const showApproval = call.status === "pending" && mutating && live;
  const hasDetail = Boolean(call.args || call.output);
  const previewHref = call.name === "start_app_preview"
    ? call.output?.match(/\]\((\/?\?tab=project&preview=[a-f0-9-]{36})\)/i)?.[1]
    : undefined;

  return (
    <div className={`tool-card tool-card-${call.status}`}>
      <button
        className="tool-card-head"
        type="button"
        onClick={() => hasDetail && setExpanded((open) => !open)}
        disabled={!hasDetail}
        aria-expanded={expanded}
      >
        <span className="tool-card-icon" aria-hidden>
          {call.status === "running" ? (
            <span className="tool-card-spinner" />
          ) : (
            <Icon name={toolStatusIcon(call.status)} size={15} />
          )}
        </span>
        <span className="tool-card-name">{call.name}</span>
        <span className="tool-card-summary">{call.summary}</span>
        <span className={`tool-card-status tool-card-status-${call.status}`}>{STATUS_LABEL[call.status]}</span>
        {hasDetail ? (
          <span className="tool-card-chevron">
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
          </span>
        ) : null}
      </button>

      {showApproval && (
        <div className="tool-card-actions">
          <span className="tool-card-actions-label">Allow this action?</span>
          <button className="btn small" type="button" onClick={() => onApprove?.(call.id)}>
            Approve
          </button>
          <button className="btn secondary small" type="button" onClick={() => onDeny?.(call.id)}>
            Deny
          </button>
        </div>
      )}

      {previewHref && call.status === "done" && (
          <a className="tool-card-preview-link" href={previewHref}>
          <Icon name="play" size={14} /> Open live preview
        </a>
      )}

      {expanded && (
        <div className="tool-card-detail">
          {call.args ? (
            <details className="tool-card-section" open={false}>
              <summary>Arguments</summary>
              <pre className="tool-card-pre">{call.args}</pre>
            </details>
          ) : null}
          {call.output ? (
            <details className="tool-card-section" open={call.status === "error"}>
              <summary>Output</summary>
              <pre className="tool-card-pre">{call.output}</pre>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
