'use strict';
// One actual shared bridge, independent terminals, deterministic subscription provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, label) => { const until = Date.now() + 20000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
async function main() {
  const binary = process.argv[2];
  const gemini = process.argv.includes('--gemini');
  const model = gemini ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku';
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-shared-provider-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), other = path.join(root, 'other');
  for (const p of [home, cwd, other]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-5.5"\n[features]\nmulti_agent=false\n');
  const sock = path.join(root, 'bridge.sock'), log = path.join(root, 'bridge.log'), control = path.join(root, 'control.json'), calls = path.join(root, 'calls.jsonl');
  const adapter = path.join(root, 'adapter.cjs');
  const agy = path.join(root, 'agy.cjs');
  fs.writeFileSync(agy, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--input-format'))process.stdin.on('data',()=>fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'agy/prompt',args:process.argv.slice(2)})+'\\n'));process.argv.push('--agy-fixture');require(${JSON.stringify(path.resolve(__dirname, 'permissions-bridge.test.cjs'))});\n`, { mode: 0o755 });
  fs.writeFileSync(adapter, `const fs=require('node:fs');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l)fs.appendFileSync(${JSON.stringify(calls)},l+'\\n');}});require(${JSON.stringify(path.resolve(__dirname, 'permissions-bridge.test.cjs'))});\n`);
  const bridge = spawn(process.execPath, [process.env.SHARED_PROVIDER_BRIDGE ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], { cwd, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
    ELPIS_ENGINE_BIN: binary, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: sock, ...(gemini ? { AGY_BIN: agy } : { ELPIS_NO_AGY: '1' }),
    ACP_BRIDGE_LOG: log, ACP_ADAPTER: adapter, ACP_BRIDGE_NO_AGENTS: '1', PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', d => { errors += d; });
  const clients = []; let serial = 0;
  const pass = text => console.log(`PASS ${text}`);
  const history = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const hold = () => { const p = { ready: path.join(root, `ready-${++serial}`), release: path.join(root, `release-${serial}`), marker: path.join(root, `marker-${serial}`) }; fs.writeFileSync(control, JSON.stringify(p)); return p; };
  async function connect(name = 'codex-tui') {
    const ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = { ws, seen: [], pending: new Map(), next: 1, approvals: [] }; clients.push(c);
    ws.on('message', data => {
      const m = JSON.parse(String(data)); c.seen.push(m);
      if (m.method && m.id !== undefined) { c.approvals.push(m); ws.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } })); }
      else if (!m.method) { const p = c.pending.get(m.id); if (p) { c.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    c.req = (method, params = {}) => new Promise((resolve, reject) => { const id = c.next++; const timer = setTimeout(() => { c.pending.delete(id); reject(Error(`timeout ${method}: ${errors}`)); }, 20000); c.pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
    c.event = (method, tid) => c.seen.filter(m => m.method === method && (m.params.threadId ?? m.params.thread?.id) === tid);
    await c.req('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } }); ws.send(JSON.stringify({ method: 'initialized' }));
    return c;
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    const unrelated = await connect();
    const a = await connect();
    const { thread } = await a.req('thread/start', { cwd, model, approvalPolicy: 'never', permissions: ':danger-full-access' });
    await wait(() => unrelated.event('thread/started', thread.id).length, 'other terminal learns provider');
    assert(unrelated.event('thread/started', thread.id).every(m => m.params.thread.model === model));
    pass('provider model is correct in other terminals from the first start event');
    const f = hold();
    const { turn } = await a.req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'held task', text_elements: [] }] });
    await wait(() => fs.existsSync(f.ready), 'provider running');
    const b = await connect();
    const loaded = await b.req('thread/loaded/list'); assert(loaded.data.includes(thread.id));
    const read = await b.req('thread/read', { threadId: thread.id, includeTurns: true });
    assert.equal(read.thread.status.type, 'active'); assert.equal(read.thread.model, model);
    assert(read.thread.turns.some(t => t.id === turn.id));
    const resumed = await b.req('thread/resume', { threadId: thread.id });
    assert.equal(resumed.thread.status.type, 'active'); assert.equal(resumed.thread.model, model);
    assert.equal(resumed.activePermissionProfile.id, ':danger-full-access');
    pass('a later terminal opens the running provider turn with its correct permissions');
    await assert.rejects(b.req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'duplicate', text_elements: [] }] }), /already has an active/);
    assert.equal(history().filter(m => m.method === (gemini ? 'agy/prompt' : 'session/prompt')).length, 1);
    if (!gemini) assert.equal(history().filter(m => m.method === 'session/new' && m.params._meta).length, 1);
    assert.equal(history().filter(m => m.method === 'session/load').length, 0);
    pass('opening and sending cannot create a second provider execution loop');
    // The owner's physical terminal can close while the subscriber keeps working.
    a.ws.close(); await pause(100);
    fs.writeFileSync(f.release, 'release');
    await wait(() => b.event('turn/completed', thread.id).some(m => m.params.turn.id === turn.id), 'subscriber completion');
    assert(fs.existsSync(f.marker)); assert.equal(b.approvals.length, 0);
    pass('provider completion survives its original terminal closing, without Full Access prompts');
    const f2 = hold();
    await b.req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'continue same session', text_elements: [] }] });
    await wait(() => fs.existsSync(f2.ready), 'continued turn');
    await b.req('turn/interrupt', { threadId: thread.id });
    await wait(() => b.event('turn/completed', thread.id).length >= 2, 'interrupt completion');
    if (!gemini) assert.equal(history().filter(m => m.method === 'session/new' && m.params._meta).length, 1);
    assert.equal(history().filter(m => m.method === 'session/load').length, 0);
    pass('a subscriber continues and interrupts the original provider session');
    await b.req('thread/settings/update', { threadId: thread.id, approvalPolicy: 'on-request', permissions: ':workspace' });
    const helper = await connect('elpis-agents');
    const h = await helper.req('thread/start', { cwd: other, model, approvalPolicy: 'on-request', sandbox: 'read-only', elpisParentThreadId: thread.id });
    const f3 = hold();
    await helper.req('turn/start', { threadId: h.thread.id, input: [{ type: 'text', text: 'ask parent terminal', text_elements: [] }] });
    await wait(() => fs.existsSync(f3.ready), 'helper running'); fs.writeFileSync(f3.release, 'release');
    await wait(() => b.approvals.length === 1, 'parent approval');
    await wait(() => helper.event('turn/completed', h.thread.id).length, 'helper completed');
    assert.equal(unrelated.approvals.length, 0); assert(!fs.existsSync(f3.marker));
    pass('helper approvals reach the parent chat subscriber, never an unrelated terminal');
    const f4 = hold();
    const beforeReconnect = await b.req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'approval waits for my terminal', text_elements: [] }] });
    await wait(() => fs.existsSync(f4.ready), 'disconnected approval turn');
    b.ws.close(); await pause(100); fs.writeFileSync(f4.release, 'release'); await pause(150);
    assert.equal(unrelated.approvals.length, 0); assert(!fs.existsSync(f4.marker));
    const later = await connect();
    const reopened = await later.req('thread/resume', { threadId: thread.id });
    assert.equal(reopened.activePermissionProfile.id, ':workspace'); assert.equal(reopened.approvalPolicy, 'on-request');
    await wait(() => later.approvals.length === 1, 'reconnected approval');
    await wait(() => later.event('turn/completed', thread.id).some(m => m.params.turn.id === beforeReconnect.turn.id), 'reconnected approval completion');
    assert(!fs.existsSync(f4.marker));
    pass('pending approval waits for its chat to reopen and preserves the latest restricted permissions');
    await unrelated.req('thread/name/set', { threadId: thread.id, name: 'Renamed from another terminal' });
    await wait(() => later.event('thread/name/updated', thread.id).some(m => m.params.threadName === 'Renamed from another terminal'), 'rename broadcast');
    const renamed = await later.req('thread/read', { threadId: thread.id, includeTurns: false });
    assert.equal(renamed.thread.name, 'Renamed from another terminal');
    pass('rename from another terminal updates both the live event and reopened metadata');
    const f5 = hold();
    await later.req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'archive stops this task', text_elements: [] }] });
    await wait(() => fs.existsSync(f5.ready), 'archive held turn');
    await unrelated.req('thread/archive', { threadId: thread.id });
    await wait(() => later.event('thread/archived', thread.id).length, 'archive broadcast');
    fs.writeFileSync(f5.release, 'release'); await pause(150);
    const active = await unrelated.req('thread/loaded/list');
    assert(!active.data.includes(thread.id)); assert(!fs.existsSync(f5.marker));
    pass('archiving from another terminal ends its provider turn and unloads the session');
    assert.equal(bridge.exitCode, null, errors);
  } finally {
    for (const c of clients) { for (const p of c.pending.values()) clearTimeout(p.timer); c.ws.terminate(); }
    bridge.kill('SIGTERM');
    await Promise.race([new Promise(r => bridge.once('exit', r)), pause(5000).then(() => bridge.kill('SIGKILL'))]);
    fs.writeFileSync(path.join(root, 'stderr.log'), errors); console.log(`Evidence ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
