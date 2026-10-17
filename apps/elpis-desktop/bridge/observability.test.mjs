// The Observability page's data (bridge/observability.mjs): what Smart Prune did, read from the records the engine
// writes under <home>/logs/smart-prune (codex-rs/core/src/session/smart_prune_audit.rs), and each chat's context use
// over its turns, read from its rollout. Fixture records in a temp dir, served through the real HTTP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';

const S1 = '01a14400-0000-7000-8000-0000000000a1', S2 = '01a14400-0000-7000-8000-0000000000a2';
const T1 = 'turn-0001', T2 = 'turn-0002', T3 = 'turn-0003', T9 = 'turn-0009';
const id = n => `01a14401-0000-7000-8000-${String(n).padStart(12, '0')}`;
const A = [1, 2, 3, 4, 5, 6].map(id);
const AD1 = '01a14402-0000-7000-8000-0000000000d1', AD2 = '01a14402-0000-7000-8000-0000000000d2';
const usage = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

/** One attempt record as write_attempt writes it. `candidates`: [call id, tool, source tokens]; `decisions`: the
 * pruner's manifest, [call id, 'compact' | 'unchanged'], or null when it gave none. */
function attempt(attemptId, session, turn, status, { at, candidates, decisions = null, admission = null, admitted = 0, saved = 0, use = null, error = null }) {
  return { schema_version: 1, attempt_id: attemptId, session_id: session, turn_id: turn, timestamp: at, status, model: 'gpt-6-luna', reasoning_effort: 'low',
    instructions: 'PRUNER INSTRUCTIONS',
    input: JSON.stringify({ active_request: 'REQUEST', items: candidates.map(([callId, tool, tokens]) => ({ call_id: callId, source_tokens_estimate: tokens,
      invocation: { type: 'function_call', name: tool, arguments: '{}', call_id: callId }, source_output: { type: 'function_call_output', call_id: callId, output: 'SOURCE TEXT' } })) }),
    raw_response: decisions && JSON.stringify({ items: decisions.map(([callId, decision]) => ({ call_id: callId, decision, content: decision === 'compact' ? 'SHORT TEXT' : null })) }),
    error, candidate_outputs: candidates.length, admitted_outputs: admitted, saved_tokens: saved, latency_ms: 1200, usage: use, admission_id: admission };
}
const manifest = (admissionId, session, turn, items) => ({ schema_version: 1, admission_id: admissionId, session_id: session, turn_id: turn, timestamp: '2026-10-16T09:00:05Z', model: 'gpt-6-luna', ace_conversation: 'ace.json',
  source_tokens: items.reduce((sum, [, s]) => sum + s, 0), admitted_tokens: items.reduce((sum, [, , a]) => sum + a, 0), saved_tokens: items.reduce((sum, [, s, a]) => sum + s - a, 0),
  items: items.map(([callId, source, admitted], index) => ({ call_id: callId, decision: 'compact', source_sha256: 'f'.repeat(64), source_artifact: `items/00${index}-${callId}-source.json`, admitted_artifact: `items/00${index}-${callId}-admitted.json`, source_tokens: source, admitted_tokens: admitted, saved_tokens: source - admitted })) });
const line = (at, payload, type = 'event_msg') => JSON.stringify({ timestamp: at, type, payload });
const count = (total, window = 100000) => ({ type: 'token_count', info: { total_token_usage: usage(total, 0), last_token_usage: usage(total - 100, 100), model_context_window: window } });

