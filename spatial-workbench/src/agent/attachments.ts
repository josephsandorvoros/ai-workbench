/**
 * Chat attachments: files/images picked from the user's computer.
 *
 * Every attachment is uploaded to the companion API (WORKSPACE_ROOT/uploads)
 * so agents with file tools can open it by path. Text files are also inlined
 * into the prompt; images are sent as OpenAI-style image_url parts.
 */

export interface ChatAttachment {
  name: string;
  mime: string;
  size: number;
  /** Absolute path on the server after upload. */
  path: string;
  /** Inline text content (text-like files only, truncated). */
  text?: string;
  /** data: URL (images only) for multimodal model input + thumbnails. */
  dataUrl?: string;
}

export const MAX_INLINE_TEXT_CHARS = 100_000;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "xml", "html", "htm", "css", "scss", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash",
  "zsh", "ps1", "sql", "log", "dockerfile", "gitignore", "tf", "hcl", "lua", "swift", "vue",
]);

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime);
}

export function isTextLike(name: string, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/(json|xml|yaml|javascript|typescript|x-sh|toml|sql)/i.test(mime)) return true;
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() ?? "" : lower;
  return TEXT_EXTENSIONS.has(ext);
}

/** Prompt section describing attachments; text files are inlined in fences. */
export function buildAttachmentPrompt(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = ["Uploaded files (saved on the server; open them by path if you need more):"];
  for (const item of attachments) {
    const kind = item.dataUrl ? "image, attached inline" : item.text !== undefined ? "text, inlined below" : "binary";
    lines.push(`- ${item.name} → ${item.path} (${kind})`);
  }
  for (const item of attachments) {
    if (item.text === undefined) continue;
    const truncated = item.text.length > MAX_INLINE_TEXT_CHARS;
    const body = truncated ? item.text.slice(0, MAX_INLINE_TEXT_CHARS) : item.text;
    const fence = body.includes("```") ? "````" : "```";
    lines.push("", `${item.name}${truncated ? ` (first ${MAX_INLINE_TEXT_CHARS} chars)` : ""}:`, fence, body, fence);
  }
  return lines.join("\n");
}

function readAs(file: File, mode: "text" | "dataUrl"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    if (mode === "text") reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

/** Read a picked file, upload it, and return the attachment record. */
export async function prepareAttachment(
  file: File,
  upload: (filename: string, contentBase64: string) => Promise<{ path: string }>,
): Promise<ChatAttachment> {
  const mime = file.type || "application/octet-stream";
  const dataUrl = await readAs(file, "dataUrl");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const { path } = await upload(file.name || "pasted-file", base64);
  const attachment: ChatAttachment = { name: file.name || "pasted-file", mime, size: file.size, path };
  if (isImageMime(mime) && file.size <= MAX_INLINE_IMAGE_BYTES) {
    attachment.dataUrl = dataUrl;
  } else if (isTextLike(attachment.name, mime)) {
    attachment.text = await readAs(file, "text");
  }
  return attachment;
}
