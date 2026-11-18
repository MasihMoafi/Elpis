import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKokoro } from "./kokoro.mts";
import { createReaderWorker, qwenPaths } from "./qwen.mts";

/** Read Aloud owns the installed voice names, pronunciation models and default choice. */
function installedVoices(worker: string, env: NodeJS.ProcessEnv) {
  if (!worker || !existsSync(path.join(worker, "voices.py"))) return null;
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from voices import available_voices, selected_voice, runtime_python",
    "voices = available_voices()",
    "print(json.dumps([voices, selected_voice(voices), str(runtime_python())]))",
  ].join("\n");
  try {
    const output = execFileSync("python3", ["-I", "-c", script, worker], { env, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const [voices, selected, python] = JSON.parse(output) as [string[], string, string];
    if (!voices.includes(selected) || !existsSync(python)) return null;
    return { voices, selected, python };
  } catch { return null; }
}

export function createLocalSpeech(env: NodeJS.ProcessEnv = process.env) {
  const qwen = createReaderWorker(env), fallback = createKokoro({ env });
  const library = installedVoices(qwenPaths(env).worker, env);
  if (!library && !qwen.available()) return fallback;
  const config = path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), ".config"), "read-aloud");
  const preference = (name: string) => {
    try { return readFileSync(path.join(config, name), "utf8").trim(); } catch { return ""; }
  };
  const kokoroVoices = library?.voices.filter(voice => !voice.startsWith("qwen_")) ?? [];
  const sharedKokoro = library && kokoroVoices.length
    ? createReaderWorker(env, { python: library.python, voices: kokoroVoices, defaultVoice: kokoroVoices.includes(library.selected) ? library.selected : kokoroVoices[0]! })
    : null;
  const selected = () => {
    const saved = preference("voice");
    return library?.voices.includes(saved) ? saved : library?.selected ?? qwen.defaultVoice;
  };
  let active: typeof qwen | null = null;
  function stream(text: string, voice: string | null, signal?: AbortSignal, speed = 1) {
    const name = voice ?? selected();
    const reader = name.startsWith("qwen_") ? qwen : sharedKokoro;
    if (!reader) throw Error("The selected streaming voice is unavailable.");
    if (active && active !== reader) active.close();
    active = reader;
    return reader.stream(text, name, signal, speed);
  }
  const canStream = (voice: string | null) => (voice ?? selected()).startsWith("qwen_") ? qwen.available() : !!sharedKokoro;
  return {
    available: () => !!sharedKokoro || qwen.available(),
    voices: async () => library?.voices ?? qwen.voices(),
    get defaultVoice() { return selected(); },
    get preferredSpeed() {
      const value = Number(preference("speed"));
      return Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : 1;
    },
    nativeTempo: !!library,
    format: (voice: string | null) => canStream(voice) ? "audio/mpeg" : "audio/wav",
    async speak(text: string, voice: string | null, signal?: AbortSignal) {
      if (!canStream(voice)) return fallback.speak(text, voice);
      const chunks: Buffer[] = [];
      for await (const chunk of await stream(text, voice, signal)) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    },
    canStream, stream,
    close: () => { qwen.close(); sharedKokoro?.close(); fallback.close(); },
  };
}
