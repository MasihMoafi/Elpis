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
    canStream: (voice: string | null) => !voice || voice.startsWith("qwen_"),
    stream: qwen.stream,
    close: () => { qwen.close(); kokoro.close(); },
  };
}
