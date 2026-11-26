export type OfficeCellValue = string | number | boolean | null;

export interface OfficeCell {
  value?: OfficeCellValue;
  formula?: string;
  result?: OfficeCellValue;
}

export interface SpreadsheetSheet {
  name: string;
  cells: Record<string, OfficeCell>;
}

export interface SpreadsheetModel {
  version: 1;
  sheets: SpreadsheetSheet[];
}

export interface SlideElement {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
  fill?: string;
}

export interface SlideModel {
  background: string;
  elements: SlideElement[];
}

export interface SlidesModel {
  version: 1;
  width: number;
  height: number;
  slides: SlideModel[];
}

export function adjustSlideGeometry(
  element: SlideElement,
  width: number,
  height: number,
  mode: "move" | "resize",
  dx: number,
  dy: number,
): SlideElement {
  const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000;
  if (mode === "move") {
    return { ...element, x: clamp(element.x + dx, 0, width - element.w), y: clamp(element.y + dy, 0, height - element.h) };
  }
  return {
    ...element,
    w: clamp(element.w + dx, 0.2, width - element.x),
    h: clamp(element.h + dy, 0.2, height - element.y),
  };
}

export const DEFAULT_SPREADSHEET: SpreadsheetModel = {
  version: 1,
  sheets: [{
    name: "Sheet1",
    cells: {
      A1: { value: "Item" },
      B1: { value: "Units" },
      C1: { value: "Cost" },
      D1: { value: "Total" },
      A2: { value: "Sample" },
      B2: { value: 2 },
      C2: { value: 5 },
      D2: { formula: "=B2*C2", result: 10 },
    },
  }],
};

export const DEFAULT_SLIDES: SlidesModel = {
  version: 1,
  width: 13.333,
  height: 7.5,
  slides: [{
    background: "FFFFFF",
    elements: [
      {
        id: "title",
        text: "A new presentation",
        x: 1.1,
        y: 2,
        w: 10.8,
        h: 1.2,
        fontSize: 40,
        color: "18242B",
        bold: true,
        align: "left",
      },
      {
        id: "subtitle",
        text: "Add a subtitle",
        x: 1.1,
        y: 3.35,
        w: 10.8,
        h: 0.65,
        fontSize: 20,
        color: "52606D",
        bold: false,
        align: "left",
      },
    ],
  }],
};

export function officeKindLabel(kind: "spreadsheet" | "slides"): string {
  return kind === "spreadsheet" ? "Spreadsheet" : "Slide deck";
}
