// Workflows that run until they finish (SPEC WR1–WR8), end to end: the real engine (ELPIS_ENGINE_BIN, default
// ~/.local/bin/elpis-next) behind the real shared bridge, a GPT chat on a local mock Responses provider
// (tools/elpis-claude/test/mock-responses.mjs), in a throwaway HOME/ELPIS_HOME with the Subagents switch off,
// no credentials and no session bus. Every process it starts is stopped at the end, including after a crash.
//   node --test --test-timeout=300000 tests/workflow-run.runtime.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const tools = fileURLToPath(new URL('../../../tools/elpis-claude/', import.meta.url));
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? path.join(os.homedir(), '.local/bin/elpis-next');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wfrun-'));
const home = path.join(root, 'elpis'), work = path.join(root, 'work'), run = path.join(root, 'run'), mockDir = path.join(root, 'mock');
for (const d of [home, work, run, mockDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const socketPath = path.join(run, 'bridge.sock');
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const port = await freePort();
fs.writeFileSync(path.join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[features]\nmulti_agent = false\n\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);

const META = (name, phases) => `export const meta = { name: '${name}', description: 'end-to-end ${name}', phases: [${phases.map((p) => `{ title: '${p}' }`).join(', ')}] }\n`;
const SCRIPTS = {
  three: { args: { items: ['alpha', 'beta', 'gamma'] }, script: `${META('three-phase', ['Scan', 'Check', 'Sum'])}phase('Scan')
const SCHEMA = { type: 'object', properties: { item: { type: 'string' }, score: { type: 'integer' } }, required: ['item', 'score'] }
const found = await parallel(args.items.map((x) => () => agent('scan ' + x, { label: 'scan ' + x, schema: SCHEMA })))
log('found ' + found.filter(Boolean).length)
phase('Check')
const checked = await pipeline(found, (f) => agent('check ' + f.item, { label: 'check ' + f.item }), (text, f, i) => agent('confirm ' + i + ' ' + text, { label: 'confirm ' + i }))
phase('Sum')
const total = await agent('sum ' + checked.join(' | '), { label: 'sum' })
return { found, checked, total }` },
  flaky: { script: `${META('flaky', ['Try'])}phase('Try')
const broken = await agent('broken FAILALWAYS', { label: 'broken' })
const fine = await agent('fine after', { label: 'fine' })
return { broken, fine }` },
  restart: { script: `${META('restart', ['First', 'Last'])}phase('First')
const first = await parallel([() => agent('quick one'), () => agent('quick two'), () => agent('slow three SLOWONCE:15000')])
phase('Last')
return { first, last: await agent('final ' + first.join(', ')) }` },
};
fs.writeFileSync(path.join(mockDir, 'scripts.json'), JSON.stringify(SCRIPTS));
const requests = () => { try { return fs.readFileSync(path.join(mockDir, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: root, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, TMPDIR: root,
  XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: path.join(root, '.config'), XDG_CACHE_HOME: path.join(root, '.cache'), XDG_DATA_HOME: path.join(root, '.local/share'), XDG_STATE_HOME: path.join(root, '.local/state'),
  ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: ENGINE, ELPIS_NO_AGY: '1', ACP_BRIDGE_LOG: path.join(root, 'bridge.log'),
  ELPIS_WORKFLOW_RETRY_MS: '300', ELPIS_WORKFLOW_ATTEMPTS: '3' };

const mock = spawn(process.execPath, [path.join(tools, 'test/mock-responses.mjs'), String(port), mockDir], { stdio: ['ignore', 'pipe', 'inherit'] });
await once(mock.stdout, 'data');

let bridge = null;
async function startBridge() {
  try { fs.rmSync(socketPath, { force: true }); } catch {}
  bridge = spawn(process.execPath, [path.join(tools, 'acp-bridge.mjs')], { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; bridge.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 200 && !fs.existsSync(socketPath); i++) await pause(50);
  assert.ok(fs.existsSync(socketPath), `the bridge did not start: ${err}`);
}
// Everything whose HOME is this test's home: the bridge, its engines, MCP servers (as app.sh stop does).
function mine() {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try { if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${root}`)) out.push(Number(pid)); } catch {}
  }
  return out;
}
async function killAll(signal = 'SIGKILL') {
  try { process.kill(-bridge.pid, signal); } catch {}
  for (const pid of mine()) { try { process.kill(pid, signal); } catch {} }
  for (let i = 0; i < 50 && mine().length; i++) await pause(100);
}

async function client(name = 'e2e-desktop') {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  await once(ws, 'open');
  const pending = new Map(), events = [];
  let seq = 0;
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.method) events.push(m); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const ok = async (method, params) => { const r = await rpc(method, params); assert.ifError(r.error); return r.result; };
  await ok('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { ws, rpc, ok, events };
}
const until = async (what, check, ms = 120_000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; assert.ok(Date.now() < end, `timed out: ${what}\n${fs.readFileSync(env.ACP_BRIDGE_LOG, 'utf8').split('\n').slice(-25).join('\n')}`); await pause(200); }
};
const runFile = (id) => JSON.parse(fs.readFileSync(path.join(home, 'workflows/runs', id, 'run.json'), 'utf8'));
const runsDir = path.join(home, 'workflows/runs');
const runIds = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);
const lastTurn = async (c, threadId) => (await c.ok('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' })).data[0];
const replyOf = (turn) => (turn?.items ?? []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join('');
async function say(c, threadId, text) {
  const before = c.events.length;
  await c.ok('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  await until(`the reply to "${text}"`, () => c.events.slice(before).some((m) => m.method === 'turn/completed' && m.params.threadId === threadId));
  return replyOf(await lastTurn(c, threadId));
}
const launchedId = (reply) => /as (wf_[\w-]+)/.exec(reply)?.[1];
async function noticeReply(c, threadId, runId) {
  return until(`the notice of ${runId} reaches its chat`, async () => { const t = await lastTurn(c, threadId); const r = replyOf(t); return t?.status === 'completed' && r.startsWith(`NOTICE RECEIVED ${runId}`) ? r : null; });
}

test.after(async () => { await killAll(); mock.kill('SIGKILL'); });

test('workflows run to the end from a chat whose person asked, with the Subagents switch off (WR1–WR7)', { timeout: 300_000 }, async (t) => {
  await startBridge();
  const c = await client();
  const parent = (await c.ok('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;

  await t.test('a model launching on its own, without the person asking, is refused', async () => {
    const reply = await say(c, parent, 'Please handle WF:three for me.');
    const launch = requests().find((r) => r.kind === 'launch');
    assert.ok(launch?.tool, `the chat has a workflow tool though Subagents is off: ${JSON.stringify(launch)}`);
    assert.ok(!launch.tools.some((n) => /delegate/.test(n)), 'the delegate tools stay off with the switch');
    assert.match(reply, /did not start: The person did not ask for a workflow/);
    assert.deepEqual(runIds(), []);
  });

  let threeId;
  await t.test('a three-phase script with parallel and pipeline runs to the end and its result reaches the starting chat', async () => {
    const reply = await say(c, parent, 'ultracode: run WF:three over the items');
    threeId = launchedId(reply);
    assert.ok(threeId, reply);
    assert.match(reply, /running in the background/);
    const notice = await noticeReply(c, parent, threeId);
    const result = JSON.parse(notice.slice(notice.indexOf(':') + 1));
    assert.deepEqual(result.found.map((f) => f.item), ['item:scan alpha', 'item:scan beta', 'item:scan gamma']);
    assert.ok(result.found.every((f) => Number.isInteger(f.score)), 'structured output through the engine');
    assert.deepEqual(result.checked, [0, 1, 2].map((i) => `ANSWER(confirm ${i} ANSWER(check item:scan ${['alpha', 'beta', 'gamma'][i]}))`));
    assert.match(result.total, /^ANSWER\(sum ANSWER\(confirm 0/);
    const state = runFile(threeId);
    assert.equal(state.status, 'completed');
    assert.equal(state.agents.length, 10);
    assert.deepEqual([...new Set(state.agents.map((a) => a.phase))], ['Scan', 'Check', 'Sum']);
    assert.ok(state.agents.every((a) => a.state === 'done' && a.threadId), 'every agent is a chat');
    assert.equal(state.notice.state, 'delivered');
    assert.ok(requests().filter((r) => r.kind === 'agent' && r.schema).length >= 3, 'scan agents asked the engine for structured output');
    // The protocol the app reads (WR7), and the agents folded under the run in the chat list.
    const read = (await c.ok('workflowRun/read', { runId: threeId })).run;
    assert.deepEqual(read.phases.map((p) => p.title), ['Scan', 'Check', 'Sum']);
    assert.deepEqual(read.logs.map((l) => l.message), ['found 3']);
    assert.ok(read.agents.every((a) => a.label && a.elapsedMs > 0));
    const listed = (await c.ok('workflowRun/list', { threadId: parent })).data;
    assert.equal(listed.find((r) => r.id === threeId).status, 'completed');
    const helper = (await c.ok('thread/read', { threadId: state.agents[0].threadId, includeTurns: false })).thread;
    assert.equal(helper.parentThreadId, parent);
    assert.equal(helper.workflowRunId, threeId);
    assert.ok(c.events.some((m) => m.method === 'workflowRun/updated' && m.params.runId === threeId && m.params.kind === 'ended'), 'the app hears every change');
    const journal = fs.readFileSync(path.join(runsDir, threeId, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(journal.filter((r) => r.type === 'result').length, 10);
  });

  await t.test('a failing agent is retried, then null, and the run still finishes', async () => {
    const reply = await say(c, parent, 'Use a workflow: WF:flaky');
    const id = launchedId(reply);
    assert.ok(id, reply);
    const notice = await noticeReply(c, parent, id);
    assert.equal(notice, `NOTICE RECEIVED ${id} completed: {"broken":null,"fine":"ANSWER(fine after)"}`);
    assert.equal(requests().filter((r) => r.kind === 'agent' && /FAILALWAYS/.test(r.prompt)).length, 3, 'three attempts, then null');
    const broken = runFile(id).agents.find((a) => a.label === 'broken');
    assert.deepEqual([broken.state, broken.attempts], ['failed', 3]);
  });

  await t.test('the runtime restarted mid-run resumes it and finishes without re-running finished agents', async () => {
    const reply = await say(c, parent, 'ultracode WF:restart');
    const id = launchedId(reply);
    assert.ok(id, reply);
    await until('two agents done and the slow one running', () => {
      const a = runFile(id).agents;
      return a.filter((x) => x.state === 'done').length === 2 && a.some((x) => x.label.startsWith('slow') && x.state === 'running');
    });
    c.ws.close();
    await killAll(); // the runtime dies with its engines, mid-turn
    assert.equal(runFile(id).status, 'running');
    await startBridge(); // the app reconnecting starts a new runtime; nothing else is sent
    const again = await client();
    const notice = await noticeReply(again, parent, id);
    assert.equal(notice, `NOTICE RECEIVED ${id} completed: {"first":["ANSWER(quick one)","ANSWER(quick two)","ANSWER(slow three SLOWONCE:15000)"],"last":"ANSWER(final ANSWER(quick one), ANSWER(quick two), ANSWER(slow three SLOWONCE:15000))"}`);
    const asked = (p) => requests().filter((r) => r.kind === 'agent' && r.prompt === p).length;
    assert.equal(asked('quick one'), 1, 'a finished agent is not asked again');
    assert.equal(asked('quick two'), 1);
    assert.equal(asked('slow three SLOWONCE:15000'), 2, 'the unfinished agent runs again');
    assert.equal(asked(`final ANSWER(quick one), ANSWER(quick two), ANSWER(slow three SLOWONCE:15000)`), 1);
    const state = runFile(id);
    assert.equal(state.launches, 2);
    assert.equal(state.agents.find((a) => a.label.startsWith('slow')).resumed, true);
    again.ws.close();
  });
});
