import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import {
  DEFAULT_SLIDES,
  DEFAULT_SPREADSHEET,
  columnName,
  exportPptx,
  exportXlsx,
  importPptx,
  importXlsx,
  readCellInput,
} from "./officeCanvas.ts";
import { adjustSlideGeometry } from "./officeModels.ts";

Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: XmlDomParser });

test("spreadsheet import and export preserve cell values and formulas", async () => {
  const blob = await exportXlsx(JSON.stringify(DEFAULT_SPREADSHEET));
  const imported = await importXlsx({
    name: "roundtrip.xlsx",
    size: blob.size,
    arrayBuffer: () => blob.arrayBuffer(),
  });
  assert.equal(imported.sheets[0].cells.A1.value, "Item");
  assert.equal(imported.sheets[0].cells.D2.formula, "=B2*C2");
  assert.equal(imported.sheets[0].cells.D2.result, 10);
});

test("slide import and export preserve editable text geometry", async () => {
  const edited = adjustSlideGeometry(DEFAULT_SLIDES.slides[0].elements[0], DEFAULT_SLIDES.width, DEFAULT_SLIDES.height, "move", 0.5, 0.25);
  const model = { ...DEFAULT_SLIDES, slides: [{ ...DEFAULT_SLIDES.slides[0], elements: [{ ...edited, text: "Edited title" }] }] };
  const blob = await exportPptx(JSON.stringify(model));
  const imported = await importPptx({
    name: "roundtrip.pptx",
    size: blob.size,
    arrayBuffer: () => blob.arrayBuffer(),
  });
  assert.equal(imported.slides.length, 1);
  assert.equal(imported.slides[0].elements[0].text, "Edited title");
  assert.equal(imported.slides[0].elements[0].x, edited.x);
  assert.equal(imported.slides[0].elements[0].y, edited.y);
});

test("slide text boxes move and resize within slide bounds", () => {
  const element = DEFAULT_SLIDES.slides[0].elements[0];
  const moved = adjustSlideGeometry(element, 13.333, 7.5, "move", -10, 20);
  assert.equal(moved.x, 0);
  assert.equal(moved.y, 6.3);
  const resized = adjustSlideGeometry(element, 13.333, 7.5, "resize", 20, -20);
  assert.equal(resized.w, 12.233);
  assert.equal(resized.h, 0.2);
  assert.equal(element.x, 1.1);
});

test("office import rejects invalid archives and preserves formula entry as a formula", async () => {
  await assert.rejects(() => importXlsx({
    name: "broken.xlsx",
    size: 3,
    arrayBuffer: async () => new ArrayBuffer(3),
  }), /not a supported XLSX or PPTX archive/);
  assert.deepEqual(readCellInput("=SUM(A1:A3)"), { formula: "=SUM(A1:A3)" });
  assert.deepEqual(readCellInput("12.5"), { value: 12.5 });
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
});
