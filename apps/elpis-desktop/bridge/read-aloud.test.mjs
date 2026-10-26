import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import * as native from './client.mjs';
import { startDesktopServer } from './server.mjs';

const CHAT = '00000000-0000-0000-0000-000000000001';
const SPEECH = '00000000-0000-0000-0000-000000000002';
const OTHER = '00000000-0000-0000-0000-000000000003';
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
const until = async check => {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'speech operation did not finish'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test('speech chunks preserve long ASCII, Persian and astral text below 900 engine-estimated tokens', () => {
  assert.equal(typeof native.speechChunks, 'function', 'the subscription transport needs a lossless chunker');
  for (const original of ['', 'a'.repeat(3596), 'b'.repeat(3597), '123. Hello! سلام 🌍 e\u0301\n'.repeat(2300)]) {
    const chunks = native.speechChunks(original);
    assert.equal(chunks.join(''), original);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0);
      assert.ok(Math.ceil(Buffer.byteLength(chunk, 'utf8') / 4) < 900);
      assert.equal(Buffer.from(chunk).toString('utf8'), chunk, 'a chunk cannot split a Unicode scalar');
    }
  }
});

async function fixture(t, { loveSpotAudio } = {}) {
  const controls = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-read-aloud-'));
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  const state = { account: 'chatgpt', provider: 'openai', voice: 'juniper', configModel: 'gpt-6.1-sol', listed: ['claude/opus', 'gpt-6.1-luna'], holdStart: false, failAppend: false, holdCleanup: false, busy: false };
  const notify = (method, params) => {
    if (method === 'turn/completed' && params.threadId === CHAT) state.busy = false;
    socket.emit('message', JSON.stringify({ method, params }));
  };
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (!request.id) return;
    const answer = result => socket.emit('message', JSON.stringify({ id: request.id, result }));
    queueMicrotask(() => {
      if (request.method === 'account/read') return answer({ account: { type: state.account } });
      if (request.method === 'config/read') return answer({ config: { realtime: { voice: state.voice }, model: state.configModel, model_provider: 'openai' } });
      if (request.method === 'model/list') return answer({ data: state.listed.map(model => ({ id: model, model })), nextCursor: null });
      if (request.method === 'thread/realtime/listVoices') return answer({ voices: { v1: ['cove', 'juniper'], defaultV1: 'cove' } });
      if (request.method === 'thread/read') {
        answer({ thread: { id: request.params.threadId, model: state.model ?? (state.provider === 'openai' ? 'gpt-5' : 'claude/sonnet'), modelProvider: state.provider, status: { type: state.busy ? 'active' : 'idle' } } });
        if (state.finishBusyRead) {
          state.finishBusyRead = false;
          notify('turn/completed', { threadId: CHAT, turn: { id: 'typed-turn', status: 'completed', items: [] } });
        }
        return;
      }
      if (request.method === 'thread/resume') return answer({ thread: { id: CHAT } });
      // The first private thread is SPEECH; later ones get their own ids.
      if (request.method === 'thread/start') { const n = socket.sent.filter(row => row.method === 'thread/start').length; return answer({ thread: { id: n === 1 ? SPEECH : `00000000-0000-0000-0000-${String(100 + n).padStart(12, '0')}`, ephemeral: true } }); }
      if (request.method === 'turn/start') {
        state.busy = true;
        const turn = { id: `voice-turn-${socket.sent.filter(row => row.method === 'turn/start').length}`, status: 'inProgress' };
        state.beforeTurnAnswer?.(turn);
        return answer({ turn });
      }
      if (request.method === 'thread/realtime/appendSpeech' && state.failAppend) return socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'fixture speech failure' } }));
      if (request.method === 'thread/unsubscribe' && state.holdCleanup) { state.finishCleanup = () => answer({}); return; }
      if (request.method === 'thread/realtime/start') {
        state.finishStart = () => { notify('thread/realtime/sdp', { threadId: request.params.threadId, sdp: 'v=0\r\nanswer' }); answer({}); };
        if (!state.holdStart) state.finishStart();
        return;
      }
      answer({});
    });
  };
  const client = new native.DesktopClient(socket, { timeoutMs: 3000, rewindHome: path.join(root, 'rewind'), workflowOptions: { stateDir: path.join(root, 'workflows') }, spawnLinksFile: path.join(root, 'spawn.json') });
  // Exercise the HTTP handler without binding a port: this sandbox forbids listen().
  let handler;
  const originalCreate = http.createServer;
  const create = mock.method(http, 'createServer', callback => {
    handler = callback;
    const server = originalCreate(callback);
    server.listen = (...args) => { queueMicrotask(args.at(-1)); return server; };
    server.address = () => ({ port: 43210 });
    return server;
  });
  let app;
  try { app = await startDesktopServer({ client, elpisHome: root, loveSpotAudio, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'board'), screenshots: path.join(root, 'shots') } }); }
  finally { create.mock.restore(); }
  t.after(async () => { state.finishStart?.(); state.finishCleanup?.(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  let cookie = '';
  const post = async (route, body, signal) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: 'POST', url: '/api/' + route, headers: { host: url.host, cookie, origin: url.origin, 'content-type': 'application/json' } });
    const response = new EventEmitter(), headers = new Map(); let stream;
    response.body = new ReadableStream({ start(controller) { stream = controller; }, cancel() { response.destroy(); } });
    response.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
    response.writeHead = (status, values = {}) => { response.status = status; for (const [name, value] of Object.entries(values)) response.setHeader(name, value); response.headersSent = true; response.emit('headers'); };
    response.flushHeaders = () => {};
    response.write = line => { controls.push(JSON.parse(line)); if (!response.destroyed) stream.enqueue(new TextEncoder().encode(line)); };
    response.end = line => { if (response.destroyed) return; if (line) response.write(line); response.destroyed = true; try { stream.close(); } catch {} response.emit('close'); };
    response.destroy = () => response.end();
    response.text = () => new Response(response.body).text();
    response.headers = { get: name => headers.get(name.toLowerCase()) };
    signal?.addEventListener('abort', () => response.destroy(), { once: true });
    const sent = new Promise(resolve => response.once('headers', resolve));
    void handler(request, response); await sent;
    return response;
  };
  const auth = await post('session', { token });
  cookie = auth.headers.get('set-cookie').split(';')[0];
  const methods = name => socket.sent.filter(row => row.method === name);
  const open = async (text = 'Read these words exactly.', { live = false } = {}) => {
    const controller = new AbortController();
    const response = await post(live ? 'voice' : text === null ? 'love-spot/voice' : 'voice/read-aloud', live ? { threadId: CHAT, sdp: offer } : text === null ? { sdp: offer } : { threadId: CHAT, text, sdp: offer }, controller.signal);
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); let pending = '';
    const next = async () => {
      while (!pending.includes('\n')) { const row = await reader.read(); assert.equal(row.done, false); pending += new TextDecoder().decode(row.value); }
      const index = pending.indexOf('\n'), line = pending.slice(0, index); pending = pending.slice(index + 1); const event = JSON.parse(line); return event.type === 'cue' ? next() : event;
    };
    return { controller, reader, next };
  };
  return { state, notify, post, methods, open, app, socket, client, controls };
}

