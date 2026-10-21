// The Observability page's data (bridge/observability.mjs): what Smart Prune did, read from the records the engine
// writes under <home>/logs/smart-prune (codex-rs/core/src/session/smart_prune_audit.rs), and each chat's context use
// over its turns, read from its rollout. Fixture records in a temp dir, served through the real HTTP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';

async function temp(prefix) { const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true }); return fs.mkdtemp(path.join(base, prefix)); }
const trash = file => execFileSync('gio', ['trash', file]);
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
  const home = await temp('observability-');
  t.after(() => trash(home));
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

/** Force the folder listing and read completions into reverse filename order. */
function reverseAttempts(t, dir) {
  const attemptsDir = path.join(dir, 'attempts'), readdir = fs.readdir, readFile = fs.readFile;
  t.mock.method(fs, 'readdir', async (file, ...args) => {
    const entries = await readdir(file, ...args);
    return file === attemptsDir ? entries.sort().reverse() : entries;
  });
  let reading = Promise.resolve();
  t.mock.method(fs, 'readFile', (file, ...args) => typeof file === 'string' && file.startsWith(`${attemptsDir}${path.sep}`)
    ? reading = reading.then(() => readFile(file, ...args)) : readFile(file, ...args));
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
    async observabilityChats() { return { data: [{ id: S1, name: 'Fix the parser' }], nextCursor: null }; },
    async observabilityTurns(id, { limit, cursor }) { const turns = [T1, T2, T3].map(id => ({ id, items: [], status: 'completed', error: null })); const start = Number(cursor ?? 0); return { data: turns.slice(start, start + limit), nextCursor: start + limit < turns.length ? String(start + limit) : null }; },
    async workflows() { return { data: [] }; },
    async chatSummary(chatId) { asked.push(chatId); return chatId === S1 ? { thread: { id: S1, name: 'Fix the parser', preview: 'Fix the parser', path: rollout, cwd: '/work' }, path: rollout } : null; } });
  const out = await temp('observability-out-'); t.after(() => trash(out));
  await fs.writeFile(path.join(out, 'index.html'), '<h1>Elpis</h1>');
  const app = await startDesktopServer({ client, staticDir: out, elpisHome: home }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = async pathname => { const response = await fetch(origin + pathname, { headers: { Cookie: cookie } }); return { status: response.status, body: await response.json() }; };
  return { get, asked };
}

test('HTTP overview excludes missing chats and their totals; reading the audit never changes it', async t => {
  const { home, rollout } = await records(t), before = await tree(home), { get } = await serve(t, home, rollout);
  const { status, body } = await get('/api/observability');
  assert.equal(status, 200);
  assert.deepEqual(body.totals, { attempts: 3, compacted: 1, unchanged: 1, failed: 1, examined: 4, shortened: 1, before: 2000, after: 500, saved: 1500, unlinked: 0, prunerTokens: 4000, prunerRuns: 2 });
  assert.deepEqual(body.chats.data.map(row => row.id), [S1]);
  assert.equal(body.chats.nextCursor, null);
  assert.equal(body.chats.data[0].chat.path, undefined);
  assert.equal(body.skipped.unreadable, 2);
  assert.ok(!JSON.stringify(body).includes('SOURCE TEXT') && !JSON.stringify(body).includes('PRUNER INSTRUCTIONS'));
  assert.deepEqual(await tree(home), before);
  for (const bad of ['?limit=0', '?limit=101', '?cursor=x', '?status=failed', '?foo=1', '?limit=1&limit=2']) assert.equal((await get(`/api/observability${bad}`)).status, 400, bad);
});

