import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttachmentPrompt, isImageMime, isTextLike, MAX_INLINE_TEXT_CHARS } from "./attachments.ts";

test("isImageMime accepts common raster formats only", () => {
  assert.ok(isImageMime("image/png"));
  assert.ok(isImageMime("image/jpeg"));
  assert.ok(!isImageMime("image/svg+xml"));
  assert.ok(!isImageMime("application/pdf"));
});

test("isTextLike detects by mime or extension", () => {
  assert.ok(isTextLike("a.bin", "text/plain"));
  assert.ok(isTextLike("config.yaml", ""));
  assert.ok(isTextLike("Dockerfile", "application/octet-stream"));
  assert.ok(!isTextLike("photo.jpg", "image/jpeg"));
  assert.ok(!isTextLike("report.pdf", "application/pdf"));
});

test("buildAttachmentPrompt lists files and inlines text", () => {
  const prompt = buildAttachmentPrompt([
    { name: "notes.md", mime: "text/markdown", size: 5, path: "/workspace/uploads/x-notes.md", text: "hello" },
    { name: "shot.png", mime: "image/png", size: 9, path: "/workspace/uploads/y-shot.png", dataUrl: "data:image/png;base64,AA" },
    { name: "a.pdf", mime: "application/pdf", size: 9, path: "/workspace/uploads/z-a.pdf" },
  ]);
  assert.match(prompt, /notes\.md → \/workspace\/uploads\/x-notes\.md \(text, inlined below\)/);
  assert.match(prompt, /shot\.png .*\(image, attached inline\)/);
  assert.match(prompt, /a\.pdf .*\(binary\)/);
  assert.match(prompt, /```\nhello\n```/);
  assert.ok(!prompt.includes("data:image"));
});

test("buildAttachmentPrompt truncates long text and handles empty list", () => {
  assert.equal(buildAttachmentPrompt([]), "");
  const long = "x".repeat(MAX_INLINE_TEXT_CHARS + 10);
  const prompt = buildAttachmentPrompt([{ name: "big.txt", mime: "text/plain", size: long.length, path: "/p", text: long }]);
  assert.match(prompt, /first 100000 chars/);
  assert.ok(prompt.length < long.length + 500);
});