test('Matilda streams through the shared HTTP transport for native and Claude text; mute retires the speaker while text continues', async t => {
  for (const provider of ['openai', 'anthropic']) {
    const f = await fixture(t, { loveSpotAudio: { available: true } }); f.state.provider = provider;
    Object.assign(f.client, {
      settings: async () => ({ main: { model: 'text', provider } }),
      models: async () => ({ data: [{ model: 'text', inputModalities: ['text'] }] }),
      createThread: async () => ({ thread: { id: CHAT, modelProvider: provider } }),
      setServiceTier: async () => ({}),
      send: async () => ({ turn: { id: 'matilda-turn' } }),
    });
    assert.equal((await f.post('love-spot/talk', { text: 'Hello', model: 'text', provider })).status, 200);
    const event = (method, params) => f.client.emit('event', { type: 'message', data: { method, params: { threadId: CHAT, turnId: 'matilda-turn', ...params } } });
    event('item/agentMessage/delta', { itemId: 'note', delta: 'First sentence. ' });
    const { controller, reader, next } = await f.open(null);
    const session = await next(); assert.equal(session.type, 'session');
    assert.equal((await next()).type, 'sdp');
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 0);
    await f.post('voice/read-aloud/ready', { id: session.id });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
    assert.equal(f.methods('thread/realtime/start')[0].params.voice, 'juniper');
    assert.equal(f.methods('thread/start')[0].params.modelProvider, 'openai');
    event('item/agentMessage/delta', { itemId: 'note', delta: 'Second sentence. ' });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 1, 'RPC acknowledgement does not advance speech');
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'user' });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 1);
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant' });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 2);
    assert.equal(f.methods('thread/realtime/appendSpeech')[1].params.text, 'Second sentence. ');
    const muted = await f.post('love-spot/voice/settings', { enabled: false }); assert.equal(muted.status, 200);
    assert.equal((await next()).type, 'stopped');
    event('item/agentMessage/delta', { itemId: 'note', delta: 'Still writing. ' });
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant' });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 2);
    assert.equal((await f.post('love-spot/voice', { sdp: offer })).status, 409);
    assert.equal(f.methods('thread/start').length, 1);
    assert.equal(f.methods('thread/realtime/stop').length, 1);
    assert.equal(f.methods('turn/interrupt').length, 0);
    controller.abort(); await reader.cancel().catch(() => {});
    await f.app.close();
  }
});

