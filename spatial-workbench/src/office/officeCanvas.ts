import ExcelJS from "exceljs";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { DEFAULT_SLIDES } from "./officeModels.ts";
import type { OfficeCell, OfficeCellValue, SlideModel, SlidesModel, SlideElement, SpreadsheetModel } from "./officeModels.ts";
export { DEFAULT_SLIDES, DEFAULT_SPREADSHEET } from "./officeModels.ts";
export type { OfficeCell, OfficeCellValue, SlidesModel, SlideElement, SpreadsheetModel, SpreadsheetSheet } from "./officeModels.ts";

export const MAX_OFFICE_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_OFFICE_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_SHEETS = 50;
const MAX_SHEET_CELLS = 20_000;
const MAX_SLIDES = 100;
const MAX_SLIDE_ELEMENTS = 100;
const EMU_PER_INCH = 914_400;
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELATION_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type OfficeFile = Pick<File, "name" | "size" | "arrayBuffer">;

function assertArchiveSize(data: ArrayBuffer) {
  if (data.byteLength > MAX_OFFICE_ARCHIVE_BYTES) {
    throw new Error("This office file is larger than the 10 MB import limit.");
  }
  if (data.byteLength < 22) throw new Error("This file is not a supported XLSX or PPTX archive.");
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("This file is not a supported XLSX or PPTX archive.");
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  let offset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
    throw new Error("ZIP64 office files are not supported for import.");
  }
  if (entryCount > 5000 || offset + directorySize > bytes.length) {
    throw new Error("This office file has an invalid or oversized ZIP directory.");
  }
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("This office file has a damaged ZIP directory.");
    }
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (uncompressedSize === 0xffffffff) throw new Error("ZIP64 office files are not supported for import.");
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_OFFICE_EXPANDED_BYTES) {
      throw new Error("This office file expands beyond the 20 MB import safety limit.");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset > view.getUint32(endOffset + 16, true) + directorySize) {
    throw new Error("This office file has a damaged ZIP directory.");
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function safeCellValue(value: unknown): OfficeCellValue {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (value instanceof Date) return value.toISOString();
  const object = objectValue(value);
  if (!object) return String(value);
  if (Array.isArray(object.richText)) {
    return object.richText
      .map((part) => objectValue(part)?.text)
      .filter((part): part is string => typeof part === "string")
      .join("");
  }
  if (typeof object.text === "string") return object.text;
  if (typeof object.error === "string") return object.error;
  if (typeof object.hyperlink === "string") return object.hyperlink;
  return "";
}

export function parseSpreadsheetModel(content: string): SpreadsheetModel {
  const model = JSON.parse(content) as SpreadsheetModel;
  if (!model || model.version !== 1 || !Array.isArray(model.sheets) || model.sheets.length === 0 || model.sheets.length > MAX_SHEETS) {
    throw new Error("Spreadsheet data must contain 1–50 sheets in Canvas format.");
  }
  return model;
}

export function parseSlidesModel(content: string): SlidesModel {
  const model = JSON.parse(content) as SlidesModel;
  if (!model || model.version !== 1 || !Array.isArray(model.slides) || model.slides.length === 0 || model.slides.length > MAX_SLIDES) {
    throw new Error("Presentation data must contain 1–100 slides in Canvas format.");
  }
  return model;
}

export async function importXlsx(file: OfficeFile): Promise<SpreadsheetModel> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Choose an .xlsx workbook.");
  if (file.size > MAX_OFFICE_ARCHIVE_BYTES) throw new Error("This office file is larger than the 10 MB import limit.");
  const data = await file.arrayBuffer();
  assertArchiveSize(data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  if (workbook.worksheets.length === 0 || workbook.worksheets.length > MAX_SHEETS) {
    throw new Error("This workbook must contain between 1 and 50 sheets.");
  }
  let totalCells = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    const cells: Record<string, OfficeCell> = {};
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.number > 100_000) throw new Error("This workbook has rows beyond the 100,000-row import limit.");
      row.eachCell({ includeEmpty: false }, (cell) => {
        const raw = objectValue(cell.value);
        const formula = typeof raw?.formula === "string" ? raw.formula : typeof raw?.sharedFormula === "string" ? raw.sharedFormula : "";
        const result = raw && "result" in raw ? safeCellValue(raw.result) : null;
        const value = formula ? undefined : safeCellValue(cell.value);
        if (formula || (value !== null && value !== "")) {
          totalCells += 1;
          if (totalCells > MAX_SHEET_CELLS) {
            throw new Error("This workbook contains more than 20,000 populated cells. Reduce it before importing.");
          }
          cells[cell.address] = formula
            ? { formula: `=${formula.replace(/^=/, "")}`, ...(result !== null && result !== undefined ? { result } : {}) }
            : { value };
        }
      });
    });
    return { name: worksheet.name, cells };
  });
  return { version: 1, sheets };
}

