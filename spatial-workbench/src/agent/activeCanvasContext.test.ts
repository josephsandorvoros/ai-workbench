import assert from "node:assert/strict";
import test from "node:test";
import { canvasContextPrompt } from "./activeCanvasContext.ts";

test("canvas context identifies an open document and protects unsaved work", () => {
  const prompt = canvasContextPrompt({
    space: "Documents", detail: "Notes", documentId: "doc-1", revision: 3,
    content: "Draft", dirty: true,
  });
  assert.match(prompt, /doc-1/);
  assert.match(prompt, /read_canvas_document and edit_canvas_document/);
  assert.match(prompt, /unsaved changes/);
  assert.match(prompt, /Draft/);
});

test("canvas context identifies open files and does not invent a selection", () => {
  assert.match(canvasContextPrompt({ space: "Projects", detail: "src/app.ts", content: "code" }), /src\/app\.ts/);
  assert.match(canvasContextPrompt({ space: "Terminal" }), /Only the workspace name is available/);
  assert.equal(canvasContextPrompt(null), "");
});

test("image context identifies the source and protects unsaved edits", () => {
  const prompt = canvasContextPrompt({ space: "Projects", detail: "demo/photo.png", imageFile: true, dirty: true }, "chat-1");
  assert.match(prompt, /demo\/photo\.png/);
  assert.match(prompt, /open project file is an image/);
  assert.match(prompt, /unsaved changes/);
  assert.match(prompt, /preserve originals/);
  assert.match(prompt, /Ask before sending an existing image to an external provider/);
});

test("HTML creation uses the active chat and editing targets the open Canvas item", () => {
  const prompt = canvasContextPrompt({ space: "Documents", detail: "Chart", documentId: "html-1", revision: 2, kind: "html" }, "chat-1");
  assert.match(prompt, /Canvas conversation ID: chat-1/);
  assert.match(prompt, /create_canvas_html/);
  assert.match(prompt, /not the legacy shared HTML artifact tools/);
  assert.match(canvasContextPrompt(null, "chat-1"), /create_canvas_html/);
});

test("diagram context targets the selected item rather than the shared board", () => {
  for (const kind of ["mermaid", "excalidraw"] as const) {
    const prompt = canvasContextPrompt({ space: "Documents", documentId: "diagram-1", revision: 1, kind }, "chat-1");
    assert.match(prompt, /create_canvas_diagram/);
    assert.match(prompt, /diagram-1/);
    assert.match(prompt, /do not edit the separate shared Spatial Board/);
  }
});

test("office context describes the open editable model and creation tool", () => {
  for (const kind of ["spreadsheet", "slides"] as const) {
    const prompt = canvasContextPrompt({ space: "Documents", documentId: `${kind}-1`, revision: 1, kind }, "chat-1");
    assert.match(prompt, /create_canvas_office/);
    assert.match(prompt, new RegExp(`${kind}-1`));
    assert.match(prompt, kind === "spreadsheet" ? /A1 cell addresses/ : /positions and sizes are in inches/);
  }
});