test('read aloud uses the saved subscription voice in a private native thread and orders speech by completed output', async t => {
  const f = await fixture(t), original = 'Hello سلام 🌍. '.repeat(900);
  const { controller, reader, next } = await f.open(original);
  const session = await next(); assert.equal(session.type, 'session');
  const sdp = await next(); assert.equal(sdp.sdp, 'v=0\r\nanswer');
  assert.equal(f.methods('thread/realtime/appendSpeech').length, 0, 'wait for the connected peer');
  assert.equal(f.controls.filter(e => e.type === 'cue').length, 0);
  const created = f.methods('thread/start')[0].params;
  assert.equal(created.ephemeral, true); assert.equal(created.modelProvider, 'openai'); assert.equal(created.model, 'gpt-5');
  const started = f.methods('thread/realtime/start')[0].params;
  assert.equal(started.threadId, SPEECH); assert.equal(started.voice, 'juniper');
  assert.equal(started.version, 'v3'); assert.equal(started.clientManagedHandoffs, true);
  assert.equal(started.includeStartupContext, false); assert.equal(started.transport.type, 'webrtc');
  assert.equal((await f.post('voice/read-aloud/ready', { id: session.id })).status, 200);
  assert.equal((await f.post('voice/read-aloud/ready', { id: session.id })).status, 200, 'a duplicate readiness message cannot advance the queue');
  const expected = native.speechChunks(original);
  for (let index = 0; index < expected.length; index++) {
    await until(() => f.methods('thread/realtime/appendSpeech').length === index + 1);
    assert.deepEqual(f.methods('thread/realtime/appendSpeech')[index].params, { threadId: SPEECH, text: expected[index] });
    await until(() => f.controls.filter(e => e.type === 'cue').length === index + 1);
    f.notify('thread/realtime/transcript/done', { threadId: CHAT, role: 'assistant', text: 'unrelated' });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, index + 1);
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: expected[index] });
  }
  assert.equal((await next()).type, 'complete', 'completion is output generation, not proof of heard audio');
  assert.equal((await f.post('voice', { threadId: CHAT, sdp: offer })).status, 409, 'live calls share the speaker owner');
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => f.methods('thread/realtime/stop').length === 1 && f.methods('thread/unsubscribe').length === 1);
  assert.equal(f.methods('thread/realtime/stop')[0].params.threadId, SPEECH);
  assert.equal(f.methods('turn/start').length, 0); assert.equal(f.methods('turn/interrupt').length, 0);
});

