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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-read-aloud-'));
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  const state = { account: 'chatgpt', provider: 'openai', voice: 'juniper', holdStart: false, failAppend: false, holdCleanup: false };
  const notify = (method, params) => socket.emit('message', JSON.stringify({ method, params }));
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (!request.id) return;
    const answer = result => socket.emit('message', JSON.stringify({ id: request.id, result }));
    queueMicrotask(() => {
      if (request.method === 'account/read') return answer({ account: { type: state.account } });
      if (request.method === 'config/read') return answer({ config: { realtime: { voice: state.voice } } });
      if (request.method === 'thread/realtime/listVoices') return answer({ voices: { v1: ['cove', 'juniper'], defaultV1: 'cove' } });
      if (request.method === 'thread/read') return answer({ thread: { id: CHAT, model: state.provider === 'openai' ? 'gpt-5' : 'claude/sonnet', modelProvider: state.provider } });
      if (request.method === 'thread/resume') return answer({ thread: { id: CHAT } });
      if (request.method === 'thread/start') return answer({ thread: { id: SPEECH, ephemeral: true } });
      if (request.method === 'thread/realtime/appendText' && state.failAppend) return socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'fixture speech failure' } }));
      if (request.method === 'thread/unsubscribe' && state.holdCleanup) { state.finishCleanup = () => answer({}); return; }
      if (request.method === 'thread/realtime/start') {
        state.finishStart = () => { notify('thread/realtime/sdp', { threadId: request.params.threadId, sdp: 'v=0\r\nanswer' }); answer({}); };
        if (!state.holdStart) state.finishStart();
        return;
      }
      answer({});
    });
  };
  const client = new native.DesktopClient(socket, { timeoutMs: 3000, workflowOptions: { stateDir: path.join(root, 'workflows') }, spawnLinksFile: path.join(root, 'spawn.json') });
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
  try { app = await startDesktopServer({ client, elpisHome: root, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'board'), screenshots: path.join(root, 'shots') } }); }
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
    response.write = line => { if (!response.destroyed) stream.enqueue(new TextEncoder().encode(line)); };
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
  const open = async (text = 'Read these words exactly.') => {
    const controller = new AbortController();
    const response = await post('voice/read-aloud', { threadId: CHAT, text, sdp: offer }, controller.signal);
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); let pending = '';
    const next = async () => {
      while (!pending.includes('\n')) { const row = await reader.read(); assert.equal(row.done, false); pending += new TextDecoder().decode(row.value); }
      const index = pending.indexOf('\n'), line = pending.slice(0, index); pending = pending.slice(index + 1); return JSON.parse(line);
    };
    return { controller, reader, next };
  };
  return { state, notify, post, methods, open, app, socket };
}

test('read aloud uses the saved subscription voice in a private native thread and orders speech by completed output', async t => {
  const f = await fixture(t), original = 'Hello سلام 🌍. '.repeat(900);
  const { controller, reader, next } = await f.open(original);
  const session = await next(); assert.equal(session.type, 'session');
  const sdp = await next(); assert.equal(sdp.sdp, 'v=0\r\nanswer');
  assert.equal(f.methods('thread/realtime/appendText').length, 0, 'wait for the connected peer');
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
    await until(() => f.methods('thread/realtime/appendText').length === index + 1);
    assert.deepEqual(f.methods('thread/realtime/appendText')[index].params, { threadId: SPEECH, role: 'user', text: `Read this aloud exactly, word for word, and say nothing else:\n\n${expected[index]}` });
    f.notify('thread/realtime/transcript/done', { threadId: CHAT, role: 'assistant', text: 'unrelated' });
    assert.equal(f.methods('thread/realtime/appendText').length, index + 1);
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: expected[index] });
  }
  assert.equal((await next()).type, 'complete', 'completion is output generation, not proof of heard audio');
  assert.equal((await f.post('voice', { threadId: CHAT, sdp: offer })).status, 409, 'live calls share the speaker owner');
  controller.abort(); await reader.cancel().catch(() => {});
  await until(() => f.methods('thread/realtime/stop').length === 1 && f.methods('thread/unsubscribe').length === 1);
  assert.equal(f.methods('thread/realtime/stop')[0].params.threadId, SPEECH);
  assert.equal(f.methods('turn/start').length, 0); assert.equal(f.methods('turn/interrupt').length, 0);
});

test('read aloud refuses signed-out, API-key, Claude, invalid voice and malformed requests before any speech starts', async t => {
  const f = await fixture(t);
  for (const [change, reason] of [[{ account: null }, /Read aloud needs a ChatGPT connection/], [{ account: 'apiKey' }, /Read aloud needs a ChatGPT connection/], [{ provider: 'anthropic' }, /available in ChatGPT Codex chats/], [{ voice: 'unknown' }, /Choose one of the listed ChatGPT voices/]]) {
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
  assert.equal(f.methods('thread/realtime/appendText').length, 0);
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
  assert.equal(f.methods('thread/realtime/appendText').length, 0);
});

test('speech failure and engine disconnect retire queued chunks without replaying uncertain speech', async t => {
  for (const failAppend of [true, false]) await t.test(failAppend ? 'append refused' : 'engine disconnected', async t => {
    const f = await fixture(t); f.state.failAppend = failAppend;
    const { next } = await f.open('Many words. '.repeat(1000)); const session = await next(); await next();
    await f.post('voice/read-aloud/ready', { id: session.id });
    await until(() => f.methods('thread/realtime/appendText').length === 1);
    if (!failAppend) f.socket.emit('close');
    assert.equal((await next()).type, 'error');
    await until(() => f.socket.listenerCount('side') === 0);
    f.notify('thread/realtime/transcript/done', { threadId: SPEECH, role: 'assistant', text: 'late output' });
    assert.equal(f.methods('thread/realtime/appendText').length, 1);
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
  end.abort();
  await until(() => f.methods('thread/realtime/stop').length === 2);
});
