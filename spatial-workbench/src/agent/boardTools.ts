import type { HermesToolSchema } from "./hermesClient";
import { FILE_TOOLS } from "./fileTools";
import { HTML_TOOLS } from "./htmlTools";
import { WEB_TOOLS } from "./webTools";
import { WIKI_TOOLS } from "./wikiTools";
import { APP_PREVIEW_TOOLS } from "./appPreviewTools";

export const BOARD_TOOLS: HermesToolSchema[] = [
  {
    name: "fetch_canvas_layout",
    description:
      "Read the current Excalidraw Spatial Board as a compact, model-readable manifest of labeled nodes (id, type, text, x, y, width, height). Use this to see what is on the board before editing.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_board_full",
    description:
      "Read the full raw Excalidraw element JSON for the Spatial Board (every element with all fields). Use this when you need exact element ids or full element details to update or delete specific elements.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "add_board_node",
    description:
      "Add a labeled rectangle, ellipse, diamond, or text node to the Spatial Board. The board is stored server-side and the browser syncs it automatically.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "text"] },
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["text"],
    },
  },
  {
    name: "add_board_arrow",
    description: "Add a labeled arrow relationship to the Spatial Board.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  },
  {
    name: "set_board_layout",
    description:
      "Replace the entire Spatial Board with a full list of Excalidraw elements in one call. Use this to lay out a whole diagram at once instead of adding elements one by one. Each element needs at least an id, type, x, y, width, height; text elements also need text. The browser syncs the result automatically.",
    parameters: {
      type: "object",
      properties: {
        elements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              text: { type: "string" },
            },
          },
        },
      },
      required: ["elements"],
    },
  },
  {
    name: "update_board_element",
    description:
      "Update an existing Spatial Board element by id (move, resize, relabel, recolor). Pass the element id plus any fields to change; unchanged fields are preserved. The browser syncs the result automatically.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        text: { type: "string" },
        strokeColor: { type: "string" },
        backgroundColor: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_board_element",
    description: "Delete a Spatial Board element by id. The browser syncs the result automatically.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "clear_spatial_board",
    description: "Clear all elements from the Spatial Board.",
    parameters: { type: "object", properties: {} },
  },
];

export const LOCAL_VISUAL_TOOLS: HermesToolSchema[] = [
  ...BOARD_TOOLS,
  ...HTML_TOOLS,
  ...WEB_TOOLS,
  ...APP_PREVIEW_TOOLS,
  ...FILE_TOOLS,
  ...WIKI_TOOLS,
];
