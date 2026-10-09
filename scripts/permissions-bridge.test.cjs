'use strict';
// Real websocket bridge and engine, deterministic ACP adapter, isolated home.
// Usage: node scripts/permissions-bridge.test.cjs /absolute/engine [absolute/bridge] [--gemini]
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
  let prompt, timer, mode = 'default';
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method) {
      if (!prompt) return;
      if (prompt.permissionResult) fs.writeFileSync(prompt.permissionResult, JSON.stringify(msg.result));
      if (msg.result?.outcome?.optionId === 'allow') fs.writeFileSync(prompt.marker, 'allowed');
      if (prompt.planProbe) return;
      send({ id: prompt.id, result: { stopReason: 'end_turn' } });
      prompt = null;
      return;
    }
    if (msg.method === 'session/prompt') {
      const control = JSON.parse(fs.readFileSync(process.env.PERMISSION_FIXTURE_CONTROL, 'utf8'));
      prompt = { ...control, id: msg.id };
      fs.writeFileSync(control.ready, 'ready');
      timer = setInterval(() => {
        if (!fs.existsSync(control.release)) return;
        clearInterval(timer);
        if (control.autoEdit && ['acceptEdits', 'auto', 'bypassPermissions'].includes(mode)) {
          fs.writeFileSync(control.marker, 'allowed by provider mode');
          send({ id: prompt.id, result: { stopReason: 'end_turn' } });
          prompt = null;
          return;
        }
        send({ id: 'permission', method: 'session/request_permission', params: {
          sessionId: msg.params.sessionId, toolCall: { toolCallId: randomUUID(), title: 'Fixture write' },
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
      mode = msg.params.modeId;
      if (control.modeChanges) fs.appendFileSync(control.modeChanges, mode + '\n');
      if (prompt?.planProbe && mode === 'acceptEdits') {
        send({ id: prompt.id, result: { stopReason: 'end_turn' } });
        prompt = null;
      }
    }
    if (msg.method === 'session/cancel') {
      clearInterval(timer);
      if (prompt) send({ id: prompt.id, result: { stopReason: 'cancelled' } });
      if (!prompt?.keepPendingOnCancel) prompt = null;
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
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), log = path.join(root, 'bridge.log');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-5.5"\n[features]\nsubagents=false\n[permissions.fixture-restricted]\nextends=":read-only"\n');
  const control = path.join(root, 'control.json');
  const agy = process.argv.includes('--gemini');
  const agyBinary = path.join(root, 'agy');
  if (agy) fs.writeFileSync(agyBinary, `#!/usr/bin/env node\nprocess.argv.push('--agy-fixture'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  const bridgePath = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
    cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
      PORT: '0', ELPIS_ENGINE_BIN: binary, ACP_ADAPTER: __filename, ...(agy ? { AGY_BIN: agyBinary } : { ELPIS_NO_AGY: '1' }), ACP_BRIDGE_NO_AGENTS: '1',
      ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(home, 'sessions.json'),
      PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const checks = [], messages = [], events = new EventEmitter(), pending = new Map();
  let ws, nextId = 1, approvals = 0, heldApprovals = null;
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 20000;
    while (!check()) { assert(Date.now() < deadline, `${label} timed out`); await pause(20); }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const notification = method => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.off(method, receive); reject(Error(`${method} timed out`)); }, 20000);
    function receive(params) { clearTimeout(timer); events.off(method, receive); resolve(params); }
    events.on(method, receive);
  });
  try {
    await waitFor(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, 'utf8')), 'bridge start');
    const port = fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/)[1];
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', data => {
      const msg = JSON.parse(String(data)); messages.push(msg);
      if (msg.method && msg.id !== undefined) {
        approvals++;
        if (heldApprovals) heldApprovals.push(msg);
        else ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
      } else if (msg.method) events.emit(msg.method, msg.params);
      else { const p = pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
    });
    await request('initialize', { clientInfo: { name: 'bridge_permission_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = await request('thread/start', { cwd, model: agy ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku', approvalPolicy: 'on-request', permissions: ':workspace' });
    let full = false;
    async function select(wantFull) {
      if (full === wantFull) return;
      const permissions = wantFull === 'readOnly' ? ':read-only'
        : wantFull === 'workspaceNever' ? ':workspace'
          : wantFull === 'customNever' ? 'fixture-restricted'
            : wantFull ? ':danger-full-access' : ':workspace';
      const applied = notification('thread/settings/updated');
      await request('thread/settings/update', { threadId: thread.id, approvalPolicy: wantFull ? 'never' : 'on-request', permissions });
      assert.equal((await applied).threadSettings.approvalPolicy, wantFull ? 'never' : 'on-request');
      full = wantFull;
    }
    async function probe(name, before, after, prompts, writes, interrupted = false, options = {}) {
      await select(before);
      const prefix = path.join(root, String(checks.length));
      const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`, ...options };
      fs.writeFileSync(control, JSON.stringify(ctl));
      const completed = notification('turn/completed'), start = approvals;
      await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fixture write.' }] });
      if (!options.setupFailure) await waitFor(() => fs.existsSync(ctl.ready), 'ACP prompt');
      if (after === 'invalid') {
        await assert.rejects(request('thread/settings/update', { threadId: thread.id, approvalPolicy: 'never', permissions: ':missing-profile' }));
      } else if (after !== undefined) await select(after);
      fs.writeFileSync(ctl.release, 'release');
      assert.equal((await completed).turn.status, options.setupFailure ? 'failed' : interrupted ? 'interrupted' : 'completed', name);
      if (options.setupFailure) assert.equal(fs.existsSync(ctl.ready), false, `${name}: provider prompt must not run`);
      assert.equal(approvals - start, prompts, `${name}: prompts`);
      assert.equal(fs.existsSync(ctl.marker), writes, `${name}: write`);
      checks.push(name); console.log(`PASS ${name}`);
    }
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
    if (!agy) {
      async function approvalRace(planProbe, restrict) {
        await select(false);
        const prefix = path.join(root, String(checks.length));
        const ctl = { marker: `${prefix}.write`, ready: `${prefix}.ready`, release: `${prefix}.release`,
          permissionResult: `${prefix}.permission`, modeChanges: `${prefix}.modes`, planProbe,
          keepPendingOnCancel: !planProbe };
        fs.writeFileSync(control, JSON.stringify(ctl));
        heldApprovals = [];
        const completed = notification('turn/completed');
        await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fixture approval race.' }] });
        await waitFor(() => fs.existsSync(ctl.ready), 'ACP prompt');
        fs.writeFileSync(ctl.modeChanges, '');
        fs.writeFileSync(ctl.release, 'release');
        await waitFor(() => heldApprovals.length === 1, 'pending approval');
        if (!planProbe) await select('workspaceNever');
        ws.send(JSON.stringify({ id: heldApprovals[0].id, result: { decision: 'accept' } }));
        await waitFor(() => fs.existsSync(ctl.permissionResult), 'provider permission response');
        if (planProbe && restrict) await select('workspaceNever');
        assert.equal((await completed).turn.status, restrict ? 'interrupted' : 'completed');
        await pause(250); // Let the plan's delayed mode transition run, if it was scheduled.
        const result = JSON.parse(fs.readFileSync(ctl.permissionResult, 'utf8'));
        assert.equal(result.outcome.outcome, planProbe ? 'selected' : 'cancelled');
        assert.equal(fs.existsSync(ctl.marker), false, 'stale approval must not authorize a write');
        assert.equal(fs.readFileSync(ctl.modeChanges, 'utf8').includes('acceptEdits'), planProbe && !restrict,
          'only a still-authorized plan may enable Accept edits');
        heldApprovals = null;
        const name = !planProbe ? 'pending approval cannot grant access after restriction'
          : restrict ? 'delayed plan transition cannot restore revoked Accept edits'
            : 'confirmed plan still enables Accept edits when authorized';
        checks.push(name); console.log(`PASS ${name}`);
      }
      await approvalRace(false, true);
      await approvalRace(true, true);
      await approvalRace(true, false);
      await probe('Full Access prepares the mode-refusal regression', true, undefined, 0, true, false, { autoEdit: true });
      await probe('refused restriction never starts a provider prompt with stale bypass', 'workspaceNever', undefined, 0, false, false, { autoEdit: true, rejectMode: 'default', setupFailure: true });
    }
  } finally {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, messages }, null, 2));
    console.log(`Evidence: ${root}`);
    ws?.close(); bridge.kill();
  }
}
