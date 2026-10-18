import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createObservability } from './observability.mjs';
import { DesktopClient } from './client.mjs';
const ROOT = '01a14400-0000-7000-8000-000000000001', CHILD = '01a14400-0000-7000-8000-000000000002', GONE = '01a14400-0000-7000-8000-000000000003', ARCHIVE = '01a14400-0000-7000-8000-000000000004';
const turn = i => ({ id: `t${i}`, status: i === 2 ? 'failed' : 'completed', error: i === 2 ? { message: 'Provider disconnected' } : null, items: [
  { id: `u${i}`, type: 'userMessage', content: [{ type: 'text', text: `Fix parser ${i}` }] },
  { id: `c${i}`, type: 'commandExecution', command: 'cargo test -p core', status: 'completed', exitCode: 0, aggregatedOutput: '42 passed' },
  { id: `a${i}`, type: 'agentMessage', text: '## Done\n\n- Fixed it\n\n```rust\nfn main() {}\n```' },
] });
async function fixture(t, count = 3) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'observe-turns-'));
  t.after(() => execFileSync('gio', ['trash', home]));
  const dir = path.join(home, 'logs/smart-prune/attempts'); await fs.mkdir(dir, { recursive: true });
  for (const [i, session] of [ROOT, CHILD, GONE, ARCHIVE].entries()) await fs.writeFile(path.join(dir, `run${i}.json`), JSON.stringify({ schema_version: 1, attempt_id: `run${i}`, session_id: session, turn_id: 't0', status: 'unchanged', saved_tokens: 100 * (i + 1) }));
  const rollout = path.join(home, 'rollout.jsonl');
  const rows = [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't0' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }, { type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 100000, last_token_usage: { total_tokens: 10000, input_tokens: 9900, output_tokens: 100 } } } }];
  await fs.writeFile(rollout, rows.map(row => JSON.stringify(row)).join('\n'));
  const active = [{ id: CHILD, parentThreadId: ROOT, agentNickname: 'Iris', model: 'gpt-6-luna' }, { id: ROOT, name: 'Fix parser', model: 'gpt-6.1-sol' }], pages = [];
  const observe = createObservability({ home,
    listChats: async () => ({ data: active, nextCursor: null }),
    chatOf: async id => active.some(row => row.id === id) ? { thread: active.find(row => row.id === id), path: rollout } : id === ARCHIVE ? { thread: { id, archived: true }, path: '/fixture/archived_sessions/a.jsonl' } : null,
    turnsOf: async (id, { limit, cursor }) => { pages.push({ id, limit, cursor }); const start = Number(cursor ?? 0); return { data: Array.from({ length: Math.min(limit, count - start) }, (_, i) => turn(start + i)), nextCursor: start + limit < count ? String(start + limit) : null }; },
    graphsOf: async () => ({ data: [{ tasks: [{ assignedThreadId: CHILD, kind: 'verify', title: 'Check parser' }] }] }),
  });
  return { observe, home, active, pages };
}
const query = value => new URLSearchParams(value);
test('only active chats contribute rows/counts/totals, without touching hidden records', async t => {
  const { observe, home } = await fixture(t), dir = path.join(home, 'logs/smart-prune/attempts');
  const before = await Promise.all((await fs.readdir(dir)).map(name => fs.readFile(path.join(dir, name), 'utf8')));
  const page = await observe.overview(query('limit=1'));
  assert.deepEqual(page.chats.data.map(row => row.id), [ROOT]);
  assert.equal(page.chats.nextCursor, null);
  assert.equal(page.totals.attempts, 2);
  assert.equal(page.totals.saved, 300);
  await assert.rejects(observe.chat(GONE, query('')), error => error.status === 404);
  await assert.rejects(observe.chat(ARCHIVE, query('')), error => error.status === 404);
  assert.deepEqual(await Promise.all((await fs.readdir(dir)).map(name => fs.readFile(path.join(dir, name), 'utf8'))), before);
});
test('readable items, failures, Ledger and Smart Prune data; Mother and every agent with model and Canvas role', async t => {
  const { observe, active } = await fixture(t);
  const grandchild = '01a14400-0000-7000-8000-000000000005';
  active.push({ id: grandchild, parentThreadId: CHILD, agentNickname: 'Nova', model: 'gpt-6.1-sol' });
  const page = await observe.chat(ROOT, query('limit=2'));
  assert.deepEqual(page.agents.map(row => [row.id, row.name, row.model, row.role]), [[ROOT, 'Mother', 'gpt-6.1-sol', null], [CHILD, 'Iris', 'gpt-6-luna', 'verify'], [grandchild, 'Nova', 'gpt-6.1-sol', null]]);
  assert.deepEqual(page.turns.data[0].items, turn(0).items);
  assert.equal(page.turns.data[0].steps, undefined);
  assert.equal(page.turns.data[0].contextTokens, 10000);
  assert.equal(page.turns.data[0].ledger.categories[0].label, 'User messages');
  assert.equal(page.turns.data[0].prunes[0].saved, 100);
  assert.equal(page.turns.nextCursor, '2');
  const next = await observe.chat(ROOT, query('limit=2&cursor=2'));
  assert.equal(next.turns.data[0].error.message, 'Provider disconnected');
  assert.equal(next.turns.nextCursor, null);
  assert.equal((await observe.chat(ROOT, query(`agent=${CHILD}`))).agentId, CHILD);
  await assert.rejects(observe.chat(CHILD, query(`agent=${ROOT}`)), error => error.status === 404);
});
test('300 turns arrive in pages of 20, without omissions; deleted chats disappear on refresh', async t => {
  const { observe, active, pages } = await fixture(t, 300), seen = []; let cursor = null;
  do { const page = await observe.chat(ROOT, query(`limit=20${cursor ? `&cursor=${cursor}` : ''}`)); seen.push(...page.turns.data.map(row => row.turnId)); cursor = page.turns.nextCursor; } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => `t${i}`));
  assert.equal(pages.length, 15);
  active.length = 0;
  assert.equal((await observe.overview(query(''))).totals.attempts, 0);
});
function engine(reply) {
  const socket = new EventEmitter(), calls = []; socket.close = () => {};
  socket.send = raw => { const request = JSON.parse(raw); calls.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...reply(request) }))); };
  return { client: new DesktopClient(socket), calls };
}
test('client uses read-only active listing and native full turn pages, without resuming agents', async () => {
  const { client, calls } = engine(request => ({ result: { data: request.method === 'thread/list' ? [{ id: ROOT }, { id: CHILD, parentThreadId: ROOT, source: { subAgent: { other: 'guardian' } } }] : [turn(0)], nextCursor: null } }));
  try {
    const listed = await client.observabilityChats({ limit: 100 }); assert.equal(listed.data.length, 2, "review agents remain observable"); await client.observabilityTurns(ROOT, { limit: 20 });
    assert.deepEqual(calls.map(row => row.method), ['thread/list', 'thread/turns/list']);
    assert.equal(calls[0].params.archived, false); assert.equal(calls[0].params.useStateDbOnly, true);
    assert.equal(calls[1].params.sortDirection, 'asc'); assert.equal(calls[1].params.itemsView, 'full');
  } finally { client.close(); }
});
test('legacy turn history is paginated too', async () => {
  const { client } = engine(request => request.method === 'thread/turns/list' ? { error: { code: -32601, message: 'Legacy history' } } : { result: { thread: { id: ROOT, turns: [turn(0), turn(1), turn(2)] } } });
  try {
    const first = await client.observabilityTurns(ROOT, { limit: 2 }); assert.equal(first.data.length, 2);
    const next = await client.observabilityTurns(ROOT, { limit: 2, cursor: first.nextCursor }); assert.deepEqual(next.data.map(row => row.id), ['t2']); assert.equal(next.nextCursor, null);
  } finally { client.close(); }
});

