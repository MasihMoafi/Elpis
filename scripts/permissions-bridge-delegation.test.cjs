'use strict';
// A bridge helper runs on its delegate tool's own connection, with its own engine. It must stay
// within the permissions its parent chat's engine confirmed: at its start, on a follow-up, from
// the next tool after a reduction while it runs, and when a fresh delegate server reopens it. A
// reduction is sticky; the chat's grants reach only new helpers, never beyond what they asked.
// Real bridge, engine and elpis-agents server, isolated home. Claude and Gemini helpers use the
// fixtures in permissions-bridge.test.cjs; engine helpers use a local Responses fixture and the
// real sandbox, behind a pass-through that can refuse or ignore the bridge's own restrictions.
// Usage: node scripts/permissions-bridge-delegation.test.cjs /absolute/engine [absolute/bridge] [--keep-going]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message, call } = require('../editors/vscode/test/runtime-eval');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The TUI's permission modes: profile and approval policy.
const MODES = { default: [':workspace', 'on-request'], readOnly: [':read-only', 'on-request'], full: [':danger-full-access', 'never'] };

if (process.argv.includes('--engine-fault')) engineFault();
else main().catch(error => { console.error(error.stack); process.exitCode = 1; });

// The engine, unchanged, except that a thread/settings/update the bridge sends itself (a helper
// restriction) is refused or left unanswered while ENGINE_FAULT_CONTROL says so.
function engineFault() {
  const readline = require('node:readline');
  const engine = spawn(process.env.ENGINE_FAULT_REAL, process.argv.slice(process.argv.indexOf('--engine-fault') + 1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = line => process.stdout.write(line + '\n');
  readline.createInterface({ input: engine.stdout }).on('line', out);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let msg = null;
    try { msg = JSON.parse(line); } catch {}
    const fault = msg?.method === 'thread/settings/update' && String(msg.id).startsWith('acp-bridge-engine-')
      && JSON.parse(fs.readFileSync(process.env.ENGINE_FAULT_CONTROL, 'utf8')).settings;
    if (fault === 'reject') out(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'Fixture engine refuses the update' } }));
    else if (fault !== 'hang') engine.stdin.write(line + '\n');
  }).on('close', () => engine.stdin.end());
  engine.stdin.on('error', () => {});
  engine.on('exit', code => process.exit(code ?? 1));
  process.on('SIGTERM', () => engine.kill());
}

