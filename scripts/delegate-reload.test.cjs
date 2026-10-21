'use strict';
// A59: real bridge, real engine, real delegation MCP; only inference is scripted.
// The ACP fixture replaces its MCP process on session/load, as Claude Code does.
// Usage: node scripts/delegate-reload.test.cjs /absolute/engine [absolute/bridge] [--private]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { once } = require('node:events');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = receive => require('node:readline').createInterface({ input: process.stdin })
  .on('line', line => receive(JSON.parse(line)));

if (process.argv.includes('--engine-gate')) engineGate();
else if (process.env.DELEGATE_RELOAD_ADAPTER) adapter();
else main().catch(error => { console.error(error.stack); process.exitCode = 1; });

// Delay only the early helper's real engine output so reload happens before turn/started.
function engineGate() {
  const engine = spawn(process.env.DELEGATE_RELOAD_REAL_ENGINE,
    process.argv.slice(process.argv.indexOf('--engine-gate') + 1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let gated = false;
  const held = [];
  engine.stderr.pipe(process.stderr);
  lines(msg => {
    if (msg.method === 'turn/start' && JSON.stringify(msg.params.input).includes('A59-EARLY')) {
      gated = true; fs.writeFileSync(process.env.DELEGATE_RELOAD_EARLY + '.held', 'held');
    }
    engine.stdin.write(JSON.stringify(msg) + '\n');
  }).on('close', () => engine.stdin.end());
  require('node:readline').createInterface({ input: engine.stdout }).on('line', line => {
    if (gated) held.push(line); else process.stdout.write(line + '\n');
  });
  const timer = setInterval(() => {
    if (gated && fs.existsSync(process.env.DELEGATE_RELOAD_EARLY + '.release')) {
      gated = false;
      for (const line of held.splice(0)) process.stdout.write(line + '\n');
    }
  }, 10);
  process.on('SIGTERM', () => engine.kill());
  engine.on('exit', code => { clearInterval(timer); process.exit(code ?? 0); });
}

function adapter() {
  const sessions = new Map();
  const approvals = new Map();
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const trace = msg => fs.appendFileSync(process.env.DELEGATE_RELOAD_TRACE, JSON.stringify(msg) + '\n');
  const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'haiku', options: [{ value: 'haiku', name: 'Haiku' }] }];
  async function mcp(config) {
    const proc = spawn(config.command, config.args, { env: { ...process.env,
      ...Object.fromEntries(config.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let seq = 0, buffer = '';
    proc.stderr.on('data', data => trace({ stderr: String(data) }));
    proc.stdout.on('data', data => {
      buffer += data;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      }
    });
    proc.on('exit', () => { for (const p of pending.values()) p.reject(Error('MCP exited')); pending.clear(); });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reload-fixture', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { call: (name, args) => rpc('tools/call', { name, arguments: args }),
      close: async () => { if (proc.exitCode !== null) return; const exited = once(proc, 'exit'); proc.kill(); await exited; } };
  }
  lines(async msg => {
    if (!msg.method) { approvals.get(msg.id)?.(msg.result); approvals.delete(msg.id); return; }
    const p = msg.params ?? {};
    trace({ method: msg.method, sessionId: p.sessionId });
    try {
      let result = { configOptions };
      if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (msg.method === 'session/new' || msg.method === 'session/load') {
        const sessionId = p.sessionId ?? randomUUID();
        await sessions.get(sessionId)?.server?.close();
        sessions.set(sessionId, { config: p.mcpServers.find(s => s.name === 'elpis-agents') });
        if (msg.method === 'session/load') await pause(150);
        result = { sessionId, configOptions };
      }
      if (msg.method === 'session/prompt') {
        const text = p.prompt.filter(b => b.type === 'text').at(-1)?.text ?? '';
        let answer;
        if (text.startsWith('A59-APPROVAL:')) {
          const id = `approval-${randomUUID()}`;
          const decision = new Promise(resolve => approvals.set(id, resolve));
          send({ id, method: 'session/request_permission', params: { sessionId: p.sessionId,
            toolCall: { toolCallId: id, title: 'Approve helper plan', kind: 'think' },
            options: [{ optionId: 'exit-plan-default', kind: 'allow_once', name: 'Approve' }, { optionId: 'deny', kind: 'reject_once', name: 'Decline' }] } });
          answer = `A59 approval: ${JSON.stringify(await decision)}`;
        } else {
          const calls = JSON.parse(text.slice(text.lastIndexOf('A59:') + 4));
          const session = sessions.get(p.sessionId);
          session.server ??= await mcp(session.config);
          const results = [];
          for (const call of calls) results.push(await session.server.call(call.name, call.args));
          answer = JSON.stringify(results);
        }
        send({ method: 'session/update', params: { sessionId: p.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } });
        result = { stopReason: 'end_turn' };
      }
      if (msg.id !== undefined) send({ id: msg.id, result });
    } catch (error) { send({ id: msg.id, error: { code: -32603, message: error.message } }); }
  });
  process.stdin.on('end', async () => { await Promise.all([...sessions.values()].map(s => s.server?.close())); process.exit(0); });
  process.on('SIGTERM', async () => { await Promise.all([...sessions.values()].map(s => s.server?.close())); process.exit(0); });
}

async function main() {
  const WebSocket = require('../tools/elpis-claude/node_modules/ws');
  const { Provider, message } = require('./lib/mock-provider.js');
  const binary = process.argv[2], bridgePath = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const shared = !process.argv.includes('--private');
  assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
  const root = fs.mkdtempSync(path.join(process.env.A59_EVIDENCE ?? os.tmpdir(), 'a59-reload-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const provider = new Provider(); await provider.start();
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nthread_unload_delay_secs=1\n[features]\nmulti_agent=true\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  // An admitted file changes at each user-message boundary, forcing the real reload path.
  const instructions = path.join(cwd, 'instructions.txt');
  const admission = path.join(home, 'context/workspaces', `work-${createHash('sha256').update(cwd).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(admission, { recursive: true });
  fs.writeFileSync(path.join(admission, 'admission.toml'), `[custom_sources]\n${JSON.stringify(instructions)}=true\n`);
  fs.writeFileSync(instructions, 'First message instructions.');
  const socket = path.join(root, 'bridge.sock'), store = path.join(root, 'sessions.json');
  const trace = path.join(root, 'acp.jsonl'), log = path.join(root, 'bridge.log');
  const engineShim = path.join(root, 'engine');
  fs.writeFileSync(engineShim, `#!${process.execPath}\nprocess.argv.splice(2, 0, '--engine-gate'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  let bridge, ws, stderr = '', next = 0, boundary = 0;
  const seen = [], pending = new Map();
  const waitFor = async (f, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (!f()) { assert(Date.now() < end, `${label} timed out: ${stderr}`); await pause(20); }
  };
  const req = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}: ${stderr}`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  async function start() {
    const listeningAt = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
    bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], { cwd, env: {
      PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, TMPDIR: root,
      ELPIS_ENGINE_BIN: engineShim, DELEGATE_RELOAD_REAL_ENGINE: binary, DELEGATE_RELOAD_EARLY: path.join(root, 'early'),
      ...(shared ? { ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socket } : { PORT: '0' }), ELPIS_NO_AGY: '1',
      ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: store, ACP_ADAPTER: __filename,
      DELEGATE_RELOAD_ADAPTER: '1', DELEGATE_RELOAD_TRACE: trace,
      ELPIS_AGENTS_LOG: path.join(root, 'agents.log'),
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    bridge.stderr.on('data', data => { stderr += data; });
    await waitFor(() => fs.existsSync(log) && /LISTENING/.test(fs.readFileSync(log, 'utf8').slice(listeningAt)) || bridge.exitCode !== null, 'bridge listener');
    assert.equal(bridge.exitCode, null, stderr);
    ws = new WebSocket(shared ? `ws+unix://${socket}:/` : `ws://127.0.0.1:${[...fs.readFileSync(log, 'utf8').matchAll(/LISTENING (\d+)/g)].at(-1)[1]}`);
    await once(ws, 'open');
    ws.on('message', data => {
      const m = JSON.parse(String(data)); seen.push(m);
      if (!m.method) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
      }
    });
    await req('initialize', { clientInfo: { name: 'codex-tui', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized' }));
  }
  async function prompt(threadId, calls) {
    fs.writeFileSync(instructions, `User message ${++boundary} instructions.`);
    const at = seen.length;
    const { turn } = await req('turn/start', { threadId, input: [{ type: 'text', text: `A59:${JSON.stringify(calls)}`, text_elements: [] }] });
    await waitFor(() => seen.slice(at).some(m => m.method === 'turn/completed' && m.params.turn.id === turn.id), 'coordinator completes');
    const end = seen.slice(at).find(m => m.method === 'turn/completed' && m.params.turn.id === turn.id);
    assert.equal(end.params.turn.status, 'completed', JSON.stringify(end));
    const answer = seen.slice(at).filter(m => m.method === 'item/agentMessage/delta' && m.params.threadId === threadId).map(m => m.params.delta).join('');
    return JSON.parse(answer);
  }
  const tool = (name, args) => ({ name, args });
  const text = r => r.content.map(c => c.text ?? '').join('\n');
  const pass = label => console.log(`PASS ${label}`);
  const helperArgs = task => ({ task, model: 'gpt-5.5', provider: 'fixture', wait: false, cwd });
  const helperIdOf = r => { const id = text(r).match(/Elpis thread (\S+)\)/)?.[1]; assert(id, text(r)); return id; };
  const loads = () => (fs.readFileSync(trace, 'utf8').match(/session\/load/g) ?? []).length;
  function release(response, answer) {
    assert(provider.hanging.has(response), 'the helper inference request is still held');
    provider.hanging.delete(response);
    const item = message(answer);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id: randomUUID() } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: randomUUID(), usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  }
  async function stopBridge() {
    ws?.terminate();
    if (bridge?.exitCode === null) {
      const exited = once(bridge, 'exit'); bridge.kill('SIGTERM');
      const timer = setTimeout(() => bridge.kill('SIGKILL'), 5000);
      const [code, signal] = await exited; clearTimeout(timer);
      return { code, signal };
    }
  }
  try {
    await start();
    const { thread: parent } = await req('thread/start', { cwd, model: 'claude/haiku', approvalPolicy: 'never', permissions: ':danger-full-access' });
    const [unknown] = await prompt(parent.id, [tool('delegate_status', { thread_id: randomUUID() })]);
    assert.equal(unknown.isError, true, text(unknown));
    pass('an empty helper list reports an unknown id as an error');
    provider.actions.push({ hang: true });
    const [started] = await prompt(parent.id, [tool('delegate', helperArgs('A59 helper: wait for the provider.'))]);
    const helperId = helperIdOf(started);
    await waitFor(() => provider.hanging.size === 1, 'helper starts inference');
    fs.writeFileSync(instructions, 'Second message instructions.');
    const [status] = await prompt(parent.id, [tool('delegate_status', { thread_id: helperId })]);
    assert(fs.readFileSync(trace, 'utf8').includes('session/load'), 'the second message actually reloaded Claude and replaced its MCP process');
    fs.writeFileSync(path.join(root, 'second-message-status.json'), JSON.stringify(status, null, 2));
    assert.equal(status.isError, undefined, text(status));
    assert.match(text(status), /status: running/, 'the helper remains running after coordinator reload');
    assert.equal(provider.hanging.size, 1, 'the real helper request survived the reload');
    pass('second coordinator message reloads Claude; delegate_status still sees the running helper');
    const [stopped] = await prompt(parent.id, [tool('delegate_stop', { thread_id: helperId })]);
    assert.equal(stopped.isError, undefined, text(stopped));
    assert.match(text(stopped), /status: interrupted/);
    pass('delegate_stop from the replacement MCP reaches the original helper');

    await waitFor(() => provider.hanging.size === 0, 'stopped request closes');
    provider.actions.push({ hang: true });
    const [earlyStart] = await prompt(parent.id, [tool('delegate', helperArgs('A59-EARLY helper with delayed turn acknowledgement'))]);
    const earlyId = helperIdOf(earlyStart);
    await waitFor(() => fs.existsSync(path.join(root, 'early.held')) && provider.hanging.size === 1, 'engine is executing before its acknowledgement arrives');
    const earlyLoads = loads();
    const earlyRead = prompt(parent.id, [tool('delegate_status', { thread_id: earlyId })]);
    await waitFor(() => loads() > earlyLoads, 'reload before the helper turn acknowledgement');
    fs.writeFileSync(path.join(root, 'early.release'), 'release');
    const [earlyStatus] = await earlyRead;
    assert.match(text(earlyStatus), /status: running/);
    assert.equal(provider.hanging.size, 1);
    await prompt(parent.id, [tool('delegate_stop', { thread_id: earlyId })]);
    pass('a helper whose turn acknowledgement has not arrived also survives reload');

    // Several simultaneous helpers, including the first, middle and last in the group.
    await waitFor(() => provider.hanging.size === 0, 'stopped request closes');
    provider.actions.push({ hang: true }, { hang: true }, { hang: true });
    const requestsAt = provider.requests.length;
    const startedMany = await prompt(parent.id, [0, 1, 2].map(i => tool('delegate', helperArgs(`A59-many-${i}`))));
    const ids = startedMany.map(helperIdOf);
    await waitFor(() => provider.hanging.size === 3, 'three simultaneous helpers');
    const held = new Map([...provider.hanging].map((response, i) => {
      const request = JSON.stringify(provider.requests[requestsAt + i].body.input);
      return [Number(request.match(/A59-many-(\d)/)[1]), response];
    }));
    const statuses = await prompt(parent.id, ids.map(thread_id => tool('delegate_status', { thread_id })));
    for (const status of statuses) assert.match(text(status), /status: running/);
    assert.equal(provider.hanging.size, 3);
    pass('all three helpers survive a coordinator reload');

    const [busy] = await prompt(parent.id, [tool('delegate', { thread_id: ids[0], task: 'Do not start a competing turn.' })]);
    assert.equal(busy.isError, true);
    assert.match(text(busy), /still working; use delegate_steer or delegate_stop/);
    assert.doesNotMatch(text(busy), /active writer/);
    pass('reopening a running helper gives its working status without acquiring a second writer');

    provider.actions.push(body => {
      assert.match(JSON.stringify(body.input), /A59-STEERED/);
      return message('A59-STEERED answer');
    });
    const [steered] = await prompt(parent.id, [tool('delegate_steer', { thread_id: ids[0], message: 'Change the answer to A59-STEERED.' })]);
    assert.equal(steered.isError, undefined, text(steered));
    release(held.get(0), 'First plan complete.');
    await waitFor(() => seen.some(m => m.method === 'thread/status/changed' && m.params.threadId === ids[0] && m.params.status.type === 'idle'), 'steered helper finishes');
    const [first] = await prompt(parent.id, [tool('delegate_status', { thread_id: ids[0] })]);
    assert.match(text(first), /A59-STEERED answer/);
    pass('delegate_steer after reload reaches the first helper and changes its actual next inference request');

    const beforeLoad = loads();
    const finishing = prompt(parent.id, [tool('delegate_status', { thread_id: ids[1] })]);
    await waitFor(() => loads() > beforeLoad, 'reload begins before helper finishes');
    release(held.get(1), 'A59-FINISHED-DURING-RELOAD');
    const [middle] = await finishing;
    assert.match(text(middle), /status: completed/);
    assert.match(text(middle), /A59-FINISHED-DURING-RELOAD/);
    pass('middle helper finishes during reload and the replacement MCP reads its answer');
    const [last] = await prompt(parent.id, [tool('delegate_stop', { thread_id: ids[2] })]);
    assert.match(text(last), /status: interrupted/);
    pass('delegate_stop after several reloads reaches the last helper');

    // The original MCP still holds a completed helper's writer; the app reopens it too.
    provider.actions.push(message('A59-COMPLETED-WITH-WRITER'));
    const [completed] = await prompt(parent.id, [tool('delegate', { ...helperArgs('A59 quick helper'), wait: true })]);
    const completedId = helperIdOf(completed);
    const reopened = await req('thread/resume', { threadId: completedId });
    assert.equal(reopened.thread.id, completedId);
    provider.actions.push(message('A59-FOLLOWUP'));
    const [followup] = await prompt(parent.id, [tool('delegate', { thread_id: completedId, task: 'A59 follow-up', wait: true })]);
    assert.equal(followup.isError, false, text(followup));
    assert.match(text(followup), /A59-FOLLOWUP/);
    pass('a completed helper reopens while its original writer is held; a replacement MCP follows it up');

    const [approvalStart] = await prompt(parent.id, [tool('delegate', { task: 'A59-APPROVAL: ask to approve the plan.', model: 'claude/haiku', wait: false, cwd })]);
    const approvalId = helperIdOf(approvalStart);
    await waitFor(() => seen.some(m => m.method === 'item/commandExecution/requestApproval' && m.params.threadId === approvalId), 'helper asks for approval');
    const approval = seen.find(m => m.method === 'item/commandExecution/requestApproval' && m.params.threadId === approvalId);
    const [waiting] = await prompt(parent.id, [tool('delegate_status', { thread_id: approvalId })]);
    assert.match(text(waiting), /status: running/);
    assert(!seen.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === approval.id), 'reload did not cancel the pending approval');
    ws.send(JSON.stringify({ id: approval.id, result: { decision: 'accept' } }));
    await waitFor(() => seen.some(m => m.method === 'thread/status/changed' && m.params.threadId === approvalId && m.params.status.type === 'idle'), 'approved helper completes');
    const [approved] = await prompt(parent.id, [tool('delegate_status', { thread_id: approvalId })]);
    assert.match(text(approved), /status: completed/);
    assert.match(text(approved), /exit-plan-default/);
    pass('a pending helper approval survives reload and its original approval still completes the helper');

    provider.actions.push({ httpError: 'A59 provider refused the request' });
    const [failedStart] = await prompt(parent.id, [tool('delegate', { ...helperArgs('A59 rejected inference'), wait: true })]);
    const failedId = helperIdOf(failedStart);
    const [failed] = await prompt(parent.id, [tool('delegate_status', { thread_id: failedId })]);
    assert.match(text(failed), /status: failed/);
    assert.match(text(failed), /A59 provider refused the request/);
    pass('a rejected inference request stays failed with its error after reload');

    // Restart the bridge itself: completed history remains readable; interrupted work can resume.
    await waitFor(() => provider.hanging.size === 0, 'all stopped requests close');
    provider.actions.push({ hang: true });
    const [restartStart] = await prompt(parent.id, [tool('delegate', helperArgs('A59 helper interrupted by bridge shutdown'))]);
    const restartId = helperIdOf(restartStart);
    await waitFor(() => provider.hanging.size === 1, 'restart helper starts');
    const shutdown = await stopBridge();
    assert.equal(shutdown.signal, null, 'bridge shutdown was graceful');
    await waitFor(() => provider.hanging.size === 0, 'shutdown closes running inference');
    await start();
    await req('thread/resume', { threadId: parent.id });
    const [saved, interrupted] = await prompt(parent.id, [tool('delegate_status', { thread_id: completedId }), tool('delegate_status', { thread_id: restartId })]);
    assert.match(text(saved), /A59-FOLLOWUP/);
    assert.match(text(interrupted), /status: interrupted/);
    provider.actions.push(message('A59-RESTARTED'));
    const [restarted] = await prompt(parent.id, [tool('delegate', { thread_id: restartId, task: 'Continue after the bridge restart.', wait: true })]);
    assert.equal(restarted.isError, false, text(restarted));
    assert.match(text(restarted), /A59-RESTARTED/);
    pass('after bridge restart, completed history is readable and interrupted work reopens without a writer conflict');
    assert.equal(provider.error, undefined);
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    await stopBridge();
    provider.close();
    fs.writeFileSync(path.join(root, 'stderr.log'), stderr);
    console.log(`Evidence ${root}`);
  }
}
