export interface SpeechVoice {
  id: string;
  label: string;
}

export interface SpeechVoicesResponse {
  ok: boolean;
  voices: SpeechVoice[];
  warning?: string;
}

export const MAX_SPEECH_RECORDING_BYTES = 8 * 1024 * 1024;

export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n[\s\S]*?```/g, " ")
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)([*_])(\S.*?)\2(?=\s|$)/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

export function recordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}