async function records(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-observability-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'logs', 'smart-prune'), write = async (relative, value) => {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await write(`attempts/${A[0]}.json`, attempt(A[0], S1, T1, 'admitted', { at: '2026-10-16T09:00:05Z', candidates: [['c1', 'exec_command', 2000], ['c2', 'read_file', 1500]], decisions: [['c1', 'compact'], ['c2', 'unchanged']], admission: AD1, admitted: 1, saved: 1500, use: usage(2500, 500) }));
  await write(`attempts/${A[1]}.json`, attempt(A[1], S1, T2, 'unchanged', { at: '2026-10-16T09:10:00Z', candidates: [['c3', 'exec_command', 1100]], decisions: [['c3', 'compact']], use: usage(900, 100) }));
  await write(`attempts/${A[2]}.json`, attempt(A[2], S1, T2, 'model_error', { at: '2026-10-16T09:11:00Z', candidates: [['c4', 'web_search', 1300]], error: 'stream disconnected before completion' }));
  await write(`attempts/${A[3]}.json`, attempt(A[3], S2, T9, 'admitted', { at: '2026-10-16T10:00:00Z', candidates: [['c5', 'exec_command', 4000]], decisions: [['c5', 'compact']], admission: AD2, admitted: 1, saved: 3000, use: usage(400, 100) }));
  await write(`attempts/${A[4]}.json`, attempt(A[4], S2, T9, 'cancelled', { at: '2026-10-16T10:05:00Z', candidates: [['c6', 'exec_command', 1200]], decisions: [['c6', 'compact']], error: 'turn cancelled while optimizer request was in flight' }));
  await write('attempts/partial.json', '{"schema_version":1,"attempt_id":');
  await write('attempts/future.json', { schema_version: 2, attempt_id: 'future' });
  await write('attempts/notes.txt', 'not a record');
  await write(`admissions/${AD1}/manifest.json`, manifest(AD1, S1, T1, [['c1', 2000, 500]]));
  await write(`admissions/${AD1}/request.json`, { schema_version: 1, admission_id: AD1, timestamp: '2026-10-16T09:00:06Z', request_sequence: 7, input_representation: 'logical_response_items_before_transport', request_input_sha256: 'e'.repeat(64) });
  await write(`admissions/${AD2}/manifest.json`, manifest(AD2, S2, T9, [['c5', 4000, 1000]]));
  await fs.mkdir(path.join(dir, 'admissions', 'orphan', 'items'), { recursive: true });
  const rollout = path.join(home, 'sessions', '2026', '10', '16', `rollout-2026-10-16T09-00-00-${S1}.jsonl`);
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await write('2026-10-16 Fix the parser.md', '# Fix the parser\n');
  await write('2026-10-16 Another chat.md', '# Another chat\n');
  await fs.writeFile(rollout, [
    line('2026-10-16T09:00:00Z', { id: S1 }, 'session_meta'),
    line('2026-10-16T09:00:01Z', { type: 'task_started', turn_id: T1 }),
    line('2026-10-16T09:00:02Z', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u'.repeat(4000) }] }, 'response_item'),
    line('2026-10-16T09:00:04Z', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cargo test -p core' }), call_id: 'c1' }, 'response_item'),
    line('2026-10-16T09:00:06Z', { type: 'function_call_output', call_id: 'c1', output: 'o'.repeat(8000) }, 'response_item'),
    line('2026-10-16T09:00:09Z', count(10000)),
    line('2026-10-16T09:09:00Z', { type: 'task_started', turn_id: T2 }),
    line('2026-10-16T09:09:30Z', count(12000)),
    line('2026-10-16T09:09:40Z', { type: 'token_count', info: null, rate_limits: {} }),
    line('2026-10-16T09:11:30Z', count(15000)),
    line('2026-10-16T09:20:00Z', { type: 'task_started', turn_id: T3 }),
  ].join('\n') + '\n');
  return { home, dir, rollout, write };
}

/** Every file under `dir`, with its size, time and content hash: the routes must leave all of it as it was. */
async function tree(dir) {
  const result = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name), stat = await fs.stat(file);
    result[path.relative(dir, file)] = entry.isFile() ? [stat.size, stat.mtimeMs, createHash('sha256').update(await fs.readFile(file)).digest('hex')] : 'dir';
  }
  return result;
}

