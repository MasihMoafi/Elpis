const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSleepBlocker } = require('./sleep-blocker.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { enabled = false, list = async () => ({ data: [], nextCursor: null }) } = {}) {
  const client = new EventEmitter(), changes = new EventEmitter(), calls = [], errors = [];
  client.listThreads = list;
  const store = { read: () => ({ 'elpis-preferences-v1': JSON.stringify({ preventSleep: enabled }) }), subscribe: fn => { changes.on('change', fn); return () => changes.off('change', fn); } };
  const powerSaveBlocker = { start: type => { calls.push(['start', type]); return 0; }, stop: id => calls.push(['stop', id]) };
  const blocker = createSleepBlocker({ client, store, powerSaveBlocker, onError: error => errors.push(error) }); t.after(() => blocker.dispose());
  return { calls, errors, blocker, client, enable: value => { enabled = value; changes.emit('change', { key: 'elpis-preferences-v1' }); },
    emit: (method, id, params = {}, type = 'message') => client.emit('event', { type, data: { method, params: { threadId: id, ...params } } }) };
}
test('off at rest; enables only during work; overlapping chat/agent turns release after the last completion', async t => {
  const f = fixture(t); await settle(); assert.deepEqual(f.calls, []);
  f.emit('turn/started', 'first'); assert.deepEqual(f.calls, []);
  f.enable(true); assert.deepEqual(f.calls, [['start', 'prevent-app-suspension']]);
  f.emit('turn/started', 'middle'); f.emit('turn/started', 'last', {}, 'sideChat');
  f.emit('turn/completed', 'first'); f.emit('turn/completed', 'middle'); assert.equal(f.calls.length, 1);
  f.emit('turn/completed', 'last', {}, 'sideChat'); assert.deepEqual(f.calls.at(-1), ['stop', 0]);
  f.emit('turn/completed', 'last'); assert.equal(f.calls.length, 2);
});
test('disabling, terminal status, closing, disconnection and quit release a running blocker', async t => {
  const f = fixture(t, { enabled: true }); await settle();
  for (const end of [() => f.enable(false), () => f.emit('thread/closed', 'x'), () => f.emit('thread/deleted', 'x'), () => f.emit('thread/status/changed', 'x', { status: { type: 'idle' } }), () => f.client.emit('event', { type: 'connection', data: { connected: false } })]) {
    f.enable(true); f.emit('turn/started', 'x'); end(); assert.deepEqual(f.calls.at(-1), ['stop', 0]);
  }
  f.enable(true); f.emit('turn/started', 'x'); f.blocker.dispose(); assert.deepEqual(f.calls.at(-1), ['stop', 0]);
  assert.equal(f.client.listenerCount('event'), 0);
});
test('startup/reconnect discover active turns across pages; late startup reads cannot resurrect finished turns', async t => {
  const f = fixture(t, { enabled: true, list: async input => input.cursor ? { data: [{ id: 'agent', status: { type: 'active' } }] } : { data: [], nextCursor: 'page2' } });
  await settle(); assert.equal(f.calls.length, 1);
  f.emit('turn/completed', 'agent'); assert.deepEqual(f.calls.at(-1), ['stop', 0]);
  f.client.emit('event', { type: 'connection', data: { connected: true } }); await settle(); assert.equal(f.calls.length, 3);
  let resolve;
  const late = fixture(t, { enabled: true, list: () => new Promise(done => { resolve = done; }) });
  late.emit('turn/started', 'x'); late.emit('turn/completed', 'x');
  resolve({ data: [{ id: 'x', status: { type: 'active' } }] }); await settle();
  assert.equal(late.calls.length, 2);
});
test('listing errors and OS refusal are contained; unrelated events do not activate a blocker', async t => {
  const f = fixture(t, { enabled: true, list: async () => { throw Error('offline'); } }); await settle();
  f.emit('item/started', 'x'); assert.deepEqual(f.calls, []); assert.match(f.errors[0], /offline/);
});

test('an event during startup does not hide other already-running chats', async t => {
  let resolve;
  const f = fixture(t, { enabled: true, list: () => new Promise(done => { resolve = done; }) });
  f.emit('turn/completed', 'finished');
  resolve({ data: [{ id: 'finished', status: { type: 'active' } }, { id: 'still-running', status: { type: 'active' } }] });
  await settle(); assert.deepEqual(f.calls, [['start', 'prevent-app-suspension']]);
  f.emit('turn/completed', 'still-running'); assert.deepEqual(f.calls.at(-1), ['stop', 0]);
});
