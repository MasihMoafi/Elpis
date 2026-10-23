import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { speechChunks } from './client.mjs';
import { BridgeError, object, text, threadId } from './validate.mjs';

/** One line per call in logs/voice-calls.jsonl, sent by the window when a call ends: how long, whether it connected, how many events of each kind the call
 * sent, and how much sound came in and went out. No words, no names: it exists so that "it says Listening and never answers" can be read from the machine. */
const REPORT_KEYS = ['seconds', 'listened', 'events', 'inboundBytes', 'inboundPackets', 'inboundEnergy', 'micEnergy', 'error'];
export async function recordVoiceCall(home, body) {
  object(body, REPORT_KEYS);
  const number = (value, name) => { if (!Number.isFinite(value) || value < 0 || value > 1e12) throw new BridgeError(`Invalid ${name}`); return Math.round(value * 1000) / 1000; };
  if (typeof body.listened !== 'boolean') throw new BridgeError('Invalid listened');
  if (!body.events || typeof body.events !== 'object' || Array.isArray(body.events) || Object.keys(body.events).length > 40) throw new BridgeError('Invalid events');
  const events = Object.fromEntries(Object.entries(body.events).map(([kind, count]) => { if (!/^[A-Za-z0-9_.-]{1,60}$/.test(kind)) throw new BridgeError('Invalid event kind'); return [kind, number(count, 'event count')]; }));
  const line = JSON.stringify({ at: new Date().toISOString(), seconds: number(body.seconds, 'seconds'), listened: body.listened, events, inboundBytes: number(body.inboundBytes, 'inbound bytes'), inboundPackets: number(body.inboundPackets, 'inbound packets'),
    inboundEnergy: number(body.inboundEnergy, 'inbound energy'), micEnergy: number(body.micEnergy, 'microphone energy'), error: typeof body.error === 'string' ? body.error.slice(0, 200) : '' });
  const file = path.join(home, 'logs', 'voice-calls.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let lines = []; try { lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  await fs.writeFile(file, [...lines.slice(-199), line].join('\n') + '\n', { mode: 0o600 });
  return { ok: true };
}

// All desktop windows share the engine. A call keeps its owner until native cleanup finishes.
let owner;
export function createVoice(client) {
  let call;
  async function close() { if (call) await call.stop(); }
  async function start(input, response, { readAloud = false, source } = {}) {
    readAloud ||= !!source;
    object(input, source ? ['sdp'] : readAloud ? ['threadId', 'sdp', 'text'] : ['threadId', 'sdp']);
    const chatId = threadId(source?.threadId ?? input.threadId);
    text(input.sdp, 'voice offer', 64000);
    if (readAloud && !source) text(input.text, 'speech text', 2_000_000);
    if (!input.sdp.startsWith('v=0\r\n') || !input.sdp.includes('\n')) throw new BridgeError('Invalid voice offer');
    if (readAloud) {
      const audio = input.sdp.split(/\r?\nm=/).filter(section => section.startsWith('audio '));
      // The window sends generated silence, never the microphone: the voice model only runs while audio comes in.
      if (audio.length !== 1 || !/\r?\na=sendrecv(?:\r?\n|$)/.test(audio[0])) throw new BridgeError('Read aloud needs one two-way audio channel.');
    }
    if (owner) throw new BridgeError('Voice is already open. End that call first.', 409);
    const current = { stopped: false, started: null, stopping: null, stop: null, id: randomUUID(), speech: null, ready: false, pending: false, finished: !source, complete: false, source };
    const chunks = readAloud && !source ? speechChunks(input.text) : [];
    let unsubscribe;
    owner = call = current;
    const send = value => { if (!current.stopped && !response.destroyed) response.write(JSON.stringify(value) + '\n'); };
    let timeout, heartbeat;
    const stop = () => {
      if (current.stopping) return current.stopping;
      current.stopped = true; clearTimeout(timeout); clearInterval(heartbeat);
      unsubscribe?.();
      client.off('event', onEvent);
      client.off('side', onSide);
      current.stopping = (async () => {
        // End may arrive while authentication or native startup is still pending.
        let started = false;
        try { await current.started; started = true; } catch {}
        try {
          if (current.speech) await client.closeSpeechThread(current.speech.id);
          else if (!readAloud && started && current.started) await client.stopVoice(chatId);
        } catch {}
        finally { if (owner === current) owner = undefined; if (call === current) call = undefined; response.end(); }
      })();
      return current.stopping;
    };
    current.stop = stop;
    const fail = message => { if (current.stopped) return; send({ type: 'error', message }); source?.fail(message); void stop(); };
    const append = () => {
      if (current.stopped || !current.ready || !current.speech || !current.startComplete || current.pending) return;
      if (!chunks.length) {
        clearTimeout(timeout);
        if (current.finished && !current.complete) { current.complete = true; send({ type: 'complete' }); }
        return;
      }
      current.pending = true;
      clearTimeout(timeout); timeout = setTimeout(() => fail('Read aloud timed out waiting for speech. Retry explicitly.'), 300000).unref();
      void client.appendSpeech(current.speech.id, chunks.shift()).catch(() => fail('Read aloud delivery is uncertain. Stop and try again explicitly.'));
    };
    if (readAloud) current.readyForSpeech = () => { if (!current.ready) { current.ready = true; append(); } };
    const onSide = message => {
      const { method, params } = message;
      if (params?.threadId !== current.speech?.id || current.stopped) return;
      onEvent({ type: 'message', data: message });
      if (method === 'thread/realtime/transcript/done' && params.role === 'assistant' && current.pending) { current.pending = false; append(); }
    };
    const onEvent = event => {
      if (event.type === 'connection' && !event.data?.connected) return fail('Elpis disconnected. Reconnect before starting voice again.');
      const { method, params } = event.data ?? {};
      if (event.type !== 'message' || params?.threadId !== (readAloud ? current.speech?.id : chatId)) return;
      if (method === 'thread/realtime/sdp') { clearTimeout(timeout); send({ type: 'sdp', sdp: params.sdp }); }
      if (method === 'thread/realtime/error') fail('Voice could not connect. Check your ChatGPT connection and try again.');
      if (method === 'thread/realtime/closed' || method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') { send({ type: 'ended' }); void stop(); }
    };
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    response.once('close', stop); client.on('event', onEvent); if (readAloud) client.on('side', onSide);
    timeout = setTimeout(() => fail('Voice connection timed out. Try again.'), 30000).unref();
    heartbeat = setInterval(() => send({ type: 'ping' }), 15000).unref();
    if (readAloud) send({ type: 'session', id: current.id });
    current.started = readAloud ? Promise.resolve().then(async () => {
      if (current.stopped) return;
      current.speech = await client.createSpeechThread(chatId, { independent: !!source });
      if (current.stopped) return;
      await client.startSpeechThread(current.speech, input.sdp);
      current.startComplete = true; append();
    }) : client.startVoice(chatId, input.sdp);
    current.started.catch(error => fail(error instanceof BridgeError && error.status < 500 ? error.message : 'Voice could not start. Check your ChatGPT connection and try again.'));
    if (source) {
      try {
        unsubscribe = source.subscribe(event => {
          if (current.stopped) return;
          if (event.type === 'stop') { send({ type: 'stopped' }); return stop(); }
          if (event.type === 'text') {
            chunks.push(...speechChunks(event.text));
            if (chunks.length > 256 || chunks.reduce((n, chunk) => n + chunk.length, 0) > 262144) return fail('Voice fell behind. Stop and retry explicitly.');
          }
          if (event.type === 'done') current.finished = true;
          append();
        });
        if (current.stopped) unsubscribe();
      } catch (cause) { fail(cause.message); }
    }
  }
  function ready(input) {
    object(input, ['id']); text(input.id, 'speech session', 64);
    if (!call || call.stopped || !call.readyForSpeech || call.id !== input.id) throw new BridgeError('This Read aloud session has ended.', 409);
    call.readyForSpeech(); return { ok: true };
  }
  return { start, ready, close, closeStream: async () => { if (call?.source) await call.stop(); }, busy: () => !!call };
}