test('read aloud refuses signed-out, API-key, invalid voice and malformed requests before any speech starts', async t => {
  const f = await fixture(t);
  for (const [change, reason] of [[{ account: null }, /Read aloud needs a ChatGPT connection/], [{ account: 'apiKey' }, /Read aloud needs a ChatGPT connection/], [{ voice: 'unknown' }, /Choose one of the listed ChatGPT voices/]]) {
    Object.assign(f.state, { account: 'chatgpt', provider: 'openai', voice: 'juniper' }, change);
    const response = await f.post('voice/read-aloud', { threadId: CHAT, text: 'Words', sdp: offer });
    assert.match(await response.text(), reason);
    assert.equal(f.methods('thread/start').length, 0);
  }
  for (const change of [{ text: '' }, { text: '  ' }, { sdp: 'bad' }, { sdp: offer.replace('sendrecv', 'recvonly') }, { threadId: 'bad' }, { extra: true }]) {
    const response = await f.post('voice/read-aloud', { threadId: CHAT, text: 'Words', sdp: offer, ...change });
    assert.equal(response.status, 400);
  }
  assert.equal(f.methods('thread/realtime/start').length, 0);
  assert.equal(f.methods('thread/realtime/appendSpeech').length, 0);
});

test('Stop during startup retires the late native session and never appends or restarts speech', async t => {
  const f = await fixture(t); f.state.holdStart = true;
  const { controller, reader, next } = await f.open(); const session = await next();
  await until(() => typeof f.state.finishStart === 'function');
  controller.abort(); await reader.cancel().catch(() => {});
  f.state.finishStart();
  await until(() => f.methods('thread/realtime/stop').length === 1 && f.methods('thread/unsubscribe').length === 1);
  assert.equal((await f.post('voice/read-aloud/ready', { id: session.id })).status, 409);
  f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'late' });
  assert.equal(f.methods('thread/realtime/appendSpeech').length, 0);
});

test('speech failure and engine disconnect retire queued chunks without replaying uncertain speech', async t => {
  for (const failAppend of [true, false]) await t.test(failAppend ? 'append refused' : 'engine disconnected', async t => {
    const f = await fixture(t); f.state.failAppend = failAppend;
    const { next } = await f.open('Many words. '.repeat(1000)); const session = await next(); await next();
    await f.post('voice/read-aloud/ready', { id: session.id });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
    if (!failAppend) f.socket.emit('close');
    assert.equal((await next()).type, 'error');
    await until(() => f.socket.listenerCount('side') === 0);
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'late output' });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 1);
    assert.equal((await f.post('voice/read-aloud/ready', { id: session.id })).status, 409);
    assert.equal(f.methods('turn/start').length, 0);
  });
});

test('speaker ownership lasts through cleanup and ordinary live calls retain their original route', async t => {
  const f = await fixture(t); f.state.holdCleanup = true;
  const { controller, reader, next } = await f.open(); await next(); await next();
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => typeof f.state.finishCleanup === 'function');
  assert.equal((await f.post('voice', { threadId: CHAT, sdp: offer })).status, 409);
  f.state.finishCleanup(); await new Promise(resolve => setImmediate(resolve));
  const end = new AbortController();
  const live = await f.post('voice', { threadId: CHAT, sdp: offer }, end.signal);
  assert.equal(live.status, 200);
  await until(() => f.methods('thread/realtime/start').length === 2);
  assert.equal(f.methods('thread/realtime/start')[1].params.threadId, CHAT);
  assert.equal(f.methods('thread/realtime/start')[1].params.voice, 'juniper');
  assert.equal(f.methods('thread/realtime/start')[1].params.clientManagedHandoffs, undefined);
  assert.equal(f.methods('thread/start').length, 1, 'the native live call creates no additional speech thread');
  end.abort();
  await until(() => f.methods('thread/realtime/stop').length === 2);
});

