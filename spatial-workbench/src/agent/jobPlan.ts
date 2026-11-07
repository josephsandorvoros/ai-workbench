export type Plan = {
  summary: string;
  subtasks: Array<{ title: string; instructions: string; depends_on?: number[]; profile_id?: string | null }>;
};

export type WorkerProfile = {
  id: string;
  name: string;
  instructions: string;
  runtime: string;
  model: string;
  base_url?: string | null;
  api_key_env?: string | null;
  skills: string[];
  permission_preset: "guarded" | "trusted";
  created_at: number;
  updated_at: number;
};

export const JOB_LANES = [
  { id: "queue", label: "Queue" },
  { id: "planning", label: "Planning" },
  { id: "running", label: "Running" },
  { id: "attention", label: "Needs attention" },
  { id: "review", label: "Review" },
  { id: "finished", label: "Finished" },
];

export function jobLaneFor(job: { stage: string; subtasks?: Array<{ status: string }> }): string {
  if (job.stage === "needs_input" || (job.stage === "running" && job.subtasks?.some((task) => task.status === "waiting_input"))) return "attention";
  if (job.stage === "inbox") return "queue";
  if (["review", "planned", "replanning"].includes(job.stage)) return "planning";
  if (job.stage === "running") return "running";
  if (job.stage === "collating") return "review";
  if (["done", "failed", "stopped"].includes(job.stage)) return "finished";
  return "attention";
}

export function workerScreenText(log: string): string {
  return log.split("\n").map((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { text?: string } };
      return event.type === "text" && typeof event.part?.text === "string" ? event.part.text : line;
    } catch {
      return line;
    }
  }).join("\n");
}

export function removePlanSubtask(plan: Plan, removedIndex: number): Plan {
  return {
    ...plan,
    subtasks: plan.subtasks
      .filter((_, index) => index !== removedIndex)
      .map((subtask) => ({
        ...subtask,
        depends_on: subtask.depends_on
          ?.filter((dependency) => dependency !== removedIndex)
          .map((dependency) => dependency > removedIndex ? dependency - 1 : dependency),
      })),
  };
}