import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./validate.mts";

const VOICES = ["aiden", "ryan", "serena", "vivian", "sohee", "ono_anna", "uncle_fu", "dylan", "eric"].map(name => `qwen_${name}`);
export function qwenPaths(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME ?? os.homedir();
  let root = env.ELPIS_READ_ALOUD_ROOT;
  if (!root) {
    try {
      const desktop = readFileSync(path.join(env.XDG_DATA_HOME ?? path.join(home, ".local/share"), "applications/read-aloud.desktop"), "utf8");
      root = desktop.match(/^X-ReadAloud-Owner=(.+)$/m)?.[1];
    } catch { /* A computer without the standalone reader keeps its existing local voice. */ }
  }
  return {
    python: env.READ_ALOUD_QWEN_PYTHON ?? path.join(home, ".local/share/rustidian/qwen-fast-venv/bin/python"),
    model: env.READ_ALOUD_QWEN_MODEL ?? path.join(home, ".local/share/rustidian/models/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
    worker: root ? path.join(root, "worker") : "",
  };
}

/** The same installed GPU model and generator as Read Aloud; no model download or CPU fallback. */
export function createReaderWorker(env: NodeJS.ProcessEnv = process.env, kokoro?: { python: string; voices: string[]; defaultVoice: string }) {
  const paths = qwenPaths(env);
  const voices = kokoro?.voices ?? VOICES;
  const defaultVoice = kokoro?.defaultVoice ?? "qwen_aiden";
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let waiting = 0;
  const jobs = new Map<string, { audio: PassThrough }>();
  function releaseWhenIdle() {
    clearTimeout(idle);
    if (!jobs.size) {
      idle = setTimeout(close, 30 * 60_000);
      idle.unref();
    }
  }
  const available = () => kokoro ? !!paths.worker && existsSync(kokoro.python) : [
    paths.python, path.join(paths.worker, "synthesis.py"), path.join(paths.model, "model.safetensors"),
    path.join(paths.model, "speech_tokenizer/model.safetensors"),
  ].every(file => existsSync(file));
  function close() {
    clearTimeout(idle);
    const running = child;
    child = null; ready = null;
    running?.kill();
    for (const job of jobs.values()) job.audio.destroy(new BridgeError("Local speech stopped.", 503));
    jobs.clear();
  }
  function start() {
    clearTimeout(idle);
    if (ready) return ready;
    const running = spawn(kokoro?.python ?? paths.python, ["-u", fileURLToPath(new URL("./qwen-worker.py", import.meta.url)), paths.worker, kokoro ? "kokoro" : "qwen"], {
      env: { ...env, READ_ALOUD_VOICE: defaultVoice, READ_ALOUD_QWEN_MODEL: paths.model, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: "2" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = running;
    running.stderr.resume();
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BridgeError("The local voice took too long to load.", 503));
        if (child === running) close();
      }, 120_000);
      let pending = "";
      running.once("error", () => { clearTimeout(timer); reject(new BridgeError("The local voice could not start.", 503)); if (child === running) close(); });
      running.once("exit", () => { clearTimeout(timer); reject(new BridgeError("The local voice stopped.", 503)); if (child === running) close(); });
      running.stdin.on("error", () => { if (child === running) close(); });
      running.stdout.on("data", (chunk: Buffer) => {
        if (child !== running) return;
        pending += chunk.toString();
        if (pending.length > 4 * 1024 * 1024) { close(); return; }
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          let message: { ready?: boolean; id?: string; audio?: string; done?: boolean; error?: string };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.ready !== undefined) {
            clearTimeout(timer);
            if (message.ready) resolve();
            else { reject(new BridgeError(message.error ?? "The local voice could not start.", 503)); close(); }
            continue;
          }
          const job = message.id ? jobs.get(message.id) : undefined;
          if (!job) continue;
          if (message.error) { job.audio.destroy(new BridgeError(message.error, 502)); jobs.delete(message.id!); }
          else if (message.done) { job.audio.end(); jobs.delete(message.id!); }
          else if (message.audio) {
            if (!job.audio.write(Buffer.from(message.audio, "base64"))) {
              running.stdout.pause();
              job.audio.once("drain", () => running.stdout.resume());
            }
          }
          releaseWhenIdle();
        }
      });
    });
    return ready;
  }
  return {
    available,
    voices: () => Promise.resolve(voices),
    defaultVoice,
    busy: () => waiting > 0 || jobs.size > 0,
    async warm() {
      if (!available()) return;
      await start();
      releaseWhenIdle();
    },
    async stream(text: string, voice: string | null, signal?: AbortSignal, speed = 1) {
      if (!text.trim() || text.length > 4000) throw new BridgeError("Read aloud takes up to 4000 characters at a time.");
      if (!available()) throw new BridgeError("Install the local GPU reader before using this voice.", 503);
      if (voice && !voices.includes(voice)) throw new BridgeError("Choose an installed voice.");
      if (signal?.aborted) throw new BridgeError("Reading was stopped.", 499);
      waiting++;
      const loading = () => { if (waiting === 1 && !jobs.size) close(); };
      signal?.addEventListener("abort", loading, { once: true });
      try { await start(); } finally { waiting--; signal?.removeEventListener("abort", loading); }
      if (signal?.aborted || !child) { if (!waiting && !jobs.size) close(); throw new BridgeError("Reading was stopped.", 499); }
      const id = randomUUID(), audio = new PassThrough();
      jobs.set(id, { audio });
      const cancel = () => {
        if (!jobs.delete(id)) return;
        child?.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
        child?.stdout.resume();
        audio.destroy(new BridgeError("Reading was stopped.", 499));
        releaseWhenIdle();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      audio.once("close", () => signal?.removeEventListener("abort", cancel));
      child.stdin.write(`${JSON.stringify({ id, text, voice: voice ?? defaultVoice, speed })}\n`);
      return audio;
    },
    close,
  };
}
