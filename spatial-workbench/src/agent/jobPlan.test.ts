import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_LANES, jobLaneFor, removePlanSubtask, workerScreenText } from "./jobPlan.ts";

describe("workerScreenText", () => {
  it("renders the real terminal text rather than escaped event JSON", () => {
    const screen = "Should the note say ready or verified?\n1. ready\n2. verified";
    assert.equal(workerScreenText(JSON.stringify({ type: "text", part: { text: screen } })), screen);
    assert.equal(workerScreenText("Plain terminal output"), "Plain terminal output");
  });
});

describe("jobLaneFor", () => {
  it("groups all existing workflow states without losing historical jobs", () => {
    const expected = { inbox: "queue", review: "planning", planned: "planning", replanning: "planning", running: "running",
      needs_input: "attention", collating: "review", done: "finished", failed: "finished", stopped: "finished" };
    for (const [stage, lane] of Object.entries(expected)) assert.equal(jobLaneFor({ stage }), lane);
    assert.equal(JOB_LANES.length, 6);
  });
  it("surfaces paused workers even while the job remains running", () => {
    assert.equal(jobLaneFor({ stage: "running", subtasks: [{ status: "waiting_input" }] }), "attention");
    assert.equal(jobLaneFor({ stage: "new_state" }), "attention");
  });
});

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