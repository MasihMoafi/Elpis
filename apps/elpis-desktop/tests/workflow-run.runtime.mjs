// Workflows that run until they finish (SPEC WR1–WR8), end to end: the real engine (ELPIS_ENGINE_BIN, default
// ~/.local/bin/elpis-next) behind the real shared bridge, a GPT chat on a local mock Responses provider
// (tools/elpis-claude/test/mock-responses.mjs), in a throwaway HOME/ELPIS_HOME with the Subagents switch off,
// no credentials and no session bus. Every process it starts is stopped at the end, including after a crash.
//   [ELPIS_TEST_TOOLS=/abs/tools/elpis-claude] node --test --test-timeout=400000 tests/workflow-run.runtime.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ELPIS_TEST_TOOLS: the runtime under test (default this checkout's); the stand-in model is always this checkout's.
const tools = path.resolve(process.env.ELPIS_TEST_TOOLS || fileURLToPath(new URL('../../../tools/elpis-claude/', import.meta.url)));
const fixtures = fileURLToPath(new URL('../../../tools/elpis-claude/test/', import.meta.url));
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
  worktree: { script: `${META('worktree', ['Work'])}phase('Work')
return await parallel([() => agent('tidy nothing', { isolation: 'worktree' }), () => agent('make WRITEFILE:made.txt', { isolation: 'worktree' })])` },
  handover: { script: `${META('handover', ['First', 'Last'])}phase('First')
const first = await parallel([() => agent('hand one'), () => agent('hand two SLOWONCE:15000')])
phase('Last')
return { first, last: await agent('hand last ' + first.join(', ')) }` },
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

