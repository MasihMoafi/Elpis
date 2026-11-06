// Read aloud speaks with local Kokoro (SPEC 45; 6 Nov, Masih: "the read aloud option via kokoro which I even chose a favorite
// voice"): one long-lived worker keeps the model loaded, and each piece of text comes back as a WAV file.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './validate.mjs';

const home = os.homedir();
const WORKER = fileURLToPath(new URL('./kokoro-worker.py', import.meta.url));
/** Where Kokoro lives on this machine; each can be overridden by its environment variable. */
export function kokoroPaths(env = process.env) {
  return {
    python: env.ELPIS_KOKORO_PYTHON || path.join(home, '.local/share/elpis/kokoro-venv/bin/python'),
    model: env.ELPIS_KOKORO_MODEL || path.join(home, '.cache/hyperframes/tts/models/kokoro-v1.0.onnx'),
    voices: env.ELPIS_KOKORO_VOICES || path.join(home, '.cache/hyperframes/tts/voices/voices-v1.0.bin'),
  };
}

export function createKokoro({ env = process.env, spawnWorker = spawn } = {}) {
  const paths = kokoroPaths(env);
  let worker = null, ready = null, buffer = '', voiceNames = [];
  const pending = new Map();
  const available = () => [paths.python, paths.model, paths.voices].every(file => existsSync(file));
  function start() {
    if (ready) return ready;
    worker = spawnWorker(paths.python, ['-u', WORKER, paths.model, paths.voices], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...env } });
    ready = new Promise((resolve, reject) => {
      worker.once('error', error => { reject(error); });
      worker.stdout.on('data', chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.ready) { voiceNames = Array.isArray(message.voices) ? message.voices.filter(name => typeof name === 'string') : []; resolve(); continue; }
          const waiting = pending.get(message.id); pending.delete(message.id);
          if (waiting) message.ok ? waiting.resolve() : waiting.reject(new BridgeError('Read aloud could not voice this text.', 500));
        }
      });
    });
    worker.once('exit', () => {
      for (const waiting of pending.values()) waiting.reject(new BridgeError('Read aloud stopped. Try again.', 503));
      pending.clear(); worker = null; ready = null; buffer = ''; voiceNames = [];
    });
    return ready;
  }
  /** WAV bytes for `text`. */
  async function speak(text, voice = null) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new BridgeError('Read aloud takes up to 4000 characters at a time.', 400);
    if (!available()) throw new BridgeError('Read aloud needs Kokoro on this computer.', 503);
    await start();
    if (voice && !voiceNames.includes(voice)) throw new BridgeError('Choose an installed Kokoro voice.', 400);
    const id = randomUUID(), out = path.join(os.tmpdir(), `elpis-read-aloud-${id}.wav`);
    const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    worker.stdin.write(JSON.stringify({ id, text, out, ...(voice ? { voice } : {}) }) + '\n');
    await done;
    try { return await fs.readFile(out); } finally { await fs.rm(out, { force: true }); }
  }
  /** Loads the voice ahead of the first read, when the app asks whether it is there. */
  const warm = () => { if (available()) start().catch(() => {}); };
  const voices = async () => { if (!available()) return []; await start(); return voiceNames; };
  return { available, warm, voices, speak, defaultVoice: env.ELPIS_KOKORO_VOICE ?? 'af_heart', close: () => { worker?.kill(); } };
}
