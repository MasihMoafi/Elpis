// Exercise the actual bridge list merger with isolated in-memory history.
// No provider or user files are opened.
type Thread = {
  id: string; source: string; modelProvider: string; model: string; preview: string;
  name: string; cwd: string; path: string; createdAt: number; updatedAt: number; recencyAt: number;
};
type ListRequest = { sourceKinds?: string[]; sortKey?: string; searchTerm?: string; modelProviders?: string[]; cursor?: string };
type ListPage = { data: { id: string; recencyAt: number }[]; nextCursor: string | null };
type FixtureOptions = { read?: (count: number, thread: Thread) => Promise<{ thread: Thread }> };
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test } = require('node:test');
const { createThreadList, shouldMergeThreadList } = require('../tools/elpis-claude/bridge-thread-list.mts');

function fixture(overrides: Partial<Thread> = {}, options: FixtureOptions = {}) {
  const thread: Thread = {
    id: 'fixture-chat', source: 'vscode', modelProvider: 'openai', model: 'gpt-fixture',
    preview: '', name: 'Research notes', cwd: '/fixture', path: '/fixture/sessions/chat',
    createdAt: 50, updatedAt: 50, recencyAt: 50, ...overrides,
  };
  const store: Record<string, { model: string; turns: { items: { type: string; content: { type: string; text: string }[] }[] }[] }> = {
    [thread.id]: {
      model: 'claude/opus',
      turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Planted history marker' }] }] }],
    },
  };
  let reads = 0, time = 0;
  const merger = createThreadList({
    storeChain: () => Promise.resolve(), loadStore: async () => store,
    engineCall: async () => { reads++; if (options.read) return options.read(reads, thread); return { thread: { ...thread } }; },
    now: () => time, log: () => {}, activeTurns: new Map(),
    ownModel: (t: Thread) => { const saved = store[t.id]; assert(saved); t.model = saved.model; },
  });
  return {
    reads: () => reads,
    advance: (ms: number) => { time += ms; },
    list: (req: ListRequest, page: ListPage = { data: [], nextCursor: null }) => merger.unlistedClaudeThreads(req, page),
    request: (req: ListRequest, page: ListPage = { data: [], nextCursor: null }) => shouldMergeThreadList(req) ? merger.unlistedClaudeThreads(req, page) : [],
  };
}

test('a missing saved thread is read once within 30 seconds, then retried', async () => {
  const f = fixture({}, { read: async (count, thread) => {
    if (count === 1) throw new Error(`thread not loaded: ${thread.id}`);
    return { thread: { ...thread } };
  } });
  assert.equal((await f.list({})).length, 0);
  assert.equal((await f.list({})).length, 0);
  assert.equal(f.reads(), 1, 'repeated list must not reread an unchanged missing thread');
  f.advance(30_000);
  assert.equal((await f.list({})).length, 1, 'a newly readable thread must reappear');
  assert.equal(f.reads(), 2);
});

test('a transient read error is retried on the next list', async () => {
  const f = fixture({}, { read: async (count, thread) => {
    if (count === 1) throw new Error('temporary transport error');
    return { thread: { ...thread } };
  } });
  assert.equal((await f.list({})).length, 0);
  assert.equal((await f.list({})).length, 1);
  assert.equal(f.reads(), 2);
});

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
