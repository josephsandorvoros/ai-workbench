import { fetchAgentMemory, fetchAgentSkills } from "./agentData";
import type { ChatMessage } from "./chatml";
import type { AgentMode } from "./providers";
import { loadCanvasManifest } from "./canvasManifest";

const MAX_CONTEXT_CHARS = 12_000;
let sharedContextPromise: Promise<ChatMessage | null> | undefined;

function trimContext(value: string): string {
  return value.length <= MAX_CONTEXT_CHARS
    ? value
    : `${value.slice(0, MAX_CONTEXT_CHARS)}\n[Shared context truncated]`;
}

export function fetchSharedHermesContext(mode: AgentMode): Promise<ChatMessage | null> {
  if (!sharedContextPromise) {
    sharedContextPromise = Promise.allSettled([fetchAgentMemory(), fetchAgentSkills()]).then(([memory, skills]) => {
      const sections = [
        "You are assisting from AI Workbench.",
        "Use the shared Hermes context as background and follow the user's current request over stale context.",
        mode === "plan"
          ? "Execution mode: Plan. Do not perform mutations or execute tools; describe the proposed steps and wait for approval."
          : mode === "auto"
            ? "Execution mode: Auto. Execute allowed tools without asking, but never bypass safety boundaries."
            : "Execution mode: Ask. Explain proposed mutations and wait for explicit approval before executing them.",
      ];
      if (memory.status === "fulfilled" && memory.value.files.length > 0) {
        sections.push(
          "Shared memory:\n" + memory.value.files.map((file) => `### ${file.name}\n${file.content}`).join("\n\n"),
        );
      }
      if (skills.status === "fulfilled" && skills.value.skills.length > 0) {
        sections.push(
          "Available Hermes skills:\n" +
            skills.value.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
        );
      }
      const board = loadCanvasManifest();
      if (board.nodes.length > 0) {
        sections.push(`Current Spatial Board manifest:\n${JSON.stringify(board, null, 2)}`);
      }
      return { role: "system" as const, content: trimContext(sections.join("\n\n")) };
    }).catch(() => null);
  }
  return sharedContextPromise;
}