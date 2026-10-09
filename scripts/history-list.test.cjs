// Exercise the actual bridge list merger with isolated in-memory history.
// No provider, runtime, or user files are opened by the evaluated bridge code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const bridgePath = process.env.HISTORY_BRIDGE_PATH
  ?? path.join(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
const source = fs.readFileSync(bridgePath, 'utf8');
const start = source.indexOf('  const pageFloor =');
const end = source.indexOf('  const engineReqs =', start);
const gateStart = source.indexOf('    if (msg.method === "thread/list" && !lp.archived');
const gateEnd = source.indexOf('pendingThreadList.set(msg.id, lp);', gateStart)
  + 'pendingThreadList.set(msg.id, lp);'.length;
assert(start >= 0 && end > start && gateStart >= 0 && gateEnd > gateStart,
  'bridge list implementation must be found');

function fixture(overrides = {}) {
  const thread = {
    id: 'fixture-chat', source: 'vscode', modelProvider: 'openai', model: 'gpt-fixture',
    preview: '', name: 'Research notes', cwd: '/fixture', path: '/fixture/sessions/chat',
    createdAt: 50, updatedAt: 50, recencyAt: 50, ...overrides,
  };
  const store = {
    [thread.id]: {
      model: 'claude/opus',
      turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Planted history marker' }] }] }],
    },
  };
  const ctx = vm.createContext({
    storeChain: Promise.resolve(), loadStore: async () => store,
    engineCall: async () => ({ thread: { ...thread } }),
    inputSummary: content => content.map(item => item.text ?? '').join(''),
    ownModel: t => { t.model = store[t.id].model; },
    pendingThreadList: new Map(),
  });
  vm.runInContext(source.slice(start, end)
    + ';globalThis.list = unlistedClaudeThreads;', ctx);
  const gate = new vm.Script(source.slice(gateStart, gateEnd));
  return {
    list: (req, page = { data: [], nextCursor: null }) => ctx.list(req, page),
    request: async (req, page = { data: [], nextCursor: null }) => {
      ctx.lp = req;
      ctx.msg = { id: 'request', method: 'thread/list', params: req };
      ctx.pendingThreadList.clear();
      gate.runInContext(ctx);
      return ctx.pendingThreadList.has('request') ? ctx.list(req, page) : [];
    },
  };
}

test('persisted bridge chat with empty native preview appears in interactive history', async () => {
  assert.equal((await fixture().request({ sourceKinds: [], sortKey: 'recency_at' })).length, 1);
});

test('interactive chat cannot consume a second slot in the background-task stream', async () => {
  const f = fixture();
  const left = await f.request({ sourceKinds: [], sortKey: 'recency_at' });
  const right = await f.request({ sourceKinds: ['exec', 'appServer'], sortKey: 'recency_at' });
  assert.equal(right.length, 0);
  assert.equal(left.length + right.length, new Set([...left, ...right].map(t => t.id)).size);
});

test('explicit background source includes its chat but default interactive source excludes it', async () => {
  const f = fixture({ source: 'exec' });
  assert.equal((await f.request({ sourceKinds: ['exec'] })).length, 1);
  assert.equal((await f.request({ sourceKinds: [] })).length, 0);
});

test('matching search returns bridge history; nonmatching search excludes it', async () => {
  const f = fixture();
  assert.equal((await f.request({ searchTerm: 'Planted history', sourceKinds: [] })).length, 1);
  assert.equal((await f.request({ searchTerm: 'not present', sourceKinds: [] })).length, 0);
});

test('native-preview chats are left to the engine and not injected again', async () => {
  assert.equal((await fixture({ preview: 'Native preview' }).request({ sourceKinds: [] })).length, 0);
});

test('provider filter excludes another provider and includes the matching one', async () => {
  const f = fixture();
  assert.equal((await f.request({ modelProviders: ['other-provider'] })).length, 0);
  assert.equal((await f.request({ modelProviders: ['openai'] })).length, 1);
});

test('older bridge chat is supplied when native cursor reaches its final page', async () => {
  const f = fixture();
  const first = await f.request({ sortKey: 'recency_at' }, {
    data: [{ id: 'native-newer', recencyAt: 100 }], nextCursor: 'older-page',
  });
  assert.equal(first.length, 0);
  const last = await f.request({ sortKey: 'recency_at', cursor: 'older-page' });
  assert.equal(last.length, 1);
});
