import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';

const ROOT = '00000000-0000-0000-0000-000000000001';
const SIDE = '00000000-0000-0000-0000-000000000002';
function fixture({ writable = true, ephemeral = true, failSend = false, deferSend = false, earlySide = false } = {}) {
  const socket = new EventEmitter(); socket.sent = [];
  let releaseSend;
  const row = { id: ROOT, cwd: '/work', model: 'gpt-6-luna', modelProvider: 'openai', canAcceptDirectInput: writable, source: 'cli', status: { type: 'idle' } };
  socket.send = raw => {
    const req = JSON.parse(raw); socket.sent.push(req);
    if (!req.id) return;
    let result = {};
    if (req.method === 'thread/read' || req.method === 'thread/resume') result = { thread: row };
    if (req.method === 'thread/fork') result = { thread: { ...row, id: SIDE, ephemeral } };
    if (req.method === 'thread/fork' && earlySide) queueMicrotask(() => {
      socket.emit('message', JSON.stringify({ method: 'thread/started', params: { thread: result.thread } }));
      socket.emit('message', JSON.stringify({ method: 'thread/status/changed', params: { threadId: SIDE, status: { type: 'idle' } } }));
    });
    if (req.method === 'turn/start') result = { turn: { id: 'side-turn' } };
    const reply = () => socket.emit('message', JSON.stringify({ id: req.id, ...(failSend && req.method === 'turn/start' ? { error: { code: -32600, message: 'Side turn refused' } } : { result }) }));
    if (deferSend && req.method === 'turn/start') releaseSend = reply; else queueMicrotask(reply);
  };
  socket.close = () => {};
  const client = new DesktopClient(socket);
  const events = []; client.on('event', e => events.push(e));
  return { client, socket, events, releaseSend: () => releaseSend(), params: method => socket.sent.filter(req => req.method === method).map(req => req.params) };
}

test('shell commands preserve shell syntax and call the thread shell escape hatch, without a model turn', async () => {
  const f = fixture();
  await f.client.shellCommand(ROOT, { command: "printf 'one\\ntwo' | head -1 > result.txt" });
  assert.deepEqual(f.params('thread/shellCommand'), [{ threadId: ROOT, command: "printf 'one\\ntwo' | head -1 > result.txt" }]);
  assert.deepEqual(f.params('turn/start'), []);
});

test('shell validates nonempty commands and disallows direct input to agents owned by their parent', async () => {
  for (const body of [{ command: ' ' }, { command: 42 }, { command: 'pwd', cwd: '/elsewhere' }]) {
    const f = fixture(); await assert.rejects(() => f.client.shellCommand(ROOT, body));
    assert.deepEqual(f.params('thread/shellCommand'), []);
  }
  const f = fixture({ writable: false });
  await assert.rejects(() => f.client.shellCommand(ROOT, { command: 'pwd' }), /parent|direct/i);
  assert.deepEqual(f.params('thread/shellCommand'), []);
});

