import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removePlanSubtask } from "./jobPlan.ts";

describe("removePlanSubtask", () => {
  it("reindexes surviving dependencies and removes links to the deleted worker", () => {
    const plan = {
      summary: "Build and test",
      subtasks: [
        { title: "Build module", instructions: "build", depends_on: [] },
        { title: "Test module", instructions: "test", depends_on: [0] },
        { title: "Package", instructions: "package", depends_on: [0, 1] },
      ],
    };

    assert.deepEqual(removePlanSubtask(plan, 0).subtasks, [
      { title: "Test module", instructions: "test", depends_on: [] },
      { title: "Package", instructions: "package", depends_on: [0] },
    ]);
  });
});