export async function exportXlsx(content: string): Promise<Blob> {
  const model = parseSpreadsheetModel(content);
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const sheet of model.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31) || "Sheet");
    for (const [address, cell] of Object.entries(sheet.cells)) {
      if (cell.formula) {
        worksheet.getCell(address).value = {
          formula: cell.formula.replace(/^=/, ""),
          ...(cell.result !== undefined && cell.result !== null ? { result: cell.result } : {}),
        };
      } else {
        worksheet.getCell(address).value = cell.value ?? null;
      }
    }
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function parseXml(xml: string, label: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`The ${label} XML uses unsupported document declarations.`);
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length) {
    throw new Error(`The ${label} XML in this presentation is invalid.`);
  }
  return parsed;
}

function normalizedSlidePath(target: string): string | null {
  const path = target.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path.slice(1) : `ppt/${path}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const result = parts.join("/");
  return /^ppt\/slides\/slide\d+\.xml$/.test(result) ? result : null;
}

function colorFromNode(node: Element | null): string | undefined {
  if (!node) return undefined;
  const color = node.getElementsByTagNameNS(DRAWING_NS, "srgbClr").item(0)?.getAttribute("val");
  return color && /^[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : undefined;
}

function uniqueId(preferred: string, seen: Set<string>): string {
  if (preferred && !seen.has(preferred)) {
    seen.add(preferred);
    return preferred;
  }
  let suffix = seen.size + 1;
  while (seen.has(`shape-${suffix}`)) suffix += 1;
  const id = `shape-${suffix}`;
  seen.add(id);
  return id;
}

export async function importPptx(file: OfficeFile): Promise<SlidesModel> {
  if (!file.name.toLowerCase().endsWith(".pptx")) throw new Error("Choose a .pptx presentation.");
  if (file.size > MAX_OFFICE_ARCHIVE_BYTES) throw new Error("This office file is larger than the 10 MB import limit.");
  const data = await file.arrayBuffer();
  assertArchiveSize(data);
  const zip = await JSZip.loadAsync(data);
  const presentationEntry = zip.file("ppt/presentation.xml");
  const relationshipsEntry = zip.file("ppt/_rels/presentation.xml.rels");
  if (!presentationEntry || !relationshipsEntry) throw new Error("This file is missing PowerPoint presentation data.");
  const presentation = parseXml(await presentationEntry.async("string"), "presentation");
  const relationships = parseXml(await relationshipsEntry.async("string"), "presentation relationship");
  const relationshipTargets = new Map<string, string>();
  for (const relationship of Array.from(relationships.getElementsByTagNameNS("*", "Relationship"))) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id && target) relationshipTargets.set(id, target);
  }
  const slideIds = Array.from(presentation.getElementsByTagNameNS(PRESENTATION_NS, "sldId"));
  if (slideIds.length === 0 || slideIds.length > MAX_SLIDES) throw new Error("This presentation must contain between 1 and 100 slides.");
  const sizeNode = presentation.getElementsByTagNameNS(PRESENTATION_NS, "sldSz").item(0);
  const width = Number(sizeNode?.getAttribute("cx")) / EMU_PER_INCH;
  const height = Number(sizeNode?.getAttribute("cy")) / EMU_PER_INCH;
  const slideWidth = Number.isFinite(width) && width > 0 && width <= 30 ? width : DEFAULT_SLIDES.width;
  const slideHeight = Number.isFinite(height) && height > 0 && height <= 30 ? height : DEFAULT_SLIDES.height;
  const slides: SlideModel[] = [];
  for (const slideId of slideIds) {
    const relationshipId = slideId.getAttributeNS(RELATION_NS, "id");
    const target = relationshipId ? relationshipTargets.get(relationshipId) : undefined;
    const path = target ? normalizedSlidePath(target) : null;
    const entry = path ? zip.file(path) : null;
    if (!entry) throw new Error("A slide referenced by this presentation could not be read.");
    const slideXml = parseXml(await entry.async("string"), "slide");
    const shapes = Array.from(slideXml.getElementsByTagNameNS(PRESENTATION_NS, "sp"));
    if (shapes.length > MAX_SLIDE_ELEMENTS) throw new Error("A slide contains more than 100 text shapes.");
    const seenIds = new Set<string>();
    const elements: SlideElement[] = [];
    for (const shape of shapes) {
      const paragraphs = Array.from(shape.getElementsByTagNameNS(DRAWING_NS, "p"));
      const text = paragraphs
        .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS(DRAWING_NS, "t")).map((run) => run.textContent ?? "").join(""))
        .filter(Boolean)
        .join("\n")
        .slice(0, 5000);
      if (!text) continue;
      const transform = shape.getElementsByTagNameNS(DRAWING_NS, "xfrm").item(0);
      const offset = transform?.getElementsByTagNameNS(DRAWING_NS, "off").item(0);
      const extent = transform?.getElementsByTagNameNS(DRAWING_NS, "ext").item(0);
      const x = Number(offset?.getAttribute("x")) / EMU_PER_INCH;
      const y = Number(offset?.getAttribute("y")) / EMU_PER_INCH;
      const w = Number(extent?.getAttribute("cx")) / EMU_PER_INCH;
      const h = Number(extent?.getAttribute("cy")) / EMU_PER_INCH;
      const safeX = Number.isFinite(x) ? Math.min(Math.max(0, x), slideWidth - 0.1) : 0.6;
      const safeY = Number.isFinite(y) ? Math.min(Math.max(0, y), slideHeight - 0.1) : 0.6;
      const safeW = Number.isFinite(w) ? Math.max(0.1, Math.min(w, slideWidth - safeX)) : Math.min(5, slideWidth - safeX);
      const safeH = Number.isFinite(h) ? Math.max(0.1, Math.min(h, slideHeight - safeY)) : 0.8;
      const styleNode = shape.getElementsByTagNameNS(DRAWING_NS, "rPr").item(0)
        ?? shape.getElementsByTagNameNS(DRAWING_NS, "defRPr").item(0);
      const fontSizeAttribute = styleNode?.getAttribute("sz");
      const fontSize = fontSizeAttribute ? Number(fontSizeAttribute) / 100 : 20;
      const alignment = shape.getElementsByTagNameNS(DRAWING_NS, "pPr").item(0)?.getAttribute("algn");
      const rawId = shape.getElementsByTagNameNS(PRESENTATION_NS, "cNvPr").item(0)?.getAttribute("id") ?? "";
      const rawName = shape.getElementsByTagNameNS(PRESENTATION_NS, "cNvPr").item(0)?.getAttribute("name") ?? "";
      const fill = colorFromNode(shape.getElementsByTagNameNS(PRESENTATION_NS, "spPr").item(0));
      elements.push({
        id: uniqueId(rawName || rawId, seenIds),
        text,
        x: safeX,
        y: safeY,
        w: safeW,
        h: safeH,
        fontSize: Number.isFinite(fontSize) ? Math.max(8, Math.min(96, fontSize)) : 20,
        color: colorFromNode(styleNode) ?? "18242B",
        bold: styleNode?.getAttribute("b") === "1",
        align: alignment === "ctr" ? "center" : alignment === "r" ? "right" : "left",
        ...(fill ? { fill } : {}),
      });
    }
    slides.push({ background: "FFFFFF", elements });
  }
  return { version: 1, width: slideWidth, height: slideHeight, slides };
}

export async function exportPptx(content: string): Promise<Blob> {
  const model = parseSlidesModel(content);
  const presentation = new pptxgen();
  presentation.defineLayout({ name: "CANVAS_CUSTOM", width: model.width, height: model.height });
  presentation.layout = "CANVAS_CUSTOM";
  presentation.author = "AI Workbench";
  for (const item of model.slides) {
    const slide = presentation.addSlide();
    slide.background = { color: item.background };
    for (const element of item.elements) {
      slide.addText(element.text, {
        x: element.x,
        y: element.y,
        w: element.w,
        h: element.h,
        fontFace: "Arial",
        fontSize: element.fontSize,
        color: element.color,
        bold: element.bold,
        align: element.align,
        valign: "middle",
        margin: 0.08,
        breakLine: false,
        ...(element.fill ? { fill: { color: element.fill } } : {}),
      });
    }
  }
  const output = await presentation.write({ outputType: "blob" });
  if (!(output instanceof Blob)) throw new Error("PowerPoint export did not produce a downloadable file.");
  return output;
}

export function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function cellAddress(row: number, column: number): string {
  return `${columnName(column)}${row + 1}`;
}

export function readCellInput(input: string): OfficeCell {
  if (input.startsWith("=")) return { formula: input };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(input.trim())) return { value: Number(input) };
  return { value: input };
}