test('Claude and Antigravity read aloud use a private native speech thread and still require ChatGPT', async t => {
  for (const [provider, model] of [['anthropic', 'claude/opus'], ['openai', 'claude/opus'], ['openai', 'agy/gemini-pro']]) await t.test(`${provider}:${model}`, async t => {
    const f = await fixture(t); Object.assign(f.state, { provider, model });
    const { controller, reader, next } = await f.open('سلام from this chat.');
    const session = await next(); assert.equal(session.type, 'session');
    assert.equal((await next()).type, 'sdp');
    const created = f.methods('thread/start')[0].params;
    assert.equal(created.model, 'gpt-6.1-sol', 'the configured default, a model the engine lists'); assert.equal(created.modelProvider, 'openai'); assert.equal(created.ephemeral, true);
    await f.post('voice/read-aloud/ready', { id: session.id });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
    assert.equal(f.methods('thread/realtime/appendSpeech')[0].params.threadId, SPEECH);
    assert.match(f.methods('thread/realtime/appendSpeech')[0].params.text, /سلام from this chat\.$/);
    assert.equal(f.methods('turn/start').length, 0);
    controller.abort(); await reader.cancel().catch(() => {});
    await until(() => f.methods('thread/unsubscribe').length === 1);
    f.state.account = null;
    await assert.rejects(f.client.createSpeechThread(CHAT), /Read aloud needs a ChatGPT connection/);
    await assert.rejects(f.client.startVoice(CHAT, offer), /Voice needs a ChatGPT connection/);
    assert.equal(f.methods('thread/start').length, 1);
  });
});

test('Claude and Antigravity voice handoffs queue ordinary turns and speak only their completed replies', async t => {
  for (const [provider, model] of [['anthropic', 'claude/opus'], ['openai', 'claude/opus'], ['openai', 'agy/gemini-pro']]) await t.test(`${provider}:${model}`, async t => {
    const f = await fixture(t); Object.assign(f.state, { provider, model, busy: true });
    const { controller, reader, next } = await f.open(null, { live: true });
    assert.equal((await next()).type, 'sdp');
    const started = f.methods('thread/realtime/start')[0].params;
    assert.equal(started.threadId, SPEECH); assert.equal(started.clientManagedHandoffs, true);
    assert.equal(f.methods('thread/start')[0].params.model, 'gpt-6.1-sol');
    const handoff = (id, input, threadId = SPEECH) => f.notify('thread/realtime/itemAdded', { threadId, item: { type: 'handoff_request', handoff_id: id, item_id: `item-${id}`, input_transcript: input, active_transcript: 'Private transcript context' } });
    handoff('wrong-thread', 'Ignore this', CHAT);
    handoff('empty', '  ');
    f.notify('thread/realtime/itemAdded', { threadId: SPEECH, item: { type: 'message', text: 'Not a handoff' } });
    handoff('first', 'First spoken request'); handoff('first', 'First spoken request'); handoff('second', 'Second spoken request');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.methods('turn/start').length, 0, 'a typed turn is never steered or interrupted');
    f.state.finishBusyRead = true;
    f.notify('thread/status/changed', { threadId: CHAT, status: { type: 'active' } });
    await until(() => f.methods('turn/start').length === 1);
    const sent = f.methods('turn/start')[0].params;
    assert.equal(sent.threadId, CHAT);
    assert.equal(sent.input[0].text, 'First spoken request');
    assert.equal(sent.model, undefined, 'the normal send inherits this chat model');
    f.notify('item/completed', { threadId: SPEECH, turnId: 'voice-turn-1', item: { id: 'private', type: 'agentMessage', text: 'Do not speak the backing native agent' } });
    f.notify('turn/completed', { threadId: CHAT, turn: { id: 'another-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Not this reply' }] } });
    f.notify('item/completed', { threadId: CHAT, turnId: 'voice-turn-1', item: { id: 'progress', type: 'agentMessage', phase: null, text: 'I will check the files.' } });
    f.notify('item/completed', { threadId: CHAT, turnId: 'voice-turn-1', item: { id: 'working', type: 'agentMessage', phase: 'commentary', text: 'Working' } });
    f.notify('item/completed', { threadId: CHAT, turnId: 'voice-turn-1', item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'The selected agent replies.' } });
    assert.equal(f.methods('thread/realtime/appendSpeech').length, 0, 'item completion is not turn completion');
    f.notify('turn/completed', { threadId: CHAT, turn: { id: 'voice-turn-1', status: 'completed', items: [] } });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
    assert.deepEqual(f.methods('thread/realtime/appendSpeech')[0].params, { threadId: SPEECH, text: 'The selected agent replies.' });
    assert.equal(f.methods('turn/start').length, 1, 'the next handoff waits for speech completion');
    f.notify('thread/realtime/transcript/done', { threadId: CHAT, role: 'assistant' });
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'user' });
    assert.equal(f.methods('turn/start').length, 1);
    const secondReply = 'A fast second reply. سلام 🌍\n'.repeat(350);
    f.state.beforeTurnAnswer = turn => {
      f.notify('turn/completed', { threadId: CHAT, turn: { id: turn.id, status: 'completed', items: [{ id: 'progress', type: 'agentMessage', phase: null, text: 'Checking the files.' }, { id: 'fast', type: 'agentMessage', phase: null, text: secondReply }] } });
    };
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant' });
    await until(() => f.methods('thread/realtime/appendSpeech').length === 2);
    assert.equal(f.methods('turn/start')[1].params.input[0].text, 'Second spoken request');
    let spoken = '', count = 1;
    while (spoken.length < secondReply.length) {
      await until(() => f.methods('thread/realtime/appendSpeech').length === count + 1);
      const chunk = f.methods('thread/realtime/appendSpeech')[count].params.text;
      assert.ok(Buffer.byteLength(chunk) <= 3596); spoken += chunk; count++;
      assert.equal(f.methods('turn/start').length, 2);
      f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant' });
    }
    assert.equal(spoken, secondReply);
    handoff('first', 'First spoken request');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.methods('turn/start').length, 2);
    assert.equal(f.methods('turn/interrupt').length, 0); assert.equal(f.methods('turn/steer').length, 0);
    controller.abort(); await reader.cancel().catch(() => {});
    await until(() => f.methods('thread/unsubscribe').length === 1);
    assert.equal(f.methods('thread/realtime/stop')[0].params.threadId, SPEECH);
  });
});

