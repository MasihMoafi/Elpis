import { createKokoro } from "./kokoro.mts";
import { createQwen } from "./qwen.mts";

/** Use the installed fast reader when present; retain the existing local backend on other computers. */
export function createLocalSpeech() {
  const qwen = createQwen(), kokoro = createKokoro();
  if (!qwen.available()) return kokoro;
  return {
    ...kokoro,
    available: qwen.available,
    voices: qwen.voices,
    defaultVoice: qwen.defaultVoice,
    format: (voice: string | null) => !voice || voice.startsWith("qwen_") ? "audio/mpeg" : "audio/wav",
    async speak(text: string, voice: string | null, signal?: AbortSignal) {
      if (voice && !voice.startsWith("qwen_")) return kokoro.speak(text, voice);
      const chunks: Buffer[] = [];
      for await (const chunk of await qwen.stream(text, voice, signal)) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    },
    canStream: (voice: string | null) => !voice || voice.startsWith("qwen_"),
    stream: qwen.stream,
    close: () => { qwen.close(); kokoro.close(); },
  };
}
