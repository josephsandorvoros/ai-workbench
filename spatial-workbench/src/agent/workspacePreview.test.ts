import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkspaceJson, workspaceFileKind } from "./workspacePreview.ts";

test("workspace previews classify common media, JSON and supported source files", () => {
  for (const path of ["photo.PNG", "photo.jpeg", "art.svg", "image.webp", "image.avif"]) {
    assert.equal(workspaceFileKind(path), "image");
  }
  assert.equal(workspaceFileKind("dir/report.pdf"), "pdf");
  assert.equal(workspaceFileKind("sound.mp3"), "audio");
  assert.equal(workspaceFileKind("clip.webm"), "video");
  assert.equal(workspaceFileKind("config.JSON"), "json");
  assert.equal(workspaceFileKind("notes.md"), "markdown");
  assert.equal(workspaceFileKind("index.html"), "html");
  assert.equal(workspaceFileKind("archive.zip"), "binary");
  assert.equal(workspaceFileKind("Dockerfile"), "binary");
});

test("JSON formatting adds indentation without changing numeric or string tokens", () => {
  const content = '{"id":9007199254740993123,"amount":1.2300,"items":[true,{"name":"a\\nb"}]}';
  const formatted = formatWorkspaceJson(content);
  assert.match(formatted, /\n  "id": 9007199254740993123/);
  assert.match(formatted, /"amount": 1\.2300/);
  assert.match(formatted, /"name": "a\\nb"/);
  assert.equal(formatWorkspaceJson(formatted), formatted);
  assert.equal(content, '{"id":9007199254740993123,"amount":1.2300,"items":[true,{"name":"a\\nb"}]}');
});

test("invalid JSON stays intact for editing", () => {
  for (const content of ['{"unfinished":', "", '{"value":undefined}']) {
    assert.equal(formatWorkspaceJson(content), content);
  }
});