import { spawn } from 'node:child_process';
import { BridgeError } from './client.mjs';
import { childEnv } from './tools.mjs';

const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_PCM = 120 * 16000 * 2;
const FORMATS = { 'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const LABELS = { local: 'Local WhisperType', codex: 'ChatGPT sign-in (cloud)', openrouter: 'OpenRouter (cloud)' };
/** Google's Gemini API, called directly with the key Elpis already holds for Google Gemini chats. `gemini-flash-latest` is
 * Google's own alias for its current Flash model, so no model name goes stale here. */
const GEMINI = { api: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-latest', label: 'Gemini API (cloud)' };
const GEMINI_PROMPT = 'Transcribe this audio recording verbatim, in the language spoken. Reply with the transcript only: no preface, notes, labels or quotation marks.';
/** The providers that bring a transcriber Elpis can reach, and the WhisperType backend that calls it: a ChatGPT chat uses
 * the ChatGPT sign-in, an OpenRouter chat OpenRouter's model from Settings → Voice. A Google Gemini chat calls the Gemini API
 * itself (see transcriptionStatus). Anthropic (API, credits, Claude subscription) has no speech-to-text, and Antigravity gives
 * Elpis no credential it can call; those chats use Settings → Voice's fallback. */
const OWN = { openai: 'codex', openrouter: 'openrouter' };
/** An explicit choice in Settings → Voice always stands. Otherwise the fallback is never a paid one: the ChatGPT sign-in
 * while Elpis is signed in to ChatGPT, else the local model. */
const fallback = (config, env = {}) => config?.env?.WHISPERTYPE_BACKEND ?? (env.chatgpt ? 'codex' : 'local');
/** WhisperType's own environment is the source of the OpenRouter model, as in transcribeMcp's merge below. */
const cloudModel = config => [config?.env?.WHISPERTYPE_CLOUD_MODEL, process.env.WHISPERTYPE_CLOUD_MODEL].find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
const cancelled = () => new BridgeError('Dictation cancelled', 499);

/** The transcriber for a chat on `provider`: its own where it has one, else the fallback chosen in Settings → Voice.
 * `env` is what only the bridge may know: `chatgpt` (Elpis is signed in to ChatGPT) and `geminiKey`. It is never returned. */
export function transcriptionStatus(config, provider, env = {}) {
  if (provider === 'google-gemini' && env.geminiKey) return { available: true, backend: 'gemini', label: `${GEMINI.label} · ${GEMINI.model}`, source: 'provider' };
  if (!config || config.enabled === false || typeof config.command !== 'string' || !config.command || config.url) {
    return { available: false, reason: 'Enable a supported WhisperType stdio server in Settings → MCP.' };
  }
  // WHISPERTYPE_EVERY_CHAT=1: the Settings → Voice engine for every chat, so voice is the same model everywhere.
  const own = config.env?.WHISPERTYPE_EVERY_CHAT !== '1' && typeof provider === 'string' && Object.hasOwn(OWN, provider);
  const route = own ? OWN[provider] : fallback(config, env);
  if (!LABELS[route]) return { available: false, reason: 'Choose a transcription engine in Settings → Voice.' };
  const source = own ? 'provider' : 'fallback';
  if (route !== 'openrouter') return { available: true, backend: route, label: LABELS[route], source };
  const model = cloudModel(config);
  return model ? { available: true, backend: route, label: `${LABELS[route]} · ${model}`, source } : { available: false, reason: 'Set the OpenRouter transcription model in Settings → Voice.' };
}

/** These processes belong only to this dictation request, including WhisperType's whisper-cli child. */
function stop(child) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch { /* Already exited. */ }
}

export function normalizeAudio(audio, mime, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const format = FORMATS[mime];
    if (!format) return reject(new BridgeError('Unsupported audio format', 415));
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-f', format,
      '-i', 'pipe:0', '-t', '121', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const chunks = []; let length = 0; let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); stop(child);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new BridgeError('Audio processing timed out. Try a shorter recording.', 504)), 30000);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new BridgeError('Audio processing needs ffmpeg installed locally.', 503)));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_PCM) finish(new BridgeError('Record at most two minutes of audio', 413)); else chunks.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0 || !length) return finish(new BridgeError('The recording could not be read. Try recording again.', 422));
      const pcm = Buffer.concat(chunks); const header = Buffer.alloc(44);
      header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
      header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
      finish(null, Buffer.concat([header, pcm]));
    });
    child.stdin.end(audio);
  });
}

/** Reuse the configured MCP command without creating/resuming a conversation or running its hotkey engine. The codex route
 * reads the ChatGPT sign-in in `home`, the Elpis home (same auth.json as Codex's), unless the server's own env sets CODEX_HOME. */
