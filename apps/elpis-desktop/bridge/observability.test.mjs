import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDesktopServer } from './server.mjs';
import { DesktopClient, BridgeError } from './client.mjs';
import { dashboardState, DASHBOARD_ASSETS } from './dashboard.mjs';

const ROOT = '01a14400-0000-7000-8000-000000000001';
const CHILD = '01a14400-0000-7000-8000-000000000002';
const usage = { inputTokens: 900, cachedInputTokens: 400, outputTokens: 100, reasoningOutputTokens: 20, totalTokens: 1000 };
const settings = { main: { model: 'gpt-6.1-sol', provider: 'openai' }, background: { model: null, provider: null }, smartPrune: { enabled: false, explicitOverride: { model: null, provider: null } }, providers: [{ id: 'openai', displayName: 'OpenAI' }] };
const input = () => ({ thread: { id: ROOT, model: 'gpt-6.1-sol', modelProvider: 'openai' }, sources: [], smartPrune: null,
  context: { tokenUsage: { total: usage, last: usage }, ledger: { used: 1000, window: 10000, categories: [] } } });

async function serve(t) {
  const directory = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(directory, { recursive: true });
  const home = await fs.mkdtemp(path.join(directory, 'dashboard-'));
  const client = new EventEmitter(); let state = input(); let chats = [{ id: ROOT, name: 'Mother', status: { type: 'idle' } }, { id: CHILD, parentThreadId: ROOT, agentNickname: 'Iris', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }];
  Object.assign(client, { connected: true, close() {}, async deleteThread() {},
    async observabilityChats() { return { data: chats, nextCursor: null }; },
    async dashboardInputs(id) { assert.equal(id, ROOT); return state; }, async settings() { return settings; },
    async providers() { return {}; },
    async readThread(id, page) { return { thread: { id, name: 'Mother' }, data: [{ item: { id: `item-${page.cursor ?? 'first'}`, type: 'agentMessage', text: 'native recorded message' } }], nextCursor: page.cursor ? null : 'next' }; },
    async dashboardPruner(edit) { return { systemPrompt: edit?.system_prompt ?? null, defaultSystemPrompt: 'Native prompt' }; },
    async dashboardModel(id, edit) { return { message: `${id}: ${edit.model}` }; },
    async providerSettings() { return { providers: [] }; },
  });
  const server = await startDesktopServer({ client, elpisHome: home, trashFile: path.join(home, 'trash.json'), loveSpot: { file: path.join(home, 'love-spot.json') }, staticDir: path.resolve('out') });
  t.after(async () => { await server.close(); execFileSync('gio', ['trash', home]); });
  const origin = new URL(server.url).origin;
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(7) }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, edit, authenticated = true) {
    return fetch(origin + route, { ...(edit !== undefined ? { method: 'POST', body: JSON.stringify(edit) } : {}), headers: { Origin: origin, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) } });
  }
  const opened = await (await request(`/api/dashboard?thread=${ROOT}`)).json();
  const token = new URL(opened.url, origin).hash.slice(10);
  return { client, request, token, home, state, setChats(value) { chats = value; }, setState(value) { state = value; } };
}

