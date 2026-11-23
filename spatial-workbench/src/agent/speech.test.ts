import assert from "node:assert/strict";
import test from "node:test";
import { textForSpeech } from "./speech.ts";
import { browserSpeechChunks, startBrowserDictation, type BrowserRecognition, type BrowserRecognitionResult } from "./browserSpeech.ts";

function recognitionStub(): BrowserRecognition & { starts: number; stops: number; aborts: number } {
  return {
    continuous: false, interimResults: false, lang: "", onstart: null, onresult: null, onerror: null, onend: null,
    starts: 0, stops: 0, aborts: 0,
    start() { this.starts++; },
    stop() { this.stops++; },
    abort() { this.aborts++; },
  };
}

function result(transcript: string, isFinal = false): BrowserRecognitionResult {
  return { 0: { transcript }, length: 1, isFinal };
}

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

test("browser dictation replaces interim words without duplicating final results", () => {
  const recognition = recognitionStub();
  const transcripts: string[] = [];
  let ended: boolean | undefined;
  const session = startBrowserDictation(recognition, {
    language: "en-GB",
    onStart() {},
    onTranscript: (text) => transcripts.push(text),
    onEnd: (hasTranscript) => { ended = hasTranscript; },
    onError: assert.fail,
  });
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.lang, "en-GB");
  recognition.onresult?.({ results: [result("turn on the")] });
  recognition.onresult?.({ results: [result("turn on the lights", true), result("in the")] });
  recognition.onresult?.({ results: [result("turn on the lights", true), result("in the kitchen", true)] });
  session.stop();
  recognition.onend?.();
  assert.deepEqual(transcripts, ["turn on the", "turn on the lights in the", "turn on the lights in the kitchen"]);
  assert.equal(recognition.stops, 1);
  assert.equal(ended, true);
});

test("dictation permission errors are not replaced by a success message on end", () => {
  const recognition = recognitionStub();
  const errors: string[] = [];
  startBrowserDictation(recognition, {
    language: "en",
    onStart() {},
    onTranscript() {},
    onEnd: () => assert.fail("A failed dictation must not report a successful end"),
    onError: (message) => errors.push(message),
  });
  recognition.onerror?.({ error: "not-allowed" });
  recognition.onend?.();
  assert.match(errors[0], /permission was denied/);
});

test("aborting dictation detaches handlers so a late result cannot change a different chat", () => {
  const recognition = recognitionStub();
  const session = startBrowserDictation(recognition, {
    language: "en",
    onStart() {},
    onTranscript: assert.fail,
    onEnd: () => assert.fail("An aborted session must not report an end"),
    onError: assert.fail,
  });
  session.abort();
  recognition.onresult?.({ results: [result("late transcript")] });
  assert.equal(recognition.aborts, 1);
  assert.equal(recognition.onresult, null);
  assert.equal(recognition.onend, null);
});

test("browser spoken replies split long text without dropping words or unspaced text", () => {
  const text = "Keep this complete sentence. ".repeat(45).trim();
  const chunks = browserSpeechChunks(text);
  assert.ok(chunks.every((chunk) => chunk.length <= 240));
  assert.equal(chunks.join(" "), text);
  const unspaced = "x".repeat(650);
  assert.equal(browserSpeechChunks(unspaced).join(""), unspaced);
  assert.deepEqual(browserSpeechChunks("  "), []);
});