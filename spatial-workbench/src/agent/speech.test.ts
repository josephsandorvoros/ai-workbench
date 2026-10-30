import assert from "node:assert/strict";
import test from "node:test";
import { textForSpeech } from "./speech.ts";

test("speech text excludes code and reads markdown labels", () => {
  const result = textForSpeech("Hello **there**. `inline()` [docs](https://example.com)\n\n```ts\nprivateCode()\n```\n- Next step.");
  assert.equal(result, "Hello there. inline() docs Next step.");
  assert.ok(!result.includes("privateCode"));
  assert.ok(!result.includes("https://"));
});

test("speech text handles headings, block quotes, and empty code-only messages", () => {
  assert.equal(textForSpeech("## Summary\n> Ready to go.\n1. Start now."), "Summary Ready to go. Start now.");
  assert.equal(textForSpeech("```python\nprint('secret')\n```"), "");
});