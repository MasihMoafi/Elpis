const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBridgeStore } = require('../tools/elpis-claude/bridge-store.mts');
const { createTestTempDir, removeTestTempDir } = require('../apps/elpis-desktop/tests/temp-root.cts');

// Run the bridge's real store functions against disposable files.
async function store(file, messages = []) {
  return createBridgeStore(file, new Set(), message => messages.push(message));
}

test('damaged saved chats remain byte-identical and refuse writes without making copies', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-store-damaged-'));
  t.after(() => removeTestTempDir(root));
  const file = path.join(root, 'sessions.json');
  const messages = [];
  const api = await store(file, messages);
  for (const raw of [Buffer.from('{"keep":"old chat",\n'), Buffer.from('[]'), Buffer.from('null')]) {
    await fs.writeFile(file, raw);
    assert.equal(await api.updateStore(value => { value.newChat = { id: 'new' }; }), false);
    assert.deepEqual(await fs.readFile(file), raw);
    await assert.rejects(api.loadStore(), /cannot load/);
    assert.deepEqual(await fs.readdir(root), ['sessions.json']);
  }
  assert.ok(messages.some(message => message.includes('cannot load')));
});

test('missing saved-chat store starts empty and saves a new chat', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-store-missing-'));
  t.after(() => removeTestTempDir(root));
  const file = path.join(root, 'sessions.json');
  const api = await store(file);
  assert.equal(await api.updateStore(value => { value.newChat = { id: 'new' }; }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { newChat: { id: 'new' } });
});

test('valid saved-chat update preserves other chats', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-store-valid-'));
  t.after(() => removeTestTempDir(root));
  const file = path.join(root, 'sessions.json');
  await fs.writeFile(file, JSON.stringify({ oldChat: { id: 'old' } }));
  const api = await store(file);
  assert.equal(await api.updateStore(value => { value.newChat = { id: 'new' }; }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { oldChat: { id: 'old' }, newChat: { id: 'new' } });
});

test('nested saved-chat corruption is rejected before a write', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-store-nested-'));
  t.after(() => removeTestTempDir(root));
  const file = path.join(root, 'sessions.json');
  const api = await store(file);
  const cases = [
    { chat: { turns: [{ id: 'turn', items: [{ id: 'item', type: 'fileChange', changes: [{ path: '/a', diff: 42 }] }] }] } },
    { chat: { active: { turnId: 'turn', startedAt: 1, startedAtMs: 2, pid: 3, cwd: '/a', userItems: 'invalid' } } },
    { chat: { thread: { id: 'child', status: { type: 42 } } } },
    { chat: { plan: { turnId: 'turn', explanation: null, plan: [{ step: 'one', status: 1 }] } } },
    { chat: { contextFiles: [{ path: '/a', name: 'a', group: 'files', included: 'yes', selectable: true }] } },
    { _delegations: { child: { parentThreadId: 'parent', requested: 'read-only', ceiling: 'unrestricted' } } },
  ];
  for (const damaged of cases) {
    const raw = JSON.stringify(damaged);
    await fs.writeFile(file, raw);
    assert.equal(await api.updateStore(value => { value.newChat = {}; }), false);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    await assert.rejects(api.loadStore(), /cannot load/);
  }
});

test('valid nested saved records and unknown fields survive an update', async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-store-nested-valid-'));
  t.after(() => removeTestTempDir(root));
  const file = path.join(root, 'sessions.json');
  const original = { chat: { model: 'claude/sonnet', future: { key: 1 }, thread: { id: 'chat', status: { type: 'idle' }, recencyAt: null }, turns: [{ id: 'turn', items: [{ id: 'item', type: 'fileChange', changes: [{ path: '/a', diff: 'text' }] }] }], plan: { turnId: 'turn', explanation: null, plan: [{ step: 'one', status: 'pending' }] } }, _delegations: { child: { parentThreadId: 'chat', requested: 'read-only', ceiling: 'read-only' } } };
  await fs.writeFile(file, JSON.stringify(original));
  const api = await store(file);
  assert.equal(await api.updateStore(value => { value.newChat = {}; }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...original, newChat: {} });
});
