'use strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';

type Item = { type: string; command?: string; text?: string };
type Turn = { id?: string; status: string; items: Item[] };
type Thread = { id: string; source?: string | { subAgent: string | { thread_spawn: { parent_thread_id: string } } }; parentThreadId?: string; model?: string; status: { type: string }; turns: Turn[] };
type BridgeRequest = { method?: string; id?: number; params: { elpisParentThreadId: string; model: string; threadId: string; expectedTurnId: string; turnId: string } };
type FixtureSocket = { on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; terminate(): void };
type FixtureServer = {
  once(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (socket: FixtureSocket) => void): void;
  address(): AddressInfo | string | null;
  clients: Set<FixtureSocket>;
  close(callback: () => void): void;
};
type ToolContent = { text: string };
type ToolResult = { isError?: boolean; content: ToolContent[] };
type Waiter = { resolve: (result: ToolResult) => void; reject: (error: Error) => void };
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');
const WebSocket: { WebSocketServer: new (options: { host: string; port: number }) => FixtureServer } = require('../tools/elpis-claude/node_modules/ws');
const { WebSocketServer } = WebSocket;

async function main() {
  const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => bridge.once('listening', resolve));
  const threads = new Map<string, Thread>();
  const methods: string[] = [];
  let nextThread = 0;
  bridge.on('connection', ws => ws.on('message', data => {
    const msg: BridgeRequest = JSON.parse(String(data));
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
      const thread = threads.get(msg.params.threadId) as Thread;
      const turn: Turn = { id: `turn-${thread.id}`, status: 'inProgress', items: [] };
      thread.turns.push(turn);
      result = { turn };
      setImmediate(() => {
        turn.items.push({ type: 'commandExecution', command: 'printf fixture' },
          { type: 'agentMessage', text: 'Answer from previous server.' });
        turn.status = 'completed';
        thread.status = { type: 'idle' };
        ws.send(JSON.stringify({ method: 'item/completed', params: { threadId: thread.id, item: turn.items[0] } }));
        ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: thread.id, delta: (turn.items[1] as Item).text } }));
        ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn } }));
      });
    } else if (msg.method === 'thread/read') result = { thread: threads.get(msg.params.threadId) };
    else if (msg.method === 'thread/turns/list') result = { data: (threads.get(msg.params.threadId) as Thread).turns.slice(-1) };
    else if (msg.method === 'turn/steer') {
      assert.equal(msg.params.expectedTurnId, ((threads.get(msg.params.threadId) as Thread).turns.at(-1) as Turn).id);
      result = { turnId: msg.params.expectedTurnId };
    } else if (msg.method === 'turn/interrupt') {
      const thread = threads.get(msg.params.threadId) as Thread, turn = thread.turns.at(-1) as Turn;
      assert.equal(msg.params.turnId, turn.id);
      turn.status = 'interrupted'; thread.status = { type: 'idle' };
      result = {};
    }
    else throw Error(`Unexpected ${msg.method}`);
    ws.send(JSON.stringify({ id: msg.id, result }));
  }));

  const servers: ChildProcessWithoutNullStreams[] = [];
  async function server() {
    const proc = spawn(process.execPath, [path.resolve(__dirname, '../tools/elpis-claude/elpis-agents-mcp.mts')], {
      env: { ...process.env, ELPIS_BRIDGE_URL: `ws://127.0.0.1:${(bridge.address() as AddressInfo).port}`,
        ELPIS_PARENT_THREAD: 'parent-chat' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    servers.push(proc);
    const pending = new Map<number, Waiter>();
    let seq = 0, buffer = '', stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (let pos; (pos = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        const msg: { id: number; error?: { message: string }; result: ToolResult } = JSON.parse(line), p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      }
    });
    proc.on('exit', () => { for (const p of pending.values()) p.reject(Error(`Server exited: ${stderr}`)); });
    const rpc = (method: string, params: unknown) => new Promise<ToolResult>((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { proc, call: (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }) };
  }

  try {
    const first = await server();
    const delegated = await first.call('delegate', { task: 'Reply with the fixture answer.', model: 'gpt-6.1-sol' });
    const id = (delegated.content[0] as ToolContent).text.match(/Elpis thread (\S+)\)/)?.[1];
    assert(id, (delegated.content[0] as ToolContent).text);
    first.proc.kill();
    await new Promise<void>(resolve => first.proc.once('exit', () => resolve()));

    threads.set('ordinary-chat', { id: 'ordinary-chat', source: 'cli', model: 'gpt-6.1-sol',
      status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Private answer.' }] }] });
    const fresh = await server();
    const before = methods.length;
    const found = await fresh.call('delegate_status', { thread_id: id });
    assert.equal(found.isError, undefined, JSON.stringify(found));
    assert.match((found.content[0] as ToolContent).text, /status: completed/);
    assert.match((found.content[0] as ToolContent).text, /Commands it ran: printf fixture/);
    assert.match((found.content[0] as ToolContent).text, /Answer:\nAnswer from previous server\./);
    assert.deepEqual(methods.slice(before), ['initialize', 'thread/read', 'thread/turns/list']);
    console.log('PASS fresh server reads the completed helper answer and commands without resuming it');

    for (const [id, turnStatus, expected] of [
      ['working-helper', 'inProgress', 'running'],
      ['failed-helper', 'failed', 'failed'],
      ['stopped-helper', 'interrupted', 'interrupted'],
    ] as const) {
      threads.set(id, { id, source: 'appServer', parentThreadId: 'parent-chat', model: 'gpt-6.1-sol',
        status: { type: turnStatus === 'inProgress' ? 'active' : 'idle' },
        turns: [{ id: `turn-${id}`, status: turnStatus, items: [{ type: 'agentMessage', text: `${id} answer` }] }] });
      const status = await fresh.call('delegate_status', { thread_id: id });
      assert.match((status.content[0] as ToolContent).text, new RegExp(`status: ${expected}`));
      assert.match((status.content[0] as ToolContent).text, new RegExp(`${id} answer`));
    }
    console.log('PASS recovered working, failed, and stopped helpers show their stored turn status');

    threads.set('native-helper', { id: 'native-helper', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-chat' } } },
      model: 'gpt-6.1-sol', status: { type: 'idle' },
      turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Native helper answer.' }] }] });
    const native = await fresh.call('delegate_status', { thread_id: 'native-helper' });
    assert.match((native.content[0] as ToolContent).text, /Native helper answer\./);
    console.log('PASS a thread marked as a spawned helper by its source is visible');

    const ordinary = await fresh.call('delegate_status', { thread_id: 'ordinary-chat' });
    assert.equal(ordinary.isError, true);
    assert.doesNotMatch((ordinary.content[0] as ToolContent).text, /Private answer/);
    threads.set('review-thread', { id: 'review-thread', source: { subAgent: 'review' },
      status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Review answer.' }] }] });
    const review = await fresh.call('delegate_status', { thread_id: 'review-thread' });
    assert.equal(review.isError, true);
    assert.doesNotMatch((review.content[0] as ToolContent).text, /Review answer/);
    console.log('PASS a regular thread is refused');

    const steered = await fresh.call('delegate_steer', { thread_id: 'working-helper', message: 'Change course.' });
    assert.equal(steered.isError, undefined, JSON.stringify(steered));
    assert.match((steered.content[0] as ToolContent).text, /Steered thread working-helper/);
    const stopped = await fresh.call('delegate_stop', { thread_id: 'working-helper' });
    assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
    assert.match((stopped.content[0] as ToolContent).text, /status: interrupted/);
    assert.equal(methods.includes('thread/resume'), false, 'steer and stop never acquire another writer');
    console.log('PASS a replacement server steers and stops its chat\'s running helper using the current turn id');

    threads.set('unrelated-helper', { id: 'unrelated-helper', parentThreadId: 'another-chat',
      status: { type: 'active' }, turns: [{ id: 'unrelated-turn', status: 'inProgress', items: [] }] });
    for (const name of ['delegate_steer', 'delegate_stop', 'delegate']) {
      const refused = await fresh.call(name, { thread_id: 'unrelated-helper', task: 'Follow up.', message: 'Change course.' });
      assert.equal(refused.isError, true);
      assert.match((refused.content[0] as ToolContent).text, /not a delegated helper of this chat/);
    }
    console.log('PASS another chat\'s helper cannot be steered, stopped or reopened through this server');
  } finally {
    for (const proc of servers) proc.kill();
    for (const client of bridge.clients) client.terminate();
    await new Promise<void>(resolve => bridge.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
