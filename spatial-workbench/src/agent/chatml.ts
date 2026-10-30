export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** data:/http(s) image URLs sent as OpenAI image_url parts alongside `content`. */
  images?: string[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export function formatChatMl(messages: ChatMessage[], options: { appendAssistantPrompt?: boolean } = {}) {
  const body = messages
    .map((message) => {
      const role = message.role.trim();
      const content = normalizeMessageContent(message.content);
      return `<|im_start|>${role}\n${content}<|im_end|>`;
    })
    .join("\n");

  if (options.appendAssistantPrompt === false) {
    return body;
  }

  return `${body}\n<|im_start|>assistant\n`;
}

function normalizeMessageContent(content: string) {
  return String(content ?? "")
    .replace(/<\|im_start\|>/g, "<|im_start| >")
    .replace(/<\|im_end\|>/g, "<|im_end| >")
    .trim();
}