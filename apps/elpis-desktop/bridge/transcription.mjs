import { spawn } from 'node:child_process';
import { BridgeError } from './client.mjs';
import { childEnv } from './tools.mjs';

const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_PCM = 120 * 16000 * 2;
const FORMATS = { 'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const LABELS = { local: 'Local WhisperType', codex: 'ChatGPT sign-in (cloud)', openrouter: 'OpenRouter (cloud)' };
const backend = config => config?.env?.WHISPERTYPE_BACKEND ?? 'openrouter';
const cancelled = () => new BridgeError('Dictation cancelled', 499);

export function transcriptionStatus(config) {
  const route = backend(config);
  if (!config || config.enabled === false || typeof config.command !== 'string' || !config.command || config.url || !LABELS[route]) {
    return { available: false, reason: 'Enable a supported WhisperType stdio server in Settings → MCP.' };
  }
  return { available: true, backend: route, label: LABELS[route] };
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

/** Reuse the configured MCP command without creating/resuming a conversation or running its hotkey engine. */
export function transcribeMcp(config, audio, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const child = spawn(config.command, config.args ?? [], { cwd: config.cwd || undefined,
      env: childEnv({ ...process.env, ...config.env }), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
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
            audio_base64: audio.toString('base64'), backend: backend(config), refine_prompt: false, language: 'auto',
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

export function createTranscription({ definition, normalize = normalizeAudio, transcribe = transcribeMcp }) {
  let active = false;
  return async (request, response, json) => {
    const config = await definition(); const status = transcriptionStatus(config);
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
      const text = await transcribe(config, audio, controller.signal);
      if (!controller.signal.aborted) json(response, 200, { text });
    } finally {
      active = false; request.removeListener('aborted', abort); response.removeListener('close', abort);
    }
  };
}
