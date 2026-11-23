export interface BrowserRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<BrowserRecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => BrowserRecognition;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

export function browserRecognitionConstructor(scope: SpeechWindow = window): RecognitionConstructor | undefined {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function startBrowserDictation(recognition: BrowserRecognition, callbacks: {
  language: string;
  onStart: () => void;
  onTranscript: (text: string) => void;
  onEnd: (hasTranscript: boolean) => void;
  onError: (message: string) => void;
}) {
  let hasTranscript = false;
  let failed = false;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = callbacks.language;
  recognition.onstart = callbacks.onStart;
  recognition.onresult = ({ results }) => {
    const transcript = Array.from(results, (result) => result[0]?.transcript.trim() ?? "").filter(Boolean).join(" ");
    hasTranscript = Boolean(transcript);
    callbacks.onTranscript(transcript);
  };
  recognition.onerror = ({ error }) => {
    failed = true;
    const detail = error === "not-allowed" || error === "service-not-allowed"
      ? "Microphone or speech permission was denied. Allow it in your browser settings."
      : error === "no-speech"
        ? "No speech was detected. Tap Talk to try again."
        : error === "network"
          ? "The browser speech service could not connect. Check your connection or choose Speech service."
          : `Browser dictation failed (${error}). Tap Talk to retry or choose Speech service.`;
    callbacks.onError(detail);
  };
  recognition.onend = () => {
    if (!failed) callbacks.onEnd(hasTranscript);
  };
  recognition.start();
  return {
    stop: () => recognition.stop(),
    abort: () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    },
  };
}

export function browserSpeechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 240) {
    const space = remaining.lastIndexOf(" ", 240);
    const end = space > 0 ? space : 240;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
