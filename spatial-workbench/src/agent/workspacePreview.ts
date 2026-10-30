import { applyEdits, format } from "jsonc-parser";

export type WorkspaceFileKind = "text" | "html" | "markdown" | "json" | "image" | "pdf" | "audio" | "video" | "binary";
export const WORKSPACE_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export function workspaceFileKind(path: string): WorkspaceFileKind {
  const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
  if (extension === "json") return "json";
  if (["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extension)) return "audio";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["c", "cc", "cpp", "css", "go", "html", "htm", "java", "js", "jsx", "md", "markdown", "py", "rs", "sh", "sql", "toml", "ts", "tsx", "txt", "yaml", "yml"].includes(extension)) return "text";
  return "binary";
}

export function formatWorkspaceJson(content: string): string {
  try {
    JSON.parse(content);
    return applyEdits(content, format(content, undefined, { tabSize: 2, insertSpaces: true, eol: "\n" }));
  } catch {
    return content;
  }
}