test('bridged voice retires pending handoffs and late speech on stop, disconnect or delivery failure', async t => {
  await t.test('stop during startup', async t => {
    const f = await fixture(t); Object.assign(f.state, { provider: 'anthropic', holdStart: true });
    const { controller, reader } = await f.open(null, { live: true });
    await until(() => typeof f.state.finishStart === 'function');
    assert.equal(f.methods('thread/realtime/start')[0].params.threadId, SPEECH);
    controller.abort(); await reader.cancel().catch(() => {}); f.state.finishStart();
    await until(() => f.methods('thread/unsubscribe').length === 1);
    assert.equal(f.methods('thread/realtime/stop')[0].params.threadId, SPEECH);
    assert.equal(f.methods('turn/start').length, 0);
  });
  for (const outcome of ['stop', 'disconnect', 'append failure', 'failed turn']) await t.test(outcome, async t => {
    const f = await fixture(t); Object.assign(f.state, { provider: 'anthropic', model: 'claude/opus' });
    const { controller, reader, next } = await f.open(null, { live: true });
    assert.equal((await next()).type, 'sdp');
    const handoff = id => f.notify('thread/realtime/itemAdded', { threadId: SPEECH, item: { type: 'handoff_request', handoff_id: id, input_transcript: id } });
    handoff('request'); handoff('queued');
    await until(() => f.methods('turn/start').length === 1);
    if (outcome === 'stop') { controller.abort(); await reader.cancel().catch(() => {}); }
    if (outcome === 'disconnect') f.socket.emit('close');
    if (outcome === 'append failure') f.state.failAppend = true;
    f.notify('turn/completed', { threadId: CHAT, turn: { id: 'voice-turn-1', status: outcome === 'failed turn' ? 'failed' : 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'The final reply.' }] } });
    if (outcome !== 'stop') assert.equal((await next()).type, 'error');
    await until(() => f.client.listenerCount('side') === 0);
    handoff('late'); f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.methods('turn/start').length, 1);
    assert.equal(f.methods('thread/realtime/appendSpeech').length, outcome === 'append failure' ? 1 : 0);
    assert.equal(f.methods('turn/interrupt').length, 0, 'ending voice does not interrupt the selected chat');
  });
});

test('a Claude chat\'s speech thread names a model the engine lists, never a missing one', async t => {
  const f = await fixture(t); Object.assign(f.state, { provider: 'openai', model: 'claude/opus' });
  // A Claude default in the config: the first native model listed instead.
  f.state.configModel = 'claude/sonnet';
  await f.client.createSpeechThread(CHAT);
  assert.equal(f.methods('thread/start').at(-1).params.model, 'gpt-6.1-luna');
  // No native model anywhere: say so, and create nothing.
  const none = await fixture(t); Object.assign(none.state, { provider: 'openai', model: 'claude/opus', configModel: 'claude/sonnet', listed: ['claude/opus'] });
  await assert.rejects(none.client.createSpeechThread(CHAT), /ChatGPT model/);
  assert.equal(none.methods('thread/start').length, 0);
});