test('side chat forks history ephemerally with the recorded model and no-write tool permissions', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.createSideChat(ROOT, {}), { threadId: SIDE });
  assert.deepEqual(f.params('thread/fork'), [{ threadId: ROOT, ephemeral: true, excludeTurns: true, model: 'gpt-6-luna', modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only' }]);
  await f.client.sendSideChat(SIDE, { text: 'What is the return type?' });
  assert.equal(f.params('turn/start')[0].threadId, SIDE);
  assert.equal(f.params('turn/start')[0].input[0].text, 'What is the return type?');
  assert.deepEqual(f.params('thread/name/set'), []);
});

test('side answers stream only as side-chat events; main transcript and activity receive none', async () => {
  const f = fixture(); await f.client.createSideChat(ROOT, {});
  const answer = { method: 'item/agentMessage/delta', params: { threadId: SIDE, turnId: 'side-turn', itemId: 'answer', delta: 'A tree.' } };
  f.socket.emit('message', JSON.stringify(answer));
  assert.deepEqual(f.events, [{ type: 'sideChat', data: answer }]);
});

test('ephemeral thread notifications arriving before the fork acknowledgement never reach the sidebar', async () => {
  const f = fixture({ earlySide: true }); await f.client.createSideChat(ROOT, {});
  assert.deepEqual(f.events, [], 'no normal thread/started or status event escapes before the fork is registered');
});

test('closing side chat interrupts its own running turn and unsubscribes; completed replies need no interrupt', async () => {
  for (const completed of [false, true]) {
    const f = fixture(); await f.client.createSideChat(ROOT, {}); await f.client.sendSideChat(SIDE, { text: 'Why?' });
    if (completed) f.socket.emit('message', JSON.stringify({ method: 'turn/completed', params: { threadId: SIDE, turn: { id: 'side-turn', status: 'completed' } } }));
    await f.client.closeSideChat(SIDE, {});
    assert.deepEqual(f.params('turn/interrupt'), completed ? [] : [{ threadId: SIDE, turnId: 'side-turn' }]);
    assert.deepEqual(f.params('thread/unsubscribe'), [{ threadId: SIDE }]);
    assert.deepEqual(f.params('thread/delete'), []);
  }
});

test('side operations cannot target a normal conversation or send two concurrent turns', async () => {
  const f = fixture();
  await assert.rejects(() => f.client.sendSideChat(ROOT, { text: 'Wrong destination' }));
  await assert.rejects(() => f.client.closeSideChat(ROOT, {}));
  await f.client.createSideChat(ROOT, {}); await f.client.sendSideChat(SIDE, { text: 'First' });
  await assert.rejects(() => f.client.sendSideChat(SIDE, { text: 'Second' }), /running|pending/i);
  assert.equal(f.params('turn/start').length, 1);
});

test('an engine that persists the side fork is cleaned up and refused', async () => {
  const f = fixture({ ephemeral: false });
  await assert.rejects(() => f.client.createSideChat(ROOT, {}), /ephemeral|temporary/i);
  assert.deepEqual(f.params('thread/delete'), [{ threadId: SIDE }]);
  assert.deepEqual(f.params('turn/start'), []);
});

test('a refused side send can be retried, and does not leave the side thread busy', async () => {
  const f = fixture({ failSend: true }); await f.client.createSideChat(ROOT, {});
  await assert.rejects(() => f.client.sendSideChat(SIDE, { text: 'Why?' }), /Side turn refused/);
  await assert.rejects(() => f.client.sendSideChat(SIDE, { text: 'Why?' }), /Side turn refused/);
  assert.equal(f.params('turn/start').length, 2);
});

test('closing during send waits for its acknowledgement before interrupting and releasing the side thread', async () => {
  const f = fixture({ deferSend: true }); await f.client.createSideChat(ROOT, {});
  const send = f.client.sendSideChat(SIDE, { text: 'Why?' });
  const close = f.client.closeSideChat(SIDE, {});
  assert.deepEqual(f.params('thread/unsubscribe'), [], 'do not release a thread whose turn is still being acknowledged');
  f.releaseSend(); await send; await close;
  assert.deepEqual(f.params('turn/interrupt'), [{ threadId: SIDE, turnId: 'side-turn' }]);
});

test('disconnect closes ephemeral side panels instead of leaving an endless running reply', async () => {
  const f = fixture(); await f.client.createSideChat(ROOT, {});
  f.socket.emit('close');
  assert.ok(f.events.some(event => event.type === 'sideChat' && event.data.method === 'thread/closed' && event.data.params.threadId === SIDE));
});

test('composer routes require authentication, enforce their schema, and reach only their intended operations', async t => {
  const f = fixture();
  const app = await startDesktopServer({ client: f.client, trashFile: fileURLToPath(new URL(`../.tmp/composer-http-${process.pid}.json`, import.meta.url)) });
  t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  const post = (route, body, cookie) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(`/api/threads/${ROOT}/shell`, { command: 'pwd' })).status, 401);
  const auth = await post('/api/session', { token: new URLSearchParams(url.hash.slice(1)).get('token') });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(`/api/threads/${ROOT}/shell`, { command: 'pwd', cwd: '/elsewhere' }, cookie)).status, 400);
  assert.equal((await post(`/api/threads/${ROOT}/shell`, { command: 'pwd' }, cookie)).status, 200);
  assert.deepEqual(await (await post(`/api/threads/${ROOT}/side-chat`, {}, cookie)).json(), { threadId: SIDE });
  assert.equal((await post(`/api/side-chats/${ROOT}/turns`, { text: 'Wrong destination' }, cookie)).status, 404);
  assert.equal((await post(`/api/side-chats/${SIDE}/turns`, { text: 'Why?' }, cookie)).status, 200);
  assert.equal((await post(`/api/side-chats/${SIDE}/close`, {}, cookie)).status, 200);
});