async function main() {
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
  const bridgePath = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  // Keep going past a failing group, to record every failure (as when checking a bridge before a fix).
  const keepGoing = process.argv.includes('--keep-going');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-bridge-delegation-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const provider = new Provider();
  await provider.start();
  // The engine reopens a helper in the configured default sandbox, not the one it started with;
  // a writable default lets a reopened helper write, so the bridge's own limit on it shows.
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nsandbox_mode="workspace-write"\n[features]\nsubagents=false\n[model_providers.fixture]\nname="Delegation fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const control = path.join(root, 'control.json'), log = path.join(root, 'bridge.log');
  const faultControl = path.join(root, 'engine-fault.json');
  const fault = settings => fs.writeFileSync(faultControl, JSON.stringify({ settings }));
  fault(null);
  const engineShim = path.join(root, 'engine'), agyShim = path.join(root, 'agy');
  fs.writeFileSync(engineShim, `#!/usr/bin/env node\nprocess.argv.splice(2, 0, '--engine-fault'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  fs.writeFileSync(agyShim, `#!/usr/bin/env node\nprocess.argv.push('--agy-fixture'); require(${JSON.stringify(path.join(__dirname, 'permissions-bridge.test.cjs'))});\n`, { mode: 0o755 });
  const checks = [], failures = [], approvals = [], messages = [], servers = [], controls = [];
  let files = 0;
  const waitFor = async (check, label, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (!check()) { assert(Date.now() < deadline, `${label} timed out`); await pause(20); }
  };
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  const disconnects = () => (fs.readFileSync(log, 'utf8').match(/tui disconnected/g) ?? []).length;
  const bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
    cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
      PORT: '0', ELPIS_ENGINE_BIN: engineShim, ENGINE_FAULT_REAL: binary, ENGINE_FAULT_CONTROL: faultControl,
      ACP_ADAPTER: path.join(__dirname, 'permissions-bridge.test.cjs'), AGY_BIN: agyShim,
      ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(home, 'sessions.json'),
      PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let ws;
  try {
    await waitFor(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, 'utf8')), 'bridge start');
    const url = `ws://127.0.0.1:${fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/)[1]}`;
    // The parent chat's TUI. It declines every question, including those relayed from helpers.
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const events = new EventEmitter(), pending = new Map();
    let nextId = 1;
    ws.on('message', data => {
      const msg = JSON.parse(String(data)); messages.push(msg);
      if (msg.method && msg.id !== undefined) { approvals.push(msg.params); ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } })); }
      else if (msg.method) events.emit(msg.method, msg.params);
      else { const p = pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
    });
    const notification = (method, threadId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off(method, receive); reject(Error(`${method} timed out`)); }, 20000);
      function receive(params) { if (threadId && params?.threadId !== threadId) return; clearTimeout(timer); events.off(method, receive); resolve(params); }
      events.on(method, receive);
    });
    await request('initialize', { clientInfo: { name: 'bridge_delegation_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    // Applies a mode to the parent and waits until its engine confirms it.
    async function select(threadId, mode) {
      const [permissions, approvalPolicy] = MODES[mode];
      const applied = notification('thread/settings/updated', threadId);
      await request('thread/settings/update', { threadId, approvalPolicy, permissions });
      assert.equal((await applied).threadSettings.approvalPolicy, approvalPolicy);
    }
    // A Claude chat (the delegate tool is offered to Claude and Antigravity chats) in a confirmed mode.
    async function parent(mode) {
      const { thread } = await request('thread/start', { cwd, model: 'claude/haiku', approvalPolicy: 'on-request', permissions: ':workspace' });
      if (mode !== 'default') await select(thread.id, mode);
      return thread.id;
    }
    // The parent chat's elpis-agents server, as the bridge configures it for that chat's session.
    async function delegateServer(parentThreadId) {
      const proc = spawn(process.execPath, [path.resolve(__dirname, '../tools/elpis-claude/elpis-agents-mcp.mjs')], {
        cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, ELPIS_ENGINE_BIN: binary, ELPIS_BRIDGE_URL: url,
          ELPIS_PARENT_THREAD: parentThreadId, ELPIS_AGENTS_LOG: path.join(root, 'agents.log') }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      servers.push(proc);
      const calls = new Map();
      let seq = 0, buffer = '';
      proc.stdout.on('data', chunk => {
        buffer += chunk;
        for (let i; (i = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          const msg = line.trim() && JSON.parse(line), p = msg && calls.get(msg.id);
          if (p) { calls.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
        }
      });
      proc.once('exit', () => { for (const p of calls.values()) p.reject(Error('elpis-agents exited')); });
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq; calls.set(id, { resolve, reject }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge_delegation_fixture', version: '1' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const delegate = async args => {
        const text = (await rpc('tools/call', { name: 'delegate', arguments: { task: 'Fixture write.', cwd, wait: true, ...args } })).content[0].text;
        return { text, threadId: text.match(/Elpis thread (\S+)\)/)?.[1], status: text.match(/status: (\S+)/)?.[1] };
      };
      // Ends the server and waits until the bridge has closed its connections (none are left
      // when the bridge stopped its helper already).
      delegate.stop = async () => {
        if (proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
        for (let seen = -1; seen !== disconnects();) { seen = disconnects(); await pause(500); }
      };
      return delegate;
    }
    // One helper turn: start it, wait until its provider holds it, run `during`, release it.
    async function turn(delegate, args, held, release, during) {
      const start = approvals.length;
      let result, error;
      const done = delegate(args).then(r => { result = r; }, e => { error = e; });
      await waitFor(() => held() || result || error, 'helper turn');
      if (during && !result && !error) await during();
      release();
      await waitFor(() => result || error, 'helper turn end', 60000);
      if (error) throw error;
      assert(result, 'the delegate call did not finish');
      return { ...result, prompts: approvals.length - start };
    }
    // A Claude helper: the fixture edits on release, natively in Accept edits/Auto/Bypass, or
    // through an approval callback in any other mode.
    async function claudeHelper(delegate, args, during, fixture = {}) {
      const prefix = path.join(root, String(++files));
      const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`, modeChanges: `${prefix}.modes`, autoEdit: true, ...fixture };
      controls.push(ctl);
      fs.writeFileSync(control, JSON.stringify(ctl));
      const t = await turn(delegate, { model: 'claude/haiku', ...args }, () => fs.existsSync(ctl.ready), () => fs.writeFileSync(ctl.release, 'release'), during);
      return { ...t, wrote: fs.existsSync(ctl.marker) };
    }
    // An engine helper: the model asks to write in the workspace with the default sandbox.
    async function engineHelper(delegate, args, during) {
      const marker = path.join(cwd, `engine-${++files}`);
      const item = call(`write_${files}`, 'exec_command', { cmd: `printf helper > '${marker}'` });
      provider.actions.push({ hang: true }, message('Done.'));
      const t = await turn(delegate, { model: 'gpt-5.5', provider: 'fixture', ...args }, () => provider.hanging.size > 0, () => {
        const response = [...provider.hanging][0];
        if (!response) return;
        provider.hanging.delete(response);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ type: 'response.created', response: { id: `r_${files}` } }, { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: `r_${files}`, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]
          .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      }, during);
      if (t.status === 'completed') assert.equal(provider.actions.length, 0, 'the helper used every scripted model response');
      provider.actions.length = 0;
      return { ...t, wrote: fs.existsSync(marker) };
    }
    async function group(label, run) {
      try { await run(); } catch (error) {
        if (!keepGoing) throw error;
        failures.push(`${label}: ${error.message}`); console.log(`FAIL ${label}: ${error.message}`);
        for (const ctl of controls) fs.writeFileSync(ctl.release, 'release');
        for (const response of provider.hanging) response.destroy();
        provider.hanging.clear(); provider.actions.length = 0; fault(null);
        await pause(1000);
      } finally {
        // Each group's parents have their own elpis-agents server; its helper connections close with it.
        for (const proc of servers.splice(0)) proc.kill();
      }
    }

    // Controls: the helper's own scope under a writable (Default) parent.
    await group('Claude helper controls', async () => {
      const delegate = await delegateServer(await parent('default'));
      const writable = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(writable.status, 'completed'); assert.equal(writable.prompts, 0, 'prompts'); assert.equal(writable.wrote, true, 'write');
      pass('Default parent: a writable Claude helper edits without prompting');
      const readOnly = await claudeHelper(delegate, { allow_writes: false });
      assert.equal(readOnly.prompts, 1, 'its question reaches the parent TUI'); assert.equal(readOnly.wrote, false, 'write');
      pass('Default parent: a read-only Claude helper asks, and the declined edit stays absent');
    });
    await group('engine helper controls', async () => {
      const delegate = await delegateServer(await parent('default'));
      const writable = await engineHelper(delegate, { allow_writes: true });
      assert.equal(writable.status, 'completed'); assert.equal(writable.prompts, 0, 'prompts'); assert.equal(writable.wrote, true, 'write');
      pass('Default parent: a writable engine helper writes in its workspace');
      const readOnly = await engineHelper(delegate, { allow_writes: false });
      assert.equal(readOnly.wrote, false, 'the read-only sandbox must block the write');
      pass('Default parent: a read-only engine helper is sandboxed');
    });
    // A helper may not exceed its parent's confirmed permissions when it starts.
    await group('Read Only parent, writable Claude helper', async () => {
      const delegate = await delegateServer(await parent('readOnly'));
      const t = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(t.wrote, false, 'a Read Only parent must not start a helper that edits without approval');
      pass('Read Only parent: allow_writes does not let a Claude helper edit');
    });
    await group('Read Only parent, writable engine helper', async () => {
      const delegate = await delegateServer(await parent('readOnly'));
      const t = await engineHelper(delegate, { allow_writes: true });
      assert.equal(t.wrote, false, 'a Read Only parent must not start a helper with a writable sandbox');
      pass('Read Only parent: allow_writes does not let an engine helper write');
    });
    // A parent reduction applies to its helpers from their next tool; a refused change fails closed.
    const followUp = (name, fixture) => group(name, async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const first = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper edits before the reduction');
      await select(parentId, 'readOnly');
      const t = await claudeHelper(delegate, { thread_id: first.threadId }, undefined, fixture);
      assert.equal(t.wrote, false, 'the follow-up must use the parent\'s reduced permissions');
      pass(name);
    });
    await followUp('a Claude helper\'s follow-up after the parent becomes Read Only does not edit');
    await followUp('a Claude helper whose provider refuses the restriction does not edit', { rejectMode: 'default' });
    await group('running Claude helper, parent reduced', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const t = await claudeHelper(delegate, { allow_writes: true }, () => select(parentId, 'readOnly'));
      assert.equal(t.wrote, false, 'the next edit after the confirmed reduction must not run');
      pass('a running Claude helper adopts the parent\'s Read Only at its next tool');
    });
    await group('running engine helper, parent reduced', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const t = await engineHelper(delegate, { allow_writes: true }, () => select(parentId, 'readOnly'));
      assert.equal(t.wrote, false, 'the next tool after the confirmed reduction must not write');
      pass('a running engine helper adopts the parent\'s Read Only at its next tool');
    });
    // Full Access is the parent's alone.
    await group('parent Full Access does not promote helpers', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const running = await claudeHelper(delegate, { allow_writes: false }, () => select(parentId, 'full'));
      assert.equal(running.wrote, false, 'a running read-only helper must not gain Full Access');
      pass('a running read-only Claude helper stays read-only when the parent gains Full Access');
      const fresh = await claudeHelper(delegate, { allow_writes: false });
      assert.equal(fresh.prompts, 0, 'prompts'); assert.equal(fresh.wrote, false, 'write');
      pass('a Full Access parent starts a read-only Claude helper read-only');
      const engine = await engineHelper(delegate, { allow_writes: false });
      assert.equal(engine.wrote, false, 'write');
      pass('a Full Access parent starts a read-only engine helper sandboxed');
    });
    // A reduction is sticky; a later grant reaches only new helpers, up to what they ask for.
    await group('sticky reduction', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const first = await engineHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper writes before the reduction');
      await select(parentId, 'readOnly'); await select(parentId, 'default');
      const followUp = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(followUp.wrote, false, 'a reduced helper must not regain write access');
      pass('an engine helper reduced by its chat stays read-only after the chat regains write access');
      const fresh = await engineHelper(delegate, { allow_writes: true });
      assert.equal(fresh.wrote, true, 'a new helper gets the scope it asks for');
      pass('a chat that regains write access starts new writable helpers');
    });
    await group('fast revoke and grant', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const first = await engineHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper writes before the reduction');
      const seen = () => messages.filter(m => m.method === 'thread/settings/updated' && m.params?.threadId === parentId).map(m => m.params.threadSettings.approvalPolicy);
      const before = seen().length;
      await Promise.all([
        request('thread/settings/update', { threadId: parentId, approvalPolicy: 'on-request', permissions: ':read-only' }),
        request('thread/settings/update', { threadId: parentId, approvalPolicy: 'never', permissions: ':danger-full-access' })]);
      await waitFor(() => seen().length >= before + 2, 'both confirmations');
      assert.deepEqual(seen().slice(before), ['on-request', 'never'], 'the TUI hears the revoke, then the grant');
      const followUp = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(followUp.wrote, false, 'the grant must not undo the revoke for the helper');
      pass('a fast revoke and grant reach the TUI in order and leave the helper read-only');
    });
    await group('fresh delegate server', async () => {
      const parentId = await parent('default');
      let delegate = await delegateServer(parentId);
      const first = await engineHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper writes before it is closed');
      await delegate.stop();
      delegate = await delegateServer(parentId);
      const reopened = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(reopened.wrote, true, 'a reopened helper keeps its write scope');
      pass('a helper reopened by a fresh delegate server keeps its write scope');
      await delegate.stop();
      await select(parentId, 'readOnly'); await select(parentId, 'default');
      delegate = await delegateServer(parentId);
      const reduced = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(reduced.wrote, false, 'a reduction made while the helper was closed must apply');
      pass('a reduction made while a helper was closed applies when a fresh delegate server reopens it');
    });
    await group('rejected chat update', async () => {
      const parentId = await parent('readOnly');
      await assert.rejects(request('thread/settings/update', { threadId: parentId, approvalPolicy: 'never', permissions: ':missing-profile' }));
      const t = await engineHelper(await delegateServer(parentId), { allow_writes: true });
      assert.equal(t.wrote, false, 'a rejected grant must not let a helper write');
      pass('a rejected chat update does not let a new helper write');
    });
    // The helper's engine refuses its restriction, or never confirms it: the helper stops, and
    // stays closed until a restriction applies.
    const refused = (name, mode) => group(name, async () => {
      const parentId = await parent('default');
      let delegate = await delegateServer(parentId);
      const t = await engineHelper(delegate, { allow_writes: true }, () => { fault(mode); return select(parentId, 'readOnly'); });
      assert.equal(t.wrote, false, 'the helper must not write after its chat\'s reduction');
      assert.equal(t.status, 'failed', 'the helper is stopped');
      pass(name);
      if (mode !== 'reject') { fault(null); return; }
      await delegate.stop();
      delegate = await delegateServer(parentId);
      assert.match((await delegate({ thread_id: t.threadId })).text, /Could not reopen/, 'reopening applies the restriction first');
      pass('a helper whose engine refuses its restriction is not reopened');
      fault(null);
      await delegate.stop();
      delegate = await delegateServer(parentId);
      const reopened = await engineHelper(delegate, { thread_id: t.threadId });
      assert.equal(reopened.status, 'completed', 'status'); assert.equal(reopened.wrote, false, 'write');
      pass('once its engine applies the restriction, the reopened helper runs read-only');
    });
    await refused('a helper whose engine refuses its restriction is stopped before its next tool', 'reject');
    await refused('a helper whose engine does not confirm its restriction is stopped before its next tool', 'hang');
    await group('nested helper', async () => {
      const parentId = await parent('default');
      const outer = await claudeHelper(await delegateServer(parentId), { allow_writes: true });
      assert.equal(outer.wrote, true, 'the outer helper edits');
      const inner = await delegateServer(outer.threadId);
      const first = await engineHelper(inner, { allow_writes: true });
      assert.equal(first.wrote, true, 'a writable helper\'s writable helper writes');
      const t = await engineHelper(inner, { thread_id: first.threadId }, () => select(parentId, 'readOnly'));
      assert.equal(t.wrote, false, 'the chat\'s reduction must reach its helper\'s helper');
      pass('a chat\'s reduction reaches a running nested helper at its next tool');
    });
    // Antigravity has no native-edit mode below Full Access, so this guards rather than separates.
    await group('Gemini helper', async () => {
      const t = await claudeHelper(await delegateServer(await parent('readOnly')), { model: 'agy/gemini-3.8-flash-medium', allow_writes: true });
      assert.equal(t.prompts, 1, 'its question reaches the parent TUI'); assert.equal(t.wrote, false, 'write');
      pass('Read Only parent: a writable Gemini helper asks, and the declined write stays absent');
    });
    if (failures.length) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, failures, approvals, messages, requests: provider.requests }, null, 2));
    console.log(`Evidence: ${root}`);
    for (const proc of servers) proc.kill();
    ws?.close(); bridge.kill(); provider.close();
  }
}