test('dashboard serves the exact TUI assets, inside authentication and a same-origin frame', async t => {
  const f = await serve(t);
  for (const name of DASHBOARD_ASSETS) {
    const response = await f.request(`/api/dashboard/${name}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(new URL(`../../../codex-rs/tui/src/dashboard_assets/${name}`, import.meta.url)));
  }
  const index = await f.request('/api/dashboard/');
  assert.equal(index.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  for (const route of ['/api/dashboard/', '/api/dashboard/data.json', '/api/dashboard/agents.json']) assert.equal((await f.request(route, undefined, false)).status, 401);
  assert.equal((await f.request(`/api/dashboard/threads/${'0'.repeat(32)}/${ROOT}`)).status, 403);
  assert.equal((await f.request('/api/observability')).status, 404);
});

test('native usage and prune failures keep the TUI schema, with unavailable telemetry left unavailable', async t => {
  const f = await serve(t);
  f.state.smartPrune = { enabled: true, approxSavedTokens: 1234, optimizerUsage: usage, latestAttempt: { status: 'model_error', failureReason: 'Provider disconnected', modelSlug: 'gpt-6-luna', candidateOutputs: 2 } };
  const result = await (await f.request(`/api/dashboard/data.json?thread=${ROOT}`)).json();
  assert.equal(result.state.context.used_tokens, 1000);
  assert.equal(result.state.context.used_percent, 10);
  assert.equal(result.state.tokens.last_turn.total, 1000);
  assert.equal(result.state.tokens.last_turn.cache_write, null);
  assert.equal(result.state.smart_prune.latest_attempt.failure_reason, 'Provider disconnected');
  assert.equal(result.state.context.categories, null, 'transcript estimates must not masquerade as request attribution');
  assert.equal(result.state.context.backtrack_points, null);
  f.client.emit('event', { type: 'message', data: { method: 'turn/started', params: { threadId: ROOT, turn: { id: 'turn', startedAt: 123 } } } });
  f.client.emit('event', { type: 'message', data: { method: 'turn/activityUpdated', params: { threadId: ROOT, turnId: 'turn', status: 'failed', durationMs: 1234, timeToFirstTokenMs: 200 } } });
  const updated = await (await f.request(`/api/dashboard/data.json?thread=${ROOT}`)).json();
  assert.equal(updated.state.activity.current, null);
  assert.equal(updated.state.activity.recent[0].duration_ms, 1234);
  assert.ok(updated.state.revision > result.state.revision, 'native updates must advance the revision that the shared renderer watches');
  const unchanged = await (await f.request(`/api/dashboard/data.json?thread=${ROOT}`)).json();
  assert.equal(unchanged.state.revision, updated.state.revision, 'idle polling must not redraw the page');
});

test('agents, empty sessions and transcript pagination use read-only native history', async t => {
  const f = await serve(t);
  const agents = await (await f.request('/api/dashboard/agents.json')).json();
  assert.deepEqual(agents.agents.map(row => [row.id, row.parent_id, row.status]), [[ROOT, null, 'ready'], [CHILD, ROOT, 'needs_you']]);
  const first = await (await f.request(`/api/dashboard/threads/${f.token}/${ROOT}?limit=20`)).json();
  const last = await (await f.request(`/api/dashboard/threads/${f.token}/${ROOT}?cursor=${first.nextCursor}`)).json();
  assert.equal(first.data[0].item.text, 'native recorded message'); assert.equal(last.nextCursor, null);
  assert.equal((await f.request(`/api/dashboard/threads/${f.token}/${ROOT}?limit=0`)).status, 400);
  assert.equal((await f.request(`/api/dashboard/threads/${f.token}/${'0'.repeat(8)}-0000-7000-8000-000000000003`)).status, 404);
  const none = dashboardState(input(), settings, [], null); assert.equal(none.tokens.session_total.total, 1000);
  f.setChats([]); f.client.emit('event', { type: 'message', data: { method: 'thread/deleted', params: { threadId: ROOT } } });
  assert.equal((await (await f.request('/api/dashboard/data.json')).json()).state, null);
  f.client.dashboardInputs = async () => { throw new BridgeError('Conversation is not loaded', 409); };
  assert.equal((await f.request(`/api/dashboard/data.json?thread=${ROOT}`)).status, 409);
});

test('pruner prompt uses native optimistic concurrency; the editor never sends an unguarded file write', async () => {
  const socket = new EventEmitter(), calls = []; socket.close = () => {};
  socket.send = raw => { const request = JSON.parse(raw); calls.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: request.method === 'pruner/read' ? { version: 'v1', model: 'gpt-6-luna', provider: 'openai', reasoningEffort: 'low' } : {} }))); };
  const client = new DesktopClient(socket);
  try {
    await client.dashboardPruner({ system_prompt: 'Keep the facts.' });
    assert.deepEqual(calls.map(row => row.method), ['pruner/read', 'pruner/write']);
    assert.deepEqual(calls[1].params, { expectedVersion: 'v1', model: 'gpt-6-luna', provider: 'openai', reasoningEffort: 'low', promptEdit: { systemPrompt: 'Keep the facts.' } });
    await assert.rejects(client.dashboardPruner({ system_prompt: ' ' }), /Provide instructions/);
  } finally { client.close(); }
});

test('subscription lists use the TUI provider IDs and native routing prefixes', async () => {
  const socket = new EventEmitter(), calls = []; socket.close = () => {};
  socket.send = raw => { const request = JSON.parse(raw); calls.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { data: [{ model: 'claude/opus', displayName: 'Opus' }, { model: 'agy/gemini', displayName: 'Gemini' }], nextCursor: null } }))); };
  const client = new DesktopClient(socket);
  try {
    assert.deepEqual((await client.dashboardModels('claude-subscription')).map(row => row.model), ['claude/opus']);
    assert.deepEqual((await client.dashboardModels('antigravity')).map(row => row.model), ['agy/gemini']);
    assert.deepEqual(calls.map(row => row.method), ['model/list']);
  } finally { client.close(); }
});

test('evidence pins registered files and refuses symlinks and oversized records', async t => {
  const f = await serve(t), file = path.join(f.home, 'rollout.jsonl');
  await fs.writeFile(file, 'ORIGINAL'); f.state.rolloutPath = file;
  const index = `/api/dashboard/evidence/${f.token}/index.json?thread=${ROOT}`;
  const rows = await (await f.request(index)).json();
  assert.equal(rows.length, 1);
  const held = file + '.held'; await fs.rename(file, held);
  await fs.writeFile(path.join(f.home, 'replacement'), 'REPLACEMENT');
  await fs.symlink(path.join(f.home, 'replacement'), file);
  assert.equal(await (await f.request(rows[0].url)).text(), 'ORIGINAL');
  assert.deepEqual(await (await f.request(index)).json(), []);
  await fs.truncate(held, 33 * 1024 * 1024);
  assert.equal((await f.request(rows[0].url)).status, 413);
});
