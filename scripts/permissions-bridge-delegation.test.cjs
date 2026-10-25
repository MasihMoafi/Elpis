'use strict';
// A233/A251, R59/R60; desktop SPEC P2/P3: automatic helpers follow the shared default,
// independently of their parent's chat menu, and never ask the person for tool approval.
// Explicit read-only task scopes and the helper's own choices remain bounded across running
// turns, follow-ups, fresh delegate servers and the TUI. Managed restrictions still fail closed.
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
const { Provider, message, call } = require('./lib/mock-provider.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The TUI's permission modes: profile and approval policy.
const MODES = { default: [':workspace', 'on-request'], readOnly: [':read-only', 'on-request'], readOnlyNever: [':read-only', 'never'], full: [':danger-full-access', 'never'] };

if (process.argv.includes('--engine-fault')) engineFault();
else main().catch(error => { console.error(error.stack); process.exitCode = 1; });

// The engine, unchanged, except as ENGINE_FAULT_CONTROL says: a thread/settings/update the bridge
// sends itself (a helper restriction) is refused or left unanswered, or a helper's thread/start
// (from the delegate tool) is answered only once a release file appears.
function engineFault() {
  const readline = require('node:readline');
  const engine = spawn(process.env.ENGINE_FAULT_REAL, process.argv.slice(process.argv.indexOf('--engine-fault') + 1), { stdio: ['pipe', 'pipe', 'ignore'] });
  const out = line => process.stdout.write(line + '\n');
  const heldStarts = new Map(); // thread/start id -> its hold's files
  readline.createInterface({ input: engine.stdout }).on('line', line => {
    let id;
    try { id = JSON.parse(line).id; } catch {}
    const hold = heldStarts.get(id);
    if (!hold) { out(line); return; }
    heldStarts.delete(id);
    fs.writeFileSync(hold.held, 'held');
    const timer = setInterval(() => { if (fs.existsSync(hold.release)) { clearInterval(timer); out(line); } }, 10);
  });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let msg = null;
    try { msg = JSON.parse(line); } catch {}
    const control = JSON.parse(fs.readFileSync(process.env.ENGINE_FAULT_CONTROL, 'utf8'));
    if (msg?.method === 'configRequirements/read' && control.requirements) {
      fs.appendFileSync(`${process.env.ENGINE_FAULT_CONTROL}.requirements.jsonl`, JSON.stringify({ id: msg.id, method: msg.method }) + '\n');
      out(JSON.stringify({ id: msg.id, result: { requirements: control.requirements } })); return;
    }
    if (msg?.method === 'thread/start' && String(msg.id).startsWith('agents-') && control.holdStart) heldStarts.set(msg.id, control.holdStart);
    const fault = msg?.method === 'thread/settings/update' && String(msg.id).startsWith('acp-bridge-engine-')
      && (!control.settingsThreadId || msg.params?.threadId === control.settingsThreadId) && control.settings;
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
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(storeDir);
  const faultControl = path.join(root, 'engine-fault.json');
  const fault = (settings, holdStart, requirements, settingsThreadId) => fs.writeFileSync(faultControl, JSON.stringify({ settings, holdStart, requirements, settingsThreadId }));
  fault(null);
  const engineShim = path.join(root, 'engine'), agyShim = path.join(root, 'agy');
  fs.writeFileSync(engineShim, `#!/usr/bin/env node\nprocess.argv.splice(2, 0, '--engine-fault'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  fs.writeFileSync(agyShim, `#!/usr/bin/env node\nprocess.argv.push('--agy-fixture'); require(${JSON.stringify(path.join(__dirname, 'permissions-bridge.test.cjs'))});\n`, { mode: 0o755 });
  const checks = [], failures = [], approvals = [], messages = [], servers = [], controls = [], observations = [];
  let files = 0, currentGroup, defaultMode = 'full';
  const waitFor = async (check, label, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (!check()) { assert(Date.now() < deadline, `${label} timed out`); await pause(20); }
  };
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  const observe = (kind, result) => {
    const { threadId, status, prompts, wrote, refused, permissionResult, providerModes } = result;
    const observation = { group: currentGroup, kind, threadId, status, prompts, wrote, ...(refused && { refused }), ...(permissionResult && { permissionResult }), ...(providerModes && { providerModes }) };
    observations.push(observation);
    console.log(`OBSERVED ${JSON.stringify(observation)}`);
  };
  const disconnects = () => (fs.readFileSync(log, 'utf8').match(/tui disconnected/g) ?? []).length;
  const bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
    cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
      PORT: '0', ELPIS_ENGINE_BIN: engineShim, ENGINE_FAULT_REAL: binary, ENGINE_FAULT_CONTROL: faultControl,
      ACP_ADAPTER: path.join(__dirname, 'permissions-bridge.test.cjs'), AGY_BIN: agyShim,
      ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(storeDir, 'sessions.json'),
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
    async function setDefault(mode) {
      const [permissions, approvalPolicy] = MODES[mode];
      defaultMode = mode;
      await request('config/batchWrite', { edits: [
        { keyPath: 'approval_policy', value: approvalPolicy, mergeStrategy: 'replace' },
        { keyPath: 'approvals_reviewer', value: 'user', mergeStrategy: 'replace' },
        { keyPath: 'default_permissions', value: permissions, mergeStrategy: 'replace' },
      ] });
    }
    async function runningHelper(parentId) {
      const listed = await request('thread/list', { ancestorThreadId: parentId, modelProviders: [], archived: false, limit: 100, useStateDbOnly: true });
      const running = listed.data.filter(thread => thread.status?.type === 'active');
      assert.equal(running.length, 1, 'this parent has one running helper');
      return running[0].id;
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
      const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`, modeChanges: `${prefix}.modes`, permissionResult: `${prefix}.permission`, autoEdit: true, ...fixture };
      controls.push(ctl);
      fs.writeFileSync(control, JSON.stringify(ctl));
      const t = await turn(delegate, { model: 'claude/haiku', ...args }, () => fs.existsSync(ctl.ready), () => fs.writeFileSync(ctl.release, 'release'), during);
      const result = { ...t, wrote: fs.existsSync(ctl.marker), permissionResult: fs.existsSync(ctl.permissionResult) ? JSON.parse(fs.readFileSync(ctl.permissionResult, 'utf8')) : null,
        providerModes: fs.existsSync(ctl.modeChanges) ? fs.readFileSync(ctl.modeChanges, 'utf8').trim().split('\n') : [] };
      observe(args.model?.startsWith('agy/') ? 'gemini' : 'claude', result);
      return result;
    }
    // The model's step in an engine turn: once released, write in the workspace with the default sandbox.
    function scriptedWrite(before = '') {
      const id = ++files, marker = path.join(cwd, `engine-${id}`);
      const item = call(`write_${id}`, 'exec_command', { cmd: `${before}printf helper > '${marker}'` });
      provider.actions.push({ hang: true }, message('Done.'));
      return { marker, release: () => {
        const response = [...provider.hanging][0];
        if (!response) return;
        provider.hanging.delete(response);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ type: 'response.created', response: { id: `r_${id}` } }, { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: `r_${id}`, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]
          .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } };
    }
    // An engine helper's turn through its delegate tool.
    async function engineHelper(delegate, args, during, before) {
      const step = scriptedWrite(before);
      const t = await turn(delegate, { model: 'gpt-5.5', provider: 'fixture', ...args }, () => provider.hanging.size > 0, step.release, during);
      const result = { ...t, wrote: fs.existsSync(step.marker) };
      observe('engine', result);
      if (t.status === 'completed') assert.equal(provider.actions.length, 0, 'the helper used every scripted model response');
      provider.actions.length = 0;
      return result;
    }
    // The TUI's turn on an engine thread it opened, with the permission fields the TUI sends;
    // `refused` when the bridge refuses to start it.
    const tuiFields = { approvalPolicy: 'on-request', permissions: ':workspace' };
    async function tuiTurn(threadId, during) {
      const step = scriptedWrite(), start = approvals.length;
      try { await request('turn/start', { threadId, input: [{ type: 'text', text: 'Fixture write.' }], ...tuiFields }); } catch (error) {
        provider.actions.length = 0;
        const result = { refused: error.message, wrote: false };
        observe('tui', { threadId, ...result });
        return result;
      }
      let completed;
      const done = notification('turn/completed', threadId).then(p => { completed = p; }, () => {});
      await waitFor(() => provider.hanging.size > 0 || completed, 'TUI turn');
      if (during && !completed) await during();
      step.release();
      await done;
      provider.actions.length = 0;
      const result = { status: completed?.turn.status, prompts: approvals.length - start, wrote: fs.existsSync(step.marker) };
      observe('tui', { threadId, ...result });
      return result;
    }
    const profileOf = r => r.activePermissionProfile?.id ?? { readOnly: ':read-only', workspaceWrite: ':workspace', dangerFullAccess: ':danger-full-access' }[r.sandbox?.type];
    async function group(label, run) {
      currentGroup = label;
      try { await run(); } catch (error) {
        if (!keepGoing) throw error;
        failures.push(`${label}: ${error.message}`); console.log(`FAIL ${label}: ${error.message}`);
        for (const ctl of controls) fs.writeFileSync(ctl.release, 'release');
        for (const response of provider.hanging) response.destroy();
        provider.hanging.clear(); provider.actions.length = 0; fault(null); fs.chmodSync(storeDir, 0o755);
        await pause(1000);
      } finally {
        // Each group's parents have their own elpis-agents server; its helper connections close with it.
        for (const proc of servers.splice(0)) proc.kill();
        fault(null);
        if (fs.existsSync(path.join(home, 'permission-choices'))) fs.chmodSync(path.join(home, 'permission-choices'), 0o700);
        if (defaultMode !== 'full') await setDefault('full');
      }
    }

    await group('saved Claude default and explicit engine helper model', async () => {
      const engineModel = (await request('config/read', { includeLayers: false })).config.model;
      const setDefault = model => request('config/batchWrite', { edits: [{ keyPath: 'model', value: model, mergeStrategy: 'replace' }] });
      await setDefault('claude/haiku');
      try {
        const user = await request('thread/start', { cwd, model: engineModel, ...tuiFields });
        assert.equal(user.model, 'claude/haiku', 'a new user chat sending the engine default still takes the saved Claude default');
        pass('Saved Claude default: a new user chat sending the engine default uses Claude');

        const delegate = await delegateServer(await parent('default'));
        const before = provider.requests.length;
        provider.actions.push(message('Done.'));
        // Release the existing Claude fixture too, so a misrouted helper finishes and exposes its model.
        const helper = await claudeHelper(delegate, { model: engineModel, provider: 'fixture' });
        assert.equal(helper.status, 'completed');
        // Read, not resume: the delegate server still holds the helper as its one writer.
        const read = await request('thread/read', { threadId: helper.threadId, includeTurns: false });
        assert.equal(read.thread.model, engineModel, 'a helper explicitly requesting the engine default must keep that model');
        const requests = provider.requests.slice(before);
        assert.equal(requests.length, 1, 'the helper ran through the local engine provider');
        assert.equal(requests[0].body.model, engineModel, 'the provider received the requested helper model');
        const stored = JSON.parse(fs.readFileSync(path.join(storeDir, 'sessions.json'), 'utf8'))[helper.threadId];
        assert.equal(stored?.session, undefined, 'the engine helper must not create a Claude session');
        assert.equal(stored?.turns?.length ?? 0, 0, 'the engine helper must not create Claude turns');
        pass('Saved Claude default: an explicit engine helper runs and reports the engine model');
      } finally {
        provider.actions.length = 0;
        await setDefault(engineModel);
      }
    });

    await group('engine helper status in the agents tree', async () => {
      const chat = await parent('default');
      const delegate = await delegateServer(chat);
      const list = () => request('thread/list', { ancestorThreadId: chat, modelProviders: [], archived: false,
        limit: 100, useStateDbOnly: true });
      const listed = async id => (await list()).data.find(thread => thread.id === id);
      assert.deepEqual((await list()).data, [], 'a delegate server does not invent an unstarted helper');
      const unownedSteer = { threadId: '00000000-0000-4000-8000-000000000000',
        expectedTurnId: '00000000-0000-4000-8000-000000000000', input: [{ type: 'text', text: 'Unknown helper.' }] };
      let unownedError;
      await assert.rejects(request('turn/steer', unownedSteer), error => { unownedError = error.message; return true; });

      const claude = await claudeHelper(delegate, { allow_writes: true });
      const claudeBefore = await listed(claude.threadId);
      assert.equal(claudeBefore?.status?.type, 'idle', 'the Claude helper is idle after its turn');

      const steerText = 'A50 steer delivered to the running helper';
      const before = provider.requests.length;
      let followed;
      const engine = await engineHelper(delegate, { allow_writes: true }, async () => {
        const working = (await list()).data.find(thread => thread.id !== claude.threadId);
        assert(working?.id, 'the running engine helper is listed as a descendant');
        assert.equal(working.status?.type, 'active', 'the running helper is Working in the agents tree');
        // The app opens a running helper the way it opens any chat; its delegate engine answers.
        const opened = await request('thread/resume', { threadId: working.id, excludeTurns: true,
          initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } }).catch(error => ({ error: error.message }));
        assert.equal(opened.thread?.status?.type, 'active', `another client opens the running helper (${opened.error ?? 'opened'})`);
        // The app finds the turn to show (and Stop) from the latest page of turns.
        const latest = await request('thread/turns/list', { threadId: working.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        assert.equal(latest.data?.[0]?.status, 'inProgress', 'another client sees the helper’s running turn');
        followed = notification('turn/completed', working.id).catch(() => null);
        const read = await request('thread/read', { threadId: working.id, includeTurns: false });
        assert.equal(read.thread.status?.type, 'active', 'thread/read has the same live status');
        const turnId = working.turns.at(-1)?.id;
        assert(turnId, 'the listed running turn can be steered');
        const steer = await request('turn/steer', { threadId: working.id, expectedTurnId: turnId,
          input: [{ type: 'text', text: steerText }] });
        assert.equal(steer.turnId, turnId, 'the delegate engine answered the other client');
      });
      assert.equal(engine.status, 'completed');
      assert.equal((await followed)?.turn?.status, 'completed', 'the client that opened the helper sees its turn end');
      const told = await tuiTurn(engine.threadId);
      assert.equal(told.status, 'completed', `another client tells the finished helper again (${told.refused ?? told.status})`);
      assert(provider.requests.slice(before).some(r => JSON.stringify(r.body.input).includes(steerText)),
        'the delegate engine sent the steer text in its next Responses request');
      const done = await listed(engine.threadId);
      assert.equal(done?.status?.type, 'idle', 'the completed helper is idle in the agents tree');
      assert.equal(done.turns.at(-1)?.status, 'completed', 'the completed helper is Done in the agents tree');
      const read = await request('thread/read', { threadId: engine.threadId, includeTurns: true });
      assert.equal(read.thread.status?.type, 'idle', 'thread/read has the completed status');
      assert.equal(read.thread.turns.at(-1)?.status, 'completed', 'thread/read retains the completed turn');
      const claudeAfter = await listed(claude.threadId);
      assert.deepEqual(claudeAfter.status, claudeBefore.status, 'engine status tracking leaves Claude status unchanged');

      const interrupted = await engineHelper(delegate, { allow_writes: true }, async () => {
        const working = (await list()).data.find(thread => ![claude.threadId, engine.threadId].includes(thread.id));
        assert.equal(working?.status?.type, 'active', 'the second engine helper is running');
        const turnId = working.turns.at(-1)?.id;
        assert(turnId, 'the listed running turn can be interrupted');
        await request('turn/interrupt', { threadId: working.id, turnId });
      });
      assert.equal(interrupted.status, 'interrupted', 'the other client interrupted the delegate turn');
      assert.equal(interrupted.wrote, false, 'the interrupted helper never ran its scripted write');
      await assert.rejects(request('turn/steer', unownedSteer), { message: unownedError },
        'a steer for an unowned thread keeps its original error');
      pass('Engine helpers show Working then Done, route another client’s steer and interrupt, and leave other statuses unchanged');
    });

    // Controls: the helper's own scope under a writable (Default) parent.
    await group('Claude helper controls', async () => {
      const delegate = await delegateServer(await parent('default'));
      const writable = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(writable.status, 'completed'); assert.equal(writable.prompts, 0, 'prompts'); assert.equal(writable.wrote, true, 'write');
      assert.equal(writable.permissionResult?.outcome?.optionId, 'allow', 'Full access answers the actual provider permission callback');
      assert(!writable.providerModes.includes('bypassPermissions'), 'R59: Full access never selects provider Bypass');
      pass('Default parent: a writable Claude helper edits without prompting');
      const readOnly = await claudeHelper(delegate, { allow_writes: false });
      assert.equal(readOnly.wrote, false, 'an explicit read-only task cannot edit');
      assert.equal(readOnly.prompts, 0, 'P3: a scoped automatic helper never asks the person');
      assert.equal(readOnly.permissionResult?.outcome?.optionId, 'deny', 'the actual ACP permission callback denies the edit');
      pass('an explicitly read-only Claude helper denies its edit without prompting');
    });
    await group('engine helper controls', async () => {
      const delegate = await delegateServer(await parent('default'));
      const writable = await engineHelper(delegate, { allow_writes: true });
      assert.equal(writable.status, 'completed'); assert.equal(writable.prompts, 0, 'prompts'); assert.equal(writable.wrote, true, 'write');
      pass('Default parent: a writable engine helper writes in its workspace');
      const readOnly = await engineHelper(delegate, { allow_writes: false });
      assert.equal(readOnly.wrote, false, 'the read-only sandbox must block the write');
      assert.equal(readOnly.prompts, 0, 'P3: a scoped automatic engine helper never asks the person');
      pass('Default parent: a read-only engine helper is sandboxed');
      // Masih, 20 Oct: "read-only agents are of no use to us"; a helper writes unless told not to.
      const unspecified = await engineHelper(delegate, {});
      assert.equal(unspecified.prompts, 0, 'prompts'); assert.equal(unspecified.wrote, true, 'a helper may write by default');
      pass('Default parent: a helper started without allow_writes writes');
    });
    // P2/P3: the parent's own choice does not replace an automatic helper's shared default.
    await group('Read Only parent, inherited Claude helper', async () => {
      const delegate = await delegateServer(await parent('readOnly'));
      const t = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(t.wrote, true, 'the helper inherits the Full access default, independently of the parent menu');
      assert.equal(t.prompts, 0, 'the automatic helper does not prompt');
      pass('a Claude helper follows the Full access default below a manually read-only parent');
    });
    await group('Read Only parent, inherited engine helper', async () => {
      const delegate = await delegateServer(await parent('readOnly'));
      const t = await engineHelper(delegate, { allow_writes: true });
      assert.equal(t.wrote, true, 'the helper inherits the Full access default, independently of the parent menu');
      assert.equal(t.prompts, 0, 'the automatic helper does not prompt');
      pass('an engine helper follows the Full access default below a manually read-only parent');
    });
    await group('managed helper restrictions', async () => {
      const delegate = await delegateServer(await parent('default'));
      fault(null, undefined, { allowedApprovalPolicies: ['never', 'on-request'], allowedSandboxModes: ['read-only'], allowedApprovalsReviewers: ['user'] });
      const requirementsLog = `${faultControl}.requirements.jsonl`;
      const requirementReads = () => fs.existsSync(requirementsLog) ? fs.readFileSync(requirementsLog, 'utf8').trim().split('\n').length : 0;
      const beforeRequirements = requirementReads();
      const before = provider.requests.length;
      const blocked = await engineHelper(delegate, { allow_writes: true });
      assert(requirementReads() > beforeRequirements, 'the new helper reads the managed requirements proxy at its start');
      assert.equal(blocked.wrote, false, 'P4: an automatic helper cannot use a managed-forbidden Full access default');
      assert.equal(blocked.prompts, 0, 'a managed refusal does not become a user approval');
      assert.match(blocked.text, /restricted by managed settings/i, 'the refused permission mode is reported');
      assert.equal(provider.requests.length, before, 'a forbidden mode is refused before inference');
      const beforeScopedRequirements = requirementReads();
      const scoped = await claudeHelper(delegate, { allow_writes: false });
      assert(requirementReads() > beforeScopedRequirements, 'the scoped helper also rechecks current managed requirements at its start');
      assert.equal(scoped.wrote, false, 'the managed-allowed explicit read-only task still cannot edit');
      assert.equal(scoped.prompts, 0, 'an allowed scoped task does not ask the person');
      assert.equal(scoped.permissionResult?.outcome?.optionId, 'deny', 'the allowed scoped task denies its actual edit');
      pass('managed restrictions refuse a forbidden automatic mode and preserve allowed explicit scopes');
    });
    // P2/P3: a helper's own explicit restriction applies on its next turn and survives reopening.
    const followUp = (name, fixture) => group(name, async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const first = await claudeHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper edits before the reduction');
      await select(first.threadId, 'readOnlyNever');
      const t = await claudeHelper(delegate, { thread_id: first.threadId }, undefined, fixture);
      assert.equal(t.wrote, false, 'the follow-up must keep the helper\'s explicit restricted choice');
      assert.equal(t.prompts, 0, 'the restriction must not become a user approval');
      pass(name);
    });
    await followUp('a Claude helper\'s follow-up keeps its own Read Only choice');
    await followUp('a Claude helper whose provider refuses its own restriction does not edit', { rejectMode: 'plan' });
    await group('running Claude helper, own permissions reduced', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const t = await claudeHelper(delegate, { allow_writes: true }, async () => select(await runningHelper(parentId), 'readOnlyNever'));
      assert.equal(t.wrote, false, 'the next edit after the helper\'s own confirmed reduction must not run');
      pass('a running Claude helper adopts its own Read Only choice before its next tool');
    });
    await group('running engine helper, shared default reduced', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const t = await engineHelper(delegate, { allow_writes: true }, () => setDefault('readOnlyNever'));
      assert.equal(t.wrote, false, 'the next tool after the confirmed reduction must not write');
      pass('a running inherited engine helper adopts the shared Read Only default before its next tool');
    });
    // P3: explicit task scopes survive parent-menu and shared-default grants.
    await group('parent Full Access does not promote helpers', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const running = await claudeHelper(delegate, { allow_writes: false }, () => select(parentId, 'full'));
      assert.equal(running.wrote, false, 'a running read-only helper must not gain Full Access');
      pass('a running read-only Claude helper stays read-only when the parent gains Full Access');
      await setDefault('default'); await setDefault('full');
      const resumed = await claudeHelper(delegate, { thread_id: running.threadId });
      assert.equal(resumed.wrote, false, 'an explicit read-only task scope survives shared-default grants');
      assert.equal(resumed.prompts, 0, 'an explicit read-only task still does not prompt');
      const fresh = await claudeHelper(delegate, { allow_writes: false });
      assert.equal(fresh.prompts, 0, 'prompts'); assert.equal(fresh.wrote, false, 'write');
      pass('a Full Access parent starts a read-only Claude helper read-only');
      const engine = await engineHelper(delegate, { allow_writes: false });
      assert.equal(engine.wrote, false, 'write');
      pass('a Full Access parent starts a read-only engine helper sandboxed');
    });
    // R59/R60 and P2/P3 replace the former A48 parent cap: the shared default owns automatic writers.
    await group('Full Access default gives a writing helper Full Access independently of its parent', async () => {
      const listen = `'${process.execPath}' -e "require('net').createServer().listen(0, '127.0.0.1', () => process.exit(0)).on('error', () => process.exit(1))" && `;
      const full = await parent('full');
      const engine = await engineHelper(await delegateServer(full), { allow_writes: true }, undefined, listen);
      assert.equal(engine.wrote, true, 'a writing helper of a Full Access chat opens a local server');
      pass('a Full Access parent starts a writing engine helper with Full Access');
      const workspace = await parent('default');
      await select(workspace, 'default');
      const independent = await engineHelper(await delegateServer(workspace), { allow_writes: true }, undefined, listen);
      assert.equal(independent.wrote, true, 'a parent\'s Workspace choice does not replace its helper\'s Full access default');
      assert.equal(independent.prompts, 0, 'the helper opens the local server without a user approval');
      pass('a Workspace parent leaves an inherited helper in the shared Full access default');
    });
    // P2: the helper's own explicit choice survives later shared-default changes.
    await group('explicit helper restriction survives default changes', async () => {
      const parentId = await parent('default');
      const delegate = await delegateServer(parentId);
      const first = await engineHelper(delegate, { allow_writes: true });
      assert.equal(first.wrote, true, 'the helper writes before the reduction');
      await select(first.threadId, 'readOnlyNever');
      await setDefault('default'); await setDefault('full');
      const followUp = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(followUp.wrote, false, 'an explicit helper choice wins over later shared-default changes');
      pass('an explicitly restricted engine helper stays read-only after a shared-default grant');
      const fresh = await engineHelper(delegate, { allow_writes: true });
      assert.equal(fresh.wrote, true, 'a new helper gets the scope it asks for');
      pass('a chat that regains write access starts new writable helpers');
    });
    await group('fast parent revoke and grant do not change a helper default', async () => {
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
      assert.equal(followUp.wrote, true, 'the parent\'s menu choices do not detach a helper from the shared default');
      assert.equal(followUp.prompts, 0, 'the automatic helper does not prompt');
      pass('a fast parent revoke and grant reach the TUI in order without replacing a helper\'s default');
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
      await select(first.threadId, 'readOnlyNever');
      delegate = await delegateServer(parentId);
      const reduced = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(reduced.wrote, false, 'the helper\'s own restriction made while closed must apply');
      assert.equal(reduced.prompts, 0, 'the reopened restricted helper does not prompt');
      pass('the helper\'s explicit restriction made while closed applies on a fresh delegate server');
    });
    await group('rejected helper update', async () => {
      const delegate = await delegateServer(await parent('default'));
      const first = await engineHelper(delegate, { allow_writes: false });
      assert.equal(first.wrote, false, 'the helper starts explicitly read-only');
      await assert.rejects(request('thread/settings/update', { threadId: first.threadId, approvalPolicy: 'never', permissions: ':missing-profile' }));
      const t = await engineHelper(delegate, { thread_id: first.threadId });
      assert.equal(t.wrote, false, 'a rejected grant must not lift the helper\'s explicit scope');
      assert.equal(t.prompts, 0, 'a refused grant does not become a user approval');
      pass('a rejected helper update preserves its explicit read-only scope');
    });
    // P3/P4: failed application of a shared-default restriction stops the affected helper.
    const refused = (name, mode) => group(name, async () => {
      const parentId = await parent('default');
      let delegate = await delegateServer(parentId);
      const t = await engineHelper(delegate, { allow_writes: true }, async () => {
        fault(mode, undefined, undefined, await runningHelper(parentId));
        await assert.rejects(setDefault('readOnlyNever'), /could not be updated|could not apply|refus/i, 'a failed default application is reported');
      });
      assert.equal(t.wrote, false, 'the helper must not write after the shared default restricts it');
      assert.equal(t.status, 'failed', 'the helper is stopped');
      pass(name);
      if (mode !== 'reject') { fault(null); return; }
      await delegate.stop();
      delegate = await delegateServer(parentId);
      const reopened = await engineHelper(delegate, { thread_id: t.threadId });
      assert.equal(reopened.wrote, false, 'reopening while its engine refuses the restriction cannot write');
      assert.notEqual(reopened.status, 'completed', 'the refused restriction is not reported as a successful turn');
      pass('the stopped helper fails closed while its engine still refuses the restricted default');
      fault(null);
      const recovered = await engineHelper(delegate, { thread_id: t.threadId });
      assert.equal(recovered.status, 'completed', `status: ${recovered.text}`);
      assert.equal(recovered.wrote, false, 'the recovered helper keeps the restricted default');
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
      const t = await engineHelper(inner, { thread_id: first.threadId }, () => setDefault('readOnlyNever'));
      assert.equal(t.wrote, false, 'the shared-default reduction must reach a running nested helper');
      assert.equal(t.prompts, 0, 'the nested automatic helper does not prompt');
      pass('a shared-default restriction reaches a running nested helper before its next tool');
    });
    // Antigravity has no native-edit mode below Full Access, so this guards rather than separates.
    await group('Gemini helper', async () => {
      const delegate = await delegateServer(await parent('readOnly'));
      const writable = await claudeHelper(delegate, { model: 'agy/gemini-3.8-flash-medium', allow_writes: true });
      assert.equal(writable.wrote, true, 'a Gemini helper follows the shared default independently of the parent menu');
      assert.equal(writable.prompts, 0, 'the automatic Gemini helper does not prompt');
      const scoped = await claudeHelper(delegate, { model: 'agy/gemini-3.8-flash-medium', allow_writes: false });
      assert.equal(scoped.wrote, false, 'a Gemini helper must respect its explicit read-only scope');
      assert.equal(scoped.prompts, 0, 'a scoped Gemini helper denies instead of asking');
      pass('Gemini helpers follow the shared default and retain explicit read-only scopes without prompts');
    });
    // P2/P3: a pending automatic start follows the last shared default, without sticky parent revocations.
    await group('helper start pending across shared-default changes', async () => {
      for (const mode of ['readOnlyNever', 'full']) {
        const parentId = await parent('default');
        const delegate = await delegateServer(parentId);
        const hold = { held: path.join(root, `${++files}.start-held`), release: path.join(root, `${files}.start-release`) };
        fault(null, hold);
        const starting = engineHelper(delegate, { allow_writes: true }).then(t => t, e => e);
        await waitFor(() => fs.existsSync(hold.held), 'held helper start');
        fault(null);
        await setDefault('readOnlyNever');
        if (mode === 'full') await setDefault('full');
        fs.writeFileSync(hold.release, 'release');
        const t = await starting;
        if (t instanceof Error) throw t;
        assert.equal(t.wrote, mode === 'full', `a pending inherited helper follows the final ${mode} default`);
        assert.equal(t.prompts, 0, 'the pending helper does not ask after the default changes');
        const fresh = await engineHelper(delegate, { allow_writes: true });
        assert.equal(fresh.wrote, mode === 'full', 'a newly started helper follows the same final default');
        await setDefault('full');
      }
      pass('pending and fresh inherited helpers follow the last shared default without prompting');
    });
    // P2/P3: cached TUI fields cannot replace the helper's explicit choice or its inherited default.
    await group('helper opened in the TUI', async () => {
      const keptParent = await parent('default'), reducedParent = await parent('default');
      const keptServer = await delegateServer(keptParent), reducedServer = await delegateServer(reducedParent);
      const kept = await engineHelper(keptServer, { allow_writes: true }), reduced = await engineHelper(reducedServer, { allow_writes: true });
      assert.equal(kept.wrote && reduced.wrote, true, 'both helpers write before');
      await keptServer.stop(); await reducedServer.stop();
      await select(reduced.threadId, 'readOnlyNever');
      assert.equal(profileOf(await request('thread/resume', { threadId: reduced.threadId })), ':read-only', 'the TUI is shown the reduced helper read-only');
      const t = await tuiTurn(reduced.threadId);
      assert.equal(t.wrote, false, 'the TUI\'s own permission fields must not raise the helper');
      pass('a reduced helper opened in the TUI stays read-only, also under the TUI\'s permission fields');
      assert.equal(profileOf(await request('thread/resume', { threadId: kept.threadId })), ':danger-full-access', 'an inherited helper keeps the shared Full access default');
      const k = await tuiTurn(kept.threadId);
      assert.equal(k.wrote, true, 'write');
      pass('an unreduced helper opened in the TUI keeps its write scope');
    });
    // A TUI's engine also runs the user's other chats: a refused restriction stops only the helper.
    await group('restriction refused for a helper open in the TUI', async () => {
      const parentId = await parent('default');
      const server = await delegateServer(parentId);
      const h = await engineHelper(server, { allow_writes: true });
      await server.stop();
      await request('thread/resume', { threadId: h.threadId });
      const t = await tuiTurn(h.threadId, async () => {
        fault('reject', undefined, undefined, h.threadId);
        await assert.rejects(setDefault('readOnlyNever'), /could not be updated|could not apply|refus/i);
      });
      assert.equal(t.wrote, false, 'the helper must not write after the shared default restricts it');
      assert.equal(ws.readyState, WebSocket.OPEN, 'the TUI connection stays open');
      await request('thread/read', { threadId: parentId });
      assert.match((await tuiTurn(h.threadId)).refused ?? '', /stopped|refus|could not apply/i, 'the helper does not run until its restriction applies');
      pass('a refused restriction stops a TUI-hosted helper without closing the TUI');
      fault(null);
      const applied = await tuiTurn(h.threadId);
      assert.equal(applied.status, 'completed', 'status'); assert.equal(applied.wrote, false, 'write');
      pass('once its restriction applies, the TUI-hosted helper runs read-only');
    });
    // A second delegate server reaches the existing helper runtime without opening another writer.
    await group('one helper on two delegate servers', async () => {
      const parentId = await parent('default');
      const first = await delegateServer(parentId), second = await delegateServer(parentId);
      const h = await engineHelper(first, { allow_writes: true });
      assert.equal(h.wrote, true, 'the first copy writes before the reduction');
      const reopened = await engineHelper(second, { thread_id: h.threadId });
      assert.doesNotMatch(reopened.text, /already has an active writer/);
      assert.equal(reopened.wrote, true, `the second server writes before the reduction: ${reopened.text}`);
      await select(h.threadId, 'readOnlyNever');
      assert.equal((await engineHelper(first, { thread_id: h.threadId })).wrote, false, 'the first server\'s copy');
      assert.equal((await engineHelper(second, { thread_id: h.threadId })).wrote, false, 'the second server\'s turn');
      pass('a helper\'s own explicit restriction reaches either delegate server');
    });
    // P2: a failed explicit-choice save is reported; no follow-up may silently regain write access.
    await group('helper choice not saved', async () => {
      const parentId = await parent('default');
      let delegate = await delegateServer(parentId);
      const h = await engineHelper(delegate, { allow_writes: true });
      await delegate.stop();
      fs.chmodSync(path.join(home, 'permission-choices'), 0o500);
      await assert.rejects(select(h.threadId, 'readOnlyNever'), /could not be saved/, 'the TUI is told its helper choice was not saved');
      fs.chmodSync(path.join(home, 'permission-choices'), 0o700);
      delegate = await delegateServer(parentId);
      const reopened = await engineHelper(delegate, { thread_id: h.threadId });
      assert.equal(reopened.wrote, false, 'a failed helper-choice save must not silently restore write access');
      pass('a failed helper-choice save is reported and does not silently restore writes');
    });
    if (failures.length) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, failures, observations, approvals, messages, requests: provider.requests }, null, 2));
    console.log(`Evidence: ${root}`);
    for (const proc of servers) proc.kill();
    ws?.close(); bridge.kill(); provider.close();
  }
}
