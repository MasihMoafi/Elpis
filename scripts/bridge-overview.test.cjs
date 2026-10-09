'use strict';
// The agents view of one TUI lists the root sessions of another on the SAME bridge. Each bridge
// connection has its own engine, so the bridge must tell the other TUIs of a root session's start,
// status, name and end, and only those: not a helper's, an ephemeral thread's, or its turn events.
// Real bridge and engine, isolated home, local Responses fixture.
// Usage: node scripts/bridge-overview.test.cjs /absolute/path/to/elpis [absolute/bridge]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message } = require('../editors/vscode/test/runtime-eval');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  throw Error(`Timed out: ${label}`);
}

async function main() {
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
  const bridgePath = process.argv[3] ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-bridge-overview-'));
  const home = path.join(root, 'home'), log = path.join(root, 'bridge.log');
  const first = path.join(root, 'first-project'), second = path.join(root, 'second-project');
  for (const dir of [home, first, second, path.join(root, 'store')]) fs.mkdirSync(dir);
  const provider = new Provider();
  await provider.start();
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nsandbox_mode="workspace-write"\n[features]\nsubagents=false\n[model_providers.fixture]\nname="Overview fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const bridge = spawn(process.execPath, [bridgePath], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, PORT: '0',
      ELPIS_ENGINE_BIN: binary, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(root, 'store', 'sessions.json'),
      ACP_ADAPTER: path.join(__dirname, 'permissions-bridge.test.cjs'), PERMISSION_FIXTURE_ADAPTER: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const sockets = [], checks = [];
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    await waitFor(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, 'utf8')), 'bridge start');
    const url = `ws://127.0.0.1:${fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/)[1]}`;
    async function client(name) {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const c = { ws, seen: [], pending: new Map(), nextId: 1 };
      ws.on('message', data => {
        const msg = JSON.parse(String(data));
        if (msg.method && msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
        else if (msg.method) c.seen.push(msg);
        else { const p = c.pending.get(msg.id); c.pending.delete(msg.id); if (p) msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      });
      c.request = (method, params) => new Promise((resolve, reject) => {
        const id = c.nextId++; c.pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
      });
      c.events = (method, threadId) => c.seen.filter(m => m.method === method && (m.params.threadId ?? m.params.thread?.id) === threadId);
      await c.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: 'initialized' }));
      sockets.push(ws);
      return c;
    }
    const a = await client('codex-tui'), b = await client('codex-tui'), helper = await client('elpis-agents');
    const turn = async (c, threadId, text) => {
      provider.actions.push(message(text));
      await c.request('turn/start', { threadId, input: [{ type: 'text', text: 'go', text_elements: [] }] });
      await waitFor(() => c.events('turn/completed', threadId).length || c.seen.some(m => m.method === 'turn/completed' && m.params.threadId === threadId), `${text} turn`);
    };
    const statuses = (c, threadId) => c.events('thread/status/changed', threadId).map(m => m.params.status.type);

    // A starts a session in its folder: B, not the delegate tool, hears of it once, with its model.
    const { thread: one } = await a.request('thread/start', { cwd: first, model: 'gpt-5.5' });
    await waitFor(() => b.events('thread/started', one.id).length, 'B hears of A session');
    assert.equal(b.events('thread/started', one.id)[0].params.thread.cwd, first);
    assert.equal(b.events('thread/started', one.id)[0].params.thread.model, 'gpt-5.5');
    assert.equal(a.events('thread/started', one.id).length, 1, 'A hears of its own session once');
    await pause(300);
    assert.equal(b.events('thread/started', one.id).length, 1, 'B hears once');
    assert.equal(helper.events('thread/started', one.id).length, 0, 'a delegate connection is not a TUI');
    pass('a second TUI is told of a root session once, with its folder and model; a delegate tool is not');

    // Its turn: the status reaches B in order, and its turn events do not.
    await turn(a, one.id, 'FIRST_DONE');
    await waitFor(() => statuses(b, one.id).at(-1) === 'idle', 'B sees the turn end');
    assert(statuses(b, one.id).includes('active'), 'B saw it working');
    assert.deepEqual(statuses(b, one.id), statuses(a, one.id), 'B hears each status once, in order');
    assert.equal(b.seen.filter(m => /^(turn|item)\//.test(m.method) && m.params.threadId === one.id).length, 0, 'B hears no turn or item events');
    pass('status changes reach the other TUI once and in order; turn events stay on their connection');

    // A rename follows, and a session B starts is listed by A the same way.
    await a.request('thread/name/set', { threadId: one.id, name: 'First sentinel' });
    await waitFor(() => b.events('thread/name/updated', one.id).length, 'B sees the rename');
    assert.equal(b.events('thread/name/updated', one.id).at(-1).params.threadName, 'First sentinel');
    const { thread: two } = await b.request('thread/start', { cwd: second, model: 'gpt-5.5' });
    await waitFor(() => a.events('thread/started', two.id).length, 'A hears of B session');
    assert.equal(a.events('thread/started', two.id).length, 1);
    assert.equal(b.events('thread/started', two.id).length, 1);
    pass('renames and sessions started on the other TUI are shared both ways');

    // A Claude chat keeps its own model name for the other TUI (the engine knows only its default).
    const { thread: claude } = await a.request('thread/start', { cwd: first, model: 'claude/haiku' });
    await waitFor(() => b.events('thread/started', claude.id).length, 'B hears of the Claude chat');
    assert.equal(b.events('thread/started', claude.id)[0].params.thread.model, 'claude/haiku');
    pass('a Claude chat is announced under its Claude model');

    // Not sessions of their own: an ephemeral thread, and a thread of the delegate connection.
    const { thread: hidden } = await a.request('thread/start', { cwd: first, model: 'gpt-5.5', ephemeral: true });
    const { thread: mine } = await helper.request('thread/start', { cwd: first, model: 'gpt-5.5' });
    await pause(500);
    assert.equal(b.events('thread/started', hidden.id).length, 0, 'an ephemeral thread is not shared');
    assert.equal(b.events('thread/started', mine.id).length, 0, 'a delegate connection thread is not shared');
    assert.equal(a.events('thread/started', mine.id).length, 0);
    pass('ephemeral and delegate-connection threads are not announced');

    // Archived: shared once, and the session is no longer announced.
    await turn(b, two.id, 'SECOND_DONE');
    await b.request('thread/archive', { threadId: two.id });
    await waitFor(() => a.events('thread/archived', two.id).length, 'A sees the archive');
    assert.equal(b.events('thread/archived', two.id).length, 1);
    await pause(300);
    assert.equal(a.events('thread/archived', two.id).length, 1, 'A hears of the archive once');
    pass('an archived session is announced once');

    // A TUI that opens later reads the live session as live, not as not loaded; once it is gone, as not loaded.
    const late = await client('codex-tui');
    assert.equal((await late.request('thread/read', { threadId: one.id, includeTurns: false })).thread.status.type, 'idle');
    assert.notEqual((await late.request('thread/read', { threadId: two.id, includeTurns: false })).thread.status.type, 'idle', 'an archived session is not live');
    pass('a TUI that opens later reads another TUI\'s live session as live');

    // A TUI that goes away takes its live sessions with it, and only those.
    const closes = () => b.seen.filter(m => m.method === 'thread/closed').map(m => m.params.threadId);
    a.ws.close();
    await waitFor(() => closes().includes(one.id), 'B hears that A session is gone');
    assert(!closes().includes(two.id), 'an archived session is not closed again');
    assert(!closes().includes(mine.id) && !closes().includes(hidden.id));
    assert.equal(closes().filter(id => id === one.id).length, 1);
    pass('a disconnected TUI closes its own live sessions for the others, once');
    assert.equal((await late.request('thread/read', { threadId: one.id, includeTurns: false })).thread.status.type, 'notLoaded');
    pass('a closed session reads as not loaded again');
    assert(!provider.error, provider.error?.message);
  } finally {
    for (const ws of sockets) ws.terminate();
    bridge.kill();
    provider.close();
    console.log(`${checks.length} checks. Evidence: ${root}`);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