const mock = spawn(process.execPath, [path.join(fixtures, 'mock-responses.mjs'), String(port), mockDir], { stdio: ['ignore', 'pipe', 'inherit'] });
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

  await t.test("isolation: 'worktree' on the real engine: a fresh worktree per agent, the unchanged one removed with its branch, the changed one kept on its branch", async () => {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'README'), 'base\n'); git('add', 'README'); git('commit', '-q', '-m', 'base');
    const chat = (await c.ok('thread/start', { cwd: repo, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;
    const id = launchedId(await say(c, chat, 'ultracode WF:worktree'));
    assert.ok(id);
    const notice = await noticeReply(c, chat, id);
    const result = JSON.parse(notice.slice(notice.indexOf(':') + 1));
    assert.equal(result[0], 'ANSWER(tidy nothing)', 'an unchanged agent says nothing about a worktree');
    const kept = /\[Changes left in worktree (\S+) on branch (\S+)\]$/.exec(result[1]);
    assert.ok(kept, result[1]);
    const [, where, branch] = kept;
    assert.equal(fs.readFileSync(path.join(where, 'made.txt'), 'utf8'), 'changed', "the agent's command ran in its own worktree");
    assert.equal(fs.existsSync(path.join(repo, 'made.txt')), false, 'the chat\'s checkout is untouched');
    assert.deepEqual(git('branch', '--format=%(refname:short)').split('\n').filter((b) => b.startsWith('elpis-workflow/')), [branch], 'only the changed agent keeps a branch');
    const tidy = runFile(id).agents.find((a) => a.label === 'tidy nothing');
    assert.equal(fs.existsSync(path.join(runsDir, id, 'worktrees', tidy.id)), false, 'the unchanged worktree is removed');
    assert.deepEqual(git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)), [fs.realpathSync(repo), where]);
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

test('an update hands a running workflow to the newer runtime, which takes it within 5 s and finishes it (WR3)', { timeout: 240_000 }, async () => {
  // Two installed bundles of this runtime, started the way the app and the terminals start it (shared-runtime.mjs): the
  // second one's launch is an update, and the first hands over (startDrain releases its runs).
  const bundle = (name) => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    for (const file of fs.readdirSync(tools).filter((f) => f.endsWith('.mjs') || f === 'package.json')) fs.copyFileSync(path.join(tools, file), path.join(dir, file));
    fs.symlinkSync(path.join(tools, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
  };
  const [older, newer] = [bundle('bundle-a'), bundle('bundle-b')];
  const home2 = path.join(root, 'elpis2'), run2 = path.join(root, 'run2');
  for (const d of [home2, run2]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(home, 'config.toml'), path.join(home2, 'config.toml'));
  const { ELPIS_SHARED_BRIDGE, ELPIS_BRIDGE_SOCKET, ...base } = env;
  const env2 = { ...base, ELPIS_HOME: home2, CODEX_HOME: home2, XDG_RUNTIME_DIR: run2, ACP_BRIDGE_LOG: path.join(root, 'bridge2.log') };
  const launch = async (dir) => {
    const child = spawn(process.execPath, [path.join(dir, 'shared-runtime.mjs'), path.join(dir, 'acp-bridge.mjs')], { env: env2, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    await once(child, 'exit');
    assert.equal(child.exitCode, 0, err);
    return out.split('\n')[0].trim().replace(/^unix:\/\//, '');
  };
  const sock = await launch(older);
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(sock), 'state.json'), 'utf8')); } catch { return {}; } };
  const oldPid = state().pid;
  const connect = async () => {
    const ws = new WebSocket(`ws+unix://${sock}:/`); await once(ws, 'open');
    const pending = new Map(), events = []; let seq = 0;
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.method) events.push(m); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const ok = async (method, params) => { const r = await new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); assert.ifError(r.error); return r.result; };
    await ok('initialize', { clientInfo: { name: 'e2e-desktop', version: '1' }, capabilities: { experimentalApi: true } }); ws.send(JSON.stringify({ method: 'initialized' }));
    return { ws, ok, events };
  };
  const c = await connect();
  const chat = (await c.ok('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;
  const before = c.events.length;
  await c.ok('turn/start', { threadId: chat, input: [{ type: 'text', text: 'ultracode WF:handover', text_elements: [] }] });
  await until('the launch turn ends', () => c.events.slice(before).some((m) => m.method === 'turn/completed' && m.params.threadId === chat));
  const runs2 = path.join(home2, 'workflows/runs');
  const id = fs.readdirSync(runs2)[0];
  const file = () => JSON.parse(fs.readFileSync(path.join(runs2, id, 'run.json'), 'utf8'));
  await until('one agent done and the slow one working', () => { const a = file().agents; return a.some((x) => x.state === 'done') && a.some((x) => x.label.startsWith('hand two') && x.state === 'running'); });
  assert.equal(file().owner.pid, oldPid);
  await launch(newer); // the update
  await until('the newer runtime serves', () => state().pid && state().pid !== oldPid, 30_000);
  const served = Date.now(), newPid = state().pid;
  await until('the newer runtime owns the run', () => file().owner?.pid === newPid, 10_000);
  const took = Date.now() - served;
  assert.ok(took <= 5000, `the newer runtime took the run after ${took} ms`);
  await until('the run completes in the newer runtime', () => file().status === 'completed' && file().notice?.state === 'delivered', 120_000);
  const done = file();
  assert.deepEqual(done.result, { first: ['ANSWER(hand one)', 'ANSWER(hand two SLOWONCE:15000)'], last: 'ANSWER(hand last ANSWER(hand one), ANSWER(hand two SLOWONCE:15000))' });
  assert.equal(done.launches, 2, 'one launch in each runtime');
  const asked = (p) => requests().filter((r) => r.kind === 'agent' && r.prompt === p).length;
  assert.equal(asked('hand one'), 1, 'a finished agent is not asked again');
  assert.equal(asked('hand two SLOWONCE:15000'), 2, 'the agent cut off by the update runs again');
  assert.equal(asked('hand last ANSWER(hand one), ANSWER(hand two SLOWONCE:15000)'), 1);
  await until('the older runtime exits', () => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, 60_000);
  c.ws.close();
});
