'use strict';
// Real native scheduler + isolated local inference. No main-agent orchestration or paid calls.
// Usage: node scripts/manual-workflow-runtime.test.cjs /absolute/path/to/elpis-next
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Provider, message, call } = require('./lib/mock-provider.js');

const binary = process.argv[2];
const disabledFanout = process.argv.includes('--disabled-fanout');
const approvalMode = process.argv.includes('--approval');
assert(!(disabledFanout && approvalMode), 'Run disabled-fanout and approval modes separately');
assert(binary && path.isAbsolute(binary), 'Provide an absolute native Elpis binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-manual-workflow-'));
const home = path.join(root, 'home'); const cwd = path.join(root, 'workspace');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const provider = new Provider(); const pending = new Map(); const notifications = []; const checks = [];
const requests = []; const assignments = []; let phase = 'invalid'; let child; let sequence = 0; let stderr = ''; let failure;
let desktop; let desktopClient; let transport; let eventAbort; let eventPump;
const appEvents = []; const nativeApprovals = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const texts = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(texts).join('\n') : value && typeof value === 'object' ? Object.values(value).map(texts).join('\n') : '';
const task = (id, dependsOn = []) => ({ id, kind: 'explore', title: `Task ${id}`, instruction: 'Report the local fixture evidence. Do not use shell or delegate.', dependsOn, writeScopes: [], acceptanceCriteria: ['Return accepted fixture evidence'] });
const graph = rootThreadId => ({ rootThreadId, name: 'Manual dependency fixture', tasks: [task('foundation'), task('dependent', ['foundation'])], maxConcurrency: 2, maxRuntimeSeconds: 30 });
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
function rpc(method, params, timeout = 15000) {
  const id = ++sequence; requests.push({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function rejected(method, params) {
  try { await rpc(method, params); } catch (error) { return error; }
  assert.fail(`${method} unexpectedly accepted the invalid request`);
}
async function eventually(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (provider.error) throw provider.error;
    if (child.exitCode !== null) throw new Error(`Runtime exited while waiting for ${label}: ${stderr}`);
    const value = await fn(); if (value) return value; await pause(75);
  }
  throw new Error(`Timed out waiting for ${label}; evidence: ${root}`);
}
async function list(rootThreadId) { return (await rpc('workGraph/list', { rootThreadId })).data; }


async function runApprovalFixture() {
  const { DesktopClient } = await import('../apps/elpis-desktop/bridge/client.mjs');
  const { startDesktopServer } = await import('../apps/elpis-desktop/bridge/server.mjs');
  desktopClient = new DesktopClient(transport, { timeoutMs: 15000 });
  await desktopClient.initialize();
  desktop = await startDesktopServer({ client: desktopClient, staticDir: cwd });
  const url = new URL(desktop.url); const origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const bootstrap = await fetch(`${origin}/api/session`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  async function api(route, body) {
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert([200, 201].includes(response.status), `${route} (${response.status}): ${JSON.stringify(value)}`);
    return value;
  }
  eventAbort = new AbortController();
  const events = await fetch(`${origin}/api/events`, { headers: { origin, cookie }, signal: eventAbort.signal });
  assert.equal(events.status, 200);
  eventPump = (async () => {
    const reader = events.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) appEvents.push({ type, data: JSON.parse(data) });
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  phase = 'approval';
  const { thread } = await api('/api/threads', { cwd });
  const owned = thread.id;
  const approvedGraph = graph(owned);
  approvedGraph.tasks[0].instruction = 'Request approval for pwd, run it, and report its result. Do not delegate.';
  const started = await api('/api/workflows/run', approvedGraph);
  const approval = await eventually(() => appEvents.find(event => event.type === 'approval' && event.data.ownerThreadId === owned)?.data, 'owned worker approval via desktop SSE');
  assert.equal(approval.method, 'item/commandExecution/requestApproval');
  assert.notEqual(approval.params.threadId, owned, 'approval must originate in the child');
  const childThread = await rpc('thread/read', { threadId: approval.params.threadId, includeTurns: false });
  assert.equal(childThread.thread.parentThreadId, owned);
  assert(nativeApprovals.some(event => event.params?.threadId === approval.params.threadId));
  const unresolved = (await list(owned)).find(item => item.id === started.graphId);
  assert.equal(unresolved.status, 'running', 'worker must wait for the approval');
  await api(`/api/approvals/${approval.id}`, { decision: 'accept' });
  await eventually(async () => (await list(owned)).find(item => item.id === started.graphId && item.status === 'succeeded'), 'approved workflow completion');
  pass('actual child command approval reaches desktop SSE, answer reaches child, and workflow completes');

  // This root exists in the same native runtime but is not owned by this app.
  phase = 'foreign-approval';
  const foreign = (await rpc('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture' })).thread.id;
  const foreignGraph = graph(foreign); foreignGraph.tasks = [foreignGraph.tasks[0]];
  foreignGraph.tasks[0].instruction = approvedGraph.tasks[0].instruction;
  const foreignStarted = await rpc('workGraph/run', foreignGraph);
  const foreignRequest = await eventually(() => nativeApprovals.find(event => event.params?.threadId !== approval.params.threadId), 'unrelated worker native approval');
  const foreignChild = (await rpc('thread/read', { threadId: foreignRequest.params.threadId, includeTurns: false })).thread;
  assert.equal(foreignChild.parentThreadId, foreign);
  // Prove the ownership check actually read the unrelated root; absence of
  // an approval alone could otherwise be a delayed ancestry lookup.
  await eventually(() => {
    const reads = requests.filter(item => item.transport === 'desktop' && item.method === 'thread/read' && item.params.threadId === foreign);
    return reads.some(read => notifications.some(reply => reply.id === read.id && reply.result?.thread?.id === foreign));
  }, 'completed ancestry lookup for unrelated root');
  await pause(75);
  assert(!desktopClient.pendingApprovals.some(item => item.params.threadId === foreignChild.id));
  assert(!appEvents.some(event => event.type === 'approval' && event.data.params.threadId === foreignChild.id));
  child.stdin.write(JSON.stringify({ id: foreignRequest.id, result: { decision: 'decline' } }) + '\n');
  await eventually(async () => (await list(foreign)).find(item => item.id === foreignStarted.graphId && item.status === 'failed'), 'unrelated declined workflow completion');
  pass('unrelated root child approval stays outside app ownership; fixture declines it directly');
  if (failure) throw failure; if (provider.error) throw provider.error;
}

(async () => {
  await provider.start();
  // The existing provider records the request before asking for its next action.
  // Dispatch by actual worker identity, so concurrent worker finishes cannot reorder scripted replies.
  provider.actions.shift = () => {
    const request = provider.requests.at(-1).body;
    const input = texts(request.input) + '\n' + texts(request.instructions);
    if (phase === 'busy-chat') {
      assert(input.includes('BUSY_USER_TURN_7321'), 'Only the explicit busy-root test may start a normal model turn');
      return { hang: true };
    }
    const graphId = /Graph ID:\s*([^\n]+)/.exec(input)?.[1]?.trim();
    const taskId = /Task ID:\s*([^\n]+)/.exec(input)?.[1]?.trim();
    assert(graphId && taskId, 'Manual graph must not make a coordinator model request');
    if (!assignments.some(item => item.graphId === graphId && item.taskId === taskId)) assignments.push({ graphId, taskId, phase, input });
    if (phase === 'cancel') return { hang: true };
    return () => {
      if (input.includes(`report-${taskId}`)) return message(`Finished ${taskId}`);
      if (approvalMode && taskId === 'foundation' && !input.includes(`command-${taskId}`)) {
        return call(`command-${taskId}`, 'exec_command', {
          cmd: 'pwd', sandbox_permissions: 'require_escalated',
          justification: 'Fixture: approve this read-only command to verify child approval routing.', max_output_tokens: 1000,
        });
      }
      if (approvalMode && taskId === 'foundation' && phase !== 'foreign-approval') {
        const output = (request.input ?? []).find(item => item.type === 'function_call_output' && item.call_id === `command-${taskId}`);
        assert(output && texts(output.output).includes(cwd), 'actual child command output must reach the worker');
        assert.match(texts(output.output), /Process exited with code 0|exit_code[\s"':]+0|Exit code: 0/, 'approved child command must exit successfully');
      }

      if (taskId === 'dependent') assert(input.includes('FOUNDATION_EVIDENCE_7321'), 'Dependent worker must receive accepted prerequisite evidence');
      return call(`report-${taskId}`, 'report_agent_work_task', {
        graph_id: graphId, task_id: taskId, outcome: phase === 'foreign-approval' ? 'failed' : 'succeeded', summary: `${taskId} complete`,
        changed_files: [], checks: ['Read assigned local fixture prompt'],
        evidence: [taskId === 'foundation' ? 'FOUNDATION_EVIDENCE_7321' : 'DEPENDENT_EVIDENCE_7321'],
        risks: [], edge_cases_considered: ['Read-only task'], open_questions: [], what_i_did_not_check: ['Live-model quality'],
      });
    };
  };
  const catalog = require('../codex-rs/models-manager/models.json');
  const model = catalog.models.find(entry => entry.slug === 'gpt-5.5'); assert(model);
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ models: [model] }));
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\nmulti_agent=true\nenable_fanout=${!disabledFanout}\nsqlite=true\nautomatic_context_pruning=false\n[memories]\ngenerate_memories=false\nuse_memories=false\n[model_providers.fixture]\nname="Local workflow fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  child = spawn(binary, ['app-server'], { cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  if (approvalMode) {
    // Byte-only adapter; protocol requests, notifications and replies stay native.
    transport = new EventEmitter();
    transport.send = data => {
      requests.push({ transport: 'desktop', ...JSON.parse(data) });
      child.stdin.write(data + '\n');
    };
    transport.close = () => transport.emit('close');
  }
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let event; try { event = JSON.parse(line); } catch { stderr += line + '\n'; return; }
    transport?.emit('message', line);
    const waiting = !event.method && pending.get(event.id);
    if (waiting) {
      clearTimeout(waiting.timer); pending.delete(event.id);
      if (event.error) waiting.reject(Object.assign(new Error(event.error.message), { code: event.error.code, data: event.error.data }));
      else waiting.resolve(event.result);
    } else if (event.id !== undefined && event.method) {
      nativeApprovals.push(event);
      if (approvalMode) return;
      failure ??= new Error(`Unexpected approval/tool request ${event.method}`);
      child.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: 'Fixture does not approve operations' } }) + '\n');
    } else notifications.push(event);
  });
  if (approvalMode) { await runApprovalFixture(); return; }
  await rpc('initialize', { clientInfo: { name: 'manual-workflow-fixture', version: '0.1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const { thread } = await rpc('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture' });
  const rootId = thread.id; assert(rootId);
  if (disabledFanout) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const denied = await rejected('workGraph/run', graph(rootId));
      assert.match(denied.message, /enable_fanout.*feature|work graphs are disabled/i);
    }
    assert.equal(provider.requests.length, 0, 'disabled workflows must not call a model');
    assert.deepEqual(await list(rootId), [], 'disabled workflows must not persist a graph');
    pass('disabled enable_fanout rejects repeated runs without inference, persisted graph, or leaked reservation');
  } else {
  const cycle = graph(rootId); cycle.tasks[0].dependsOn = ['dependent'];
  const invalid = await rejected('workGraph/run', cycle);
  if (invalid.code === -32601 || /unknown variant `workGraph\/run`/.test(invalid.message)) throw new Error('workGraph/run is unsupported by this binary: expected pre-change failure');
  assert.match(invalid.message, /cycle|cyclic|dag|dependenc/i);
  assert.equal(provider.requests.length, 0); assert.equal((await list(rootId)).length, 0);
  const missingVerifier = graph(rootId); missingVerifier.tasks = [{ ...task('write'), kind: 'implement', writeScopes: ['.'] }];
  const invalidVerifier = await rejected('workGraph/run', missingVerifier);
  assert.match(invalidVerifier.message, /verif/i); assert.equal(provider.requests.length, 0);
  pass('cycle and missing-verifier graphs fail before workers or inference');

  phase = 'success';
  const started = await rpc('workGraph/run', graph(rootId));
  assert.equal(started.threadId, rootId); assert(started.graphId && started.turnId);
  const completed = await eventually(async () => (await list(rootId)).find(item => item.id === started.graphId && item.status === 'succeeded'), 'successful persisted graph');
  assert.deepEqual(completed.tasks.map(item => item.status), ['succeeded', 'succeeded']);
  assert.deepEqual(completed.tasks[1].dependencies, ['foundation']);
  assert(completed.tasks[0].evidence.includes('FOUNDATION_EVIDENCE_7321'));
  assert.deepEqual(assignments.filter(item => item.graphId === started.graphId).map(item => item.taskId), ['foundation', 'dependent']);
  for (const item of completed.tasks) {
    assert(item.assignedThreadId && item.assignedThreadId !== rootId);
    const read = await rpc('thread/read', { threadId: item.assignedThreadId, includeTurns: false });
    assert.equal(read.thread.parentThreadId, rootId, 'Persisted worker must retain real parent identity');
  }
  await eventually(() => notifications.find(event => event.method === 'turn/completed' && event.params?.threadId === rootId && event.params.turn.id === started.turnId), 'normal workflow turn completion');
  pass('manual scheduler starts real child threads in dependency order with accepted evidence, without coordinator inference');

  phase = 'busy-chat';
  const busyTurn = await rpc('turn/start', { threadId: rootId, input: [{ type: 'text', text: 'BUSY_USER_TURN_7321', text_elements: [] }] });
  await eventually(() => provider.hanging.size > 0, 'ordinary user turn is running');
  const occupied = await rejected('workGraph/run', graph(rootId));
  assert.equal(occupied.data?.reason, 'threadBusy');
  assert.equal((await list(rootId)).length, 1, 'Rejected graph must not be persisted');
  await rpc('turn/interrupt', { threadId: rootId, turnId: busyTurn.turn.id });
  await eventually(() => notifications.find(event => event.method === 'turn/completed' && event.params?.threadId === rootId && event.params.turn.id === busyTurn.turn.id), 'ordinary turn interrupted');
  pass('active user turn rejects manual workflow without replacing the turn or creating a graph');

  phase = 'cancel';
  const simultaneous = await Promise.allSettled([
    rpc('workGraph/run', { ...graph(rootId), name: 'Cancellation fixture A' }),
    rpc('workGraph/run', { ...graph(rootId), name: 'Cancellation fixture B' }),
  ]);
  assert.equal(simultaneous.filter(item => item.status === 'fulfilled').length, 1, 'one concurrent request owns the root');
  assert.equal(simultaneous.find(item => item.status === 'rejected')?.reason.data?.reason, 'threadBusy');
  const hanging = simultaneous.find(item => item.status === 'fulfilled').value;
  pass('concurrent workflow starts admit exactly one graph and reject the other as threadBusy');
  await eventually(() => assignments.find(item => item.graphId === hanging.graphId && item.taskId === 'foundation'), 'first cancellable worker');
  const busy = await rejected('workGraph/run', graph(rootId));
  assert.equal(busy.data?.reason, 'threadBusy');
  const current = (await list(rootId)).find(item => item.id === hanging.graphId); assert.equal(current.status, 'running');
  const steer = await rejected('turn/steer', { threadId: rootId, expectedTurnId: hanging.turnId, input: [{ type: 'text', text: 'Do not queue this into an unconsumed workflow input', text_elements: [] }] });
  assert.match(steer.message, /workflow|work graph|steer/i);
  pass('busy workflow refuses a second graph and unconsumed steers without replacing its turn');
  await rpc('turn/interrupt', { threadId: rootId, turnId: hanging.turnId });
  const cancelled = await eventually(async () => (await list(rootId)).find(item => item.id === hanging.graphId && item.status === 'cancelled'), 'persisted graph cancellation');
  assert(cancelled.tasks.every(item => ['cancelled', 'blocked', 'failed'].includes(item.status)));
  assert.equal(assignments.filter(item => item.graphId === hanging.graphId).length, 1, 'Cancelled dependency must never spawn');
  pass('normal turn interrupt cancels worker and persisted graph without starting dependents');
  }
  if (failure) throw failure; if (provider.error) throw provider.error;
})().catch(error => { failure = error; process.exitCode = 1; console.error(error.stack); }).finally(async () => {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ checks, failure: failure?.message, binary, assignments: assignments.map(({ input, ...rest }) => rest) }, null, 2));
  fs.writeFileSync(path.join(root, 'app-events.json'), JSON.stringify({ appEvents, nativeApprovals }, null, 2));
  fs.writeFileSync(path.join(root, 'protocol.json'), JSON.stringify({ requests, notifications }, null, 2));
  fs.writeFileSync(path.join(root, 'provider.json'), JSON.stringify(provider.requests, null, 2));
  fs.writeFileSync(path.join(root, 'runtime.log'), stderr);
  eventAbort?.abort();
  if (eventPump) await eventPump;
  if (desktop) await desktop.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture shutdown')); } pending.clear();
  if (provider.server) provider.close();
  if (child && child.exitCode === null) { child.stdin.end(); child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]); }
  console.log(`Evidence: ${root}`);
});