test('HTTP chat carries Ledger metrics and exact Prune decisions with the readable record', async t => {
  const { home, rollout } = await records(t), before = await tree(home), { get } = await serve(t, home, rollout);
  reverseAttempts(t, path.join(home, 'logs', 'smart-prune'));
  const { status, body } = await get(`/api/observability/chats/${S1}`);
  assert.equal(status, 200);
  assert.equal(body.record, path.join(home, 'logs', 'smart-prune', '2026-10-16 Fix the parser.md'));
  assert.deepEqual(body.turns.data.map(turn => [turn.turnId, turn.contextTokens, turn.window, turn.requests, turn.saved]),
    [[T1, 10000, 100000, 1, 1500], [T2, 15000, 100000, 2, 0], [T3, null, null, 0, 0]]);
  const compacted = body.turns.data[0].prunes[0];
  assert.deepEqual(compacted.items, [
    { callId: 'c1', tool: 'exec_command', sourceTokens: 2000, decision: 'compact', admitted: true, admittedTokens: 500, saved: 1500 },
    { callId: 'c2', tool: 'read_file', sourceTokens: 1500, decision: 'unchanged', admitted: false, admittedTokens: null, saved: null }]);
  assert.deepEqual(compacted.admission, { id: AD1, before: 2000, after: 500, saved: 1500, requestSequence: 7 });
  const [unchanged, failed] = body.turns.data[1].prunes;
  assert.equal(unchanged.items[0].admitted, false);
  assert.equal(unchanged.items[0].decision, 'compact');
  assert.equal(failed.error, 'stream disconnected before completion');
  assert.equal(failed.prunerTokens, null);
  const ledger = body.turns.data[0].ledger;
  assert.deepEqual([ledger.used, ledger.window, ledger.basis], [10000, 100000, 'transcript']);
  assert.deepEqual(ledger.categories.map(row => [row.id, row.label]), [['userMessages', 'User messages'], ['toolCalls', 'Tool calls'], ['toolResults', 'Tool results'], ['toolDefinitions', 'Tool definitions + schema']]);
  assert.equal(ledger.categories.reduce((sum, row) => sum + row.tokens, 0), 10000);
  assert.equal(ledger.categories[0].tokens, 1000);
  assert.equal((await get(`/api/observability/chats/${S2}`)).status, 404);
  for (const bad of ['/api/observability/chats/not-a-chat', `/api/observability/chats/${S1}?cursor=../x`, `/api/observability/chats/${S1}?agent=bogus`]) assert.equal((await get(bad)).status, 400, bad);
  assert.deepEqual(await tree(home), before);
});

test('HTTP turn prunes sort by time then id, including older records found after a cached read', async t => {
  const { home, dir, rollout, write } = await records(t);
  reverseAttempts(t, dir);
  await write(`attempts/${A[5]}.json`, attempt(A[5], S1, T2, 'unchanged', { at: '2026-10-16T09:10:00Z', candidates: [] }));
  const { get } = await serve(t, home, rollout);
  const prunes = async () => (await get(`/api/observability/chats/${S1}`)).body.turns.data.map(turn => turn.prunes.map(run => run.id));
  assert.deepEqual(await prunes(), [[A[0]], [A[1], A[5], A[2]], []]);
  const older = id(7);
  await write(`attempts/${older}.json`, attempt(older, S1, T2, 'unchanged', { at: '2026-10-16T10:09:00+01:00', candidates: [] }));
  assert.deepEqual(await prunes(), [[A[0]], [older, A[1], A[5], A[2]], []]);
});

test('new records show on next read; missing metrics do not hide native turns', async t => {
  const { home, rollout, write } = await records(t), { get } = await serve(t, home, rollout);
  assert.equal((await get('/api/observability')).body.totals.attempts, 3);
  await write(`attempts/${A[5]}.json`, attempt(A[5], S1, T3, 'unchanged', { candidates: [['c7', 'exec_command', 1500]], use: usage(100, 10) }));
  assert.equal((await get('/api/observability')).body.totals.attempts, 4);
  trash(rollout);
  const chat = (await get(`/api/observability/chats/${S1}`)).body;
  assert.equal(chat.turns.data.length, 3);
  assert.equal(chat.turns.data[0].contextTokens, null);
  const empty = await temp('observability-empty-'); t.after(() => trash(empty));
  const none = await serve(t, empty, rollout), overview = (await none.get('/api/observability')).body;
  assert.deepEqual([overview.available, overview.totals.attempts, overview.chats.data.length], [false, 0, 1]);
  assert.deepEqual(await fs.readdir(empty), []);
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
