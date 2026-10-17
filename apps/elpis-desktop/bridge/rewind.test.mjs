import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';

const ID = '00000000-0000-0000-0000-000000000002';
function fixture(mode = 'direct') {
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => socket.emit('close');
  socket.send = raw => {
    const row = JSON.parse(raw); socket.sent.push(row); if (!row.id) return;
    const thread = { id: ID, source: 'cli', modelProvider: 'openai', status: { type: 'idle' }, canAcceptDirectInput: mode === 'direct' };
    const result = row.method === 'thread/read' || row.method === 'thread/resume' ? { thread } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: row.id, result })));
  };
  return { socket, client: new DesktopClient(socket) };
}
const methods = socket => socket.sent.map(row => row.method).filter(method => ['thread/revert', 'turn/start', 'thread/items/list'].includes(method));

test('a revert without text only rewinds: thread/revert, no verification of the input and no new turn', async t => {
  const { socket, client } = fixture(); t.after(() => client.close()); await client.initialize();
  assert.deepEqual(await client.revert(ID, { beforeTurnId: 'turn-3' }), { rewound: true, beforeTurnId: 'turn-3' });
  assert.deepEqual(methods(socket), ['thread/revert']);
  assert.deepEqual(socket.sent.find(row => row.method === 'thread/revert').params, { threadId: ID, beforeTurnId: 'turn-3' });
});

test('a rewind obeys the replacement rules: not while a turn runs and never for an agent its parent owns', async t => {
  const direct = fixture(); t.after(() => direct.client.close()); await direct.client.initialize();
  await assert.rejects(direct.client.revert(ID, { beforeTurnId: 'turn-3', model: 'x' }), /text|message/i);
  const owned = fixture('continue'); t.after(() => owned.client.close()); await owned.client.initialize();
  await assert.rejects(owned.client.revert(ID, { beforeTurnId: 'turn-3' }), /only from its parent/);
  assert.deepEqual(methods(owned.socket), []);
});
