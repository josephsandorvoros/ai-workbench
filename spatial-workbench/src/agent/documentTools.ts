import type { HermesToolSchema } from "./hermesClient";

export const DOCUMENT_TOOLS: HermesToolSchema[] = [
  {
    name: "create_canvas_diagram",
    description: "Create a separate diagram in Canvas. Use Mermaid source for mermaid, or Excalidraw JSON with an elements array for excalidraw. Ask for the location if the chat has no prior Canvas item.",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: ["mermaid", "excalidraw"] },
        content: { type: "string", description: "Complete Mermaid source or Excalidraw scene JSON. For Excalidraw elements supply unique IDs, types, x, y, width, height, and text when applicable." },
        placement: { type: "string", enum: ["inherit", "chat", "project"] },
        project: { type: "string", description: "Workspace project folder when placement is project." },
      },
      required: ["chat_id", "title", "kind", "content", "placement"],
    },
  },
  {
    name: "create_canvas_html",
    description: "Create a new interactive HTML visualization in Canvas. Use the chat ID supplied in the conversation context. Use inherit to reuse the conversation's existing location; if there is none, ask the user to choose a chat draft or project.",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        title: { type: "string" },
        html: { type: "string", description: "Complete self-contained HTML source." },
        placement: { type: "string", enum: ["inherit", "chat", "project"] },
        project: { type: "string", description: "Workspace project folder when placement is project." },
      },
      required: ["chat_id", "title", "html", "placement"],
    },
  },
  {
    name: "create_canvas_office",
    description: "Create an editable Canvas spreadsheet or slide deck. Provide complete version-1 Canvas JSON: spreadsheet {version:1,sheets:[{name,cells:{A1:{value},B2:{formula:'=SUM(A1:A1)',result}}}]}; slide deck {version:1,width:13.333,height:7.5,slides:[{background:'FFFFFF',elements:[{id,text,x,y,w,h,fontSize,color,bold,align}]}]}. Use the current conversation ID and inherit a prior Canvas location; otherwise ask where to save it.",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: ["spreadsheet", "slides"] },
        content: { type: "string", description: "Complete JSON Canvas model. Spreadsheet cell addresses use A1 notation. Slide positions and sizes are in inches." },
        placement: { type: "string", enum: ["inherit", "chat", "project"] },
        project: { type: "string", description: "Workspace project folder when placement is project." },
      },
      required: ["chat_id", "title", "kind", "content", "placement"],
    },
  },
  {
    name: "read_canvas_document",
    description: "Read a Canvas document by its ID, including its current content and revision. Read before editing.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "ID supplied in the current Canvas context." } },
      required: ["id"],
    },
  },
  {
    name: "edit_canvas_document",
    description: "Replace a Canvas item's complete content (Markdown, HTML, Mermaid, Excalidraw, spreadsheet, or slide-deck JSON). Use the revision returned by read_canvas_document; stale edits are rejected and the prior version is retained.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        revision: { type: "integer" },
        content: { type: "string", description: "Complete revised item content." },
      },
      required: ["id", "revision", "content"],
    },
  },
];
