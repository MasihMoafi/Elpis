const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Run the bridge's real store functions against disposable files.
async function store(file, messages = []) {
  const source = await fs.readFile(path.join(__dirname, '../tools/elpis-claude/acp-bridge.mjs'), 'utf8');
  const context = vm.createContext({
    STORE: file, Error, readFile: fs.readFile, statSync: require('node:fs').statSync,
    withFileLock: (_file, fn) => fn(),
    readJson: async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } },
    saveStore: value => fs.writeFile(file, JSON.stringify(value)),
    log: message => messages.push(message),
  });
  vm.runInContext(source.slice(source.indexOf('async function readStore()'), source.indexOf('const STATE_DIR =')) + '\nthis.api = { loadStore, updateStore };', context);
  return context.api;
}

test('damaged saved chats remain byte-identical and refuse writes without making copies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-store-damaged-'));
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

test('missing saved-chat store starts empty and saves a new chat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-store-missing-'));
  const file = path.join(root, 'sessions.json');
  const api = await store(file);
  assert.equal(await api.updateStore(value => { value.newChat = { id: 'new' }; }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { newChat: { id: 'new' } });
});

test('valid saved-chat update preserves other chats', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-store-valid-'));
  const file = path.join(root, 'sessions.json');
  await fs.writeFile(file, JSON.stringify({ oldChat: { id: 'old' } }));
  const api = await store(file);
  assert.equal(await api.updateStore(value => { value.newChat = { id: 'new' }; }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { oldChat: { id: 'old' }, newChat: { id: 'new' } });
});
