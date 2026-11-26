import assert from "node:assert/strict";
import test from "node:test";
import { DOCUMENT_TOOLS } from "./documentTools.ts";

test("Canvas office creation tool describes the supported spreadsheet and slide models", () => {
  const tool = DOCUMENT_TOOLS.find((item) => item.name === "create_canvas_office");
  assert.ok(tool);
  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /"kind":\{"type":"string","enum":\["spreadsheet","slides"\]\}/);
  assert.match(schema, /"required":\["chat_id","title","kind","content","placement"\]/);
  assert.match(tool.description, /A1:\{value\}/);
  assert.match(tool.description, /slide deck \{version:1,width/);
});