export function transcribeMcp(config, audio, signal, route = fallback(config), home = null) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const child = spawn(config.command, config.args ?? [], { cwd: config.cwd || undefined,
      env: childEnv({ ...process.env, ...(route === 'codex' && home ? { CODEX_HOME: home } : {}), ...config.env }), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8');
    let pending = ''; let size = 0; let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); stop(child);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new BridgeError('WhisperType timed out. Try a shorter recording.', 504)), 180000);
    signal.addEventListener('abort', abort, { once: true });
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    child.on('error', () => finish(new BridgeError('WhisperType could not start. Check its MCP command.', 503)));
    child.on('exit', () => finish(new BridgeError('WhisperType stopped before returning a transcript.', 502)));
    child.stdin.on('error', () => finish(new BridgeError('WhisperType connection closed.', 502)));
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) return finish(new BridgeError('WhisperType returned too much output.', 502));
      pending += chunk; let newline;
      while (!done && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); let message;
        try { message = JSON.parse(line); } catch { return finish(new BridgeError('WhisperType returned unreadable output.', 502)); }
        if (message.error) return finish(new BridgeError('WhisperType rejected transcription. Check its backend and model in Settings → MCP.', 502));
        if (message.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: 'transcribe_audio', arguments: {
            audio_base64: audio.toString('base64'), backend: route, refine_prompt: false, language: 'auto',
          } } });
        } else if (message.id === 2) {
          try {
            const result = message.result;
            const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
            if (result.isError || value.success !== true || typeof value.text !== 'string') throw new Error();
            finish(null, value.text.trim());
          } catch { finish(new BridgeError('WhisperType could not transcribe this recording. Check the selected backend, credentials and model.', 502)); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Elpis dictation', version: '0.1.0' } } });
  });
}

/** One Gemini API call with the audio inline (16 kHz mono WAV, at most two minutes, far under the 20 MB inline limit).
 * Errors never include the key or Google's message. */
export async function transcribeGemini(key, audio, signal, { api = GEMINI.api, fetchImpl = fetch } = {}) {
  if (signal.aborted) throw cancelled();
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: GEMINI_PROMPT }, { inline_data: { mime_type: 'audio/wav', data: audio.toString('base64') } }] }], generationConfig: { temperature: 0 } });
  let response;
  try {
    response = await fetchImpl(`${api}/models/${GEMINI.model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
  } catch { if (signal.aborted) throw cancelled(); throw new BridgeError('Gemini could not be reached. Check the connection and try again.', 502); }
  let raw;
  try { raw = await response.text(); } catch { if (signal.aborted) throw cancelled(); throw new BridgeError('Gemini could not be reached. Check the connection and try again.', 502); }
  let value = null; try { value = JSON.parse(raw.slice(0, 1024 * 1024)); } catch { /* Reported below, by status first. */ }
  if (!response.ok) {
    const invalidKey = [401, 403].includes(response.status) || value?.error?.details?.some?.(detail => detail?.reason === 'API_KEY_INVALID');
    if (invalidKey) throw new BridgeError('Gemini rejected the API key. Check it in Settings → Models & accounts.', 502);
    if (response.status === 429) throw new BridgeError('Gemini is rate limiting requests. Try again shortly.', 502);
    throw new BridgeError(`Gemini transcription failed (HTTP ${response.status}).`, 502);
  }
  if (value === null || typeof value !== 'object') throw new BridgeError('Gemini returned unreadable output.', 502);
  const parts = value.candidates?.[0]?.content?.parts;
  const text = (Array.isArray(parts) ? parts : []).filter(part => typeof part?.text === 'string' && part.thought !== true).map(part => part.text).join('').trim();
  if (!text) throw new BridgeError('Gemini returned no transcript. Try recording again.', 502);
  return text;
}

export function createTranscription({ definition, environment = async () => ({}), normalize = normalizeAudio, transcribe = transcribeMcp, gemini = transcribeGemini }) {
  let active = false;
  return async (request, response, json) => {
    const config = await definition();
    const env = await environment().catch(() => ({})); // a failed read only means no ChatGPT sign-in or Gemini key is known
    const status = transcriptionStatus(config, new URL(request.url ?? '/', 'http://local').searchParams.get('provider') ?? undefined, env);
    if (request.method === 'GET') return json(response, 200, status);
    if (!status.available) throw new BridgeError(status.reason, 503);
    if (request.headers['x-elpis-transcription-backend'] !== status.backend) throw new BridgeError('The transcription provider changed. Reload the chat before recording again.', 409);
    if (active) throw new BridgeError('A recording is already being transcribed. Wait or cancel it.', 409);
    const mime = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!FORMATS[mime]) throw new BridgeError('Send a supported audio recording', 415);
    const controller = new AbortController(); const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort); active = true;
    try {
      if (request.aborted || response.destroyed) throw cancelled();
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; if (size > MAX_AUDIO) throw new BridgeError('Audio is too large. Record at most two minutes.', 413); chunks.push(chunk);
      }
      if (!size) throw new BridgeError('The recording is empty', 422);
      const audio = await normalize(Buffer.concat(chunks), mime, controller.signal);
      const text = status.backend === 'gemini' ? await gemini(env.geminiKey, audio, controller.signal) : await transcribe(config, audio, controller.signal, status.backend, env.home);
      if (!controller.signal.aborted) json(response, 200, { text });
    } finally {
      active = false; request.removeListener('aborted', abort); response.removeListener('close', abort);
    }
  };
}
