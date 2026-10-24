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
  async function start(input, response, { readAloud = false, source, conversation } = {}) {
    readAloud ||= !!source;
    object(input, source || conversation ? ['sdp'] : readAloud ? ['threadId', 'sdp', 'text'] : ['threadId', 'sdp']);
    const chatId = conversation ? undefined : threadId(source?.threadId ?? input.threadId);
    text(input.sdp, 'voice offer', 64000);
    if (readAloud && !source) text(input.text, 'speech text', 2_000_000);
    if (!input.sdp.startsWith('v=0\r\n') || !input.sdp.includes('\n')) throw new BridgeError('Invalid voice offer');
    if (readAloud) {
      const audio = input.sdp.split(/\r?\nm=/).filter(section => section.startsWith('audio '));
      // The window sends generated silence, never the microphone: the voice model only runs while audio comes in.
      if (audio.length !== 1 || !/\r?\na=sendrecv(?:\r?\n|$)/.test(audio[0])) throw new BridgeError('Read aloud needs one two-way audio channel.');
    }
    // A Read aloud call kept open after it finished speaking (its last words had two seconds to play) gives way.
    if (owner?.more && owner.complete && Date.now() - owner.completedAt > 2000) await owner.stop();
    if (owner) throw new BridgeError('Voice is already open. End that call first.', 409);
    const current = { stopped: false, started: null, stopping: null, stop: null, id: randomUUID(), speech: null, ready: false, pending: false, finished: !source, complete: false, source, conversation };
    const chunks = readAloud && !source ? speechChunks(input.text) : [];
    const handoffs = [], seenHandoffs = new Set();
    let relay, idleRevision = 0;
    let unsubscribe;
    owner = call = current;
    const send = value => { if (!current.stopped && !response.destroyed) response.write(JSON.stringify(value) + '\n'); };
    let timeout, heartbeat;
    const stop = () => {
      if (current.stopping) return current.stopping;
      current.stopped = true; clearTimeout(timeout); clearInterval(heartbeat);
      unsubscribe?.();
      conversation?.close();
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
    const finishRelay = () => {
      const turn = relay?.completed.get(relay.turnId);
      if (!turn || current.stopped) return;
      if (turn.status !== 'completed') return fail('The chat could not finish this voice request. Check its reply before trying again.');
      const items = turn.items?.length ? turn.items : [...(relay.items.get(turn.id)?.values() ?? [])];
      const reply = items.findLast(item => item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer'))?.text ?? '';
      if (!reply.trim()) return fail('The chat finished without a reply to read aloud.');
      relay = null; chunks.push(...speechChunks(reply)); append();
    };
    const relayNext = async () => {
      if (current.stopped || !current.startComplete || !current.speech || relay || current.pending || chunks.length || !handoffs.length) return;
      const pending = relay = { turnId: null, items: new Map(), completed: new Map() };
      const revision = idleRevision;
      try {
        const thread = await client.readThreadMetadata(chatId);
        if (current.stopped) return;
        if (thread.status?.type === 'active') { relay = null; if (idleRevision !== revision) void relayNext(); return; }
        const result = await client.send(chatId, { text: handoffs[0] });
        if (current.stopped) return;
        if (!result.turn?.id) return fail('The voice request was not confirmed. Check the chat before trying again.');
        pending.turnId = result.turn.id; handoffs.shift(); finishRelay();
      } catch (cause) {
        if (current.stopped) return;
        relay = null;
        // A typed turn may have won the race; wait for it instead of steering it.
        if (cause.status === 409 && cause.message === 'This conversation is running. Use Steer with its active turn ID.') { if (idleRevision !== revision) void relayNext(); return; }
        fail(cause instanceof BridgeError && cause.status < 500 ? cause.message : 'The voice request could not be sent. Check the chat before trying again.');
      }
    };
    const append = () => {
      if (current.stopped || !current.ready || !current.speech || !current.startComplete || current.pending) return;
      if (!chunks.length) {
        clearTimeout(timeout);
        if (readAloud && current.finished && !current.complete) { current.complete = true; current.completedAt = Date.now(); send({ type: 'complete' }); }
        if (!readAloud) void relayNext();
        return;
      }
      current.pending = true;
      clearTimeout(timeout); timeout = setTimeout(() => fail('Read aloud timed out waiting for speech. Retry explicitly.'), 300000).unref();
      void client.appendSpeech(current.speech.id, chunks.shift()).then(() => { if (readAloud) send({ type: 'cue' }); }).catch(() => fail('Read aloud delivery is uncertain. Stop and try again explicitly.'));
    };
    if (readAloud) current.readyForSpeech = () => { if (!current.ready) { current.ready = true; append(); } };
    // An open call reads a further reply (the window keeps it open a minute after a read) without a new call.
    if (readAloud && !source) current.more = value => { chunks.push(...speechChunks(value)); current.complete = false; append(); };
    const onSide = message => {
      const { method, params } = message;
      if (params?.threadId !== current.speech?.id || current.stopped) return;
      onEvent({ type: 'message', data: message });
      // app-server maps RealtimeEvent::HandoffRequested to this item notification.
      const item = params.item;
      if (conversation && method === 'thread/realtime/itemAdded' && item?.type === 'handoff_request') return fail('Live voice requested a tool it cannot use. End the call and write the request on the board.');
      if (conversation && /^thread\/realtime\/transcript\/(delta|done)$/.test(method)) { conversation.transcript(params); send({ type: 'transcript', role: params.role, ...(params.delta !== undefined ? { delta: params.delta } : { text: params.text }) }); }
      if (!readAloud && !conversation && method === 'thread/realtime/itemAdded' && item?.type === 'handoff_request' && typeof item.handoff_id === 'string' && item.handoff_id && typeof item.input_transcript === 'string' && item.input_transcript.trim() && !seenHandoffs.has(item.handoff_id)) {
        seenHandoffs.add(item.handoff_id); handoffs.push(item.input_transcript); void relayNext();
      }
      if (method === 'thread/realtime/transcript/done' && params.role === 'assistant' && current.pending) { current.pending = false; append(); }
    };
    const onEvent = event => {
      if (event.type === 'connection' && !event.data?.connected) return fail('Elpis disconnected. Reconnect before starting voice again.');
      const { method, params } = event.data ?? {};
      if (current.stopped || event.type !== 'message') return;
      if (!readAloud && current.speech && params?.threadId === chatId) {
        if (method === 'turn/completed' || (method === 'thread/status/changed' && params.status?.type !== 'active')) idleRevision++;
        const turnId = params.turnId ?? params.turn?.id;
        // A fast provider can finish before turn/start returns its turn ID.
        if (relay && (!relay.turnId || relay.turnId === turnId)) {
          if (method === 'item/completed' && params.item?.type === 'agentMessage') {
            if (!relay.items.has(turnId)) relay.items.set(turnId, new Map());
            relay.items.get(turnId).set(params.item.id, params.item);
          }
          if (method === 'turn/completed') relay.completed.set(turnId, params.turn);
          finishRelay();
        }
        if (method === 'turn/completed' || method === 'thread/status/changed') void relayNext();
        if (method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') { send({ type: 'ended' }); void stop(); }
      }
      if (params?.threadId !== (current.speech?.id ?? chatId)) return;
      if (method === 'thread/realtime/sdp') { clearTimeout(timeout); send({ type: 'sdp', sdp: params.sdp }); }
      if (method === 'thread/realtime/error') fail('Voice could not connect. Check your ChatGPT connection and try again.');
      if (method === 'thread/realtime/closed' || method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') { send({ type: 'ended' }); void stop(); }
    };
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    response.once('close', stop); client.on('event', onEvent); client.on('side', onSide);
    timeout = setTimeout(() => fail('Voice connection timed out. Try again.'), 30000).unref();
    heartbeat = setInterval(() => send({ type: 'ping' }), 15000).unref();
    if (readAloud) send({ type: 'session', id: current.id });
    current.started = conversation ? Promise.resolve().then(async () => {
      if (current.stopped) return;
      current.speech = await client.createSpeechThread();
      if (current.stopped) return;
      await client.startSpeechThread(current.speech, input.sdp, { conversation: conversation.context });
      if (current.stopped) return;
      unsubscribe = await conversation.watch(context => {
        void client.updateSpeechContext(current.speech.id, context).catch(() => fail('Live voice could not read the updated board. End the call and start again.'));
      }, fail);
      if (current.stopped) unsubscribe();
    }) : readAloud ? Promise.resolve().then(async () => {
      if (current.stopped) return;
      current.speech = await client.takeSpeechThread(chatId);
      if (current.stopped) return;
      await client.startSpeechThread(current.speech, input.sdp);
      current.startComplete = true; append();
    }) : client.startVoice(chatId, input.sdp, { onSpeech: speech => { current.speech = speech; } }).then(() => {
      current.startComplete = true; current.ready = true; append();
    });
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
  function more(input) {
    object(input, ['id', 'text']); text(input.id, 'speech session', 64); text(input.text, 'speech text', 2_000_000);
    if (!call || call.stopped || !call.more || call.id !== input.id) throw new BridgeError('This Read aloud session has ended.', 409);
    call.more(input.text); return { ok: true };
  }
  return { start, ready, more, close, closeStream: async () => { if (call?.source || call?.conversation) await call.stop(); }, busy: () => !!call };
}