test('Canvas lineage is recovered for an agent whose list row omits its parent', async () => {
  const graphId = '01a14400-0000-7000-8000-000000000099';
  const worker = { id: CHILD, parentThreadId: null, source: { subAgent: { other: `work_graph:${graphId}:verify` } } };
  const { client } = engine(request => ({ result: request.method === 'thread/list' ? { data: [worker], nextCursor: null }
    : request.method === 'thread/read' ? { thread: { ...worker, parentThreadId: ROOT } }
    : { data: [{ id: graphId, tasks: [{ id: 'verify', title: 'Verify parser', assignedThreadId: CHILD }] }] } }));
  try { const page = await client.observabilityChats(); assert.equal(page.data[0].parentThreadId, ROOT); assert.equal(page.data[0].workflowTaskTitle, 'Verify parser'); }
  finally { client.close(); }
});

test('every active child is observable, including the automatic reviewer', async t => {
  const { observe, active } = await fixture(t), reviewer = '01a14400-0000-7000-8000-000000000006';
  active.push({ id: reviewer, parentThreadId: ROOT, agentNickname: 'Reviewer', model: 'gpt-6-luna', source: { subAgent: { other: 'guardian' } } });
  const page = await observe.chat(ROOT, query(''));
  assert.ok(page.agents.some(agent => agent.id === reviewer));
});
