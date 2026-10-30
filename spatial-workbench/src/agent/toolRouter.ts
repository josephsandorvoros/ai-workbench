export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  approvalRequired: boolean;
}

export interface ToolCallPolicyResult {
  allowed: boolean;
  approvalRequired: boolean;
  reason?: string;
}

export function parseHermesToolCalls(raw: unknown): ParsedToolCall[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const payload = raw as Record<string, unknown>;
  const calls = payload.tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }

  return calls
    .map((call) => {
      if (!call || typeof call !== "object") return null;
      const fn = (call as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object") return null;
      const nameValue = (fn as Record<string, unknown>).name;
      const name = typeof nameValue === "string" ? nameValue : "";
      const rawArgs = (fn as Record<string, unknown>).arguments;
      const args: Record<string, unknown> = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
      if (!name) return null;

      const policyInput: { name: string; args: Record<string, unknown>; approvalRequired: boolean } = {
        name,
        args,
        approvalRequired: false,
      };

      return {
        name,
        args,
        approvalRequired: evaluateToolCallPolicy(policyInput).approvalRequired,
      };
    })
    .filter((entry): entry is ParsedToolCall => Boolean(entry));
}

export function evaluateToolCallPolicy(call: { name: string; args: Record<string, unknown>; approvalRequired: boolean }): ToolCallPolicyResult {
  const name = call.name;
  const command = typeof call.args.command === "string" ? call.args.command : "";
  const path = typeof call.args.path === "string" ? call.args.path : "";

  if (name === "execute_bash_command") {
    const normalized = command.toLowerCase();
    const destructive = /(rm\s+-rf|git\s+push|sudo\s+|curl\s+.*\|\s*sh|chmod\s+[0-9]+\s+[0-9]+(?:\.[0-9]+)?)/i.test(normalized);
    if (destructive || normalized.includes("--force") || normalized.includes("> /dev/")) {
      return {
        allowed: false,
        approvalRequired: true,
        reason: "This shell action is destructive and requires human approval.",
      };
    }
    return {
      allowed: true,
      approvalRequired: false,
      reason: "Shell command is safe to run in the configured guardrail scope.",
    };
  }

  if (name === "write_code_file" || name === "edit_code_file") {
    const restricted = /(^|\/)(\.git|node_modules|\.venv|dist|build)\b/.test(path);
    if (restricted) {
      return {
        allowed: false,
        approvalRequired: true,
        reason: "Write target is outside the safe workspace scope and requires approval.",
      };
    }
    return {
      allowed: true,
      approvalRequired: false,
      reason: "Write target is within the approved workspace scope.",
    };
  }

  if (name === "delete_code_file") {
    return {
      allowed: true,
      approvalRequired: true,
      reason: "Deleting a file always requires human approval.",
    };
  }

  if (name === "write_wiki_file" || name === "edit_wiki_file") {
    return {
      allowed: true,
      approvalRequired: false,
      reason: "Wiki writes are scoped to the wiki root and backed up on every save.",
    };
  }

  return {
    allowed: true,
    approvalRequired: Boolean(call.approvalRequired),
    reason: "No additional guardrail blocking was required.",
  };
}
