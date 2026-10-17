#!/usr/bin/env node
// Runs a held ACP tool through the real bridge. The same file is the local ACP fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.env.QUEUE_STEER_FIXTURE_ADAPTER === '1') {
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const root = process.env.QUEUE_STEER_FIXTURE_ROOT;
  const log = (method, params) => fs.appendFileSync(path.join(root, 'provider-inputs.jsonl'), JSON.stringify({ method, params }) + '\n');
  const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'haiku', options: [{ value: 'haiku', name: 'Haiku' }] }];
  let pending;
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method) return;
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (msg.method === 'session/new' || msg.method === 'session/load') {
      send({ id: msg.id, result: { sessionId: msg.params.sessionId ?? 'queue-fixture-session', configOptions } });
    } else if (msg.method === 'session/prompt') {
      log(msg.method, msg.params);
      const sessionId = msg.params.sessionId;
      const update = update => send({ method: 'session/update', params: { sessionId, update } });
      if (!msg.params.prompt.some(part => /(?:Keep this turn running|Hold a tool)/.test(part.text ?? ''))) {
        const titleRequest = msg.params.prompt.some(part => (part.text ?? '').includes('Generate a concise, single-line task title'));
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: titleRequest
          ? JSON.stringify({ title: 'Editor test session' }) : 'PERMISSION_FIXTURE_READY' } });
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }
      update({ sessionUpdate: 'tool_call', toolCallId: 'held-tool', kind: 'execute', title: 'Queue fixture held tool', rawInput: { command: 'held queue fixture' }, status: 'in_progress' });
      fs.writeFileSync(path.join(root, 'ready'), 'ready');
      let released = false;
      const timer = setInterval(() => {
        if (!released && fs.existsSync(path.join(root, 'release'))) {
          released = true;
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'held-tool', status: 'completed' });
        }
        if (fs.existsSync(path.join(root, 'finish'))) {
          clearInterval(timer);
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QUEUE_FIXTURE_COMPLETE' } });
          send({ id: msg.id, result: { stopReason: 'end_turn' } });
          pending = null;
        }
      }, 10);
      pending = { id: msg.id, timer };
    } else if (msg.method === '_session/steering') {
      log(msg.method, msg.params);
      if (fs.existsSync(path.join(root, 'ambiguous-error'))) {
        send({ id: msg.id, error: { code: -32603, message: 'Fixture lost the delivery acknowledgement' } });
        return;
      }
      send({ id: msg.id, result: { outcome: 'steered' } });
      if (process.env.QUEUE_STEER_FIXTURE_AUTO_FINISH === '1') {
        send({ method: 'session/update', params: { sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QUEUE_SENT_ONCE' } } } });
        fs.writeFileSync(path.join(root, 'finish'), 'done');
      }
    } else if (msg.method === 'session/cancel') {
      if (pending) {
        clearInterval(pending.timer);
        send({ id: pending.id, result: { stopReason: 'cancelled' } });
        pending = null;
      }
    } else if (msg.id !== undefined) {
      send({ id: msg.id, result: {} });
    }
  });
} else {
  const WebSocket = require('../tools/elpis-claude/node_modules/ws');
  const binary = process.argv[2];
  const bridgeFile = process.argv[3] ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
  assert(binary && path.isAbsolute(binary), 'provide an absolute engine path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-queue-steer-cancel-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-5.5"\n[features]\nsubagents=false\n');
  const bridgeLog = path.join(root, 'bridge.log');
  const messages = [], pending = new Map();
  let bridge, ws, nextId = 1;
  async function waitFor(predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (predicate()) return; await pause(10); }
    throw Error(`Timed out: ${label}; evidence ${root}`);
  }
  const input = text => [{ type: 'text', text }];
  const providerInputs = () => fs.existsSync(path.join(root, 'provider-inputs.jsonl'))
    ? fs.readFileSync(path.join(root, 'provider-inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const request = (method, params) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  };
  (async () => {
    bridge = spawn(process.execPath, [bridgeFile], { cwd,
      env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
        PORT: '0', ELPIS_ENGINE_BIN: binary, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1',
        ACP_ADAPTER: __filename, QUEUE_STEER_FIXTURE_ADAPTER: '1', QUEUE_STEER_FIXTURE_ROOT: root,
        ACP_BRIDGE_LOG: bridgeLog, ACP_BRIDGE_STORE: path.join(home, 'sessions.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    bridge.stdout.on('data', chunk => fs.appendFileSync(path.join(root, 'stdout.log'), chunk));
    bridge.stderr.on('data', chunk => fs.appendFileSync(path.join(root, 'stderr.log'), chunk));
    await waitFor(() => fs.existsSync(bridgeLog) && /LISTENING (\d+)/.test(fs.readFileSync(bridgeLog, 'utf8')), 'bridge startup');
    const port = fs.readFileSync(bridgeLog, 'utf8').match(/LISTENING (\d+)/)[1];
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', data => {
      const msg = JSON.parse(String(data)); messages.push(msg);
      if (msg.id !== undefined && !msg.method) {
        const result = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) result?.reject(Error(msg.error.message)); else result?.resolve(msg.result);
      } else if (msg.id !== undefined) {
        ws.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
      }
    });
    await request('initialize', { clientInfo: { name: 'queue-steer-fixture', version: '1' }, capabilities: { experimentalApi: true } });
    const { thread } = await request('thread/start', { cwd, model: 'claude/haiku', approvalPolicy: 'on-request', permissions: ':workspace' });
    const threadId = thread.id;
    const { turn } = await request('turn/start', { threadId, input: input('Hold a tool while queued messages wait.') });
    await waitFor(() => fs.existsSync(path.join(root, 'ready')) && messages.some(msg => msg.method === 'item/started' && msg.params.item.type === 'commandExecution'), 'real held tool');
    for (const [id, text] of [['first', 'QUEUE_FIRST_28c'], ['second', 'QUEUE_SECOND_91b']]) {
      let acknowledged = false;
      request('turn/steer', { threadId, expectedTurnId: turn.id, clientUserMessageId: id, input: input(text) }).then(() => { acknowledged = true; });
      await waitFor(() => acknowledged, 'pending steer accepted before tool completion', 1500);
    }
    const cancelled = await request('turn/steer/cancel', { threadId, clientUserMessageIds: ['first', 'second', 'missing', 'first'] });
    assert.deepEqual(cancelled.cancelledClientUserMessageIds, ['first', 'second']);
    assert.equal(providerInputs().filter(row => row.method === '_session/steering').length, 0, 'originals must remain undelivered');
    const replacement = 'QUEUE_FIRST_28c\nQUEUE_SECOND_91b\nCURRENT_DRAFT_62a_EDITED';
    await request('turn/steer', { threadId, expectedTurnId: turn.id, clientUserMessageId: 'replacement', input: input(replacement) });
    fs.writeFileSync(path.join(root, 'release'), 'done');
    await waitFor(() => providerInputs().some(row => row.method === '_session/steering'), 'edited replacement delivered');
    await waitFor(() => messages.some(msg => msg.method === 'item/completed' && msg.params.item.clientId === 'replacement'), 'replacement committed');
    const delivered = await request('turn/steer/cancel', { threadId, clientUserMessageIds: ['replacement', 'first', 'missing'] });
    assert.deepEqual(delivered.cancelledClientUserMessageIds, [], 'delivered/unknown inputs must never become editable');
    fs.writeFileSync(path.join(root, 'ambiguous-error'), 'lose acknowledgement');
    await request('turn/steer', { threadId, expectedTurnId: turn.id, clientUserMessageId: 'uncertain', input: input('UNCERTAIN_DELIVERY_83c') });
    await waitFor(() => messages.some(msg => msg.method === 'warning' && msg.params.message.includes('delivery is unconfirmed')), 'ambiguous delivery reported');
    const uncertain = await request('turn/steer/cancel', { threadId, clientUserMessageIds: ['uncertain'] });
    assert.deepEqual(uncertain.cancelledClientUserMessageIds, [], 'an ambiguous provider acknowledgement must never permit duplicate replay');
    fs.writeFileSync(path.join(root, 'finish'), 'done');
    await waitFor(() => messages.some(msg => msg.method === 'turn/completed' && msg.params.turn.id === turn.id), 'turn completed');
    const steers = providerInputs().filter(row => row.method === '_session/steering');
    assert.equal(steers.length, 2, 'original delayed tasks and ambiguous delivery must not be replayed');
    assert.equal(steers[0].params.prompt.map(part => part.text ?? '').join(''), replacement);
    assert(!messages.some(msg => msg.method === 'item/completed' && ['first', 'second'].includes(msg.params.item.clientId)));
    console.log('PASS held Claude steers cancel atomically; edited replacement reaches ACP once; delivered/unknown/ambiguous inputs cannot be replayed');
  })().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (ws) ws.close();
    if (bridge) {
      const exited = new Promise(resolve => bridge.once('exit', resolve));
      bridge.kill('SIGTERM');
      if (!await Promise.race([exited.then(() => true), pause(3000).then(() => false)])) bridge.kill('SIGKILL');
    }
    fs.writeFileSync(path.join(root, 'messages.json'), JSON.stringify(messages, null, 2));
    console.log(`Evidence: ${root}`);
  });
}
