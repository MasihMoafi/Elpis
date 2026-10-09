'use strict';
// Real websocket bridge and engine, deterministic ACP adapter, isolated home.
// Usage: node scripts/permissions-bridge.test.cjs /absolute/engine [absolute/bridge] [--gemini] [--shared]
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--agy-fixture')) {
  if (process.argv.includes('models')) {
    console.log('gemini-3.8-flash-medium\tGemini fixture');
  } else {
    const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
    send({ event: 'init', conversation_id: randomUUID() });
    require('node:readline').createInterface({ input: process.stdin }).on('line', async () => {
      const control = JSON.parse(fs.readFileSync(process.env.PERMISSION_FIXTURE_CONTROL, 'utf8'));
      fs.writeFileSync(control.ready, 'ready');
      while (!fs.existsSync(control.release)) await pause(10);
      let allowed = true;
      if (process.env.ELPIS_AGY_GATE) {
        allowed = await new Promise((resolve, reject) => {
          const socket = require('node:net').connect(process.env.ELPIS_AGY_GATE);
          let data = '';
          socket.once('error', reject);
          socket.once('connect', () => socket.write(JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: control.marker } } }) + '\n'));
          socket.on('data', chunk => { data += chunk; });
          socket.once('end', () => resolve(JSON.parse(data).allowed));
        });
      }
      if (allowed) fs.writeFileSync(control.marker, 'allowed');
      send({ event: 'result', result: { status: 'SUCCESS' } });
    });
  }
} else if (process.env.PERMISSION_FIXTURE_ADAPTER) {
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'haiku', options: [{ value: 'haiku', name: 'Haiku' }] }];
  // One prompt and mode per ACP session, so two chats can run at once.
  const prompts = new Map(), modes = new Map(), asked = new Map();
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method) {
      const sessionId = asked.get(msg.id); asked.delete(msg.id);
      const prompt = prompts.get(sessionId);
      if (!prompt) return;
      if (prompt.permissionResult) fs.writeFileSync(prompt.permissionResult, JSON.stringify(msg.result));
      if (msg.result?.outcome?.optionId === 'allow') fs.writeFileSync(prompt.marker, 'allowed');
      if (prompt.planProbe) return;
      send({ id: prompt.id, result: { stopReason: 'end_turn' } });
      prompts.delete(sessionId);
      return;
    }
    if (msg.method === 'session/prompt') {
      const control = JSON.parse(fs.readFileSync(process.env.PERMISSION_FIXTURE_CONTROL, 'utf8'));
      const sessionId = msg.params.sessionId;
      const prompt = { ...control, id: msg.id };
      prompts.set(sessionId, prompt);
      fs.writeFileSync(control.ready, 'ready');
      prompt.timer = setInterval(() => {
        if (!fs.existsSync(control.release)) return;
        clearInterval(prompt.timer);
        if (control.autoEdit && ['acceptEdits', 'auto', 'bypassPermissions'].includes(modes.get(sessionId))) {
          fs.writeFileSync(control.marker, 'allowed by provider mode');
          send({ id: prompt.id, result: { stopReason: 'end_turn' } });
          prompts.delete(sessionId);
          return;
        }
        const id = `permission-${randomUUID()}`;
        asked.set(id, sessionId);
        send({ id, method: 'session/request_permission', params: {
          sessionId: control.unknownSession ? randomUUID() : sessionId, toolCall: { toolCallId: randomUUID(), title: 'Fixture write' },
          options: [{ optionId: control.planProbe ? 'exit-plan-default' : 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
        } });
      }, 10);
      return;
    }
    if (msg.method === 'session/set_mode') {
      const control = JSON.parse(fs.readFileSync(process.env.PERMISSION_FIXTURE_CONTROL, 'utf8'));
      if (control.rejectMode === msg.params.modeId) {
        send({ id: msg.id, error: { code: -32603, message: 'Fixture refuses mode change' } });
        return;
      }
      const mode = msg.params.modeId, prompt = prompts.get(msg.params.sessionId);
      modes.set(msg.params.sessionId, mode);
      if (control.modeChanges) fs.appendFileSync(control.modeChanges, mode + '\n');
      if (prompt?.planProbe && mode === 'acceptEdits') {
        send({ id: prompt.id, result: { stopReason: 'end_turn' } });
        prompts.delete(msg.params.sessionId);
      }
    }
    if (msg.method === 'session/cancel') {
      const prompt = prompts.get(msg.params.sessionId);
      clearInterval(prompt?.timer);
      if (prompt) send({ id: prompt.id, result: { stopReason: 'cancelled' } });
      if (!prompt?.keepPendingOnCancel) prompts.delete(msg.params.sessionId);
      return;
    }
    const result = msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : msg.method === 'session/new' ? { sessionId: randomUUID(), configOptions }
      : { configOptions };
    if (msg.id !== undefined) send({ id: msg.id, result });
  });
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const WebSocket = require('../tools/elpis-claude/node_modules/ws');
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'elpis-bridge-permissions-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-5.5"\n[features]\nsubagents=false\n[permissions.fixture-restricted]\nextends=":read-only"\n');
  const control = path.join(root, 'control.json');
  const agy = process.argv.includes('--gemini');
  const shared = process.argv.includes('--shared');
  const agyBinary = path.join(root, 'agy');
  if (agy) fs.writeFileSync(agyBinary, `#!/usr/bin/env node\nprocess.argv.push('--agy-fixture'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  const bridgePath = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  // Keep going past a failing group, to record every failure (as when checking a bridge before a fix).
  const keepGoing = process.argv.includes('--keep-going');
  const model = agy ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku';
  const checks = [], failures = [], clients = [], holds = [];
  let files = 0; // each fixture turn's own control files
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 20000;
    while (!check()) { assert(Date.now() < deadline, `${label} timed out`); await pause(20); }
  };
  const logged = (file, pattern) => fs.existsSync(file) && pattern.test(fs.readFileSync(file, 'utf8'));
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  // One bridge process, with its own engine, and its websocket. A restart is a new one on the same home.
  async function launch() {
    const log = path.join(root, `bridge-${clients.length + 1}.log`);
    const socket = path.join(root, `bridge-${clients.length + 1}.sock`);
    const bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
      cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
        PORT: '0', ...(shared ? { ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socket } : {}), ELPIS_ENGINE_BIN: binary, ACP_ADAPTER: __filename, ...(agy ? { AGY_BIN: agyBinary } : { ELPIS_NO_AGY: '1' }), ACP_BRIDGE_NO_AGENTS: '1',
        ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(home, 'sessions.json'),
        PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const c = { bridge, log, messages: [], events: new EventEmitter(), pending: new Map(), nextId: 1, approvals: [], held: null, full: new Map() };
    clients.push(c);
    await waitFor(() => logged(log, /LISTENING /), 'bridge start');
    c.ws = new WebSocket(shared ? `ws+unix://${socket}:/` : `ws://127.0.0.1:${fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/)[1]}`);
    await new Promise((resolve, reject) => { c.ws.once('open', resolve); c.ws.once('error', reject); });
    c.ws.on('message', data => {
      const msg = JSON.parse(String(data)); c.messages.push(msg);
      if (msg.method && msg.id !== undefined) {
        c.approvals.push(msg.params);
        if (c.held) c.held.push(msg);
        else c.ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
      } else if (msg.method) c.events.emit(msg.method, msg.params);
      else { const p = c.pending.get(msg.id); c.pending.delete(msg.id); if (p) msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
    });
    c.request = (method, params) => new Promise((resolve, reject) => {
      const id = c.nextId++; c.pending.set(id, { resolve, reject }); c.ws.send(JSON.stringify({ id, method, params }));
    });
    c.notification = (method, threadId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.events.off(method, receive); reject(Error(`${method} timed out`)); }, 20000);
      function receive(params) { if (threadId && params?.threadId !== threadId) return; clearTimeout(timer); c.events.off(method, receive); resolve(params); }
      c.events.on(method, receive);
    });
    c.stop = async () => {
      c.ws.close();
      await waitFor(() => logged(log, /tui disconnected/), 'bridge disconnect');
      if (bridge.exitCode === null && bridge.signalCode === null) await new Promise(resolve => { bridge.once('exit', resolve); bridge.kill(); });
      if (shared) assert(!fs.existsSync(socket), 'cold restart must remove the old shared listener after its engine stops');
    };
    await c.request('initialize', { clientInfo: { name: 'bridge_permission_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    c.ws.send(JSON.stringify({ method: 'initialized' }));
    return c;
  }
  let c, thread;
  try {
    c = await launch();
    const newThread = async () => (await c.request('thread/start', { cwd, model, approvalPolicy: 'on-request', permissions: ':workspace' })).thread;
    thread = await newThread();
    async function select(wantFull, threadId = thread.id) {
      if ((c.full.get(threadId) ?? false) === wantFull) return;
      const permissions = wantFull === 'readOnly' ? ':read-only'
        : wantFull === 'workspaceNever' ? ':workspace'
          : wantFull === 'customNever' ? 'fixture-restricted'
            : wantFull ? ':danger-full-access' : ':workspace';
      const applied = c.notification('thread/settings/updated', threadId);
      await c.request('thread/settings/update', { threadId, approvalPolicy: wantFull ? 'never' : 'on-request', permissions });
      assert.equal((await applied).threadSettings.approvalPolicy, wantFull ? 'never' : 'on-request');
      c.full.set(threadId, wantFull);
    }
    // Starts a fixture turn and, unless its setup is meant to fail, waits until the provider holds it.
    async function hold(threadId, fixture = {}, turnParams = {}) {
      const prefix = path.join(root, String(++files));
      const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`, ...fixture };
      holds.push(ctl);
      fs.writeFileSync(control, JSON.stringify(ctl));
      const completed = c.notification('turn/completed', threadId);
      const { turn } = await c.request('turn/start', { threadId, input: [{ type: 'text', text: 'Fixture write.' }], ...turnParams });
      if (!fixture.setupFailure) await waitFor(() => fs.existsSync(ctl.ready), 'ACP prompt');
      return { ctl, completed, turnId: turn.id, release: () => fs.writeFileSync(ctl.release, 'release'), wrote: () => fs.existsSync(ctl.marker) };
    }
    async function probe(name, before, after, prompts, writes, interrupted = false, options = {}) {
      const { thread: threadId = thread.id, turnParams, ...fixture } = options;
      await select(before, threadId);
      const start = c.approvals.length;
      const turn = await hold(threadId, fixture, turnParams);
      if (after === 'invalid') {
        await assert.rejects(c.request('thread/settings/update', { threadId, approvalPolicy: 'never', permissions: ':missing-profile' }));
      } else if (after !== undefined) await select(after, threadId);
      turn.release();
      assert.equal((await turn.completed).turn.status, fixture.setupFailure ? 'failed' : interrupted ? 'interrupted' : 'completed', name);
      if (fixture.setupFailure) assert.equal(fs.existsSync(turn.ctl.ready), false, `${name}: provider prompt must not run`);
      assert.equal(c.approvals.length - start, prompts, `${name}: prompts`);
      assert.equal(turn.wrote(), writes, `${name}: write`);
      pass(name);
    }
    async function group(label, run) {
      try { await run(); } catch (error) {
        if (!keepGoing) throw error;
        failures.push(`${label}: ${error.message}`); console.log(`FAIL ${label}: ${error.message}`);
        c.held = null;
        for (const ctl of holds) fs.writeFileSync(ctl.release, 'release');
        await pause(1000);
      }
    }
    await group('existing', async () => {
      await probe('restricted mode denies the fixture write', false, undefined, 1, false);
      await probe('idle Full Access approves without prompting', true, undefined, 0, true);
      await probe('in-flight Full Access uses confirmed live permission', false, true, 0, true);
      await probe('revoking Full Access cancels the bypass turn', true, false, 0, false, true);
      await probe('rejected permission update never grants access', false, 'invalid', 1, false);
      await probe('read-only mode cancels bypass even with approval policy never', true, 'readOnly', 0, false, true);
      await probe('workspace with never policy denies without prompting', 'workspaceNever', undefined, 0, false);
      await probe('custom restricted profile with never policy denies without prompting', 'customNever', undefined, 0, false);
      await probe('workspace with never policy revokes a bypass turn', true, 'workspaceNever', 0, false, true);
      await probe('custom restricted profile with never policy revokes a bypass turn', true, 'customNever', 0, false, true);
      await probe('explicit Full Access replaces restricted never policy without prompting', 'workspaceNever', true, 0, true);
      if (!agy) await probe('Accept edits performs a provider-native edit without an approval callback', false, undefined, 0, true, false, { autoEdit: true });
      await probe('read-only mode cancels a running Accept edits turn', false, 'readOnly', 0, false, true, { autoEdit: true });
      await probe('workspace never policy cancels a running Accept edits turn', false, 'workspaceNever', 0, false, true, { autoEdit: true });
      await probe('custom never policy cancels a running Accept edits turn', false, 'customNever', 0, false, true, { autoEdit: true });
      if (agy) return;
      async function approvalRace(planProbe, restrict) {
        await select(false);
        const prefix = path.join(root, String(++files));
        const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`,
          permissionResult: `${prefix}.permission`, modeChanges: `${prefix}.modes`, planProbe,
          keepPendingOnCancel: !planProbe };
        fs.writeFileSync(control, JSON.stringify(ctl));
        c.held = [];
        const completed = c.notification('turn/completed', thread.id);
        await c.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fixture approval race.' }] });
        await waitFor(() => fs.existsSync(ctl.ready), 'ACP prompt');
        fs.writeFileSync(ctl.modeChanges, '');
        fs.writeFileSync(ctl.release, 'release');
        await waitFor(() => c.held.length === 1, 'pending approval');
        if (!planProbe) await select('workspaceNever');
        c.ws.send(JSON.stringify({ id: c.held[0].id, result: { decision: 'accept' } }));
        await waitFor(() => fs.existsSync(ctl.permissionResult), 'provider permission response');
        if (planProbe && restrict) await select('workspaceNever');
        assert.equal((await completed).turn.status, restrict ? 'interrupted' : 'completed');
        await pause(250); // Let the plan's delayed mode transition run, if it was scheduled.
        const result = JSON.parse(fs.readFileSync(ctl.permissionResult, 'utf8'));
        assert.equal(result.outcome.outcome, planProbe ? 'selected' : 'cancelled');
        assert.equal(fs.existsSync(ctl.marker), false, 'stale approval must not authorize a write');
        assert.equal(fs.readFileSync(ctl.modeChanges, 'utf8').includes('acceptEdits'), planProbe && !restrict,
          'only a still-authorized plan may enable Accept edits');
        c.held = null;
        pass(!planProbe ? 'pending approval cannot grant access after restriction'
          : restrict ? 'delayed plan transition cannot restore revoked Accept edits'
            : 'confirmed plan still enables Accept edits when authorized');
      }
      await approvalRace(false, true);
      await approvalRace(true, true);
      await approvalRace(true, false);
      await probe('Full Access prepares the mode-refusal regression', true, undefined, 0, true, false, { autoEdit: true });
      await probe('refused restriction never starts a provider prompt with stale bypass', 'workspaceNever', undefined, 0, false, false, { autoEdit: true, rejectMode: 'default', setupFailure: true });
    });
    // The TUI attaches its own, unconfirmed permission choice to every turn/start, before (or
    // without) the engine accepting it. Only the engine's confirmed settings may grant access.
    const tuiFull = { approvalPolicy: 'never', permissions: ':danger-full-access' };
    await group('unconfirmed turn/start permissions', async () => {
      const t = (await newThread()).id;
      await probe('turn/start permission fields cannot grant Full Access', false, undefined, 1, false, false, { thread: t, turnParams: tuiFull });
      await probe('unconfirmed turn/start fields do not carry into the next turn', false, undefined, 1, false, false, { thread: t });
      await probe('confirmed Full Access still applies with the TUI turn/start fields', true, undefined, 0, true, false, { thread: t, turnParams: tuiFull });
    });
    // Two chats on one bridge connection, both on the same provider adapter, running at once.
    // Chat A's provider asks first, while chat B's turn is the newer one.
    const pair = (name, fullA) => group(name, async () => {
      const a = (await newThread()).id, b = (await newThread()).id;
      await select(fullA, a); await select(!fullA, b);
      const start = c.approvals.length;
      const ta = await hold(a), tb = await hold(b);
      ta.release();
      assert.equal((await ta.completed).turn.status, 'completed', 'chat A');
      tb.release();
      assert.equal((await tb.completed).turn.status, 'completed', 'chat B');
      assert.deepEqual(c.approvals.slice(start).map(p => p.threadId), [fullA ? b : a], 'only the restricted chat asks, under its own thread');
      assert.equal(ta.wrote(), fullA, 'chat A write');
      assert.equal(tb.wrote(), !fullA, 'chat B write');
      pass(name);
    });
    await pair('a restricted chat cannot borrow a concurrent chat\'s Full Access', false);
    await pair('a Full Access chat is not asked under a concurrent chat\'s restriction', true);
    const stopOne = (name, stop) => group(name, async () => {
      const a = (await newThread()).id, b = (await newThread()).id;
      await select(true, a); await select(true, b);
      const start = c.approvals.length;
      const ta = await hold(a, { autoEdit: true }), tb = await hold(b, { autoEdit: true });
      await stop(a, ta);
      ta.release();
      assert.equal((await ta.completed).turn.status, 'interrupted', 'chat A');
      tb.release();
      assert.equal((await tb.completed).turn.status, 'completed', 'chat B');
      assert.equal(c.approvals.length - start, 0, 'prompts');
      assert.equal(ta.wrote(), false, 'chat A write');
      assert.equal(tb.wrote(), true, 'chat B write');
      pass(name);
    });
    await stopOne('revoking one chat\'s Full Access stops only that chat', a => select(false, a));
    await stopOne('interrupting one chat stops only that chat', (a, ta) => Promise.race([
      c.request('turn/interrupt', { threadId: a, turnId: ta.turnId }).catch(() => {}), pause(2000)]));
    await group('a second turn cannot replace a running turn in the same chat', async () => {
      const a = (await newThread()).id;
      await select(true, a);
      const t = await hold(a);
      await assert.rejects(c.request('turn/start', { threadId: a, input: [{ type: 'text', text: 'Duplicate turn.' }] }), /already has an active or pending turn/);
      t.release();
      assert.equal((await t.completed).turn.status, 'completed');
      assert.equal(t.wrote(), true, 'the original turn keeps its authority and completes');
      pass('a second turn cannot replace a running turn in the same chat');
    });
    // Antigravity's adapter names its own session in every request.
    if (!agy) await group('an approval from an unknown ACP session is refused', async () => {
      const a = (await newThread()).id;
      await select(true, a);
      const t = await hold(a, { unknownSession: true, permissionResult: path.join(root, `${files + 1}.permission`) });
      t.release();
      assert.equal((await t.completed).turn.status, 'completed');
      assert.equal(JSON.parse(fs.readFileSync(t.ctl.permissionResult, 'utf8')).outcome.outcome, 'cancelled');
      assert.equal(t.wrote(), false, 'an unknown session must not be answered with Full Access');
      pass('an approval from an unknown ACP session is refused');
    });
    // A restart (new bridge, new engine, same home), resumed as the TUI does over the bridge's
    // websocket without permission flags (remote mode: thread id only): the engine's saved
    // choice applies, and turn/start fields still cannot grant access.
    async function restart(threadId, full) {
      await c.stop();
      c = await launch();
      const resumed = await c.request('thread/resume', { threadId });
      assert.equal(resumed.approvalPolicy, full ? 'never' : 'on-request', 'resumed approval policy is the saved one');
      assert.equal(resumed.activePermissionProfile?.id, full ? ':danger-full-access' : ':workspace', 'resumed permission profile is the saved one');
      c.full.set(threadId, full);
    }
    await group('cold resume of revoked Full Access', async () => {
      const r = (await newThread()).id;
      await probe('Full Access before revoking and restarting', true, undefined, 0, true, false, { thread: r });
      await probe('Default chosen before a restart asks', false, undefined, 1, false, false, { thread: r });
      await restart(r, false);
      await probe('cold-resumed Default asks', false, undefined, 1, false, false, { thread: r });
      await probe('cold-resumed Default ignores TUI turn/start Full Access', false, undefined, 1, false, false, { thread: r, turnParams: tuiFull });
    });
    await group('cold resume of Full Access', async () => {
      const r = (await newThread()).id;
      await probe('Full Access before a restart', true, undefined, 0, true, false, { thread: r });
      await restart(r, true);
      await probe('cold-resumed Full Access approves without prompting', true, undefined, 0, true, false, { thread: r });
    });
    if (failures.length) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, failures, messages: clients.map(client => client.messages) }, null, 2));
    console.log(`Evidence: ${root}`);
    for (const client of clients) { client.ws?.close(); client.bridge.kill(); }
  }
}
