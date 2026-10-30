import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyMentionToInput,
  buildContextPrompt,
  buildFollowUps,
  filterMentionItems,
  isMutatingTool,
  parseContextChips,
  parseMentionQuery,
  summarizeToolCall,
  truncateOutput,
  type MentionItem,
} from "./toolCallSummary.ts";

test("isMutatingTool: read-only tools never need approval", () => {
  assert.equal(isMutatingTool("fetch_canvas_layout"), false);
  assert.equal(isMutatingTool("web_fetch"), false);
  assert.equal(isMutatingTool("read_html_artifact"), false);
  assert.equal(isMutatingTool("read_code_file"), false);
  assert.equal(isMutatingTool("search_wiki"), false);
  assert.equal(isMutatingTool("read_wiki_file"), false);
  assert.equal(isMutatingTool("add_board_node"), true);
  assert.equal(isMutatingTool("execute_bash_command"), true);
  assert.equal(isMutatingTool("edit_code_file"), true);
  assert.equal(isMutatingTool("delete_code_file"), true);
  assert.equal(isMutatingTool("write_wiki_file"), true);
  assert.equal(isMutatingTool("edit_wiki_file"), true);
  assert.equal(isMutatingTool("start_app_preview"), true);
  assert.equal(isMutatingTool("stop_app_preview"), true);
});

test("summarizeToolCall builds one-line summaries", () => {
  assert.equal(
    summarizeToolCall("add_board_node", { type: "rectangle", text: "Gateway", x: 10, y: 20 }),
    'add_board_node "Gateway" (rectangle) @ 10,20',
  );
  assert.equal(summarizeToolCall("web_fetch", { url: "https://example.com" }), "web_fetch \"https://example.com\"");
  assert.equal(summarizeToolCall("clear_spatial_board", {}), "clear_spatial_board");
  // Long text is truncated with an ellipsis.
  const long = "a".repeat(100);
  assert.ok(summarizeToolCall("add_board_node", { text: long }).length < 80);
});

test("truncateOutput keeps head and tail, marks the cut", () => {
  const text = "x".repeat(5000);
  const out = truncateOutput(text, 1000);
  assert.ok(out.length < 5000);
  assert.ok(out.includes("truncated"));
  assert.equal(truncateOutput("short"), "short");
});

test("buildContextPrompt renders chips; empty context is empty string", () => {
  assert.equal(buildContextPrompt([]), "");
  const prompt = buildContextPrompt([
    { kind: "board", label: "Spatial Board" },
    { kind: "file", label: "README.md", value: "/home/user/apps/README.md" },
    { kind: "web", label: "example.com", value: "https://example.com" },
  ]);
  assert.ok(prompt.includes("Attached context:"));
  assert.ok(prompt.includes("/home/user/apps/README.md"));
  assert.ok(prompt.includes("https://example.com"));
});

test("parseMentionQuery: active only for a trailing @token", () => {
  assert.deepEqual(parseMentionQuery("@bo"), { active: true, token: "bo" });
  assert.deepEqual(parseMentionQuery("check @file"), { active: true, token: "file" });
  assert.deepEqual(parseMentionQuery("@"), { active: true, token: "" });
  assert.deepEqual(parseMentionQuery("@file more"), { active: false, token: "" });
  assert.deepEqual(parseMentionQuery("no mention"), { active: false, token: "" });
  assert.deepEqual(parseMentionQuery("email@x.com"), { active: false, token: "" });
});

test("filterMentionItems matches label or kind", () => {
  const items: MentionItem[] = [
    { kind: "board", label: "Spatial Board", description: "" },
    { kind: "file", label: "README.md", description: "" },
    { kind: "web", label: "Web page", description: "" },
  ];
  assert.equal(filterMentionItems("", items).length, 3);
  assert.deepEqual(filterMentionItems("board", items).map((i) => i.kind), ["board"]);
  assert.deepEqual(filterMentionItems("file", items).map((i) => i.kind), ["file"]);
  assert.equal(filterMentionItems("zzz", items).length, 0);
});

test("applyMentionToInput replaces the trailing @token", () => {
  assert.equal(applyMentionToInput("add @bo", { kind: "board", label: "Spatial Board", description: "" }), "add @Spatial Board ");
  assert.equal(applyMentionToInput("@", { kind: "file", label: "README.md", description: "" }), "@README.md ");
});

test("parseContextChips extracts @board/@file/@web/@note tokens", () => {
  const board = parseContextChips("@board show the current layout");
  assert.deepEqual(board.chips, [{ kind: "board", label: "Spatial Board" }]);
  assert.equal(board.cleanText, "show the current layout");

  const file = parseContextChips("@file /home/user/apps/README.md fix the typo");
  assert.deepEqual(file.chips, [{ kind: "file", label: "README.md", value: "/home/user/apps/README.md" }]);
  assert.equal(file.cleanText, "fix the typo");

  const web = parseContextChips("@web https://example.com/page summarize");
  assert.deepEqual(web.chips, [{ kind: "web", label: "example.com", value: "https://example.com/page" }]);
  assert.equal(web.cleanText, "summarize");

  const note = parseContextChips("@note remember the API key is in .env");
  assert.equal(note.chips.length, 1);
  assert.equal(note.chips[0].kind, "note");
  assert.equal(note.cleanText, "");

  const mixed = parseContextChips("@board @file /a/b.ts refactor this");
  assert.equal(mixed.chips.length, 2);
  assert.equal(mixed.cleanText, "refactor this");

  const none = parseContextChips("plain message, no mentions");
  assert.deepEqual(none.chips, []);
  assert.equal(none.cleanText, "plain message, no mentions");
});

test("buildFollowUps is content-aware and bounded", () => {
  assert.deepEqual(buildFollowUps(""), []);
  const error = buildFollowUps("The build failed with an error in main.ts");
  assert.ok(error.some((s) => /root cause/i.test(s)));
  const board = buildFollowUps("I added a node to the board layout.");
  assert.ok(board.some((s) => /board/i.test(s)));
  const generic = buildFollowUps("The answer is 42.");
  assert.ok(generic.length >= 1 && generic.length <= 3);
});
