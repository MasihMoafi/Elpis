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
