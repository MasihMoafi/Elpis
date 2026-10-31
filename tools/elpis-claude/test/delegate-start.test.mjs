import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocketServer } from '../node_modules/ws/wrapper.mjs';
import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';

test('a refused helper start preserves its managed-policy reason and closes its connection', { timeout: 10000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-delegate-start-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const reason = 'This permission mode is restricted by managed settings. Choose an allowed default in Settings.';
  const methods = [];
  let closed = false;
  server.on('connection', socket => {
    socket.on('close', () => { closed = true; });
    socket.on('message', data => {
      const msg = JSON.parse(String(data));
      methods.push(msg.method);
      if (msg.id === undefined) return;
      socket.send(JSON.stringify({ id: msg.id, ...(msg.method === 'thread/start'
        ? { error: { code: -32600, message: reason } }
        : { result: msg.method === 'thread/read' ? { thread: { mcpServerSelection: null } } : {} }) }));
    });
  });
  const child = spawn(process.execPath, [new URL('../elpis-agents-mcp.mjs', import.meta.url).pathname], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, ELPIS_PARENT_THREAD: 'parent',
      ELPIS_BRIDGE_URL: `ws://127.0.0.1:${server.address().port}`, ELPIS_AGENTS_LOG: path.join(root, 'agents.log') },
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line), call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    msg.error ? call.reject(Error(msg.error.message)) : call.resolve(msg.result);
  });
  child.on('exit', () => { for (const call of pending.values()) call.reject(Error(`delegate server exited: ${stderr}`)); });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    }
    removeTestTempDir(root);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'delegate-start-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await rpc('tools/call', { name: 'delegate', arguments: { task: 'Do the fixture.', model: 'gpt-test', provider: 'fixture', cwd: root } });
  assert.equal(result.isError, true);
  assert(result.content.some(item => item.text?.includes(reason)), 'the model receives the actual managed refusal, not an object string');
  for (let i = 0; !closed && i < 100; i++) await pause(10);
  assert.equal(closed, true, 'the refused helper leaves no app-server connection open');
  assert.equal(methods.includes('turn/start'), false, 'a refused helper never starts inference');
});

test('a helper is parented to the chat that called delegate, never another chat', { timeout: 10000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-delegate-parent-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const starts = [];
  const archived = [];
  const selections = { 'chat-a': null, 'chat-b': [], 'chat-c': ['alpha'], 'chat-old': [] };
  server.on('connection', socket => {
    socket.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id === undefined) return;
      if (msg.method === 'thread/start') starts.push(msg.params);
      if (msg.method === 'thread/archive') archived.push(msg.params.threadId);
      const result = msg.method === 'thread/read'
        ? { thread: Object.hasOwn(selections, msg.params.threadId) ? { mcpServerSelection: selections[msg.params.threadId] } : {} }
        : msg.method === 'thread/start' && msg.params.elpisParentThreadId === 'chat-old' ? { thread: { id: 'old-child' } } : {};
      socket.send(JSON.stringify({ id: msg.id, ...(msg.method === 'thread/start' && msg.params.elpisParentThreadId !== 'chat-old'
        ? { error: { code: -32600, message: 'fixture stops here' } } : { result }) }));
    });
  });
  const child = spawn(process.execPath, [new URL('../elpis-agents-mcp.mjs', import.meta.url).pathname], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root,
      ELPIS_BRIDGE_URL: `ws://127.0.0.1:${server.address().port}`, ELPIS_AGENTS_LOG: path.join(root, 'agents.log') },
  });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line), call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    msg.error ? call.reject(Error(msg.error.message)) : call.resolve(msg.result);
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    removeTestTempDir(root);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'delegate-parent-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const caller of ['chat-a', 'chat-b', 'chat-c']) {
    const result = await rpc('tools/call', { name: 'delegate', arguments: { task: 'Do the fixture.', model: 'gpt-test', provider: 'fixture', cwd: root }, _meta: { threadId: caller } });
    assert.match(result.content[0].text, /fixture stops here/, JSON.stringify(result));
  }
  assert.deepEqual(starts.map(params => params.elpisParentThreadId), ['chat-a', 'chat-b', 'chat-c']);
  assert.deepEqual(starts.map(params => params.mcpServerSelection), [null, [], ['alpha']]);

  const missing = await rpc('tools/call', { name: 'delegate', arguments: { task: 'No selection.', model: 'gpt-test', provider: 'fixture', cwd: root }, _meta: { threadId: 'chat-missing' } });
  assert.match(missing.content[0].text, /MCP selection is unavailable/);
  const unsupported = await rpc('tools/call', { name: 'delegate', arguments: { task: 'Unsupported selection.', model: 'agy/gemini-test', cwd: root }, _meta: { threadId: 'chat-c' } });
  assert.match(unsupported.content[0].text, /MCP choices are unavailable/);
  const old = await rpc('tools/call', { name: 'delegate', arguments: { task: 'Old engine.', model: 'gpt-test', provider: 'fixture', cwd: root }, _meta: { threadId: 'chat-old' } });
  assert.match(old.content[0].text, /could not preserve/);
  assert.deepEqual(starts.map(params => params.elpisParentThreadId), ['chat-a', 'chat-b', 'chat-c', 'chat-old']);
  assert.deepEqual(archived, ['old-child']);
});
