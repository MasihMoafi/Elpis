// Real delegate MCP -> shared bridge -> DesktopClient -> desktop HTTP/SSE.
// Only inference/storage are scripted; each engine process has its own loaded threads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DesktopClient } from '../../../apps/elpis-desktop/bridge/client.mjs';
import { startDesktopServer } from '../../../apps/elpis-desktop/bridge/server.mjs';
import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);

if (process.argv.includes('app-server')) {
  const loaded = new Map();
  const timers = new Map();
  const file = id => path.join(process.env.HOME, `${id}.json`);
  const stored = id => fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
  const save = row => fs.writeFileSync(file(row.thread.id), JSON.stringify(row));
  const settings = (p, previous = {}) => {
    const profile = p.permissions ?? (p.sandbox && { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[p.sandbox]);
    const sandboxPolicy = profile ? { type: { ':read-only': 'readOnly', ':workspace': 'workspaceWrite', ':danger-full-access': 'dangerFullAccess' }[profile] } : p.sandboxPolicy ?? previous.sandboxPolicy;
    return { ...previous, approvalPolicy: p.approvalPolicy ?? previous.approvalPolicy ?? 'never', approvalsReviewer: p.approvalsReviewer ?? previous.approvalsReviewer ?? 'user', sandboxPolicy,
      activePermissionProfile: profile ? { id: profile } : null };
  };
  const handle = (msg, send) => {
    if (msg.id === undefined) return;
    const p = msg.params ?? {};
    const reply = result => send({ id: msg.id, result });
    const missing = () => send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
    let row = loaded.get(p.threadId);
    switch (msg.method) {
      case 'initialize': return reply({ userAgent: 'a166-fixture' });
      case 'thread/start': {
        const id = randomUUID();
        row = { thread: { id, cwd: p.cwd, model: p.model, source: 'appServer', status: { type: 'idle' }, turns: [], historyMode: 'paginated' }, model: p.model, modelProvider: p.modelProvider ?? 'openai', ...settings(p) };
        loaded.set(id, row); save(row);
        reply({ ...row, sandbox: row.sandboxPolicy });
        return send({ method: 'thread/started', params: { thread: row.thread } });
      }
      case 'thread/list': return reply({ data: fs.readdirSync(process.env.HOME).filter(name => /^[\da-f-]{36}\.json$/.test(name)).map(name => stored(name.slice(0, -5)).thread), nextCursor: null });
      case 'thread/read': {
        row ??= stored(p.threadId);
        return row ? reply({ thread: { ...row.thread, turns: p.includeTurns ? row.thread.turns : [] } }) : missing();
      }
      case 'thread/resume': {
        const saved = row ?? stored(p.threadId);
        if (!saved || (!row && saved.thread.status.type === 'active')) return missing();
        loaded.set(p.threadId, saved);
        return reply({ ...saved, sandbox: saved.sandboxPolicy, initialTurnsPage: { data: saved.thread.turns } });
      }
      case 'thread/items/list':
        if (!row) return missing();
        return reply({ data: row.thread.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null });
      case 'thread/turns/list':
        return row ? reply({ data: row.thread.turns, nextCursor: null }) : missing();
      case 'thread/name/set':
        if (!row) return missing();
        row.thread.name = p.name; save(row); return reply({});
      case 'thread/settings/update':
        if (!row) return missing();
        Object.assign(row, settings(p, row)); save(row);
        send({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: row } });
        return reply({});
      case 'turn/start': {
        if (!row) return missing();
        const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: 'prompt', type: 'userMessage', content: p.input }] };
        row.thread.status = { type: 'active', activeFlags: [] }; row.thread.turns = [turn]; save(row);
        reply({ turn }); send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
        let n = 0;
        timers.set(p.threadId, setInterval(() => send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId: turn.id, itemId: 'answer', delta: `LIVE ${++n}\n` } }), 40));
        return;
      }
      case 'turn/interrupt': {
        if (!row) return missing();
        clearInterval(timers.get(p.threadId));
        row.thread.status = { type: 'idle' }; row.thread.turns[0].status = 'interrupted'; save(row);
        send({ method: 'turn/completed', params: { threadId: p.threadId, turn: row.thread.turns[0] } });
        return reply({});
      }
      default: return reply({});
    }
  };
  const socket = process.argv.find(arg => arg.startsWith('unix://'))?.slice(7);
  if (socket) {
    const server = http.createServer();
    new WebSocketServer({ server }).on('connection', ws => ws.on('message', data => handle(JSON.parse(String(data)), msg => ws.readyState === 1 && ws.send(JSON.stringify(msg)))));
    server.listen(socket);
  } else readline.createInterface({ input: process.stdin }).on('line', line => handle(JSON.parse(line), msg => process.stdout.write(JSON.stringify(msg) + '\n')));
} else {
  test('desktop opens a delegated helper and changes permissions during its live turn', { timeout: 20000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), 'a166-'));
    const socketPath = path.join(root, 'bridge.sock'), log = path.join(root, 'bridge.log');
    const engine = path.join(root, 'engine.mjs');
    fs.writeFileSync(engine, `#!${process.execPath}\nawait import(${JSON.stringify(self)});\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine,
      ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: log };
    const bridge = spawn(process.execPath, [path.join(source, 'acp-bridge.mjs')], { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', app, desktop, mcp, observer, sse;
    bridge.stderr.on('data', data => { stderr += data; });
    t.after(async () => {
      await sse?.cancel(); observer?.close(); await mcp?.close(); await app?.close(); desktop?.close();
      if (bridge.exitCode === null && bridge.signalCode === null) {
        const ended = once(bridge, 'exit'); bridge.kill('SIGTERM');
        const timer = setTimeout(() => process.kill(-bridge.pid, 'SIGKILL'), 2000);
        await ended; clearTimeout(timer);
      }
      try { process.kill(-bridge.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      removeTestTempDir(root);
    });
    const until = async (predicate, label) => {
      const deadline = Date.now() + 8000;
      while (!predicate()) { assert.ok(Date.now() < deadline, `${label}: ${stderr}`); await pause(10); }
    };
    await until(() => (fs.statSync(socketPath, { throwIfNoEntry: false })?.mode & 0o777) === 0o600, 'bridge startup');
    observer = new WebSocket(`ws+unix://${socketPath}:/`);
    await once(observer, 'open');
    const pending = new Map(); let seq = 0;
    observer.on('message', data => { const msg = JSON.parse(String(data)); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
    const rpc = (method, params) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); observer.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'a166-parent' }, capabilities: { experimentalApi: true } });
    const parent = await rpc('thread/start', { model: 'claude/haiku', cwd: root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.ifError(parent.error);
    assert.equal(parent.result.model, 'claude/haiku');
    mcp = new Client({ name: 'a166-desktop-test', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(source, 'elpis-agents-mcp.mjs')], env: { ...env, ELPIS_BRIDGE_URL: `ws+unix://${socketPath}:/`, ELPIS_PARENT_THREAD: parent.result.thread.id, ELPIS_AGENTS_LOG: path.join(root, 'agents.log') } }));
    const delegate = async allow_writes => {
      const result = await mcp.callTool({ name: 'delegate', arguments: { model: 'gpt-test', task: 'Keep working for the desktop test', cwd: root, wait: false, allow_writes } });
      assert.ok(!result.isError, JSON.stringify(result));
      const id = result.content[0].text.match(/Elpis thread ([\da-f-]{36})/)?.[1];
      assert.ok(id, result.content[0].text);
      await until(() => fs.existsSync(path.join(root, `${id}.json`)) && JSON.parse(fs.readFileSync(path.join(root, `${id}.json`))).thread.status.type === 'active', 'helper turn starts');
      return id;
    };
    const id = await delegate(true);
    desktop = await DesktopClient.connect({ socketPath, timeoutMs: 4000, settingsConfirmMs: 100, appHome: root, rewindHome: path.join(root, 'rewind'), archiveDirectory: path.join(root, 'archives'), spawnLinksFile: path.join(root, 'links.json'), workflowOptions: { stateDir: path.join(root, 'workflows') } });
    app = await startDesktopServer({ client: desktop, elpisHome: root, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing'), screenshots: path.join(root, 'shots') } });
    const launch = new URL(app.url), origin = launch.origin;
    const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const request = async (route, body) => {
      const response = await fetch(origin + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const events = await fetch(origin + '/api/events', { headers: { Cookie: cookie } });
    sse = events.body.getReader(); let live = '';
    const readEvents = async () => { for (;;) { const result = await sse.read(); if (result.done) break; live += Buffer.from(result.value).toString(); } };
    const reading = readEvents();
    t.after(() => reading);
    const messages = () => live.split('\n\n').slice(0, -1).flatMap(block => block.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
    await t.test('sidebar and exact open requests return live history and turn', async () => {
      const listed = await request('/threads?limit=100');
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.ok(listed.body.data.some(thread => thread.id === id && thread.parentThreadId === parent.result.thread.id));
      const history = await request(`/threads/${id}?limit=100`);
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.ok(history.body.data.some(entry => entry.item.type === 'userMessage'));
      const opened = await request(`/threads/${id}/resume`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.ok(opened.body.activeTurnId);
      await until(() => messages().some(msg => msg.method === 'item/agentMessage/delta' && msg.params?.threadId === id && msg.params.delta.includes('LIVE')), 'desktop SSE receives live helper items');
    });
    await t.test('permission changes are accepted and visible before completion', async () => {
      const opened = await request(`/threads/${id}/resume`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      for (const [permissions, sandbox, reviewer] of [['ask', 'workspaceWrite', 'user'], ['auto', 'workspaceWrite', 'auto_review'], ['full', 'dangerFullAccess', 'user']]) {
        const changed = await request(`/threads/${id}/permissions`, { permissions });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.equal(changed.body.permissions, permissions);
        await until(() => messages().some(msg => msg.method === 'thread/settings/updated' && msg.params?.threadId === id
          && msg.params.threadSettings.sandboxPolicy.type === sandbox && msg.params.threadSettings.approvalsReviewer === reviewer), `${permissions} permissions reach desktop SSE`);
        assert.equal((await request(`/threads/${id}/resume`, {})).body.activeTurnId, opened.body.activeTurnId);
      }
      const previous = messages().length;
      await until(() => messages().slice(previous).some(msg => msg.method === 'item/agentMessage/delta' && msg.params?.threadId === id), 'helper remains live after permission changes');
    });
    await t.test('missing threads and grants above the helper ceiling are refused', async () => {
      const missing = await request(`/threads/${randomUUID()}/permissions`, { permissions: 'full' });
      assert.equal(missing.status, 502);
      assert.match(missing.body.error, /thread not found/);
      const restricted = await delegate(false);
      const opened = await request(`/threads/${restricted}/resume`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const changed = await request(`/threads/${restricted}/permissions`, { permissions: 'full' });
      assert.equal(changed.status, 409, JSON.stringify(changed.body));
      assert.match(changed.body.error, /did not apply full/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, `${restricted}.json`))).sandboxPolicy.type, 'readOnly');
    });
  });
}
