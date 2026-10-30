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