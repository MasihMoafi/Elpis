'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { WebSocketServer } = WebSocket;

async function main() {
  const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => bridge.once('listening', resolve));
  const threads = new Map();
  const methods = [];
  let nextThread = 0;
  bridge.on('connection', ws => ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (!msg.method || msg.id === undefined) return;
    methods.push(msg.method);
    let result;
    if (msg.method === 'initialize') result = {};
    else if (msg.method === 'thread/start') {
      const id = `helper-${++nextThread}`;
      const thread = { id, source: 'appServer', parentThreadId: msg.params.elpisParentThreadId,
        model: msg.params.model, status: { type: 'active' }, turns: [] };
      threads.set(id, thread);
      result = { thread };
    } else if (msg.method === 'thread/name/set') result = {};
    else if (msg.method === 'turn/start') {
      const thread = threads.get(msg.params.threadId);
      const turn = { id: `turn-${thread.id}`, status: 'inProgress', items: [] };
      thread.turns.push(turn);
      result = { turn };
      setImmediate(() => {
        turn.items.push({ type: 'commandExecution', command: 'printf fixture' },
          { type: 'agentMessage', text: 'Answer from previous server.' });
        turn.status = 'completed';
        thread.status = { type: 'idle' };
        ws.send(JSON.stringify({ method: 'item/completed', params: { threadId: thread.id, item: turn.items[0] } }));
        ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: thread.id, delta: turn.items[1].text } }));
        ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn } }));
      });
    } else if (msg.method === 'thread/read') result = { thread: threads.get(msg.params.threadId) };
    else if (msg.method === 'thread/turns/list') result = { data: threads.get(msg.params.threadId).turns.slice(-1) };
    else throw Error(`Unexpected ${msg.method}`);
    ws.send(JSON.stringify({ id: msg.id, result }));
  }));

  const servers = [];
  async function server() {
    const proc = spawn(process.execPath, [path.resolve(__dirname, '../tools/elpis-claude/elpis-agents-mcp.mjs')], {
      env: { ...process.env, ELPIS_BRIDGE_URL: `ws://127.0.0.1:${bridge.address().port}`,
        ELPIS_PARENT_THREAD: 'parent-chat' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    servers.push(proc);
    const pending = new Map();
    let seq = 0, buffer = '', stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (let pos; (pos = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        const msg = JSON.parse(line), p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      }
    });
    proc.on('exit', () => { for (const p of pending.values()) p.reject(Error(`Server exited: ${stderr}`)); });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { proc, call: (name, args) => rpc('tools/call', { name, arguments: args }) };
  }

  try {
    const first = await server();
    const delegated = await first.call('delegate', { task: 'Reply with the fixture answer.', model: 'gpt-6.1-sol' });
    const id = delegated.content[0].text.match(/Elpis thread (\S+)\)/)?.[1];
    assert(id, delegated.content[0].text);
    first.proc.kill();
    await new Promise(resolve => first.proc.once('exit', resolve));

    threads.set('ordinary-chat', { id: 'ordinary-chat', source: 'cli', model: 'gpt-6.1-sol',
      status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Private answer.' }] }] });
    const fresh = await server();
    const before = methods.length;
    const found = await fresh.call('delegate_status', { thread_id: id });
    assert.equal(found.isError, undefined, JSON.stringify(found));
    assert.match(found.content[0].text, /status: completed/);
    assert.match(found.content[0].text, /Commands it ran: printf fixture/);
    assert.match(found.content[0].text, /Answer:\nAnswer from previous server\./);
    assert.deepEqual(methods.slice(before), ['initialize', 'thread/read', 'thread/turns/list']);
    console.log('PASS fresh server reads the completed helper answer and commands without resuming it');

    for (const [id, turnStatus, expected] of [
      ['working-helper', 'inProgress', 'running'],
      ['failed-helper', 'failed', 'failed'],
      ['stopped-helper', 'interrupted', 'interrupted'],
    ]) {
      threads.set(id, { id, source: 'appServer', parentThreadId: 'parent-chat', model: 'gpt-6.1-sol',
        status: { type: turnStatus === 'inProgress' ? 'active' : 'idle' },
        turns: [{ status: turnStatus, items: [{ type: 'agentMessage', text: `${id} answer` }] }] });
      const status = await fresh.call('delegate_status', { thread_id: id });
      assert.match(status.content[0].text, new RegExp(`status: ${expected}`));
      assert.match(status.content[0].text, new RegExp(`${id} answer`));
    }
    console.log('PASS recovered working, failed, and stopped helpers show their stored turn status');

    threads.set('native-helper', { id: 'native-helper', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-chat' } } },
      model: 'gpt-6.1-sol', status: { type: 'idle' },
      turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Native helper answer.' }] }] });
    const native = await fresh.call('delegate_status', { thread_id: 'native-helper' });
    assert.match(native.content[0].text, /Native helper answer\./);
    console.log('PASS a thread marked as a spawned helper by its source is visible');

    const ordinary = await fresh.call('delegate_status', { thread_id: 'ordinary-chat' });
    assert.equal(ordinary.isError, true);
    assert.doesNotMatch(ordinary.content[0].text, /Private answer/);
    threads.set('review-thread', { id: 'review-thread', source: { subAgent: 'review' },
      status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Review answer.' }] }] });
    const review = await fresh.call('delegate_status', { thread_id: 'review-thread' });
    assert.equal(review.isError, true);
    assert.doesNotMatch(review.content[0].text, /Review answer/);
    console.log('PASS a regular thread is refused');

    for (const name of ['delegate_steer', 'delegate_stop']) {
      const refused = await fresh.call(name, { thread_id: id, message: 'Change course.' });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /visible through delegate_status/);
    }
    console.log('PASS an unowned helper cannot be steered or stopped through this server');
  } finally {
    for (const proc of servers) proc.kill();
    for (const client of bridge.clients) client.terminate();
    await new Promise(resolve => bridge.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
