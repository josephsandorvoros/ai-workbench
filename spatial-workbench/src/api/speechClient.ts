import type { SpeechVoicesResponse } from "../agent/speech";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const result = await response.json() as { message?: unknown };
    return typeof result.message === "string" ? result.message : fallback;
  } catch {
    return fallback;
  }
}

export async function transcribeSpeech(audio: Blob, signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/speech/transcriptions", {
    method: "POST",
    headers: { "Content-Type": audio.type.split(";")[0] || "audio/webm" },
    body: audio,
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Speech transcription failed"));
  const result = await response.json() as { ok?: boolean; text?: unknown };
  if (!result.ok || typeof result.text !== "string") throw new Error("Speech service returned no transcript");
  return result.text;
}

export async function fetchSpeechVoices(): Promise<SpeechVoicesResponse> {
  const response = await fetch("/api/speech/voices", { cache: "no-store" });
  if (!response.ok) throw new Error(await errorMessage(response, "Could not load speech voices"));
  const result = await response.json() as SpeechVoicesResponse;
  if (!result.ok || !Array.isArray(result.voices)) throw new Error("Speech service returned an invalid voice list");
  return result;
}

export async function synthesizeSpeech(text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/speech/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed: 1 }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Speech synthesis failed"));
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("audio/wav")) {
    throw new Error("Speech service did not return WAV audio");
  }
  const audio = await response.blob();
  if (!audio.size) throw new Error("Speech service returned empty audio");
  return audio;
}