import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateToolCallPolicy, parseHermesToolCalls } from "./toolRouter.ts";

describe("parseHermesToolCalls", () => {
  it("parses tool calls from a Hermes payload", () => {
    const calls = parseHermesToolCalls({
      tool_calls: [
        {
          function: {
            name: "read_code_file",
            arguments: { path: "/workspace/src/App.tsx" },
          },
        },
      ],
    });

    assert.deepEqual(calls, [
      {
        name: "read_code_file",
        args: { path: "/workspace/src/App.tsx" },
        approvalRequired: false,
      },
    ]);
  });

  it("blocks destructive shell actions before approval", () => {
    const decision = evaluateToolCallPolicy({
      name: "execute_bash_command",
      args: { command: "rm -rf /tmp/thing && git push --force origin main" },
      approvalRequired: false,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.approvalRequired, true);
    assert.match(decision.reason ?? "", /destructive|approval/i);
  });

  it("guards edit_code_file the same way as write_code_file", () => {
    const blocked = evaluateToolCallPolicy({
      name: "edit_code_file",
      args: { path: "node_modules/react/index.js" },
      approvalRequired: false,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.approvalRequired, true);

    const allowed = evaluateToolCallPolicy({
      name: "edit_code_file",
      args: { path: "src/App.tsx" },
      approvalRequired: false,
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.approvalRequired, false);
  });

  it("always requires approval to delete a file", () => {
    const decision = evaluateToolCallPolicy({
      name: "delete_code_file",
      args: { path: "src/App.tsx" },
      approvalRequired: false,
    });

    assert.equal(decision.approvalRequired, true);
  });
});