/** The HTTP server over a stand-in client that knows chat S1 (with its rollout) and no longer has S2. */
async function serve(t, home, rollout) {
  const asked = [];
  const client = Object.assign(new EventEmitter(), { connected: true, pendingApprovals: [], close() {},
    async chatSummary(chatId) { asked.push(chatId); return chatId === S1 ? { thread: { id: S1, name: 'Fix the parser', preview: 'Fix the parser', path: rollout, cwd: '/work' }, path: rollout } : null; } });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-observability-out-')); t.after(() => fs.rm(out, { recursive: true, force: true }));
  await fs.writeFile(path.join(out, 'index.html'), '<h1>Elpis</h1>');
  const app = await startDesktopServer({ client, staticDir: out, elpisHome: home }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = async pathname => { const response = await fetch(origin + pathname, { headers: { Cookie: cookie } }); return { status: response.status, body: await response.json() }; };
  return { get, asked };
}

test('overview: Smart Prune totals over every record, and its chats by last run, one page at a time', async t => {
  const { home, rollout } = await records(t), before = await tree(home);
  const { get, asked } = await serve(t, home, rollout);
  const { status, body } = await get('/api/observability');
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.match(body.records, /logs\/smart-prune$/);
  assert.deepEqual(body.totals, { attempts: 5, compacted: 2, unchanged: 1, failed: 2, examined: 6, shortened: 2, before: 6000, after: 1500, saved: 4500, unlinked: 0, prunerTokens: 4500, prunerRuns: 3 });
  assert.deepEqual(body.skipped, { unreadable: 2, unlinkedAdmissions: 1 }, 'a half-written and a newer-schema record are counted, not read; the orphan admission folder too');
  assert.deepEqual(body.chats.data.map(row => [row.id, row.found, row.chat?.name ?? null, row.lastAt, row.totals.attempts, row.totals.saved]), [
    [S2, false, null, '2026-10-16T10:05:00Z', 2, 3000],
    [S1, true, 'Fix the parser', '2026-10-16T09:11:00Z', 3, 1500]]);
  assert.equal(body.chats.data[1].chat.path, undefined, 'a chat reaches the page without its file paths');
  assert.equal(body.chats.data[1].chat.cwd, undefined);
  assert.equal(body.chats.nextCursor, null);
  assert.ok(!JSON.stringify(body).includes('SOURCE TEXT') && !JSON.stringify(body).includes('PRUNER INSTRUCTIONS'), 'no record text leaves the bridge');

  const first = (await get('/api/observability?limit=1')).body.chats;
  assert.deepEqual([first.data.map(row => row.id), first.nextCursor], [[S2], '1']);
  const second = (await get(`/api/observability?limit=1&cursor=${first.nextCursor}`)).body.chats;
  assert.deepEqual([second.data.map(row => row.id), second.nextCursor], [[S1], null]);
  assert.ok(asked.length <= 4, 'chat names are asked for only on the page shown');

  for (const bad of ['?limit=0', '?limit=101', '?cursor=x', '?status=failed', '?foo=1', '?limit=1&limit=2']) assert.equal((await get(`/api/observability${bad}`)).status, 400, bad);
  assert.deepEqual(await tree(home), before, 'reading changes no file');
});

test('a chat: its totals, every output with what the pruner decided and what was admitted, and context over the turns', async t => {
  const { home, rollout } = await records(t), before = await tree(home);
  const { get } = await serve(t, home, rollout);
  const { status, body } = await get(`/api/observability/chats/${S1}`);
  assert.equal(status, 200);
  assert.deepEqual([body.id, body.found, body.chat.name], [S1, true, 'Fix the parser']);
  assert.deepEqual(body.totals, { attempts: 3, compacted: 1, unchanged: 1, failed: 1, examined: 4, shortened: 1, before: 2000, after: 500, saved: 1500, unlinked: 0, prunerTokens: 4000, prunerRuns: 2 });
  assert.deepEqual(body.attempts.data.map(row => [row.id, row.outcome, row.status]), [[A[2], 'failed', 'model_error'], [A[1], 'unchanged', 'unchanged'], [A[0], 'compacted', 'admitted']]);
  const [failed, unchanged, compacted] = body.attempts.data;
  assert.deepEqual(compacted, { id: A[0], turnId: T1, at: '2026-10-16T09:00:05Z', status: 'admitted', outcome: 'compacted', model: 'gpt-6-luna', effort: 'low',
    candidates: 2, shortened: 1, saved: 1500, latencyMs: 1200, prunerTokens: 3000, error: null,
    items: [{ callId: 'c1', tool: 'exec_command', sourceTokens: 2000, decision: 'compact', admitted: true, admittedTokens: 500, saved: 1500 },
      { callId: 'c2', tool: 'read_file', sourceTokens: 1500, decision: 'unchanged', admitted: false, admittedTokens: null, saved: null }],
    admission: { id: AD1, before: 2000, after: 500, saved: 1500, requestSequence: 7 } });
  assert.deepEqual(unchanged.items, [{ callId: 'c3', tool: 'exec_command', sourceTokens: 1100, decision: 'compact', admitted: false, admittedTokens: null, saved: null }], 'the pruner shortened it, but the text was not admitted');
  assert.equal(unchanged.admission, null);
  assert.deepEqual([failed.error, failed.prunerTokens, failed.items[0].decision], ['stream disconnected before completion', null, null]);
  assert.equal(body.record, path.join(home, 'logs', 'smart-prune', '2026-10-16 Fix the parser.md'), 'the readable record is found by the chat title');
  assert.deepEqual(body.turns.data.map(turn => [turn.turnId, turn.at, turn.contextTokens, turn.window, turn.requests, turn.saved]),
    [[T1, '2026-10-16T09:00:01Z', 10000, 100000, 1, 1500], [T2, '2026-10-16T09:09:00Z', 15000, 100000, 2, 0], [T3, '2026-10-16T09:20:00Z', null, null, 0, 0]]);
  assert.deepEqual(body.turns.data[0].steps, [
    { at: '2026-10-16T09:00:04Z', kind: 'tool', name: 'exec_command', detail: 'cargo test -p core' },
    { at: '2026-10-16T09:00:09Z', kind: 'model', input: 9900, cached: 0, output: 100, context: 10000 }], 'tool calls and model requests, in order');
  const ledger = body.turns.data[0].ledger;
  assert.deepEqual([ledger.used, ledger.window, ledger.basis], [10000, 100000, 'transcript']);
  assert.deepEqual(ledger.categories.map(row => [row.id, row.label]), [['userMessages', 'User messages'], ['toolCalls', 'Tool calls'], ['toolResults', 'Tool results'], ['toolDefinitions', 'Tool definitions + schema']], 'the Ledger\'s words and order');
  assert.equal(ledger.categories.reduce((sum, row) => sum + row.tokens, 0), 10000, 'the categories add up to the measured context');
  assert.equal(ledger.categories[0].tokens, 1000);
  assert.deepEqual(body.turns.data[2].steps, []);

  const failedOnly = (await get(`/api/observability/chats/${S1}?status=failed`)).body.attempts;
  assert.deepEqual(failedOnly.data.map(row => row.id), [A[2]]);
  const page = (await get(`/api/observability/chats/${S1}?limit=2`)).body.attempts;
  assert.deepEqual([page.data.map(row => row.id), page.nextCursor], [[A[2], A[1]], A[1]]);
  const rest = (await get(`/api/observability/chats/${S1}?limit=2&cursor=${page.nextCursor}`)).body.attempts;
  assert.deepEqual([rest.data.map(row => row.id), rest.nextCursor], [[A[0]], null]);

  const gone = (await get(`/api/observability/chats/${S2}`)).body;
  assert.deepEqual([gone.found, gone.chat, gone.turns], [false, null, { available: false, reason: 'chat-missing' }]);
  assert.deepEqual(gone.attempts.data.map(row => [row.outcome, row.status, row.error]), [['failed', 'cancelled', 'turn cancelled while optimizer request was in flight'], ['compacted', 'admitted', null]]);
  assert.deepEqual(gone.attempts.data[1].admission, { id: AD2, before: 4000, after: 1000, saved: 3000, requestSequence: null }, 'no request linkage recorded yet');

  for (const bad of ['/api/observability/chats/not-a-chat', `/api/observability/chats/${S1}?status=bogus`, `/api/observability/chats/${S1}?cursor=../x`, `/api/observability/chats/${S1}?limit=0`])
    assert.equal((await get(bad)).status, 400, bad);
  assert.deepEqual(await tree(home), before, 'reading changes no file');
});

test('new records show on the next read; a missing rollout or records folder is reported, not invented', async t => {
  const { home, rollout, write } = await records(t);
  const { get } = await serve(t, home, rollout);
  assert.equal((await get('/api/observability')).body.totals.attempts, 5);
  await write(`attempts/${A[5]}.json`, attempt(A[5], S1, T3, 'unchanged', { at: '2026-10-16T11:00:00Z', candidates: [['c7', 'exec_command', 1500]], decisions: [['c7', 'unchanged']], use: usage(100, 10) }));
  const next = (await get('/api/observability')).body;
  assert.deepEqual([next.totals.attempts, next.totals.unchanged, next.chats.data[0].id], [6, 2, S1]);

  await fs.rm(rollout);
  assert.deepEqual((await get(`/api/observability/chats/${S1}`)).body.turns, { available: false, reason: 'no-rollout' });

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-observability-empty-')); t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const none = await serve(t, empty, rollout), overview = (await none.get('/api/observability')).body;
  assert.deepEqual([overview.available, overview.totals.attempts, overview.chats.data], [false, 0, []]);
  assert.deepEqual(await fs.readdir(empty), [], 'no records folder is created');
});

test('chatSummary: a chat Elpis has, by name and rollout; one it no longer has is null', async () => {
  const socket = new EventEmitter(); socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw);
    const reply = request.params.threadId === S1 ? { result: { thread: { id: S1, name: 'Fix the parser', path: '/r/rollout.jsonl' } } }
      : { error: { code: -32600, message: `thread not loaded: ${request.params.threadId}` } };
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...reply })));
  };
  const client = new DesktopClient(socket);
  try {
    const known = await client.chatSummary(S1);
    assert.deepEqual([known.thread.id, known.thread.name, known.path], [S1, 'Fix the parser', '/r/rollout.jsonl']);
    assert.equal(await client.chatSummary(S2), null);
    await assert.rejects(client.chatSummary('../etc'), /Invalid thread ID/);
  } finally { client.close(); }
});