test('a speech thread warmed when a chat\'s reply actions show is used by its next Read aloud; another chat\'s is closed', async t => {
  const f = await fixture(t); Object.assign(f.state, { provider: 'openai', model: 'claude/opus' });
  assert.equal((await f.post('voice/read-aloud/warm', { threadId: CHAT })).status, 200);
  await f.post('voice/read-aloud/warm', { threadId: CHAT });
  assert.equal(f.methods('thread/start').length, 1, 'one warm thread per chat, however often the actions show');
  const { controller, reader, next } = await f.open('Warm words.');
  assert.equal((await next()).type, 'session'); assert.equal((await next()).type, 'sdp');
  assert.equal(f.methods('thread/start').length, 1, 'Read aloud uses the warm thread');
  assert.equal(f.methods('thread/realtime/start')[0].params.threadId, SPEECH);
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => f.methods('thread/unsubscribe').length === 1);
  // A thread warmed for another chat is not used here and is closed when this chat warms its own.
  await f.post('voice/read-aloud/warm', { threadId: OTHER });
  await f.post('voice/read-aloud/warm', { threadId: CHAT });
  assert.equal(f.methods('thread/start').length, 3);
  await until(() => f.methods('thread/unsubscribe').length === 2, 'the other chat\'s warm thread is closed');
  assert.equal((await f.post('voice/read-aloud/warm', { threadId: 'not a thread' })).status, 400);
});

test('an open Read aloud call reads a further reply without a new call; a finished call refuses it', async t => {
  const f = await fixture(t);
  const { controller, reader, next } = await f.open('First reply.');
  const session = await next(); await next();
  await f.post('voice/read-aloud/ready', { id: session.id });
  await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
  f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'First reply.' });
  assert.equal((await next()).type, 'complete');
  assert.equal((await f.post('voice/read-aloud/more', { id: session.id, text: 'Second reply.' })).status, 200);
  await until(() => f.methods('thread/realtime/appendSpeech').length === 2);
  assert.deepEqual(f.methods('thread/realtime/appendSpeech')[1].params, { threadId: SPEECH, text: 'Second reply.' });
  await until(() => f.controls.filter(e => e.type === 'cue').length === 2, 'the second reply is cued');
  f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'Second reply.' });
  assert.equal((await next()).type, 'complete', 'the second reply completes on the same call');
  assert.equal(f.methods('thread/realtime/start').length, 1);
  assert.equal((await f.post('voice/read-aloud/more', { id: 'stale', text: 'x' })).status, 409);
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => f.methods('thread/unsubscribe').length === 1);
  assert.equal((await f.post('voice/read-aloud/more', { id: session.id, text: 'Too late.' })).status, 409, 'a closed call reads nothing more');
});

test('a finished Read aloud call kept open yields to a new voice call instead of refusing it', async t => {
  const f = await fixture(t);
  const { reader, next } = await f.open('Done reading.');
  const session = await next(); await next();
  await f.post('voice/read-aloud/ready', { id: session.id });
  await until(() => f.methods('thread/realtime/appendSpeech').length === 1);
  f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'Done reading.' });
  assert.equal((await next()).type, 'complete');
  assert.equal((await f.post('voice', { threadId: CHAT, sdp: offer })).status, 409, 'its last words may still be playing');
  await new Promise(resolve => setTimeout(resolve, 2100));
  const live = await f.post('voice', { threadId: CHAT, sdp: offer });
  assert.equal(live.status, 200, 'an idle Read aloud call gives the speaker to the new call');
  let rest = ''; for (;;) { const row = await reader.read(); if (row.done) break; rest += new TextDecoder().decode(row.value); }
  assert.doesNotMatch(rest, /"error"/, 'the idle call ends quietly');
  await until(() => f.methods('thread/unsubscribe').length >= 1);
});
