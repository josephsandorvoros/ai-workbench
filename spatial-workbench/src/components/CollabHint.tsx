/**
 * Shared notice for editors that live-sync with the agent.
 *
 * While the user has unsaved edits the sync poll pauses, so agent changes are
 * not pulled in and a later save would overwrite them.
 */
export function CollabHint({ dirty, target = "this file" }: { dirty: boolean; target?: string }) {
  return (
    <p className={`collab-hint ${dirty ? "warn" : ""}`} role={dirty ? "status" : undefined}>
      {dirty
        ? `Unsaved changes — live sync is paused. Save or reload before asking the agent to edit ${target}, or your next save will overwrite its work.`
        : `Agent edits to ${target} appear here automatically. Save your own changes before asking the agent to edit.`}
    </p>
  );
}
