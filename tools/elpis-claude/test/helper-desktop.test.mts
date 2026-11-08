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
import { DesktopClient } from '../../../apps/elpis-desktop/bridge/client.mts';
import { startDesktopServer } from '../../../apps/elpis-desktop/bridge/server.mts';
import { connectAppServer } from '../app-server-connection.mts';
import { createTestTempDir, removeTestTempDir } from './temp-root.mts';

type Profile = ':read-only' | ':workspace' | ':danger-full-access';
type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
type Turn = { id: string; status: string; items: { id: string; type: string; content?: { text?: string }[] | undefined }[] };
type Thread = { id: string; cwd?: string | undefined; model?: string | undefined; source?: string; status: { type: string; activeFlags?: string[] }; turns: Turn[]; historyMode?: string; name?: string | undefined; parentThreadId?: string | undefined };
type Settings = { approvalPolicy?: string; approvalsReviewer?: string; sandboxPolicy?: { type?: string } | undefined; activePermissionProfile?: { id: Profile } | null };
type Row = Settings & { thread: Thread; model?: string | undefined; modelProvider?: string; approvalRequested?: boolean };
type Params = { threadId?: string; cwd?: string; model?: string; modelProvider?: string; name?: string; includeTurns?: boolean; input?: { text?: string }[]; permissions?: Profile; sandbox?: Sandbox; approvalPolicy?: string; approvalsReviewer?: string; sandboxPolicy?: { type?: string } };
type Wire = { id?: string | number; method?: string; params?: Params; result?: unknown };
type BridgeEvent = { method?: string; params: { threadId?: string; delta: string; item?: { id?: string }; threadSettings: { sandboxPolicy: { type: string }; approvalsReviewer: string } } };
type RpcResult = { model: string; thread: { id: string } };
type ApiBody = { data?: { id?: string; parentThreadId?: string; item?: { type: string } }[]; activeTurnId?: string; permissions?: string; error?: string };
type RestrictionReply = { id: number; error?: { message?: string }; result?: { thread?: { id: string }; turn?: { status: string } } };
const source = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);

if (process.argv.includes('app-server')) {
  const home = process.env.HOME; assert.ok(home);
  const loaded = new Map<string | undefined, Row>();
  const timers = new Map<string | undefined, NodeJS.Timeout>();
  const file = (id: string | undefined) => path.join(home, `${id}.json`);
  const stored = (id: string | undefined): Row | null => fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
  const save = (row: Row) => {
    fs.writeFileSync(file(row.thread.id) + '.pending', JSON.stringify(row));
    fs.renameSync(file(row.thread.id) + '.pending', file(row.thread.id));
  };
  const settings = (p: Params, previous: Settings = {}): Settings => {
    const profile = p.permissions ?? (p.sandbox && { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[p.sandbox] as Profile | undefined);
    const sandboxPolicy = profile ? { type: { ':read-only': 'readOnly', ':workspace': 'workspaceWrite', ':danger-full-access': 'dangerFullAccess' }[profile] } : p.sandboxPolicy ?? previous.sandboxPolicy;
    return { ...previous, approvalPolicy: p.approvalPolicy ?? previous.approvalPolicy ?? 'never', approvalsReviewer: p.approvalsReviewer ?? previous.approvalsReviewer ?? 'user', sandboxPolicy,
      activePermissionProfile: profile ? { id: profile } : null };
  };
  const handle = (msg: Wire, send: (message: object) => void) => {
    if (msg.id === undefined) return;
    if (!msg.method && String(msg.id).startsWith('native-child-approval-')) {
      fs.writeFileSync(path.join(home, 'native-child-decision.json'), JSON.stringify(msg.result)); return;
    }
    if (!msg.method && String(msg.id).startsWith('native-dynamic-')) {
      fs.writeFileSync(path.join(home, 'native-dynamic-response.json'), JSON.stringify(msg)); return;
    }
    const p = msg.params ?? {};
    const reply = (result: object) => send({ id: msg.id, result });
    const missing = () => send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
    let row = loaded.get(p.threadId);
    switch (msg.method) {
      case 'initialize': return reply({ userAgent: 'a166-fixture' });
      case 'config/read': return reply({ config: fs.existsSync(path.join(home, 'permission-defaults.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'permission-defaults.json'), 'utf8')) : {} });
      case 'configRequirements/read': return reply({ requirements: fs.existsSync(path.join(home, 'requirements.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'requirements.json'), 'utf8')) : null });
      case 'config/batchWrite':
        if (fs.existsSync(path.join(home, 'hold-profile'))) fs.writeFileSync(path.join(home, 'permission-defaults.json'), JSON.stringify({ approval_policy: 'never', default_permissions: ':danger-full-access' }));
        return reply({});
      case 'thread/start': {
        const id = randomUUID();
        row = { thread: { id, cwd: p.cwd, model: p.model, source: 'appServer', status: { type: 'idle' }, turns: [], historyMode: 'paginated' }, model: p.model, modelProvider: p.modelProvider ?? 'openai', ...settings(p) };
        loaded.set(id, row); save(row);
        reply({ ...row, sandbox: row.sandboxPolicy });
        return send({ method: 'thread/started', params: { thread: row.thread } });
      }
      case 'thread/list': return reply({ data: fs.readdirSync(home).filter(name => /^[\da-f-]{36}\.json$/.test(name)).map(name => stored(name.slice(0, -5))?.thread), nextCursor: null });
      case 'thread/read': {
        row ??= stored(p.threadId) ?? undefined;
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
        if (fs.existsSync(path.join(home, 'hold-profile'))) {
          const marker = path.join(home, 'profile-held');
          const count = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 0) + 1;
          fs.writeFileSync(marker, String(count));
          // The turn's preliminary settings update may finish, while the earlier
          // helper restriction and the native route's recheck remain pending.
          if (count === 2) return reply({});
          const release = () => {
            if (!fs.existsSync(path.join(home, 'release-profile'))) { setTimeout(release, 10); return; }
            if (fs.existsSync(path.join(home, 'reject-profile'))) return send({ id: msg.id, error: { code: -32600, message: 'fixture refuses restriction' } });
            send({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: { approvalPolicy: 'never', activePermissionProfile: { id: p.permissions } } } });
            reply({});
          };
          release(); return;
        }
        if (!row) return missing();
        Object.assign(row, settings(p, row)); save(row);
        send({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: row } });
        if (row.thread.parentThreadId && !row.approvalRequested) {
          row.approvalRequested = true; save(row);
          send({ id: `native-child-approval-${p.threadId}`, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId: 'child-turn', itemId: 'child-command', command: 'printf child' } });
        }
        return reply({});
      case 'turn/start': {
        if (fs.existsSync(path.join(home, 'hold-profile'))) fs.writeFileSync(path.join(home, 'turn-started'), '1');
        if (!row) return missing();
        const activeRow = row;
        const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: 'prompt', type: 'userMessage', content: p.input }] };
        row.thread.status = { type: 'active', activeFlags: [] }; row.thread.turns = [turn]; save(row);
        reply({ turn }); send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
        if (p.input?.some(item => item.text === '[dynamic-tool]')) send({ id: `native-dynamic-${p.threadId}`, method: 'item/tool/call',
          params: { threadId: p.threadId, turnId: turn.id, callId: 'probe', namespace: null, tool: 'orchestrator_probe', arguments: { value: 'source result' } } });
        if (p.input?.some(item => item.text === '[native-child]')) {
          const id = randomUUID();
          const childTurn = { id: 'child-turn', status: 'inProgress', items: [] };
          const child = { thread: { id, parentThreadId: p.threadId, cwd: row.thread.cwd, model: row.thread.model, status: { type: 'active' }, turns: [childTurn] }, ...settings({ approvalPolicy: 'on-request', permissions: ':workspace' }) };
          loaded.set(id, child); save(child);
          send({ method: 'thread/started', params: { thread: child.thread } });
          send({ method: 'turn/started', params: { threadId: id, turn: childTurn } });
        }
        let n = 0;
        timers.set(p.threadId, setInterval(() => {
          n++;
          const params = { threadId: p.threadId, turnId: turn.id };
          const item = { id: `command-${n}`, type: 'commandExecution', command: `printf ${n}`, status: 'completed', exitCode: 0, aggregatedOutput: `${n}\n`, commandActions: [], cwd: activeRow.thread.cwd };
          send({ method: 'item/started', params: { ...params, item: { ...item, status: 'inProgress' } } });
          send({ method: 'item/completed', params: { ...params, item } });
          // Equal consecutive deltas are distinct events; a transport fix must preserve both.
          for (const delta of ['read ', 'read ', `LIVE ${n}\n`]) send({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'answer', delta } });
        }, 40));
        return;
      }
      case 'turn/interrupt': {
        if (!row) return missing();
        clearInterval(timers.get(p.threadId));
        row.thread.status = { type: 'idle' }; const first = row.thread.turns[0]; assert.ok(first); first.status = 'interrupted'; save(row);
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
  for (const reject of [false, true]) test(`native helper waits for ${reject ? 'a refused' : 'a confirmed'} restriction before its turn`, { timeout: 20000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), 'helper-restriction-'));
    const socketPath = path.join(root, 'bridge.sock'), engine = path.join(root, 'engine.mjs');
    fs.writeFileSync(engine, `#!${process.execPath}\nawait import(${JSON.stringify(self)});\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'permission-defaults.json'), JSON.stringify({ approval_policy: 'on-request', default_permissions: ':workspace' }));
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1',
      ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: path.join(root, 'bridge.log') };
    const bridge = spawn(process.execPath, [process.env.HELPER_TEST_BRIDGE ?? path.join(source, 'acp-bridge.mts')], { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let ws: WebSocket | undefined;
    const pid = bridge.pid;
    assert.ok(pid);
    bridge.stderr.on('data', data => { stderr += data; });
    t.after(async () => {
      ws?.close();
      if (bridge.exitCode === null && bridge.signalCode === null) {
        const ended = once(bridge, 'exit'); bridge.kill('SIGTERM');
        const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 2000);
        await ended; clearTimeout(timer);
      }
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      removeTestTempDir(root);
    });
    const until = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 8000;
      while (!predicate()) { assert.ok(Date.now() < deadline, `${label}: ${stderr}`); await pause(10); }
    };
    await until(() => fs.existsSync(socketPath), 'bridge startup');
    const socket = new WebSocket(`ws+unix://${socketPath}:/`); ws = socket; await once(socket, 'open');
    const pending = new Map<number, (value: RestrictionReply) => void>(); let seq = 0;
    socket.on('message', data => { const msg: RestrictionReply = JSON.parse(String(data)); const resolve = pending.get(msg.id); if (resolve) { resolve(msg); pending.delete(msg.id); } });
    const rpc = (method: string, params: Record<string, unknown>) => new Promise<RestrictionReply>(resolve => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'helper-restriction-test' }, capabilities: { experimentalApi: true } });
    const helper = await rpc('thread/start', { model: 'gpt-test', cwd: root, elpisParentThreadId: 'parent', sandbox: 'workspace-write' });
    assert.ifError(helper.error);
    const threadId = helper.result?.thread?.id;
    assert.ok(threadId);
    fs.writeFileSync(path.join(root, 'hold-profile'), '1');
    if (reject) fs.writeFileSync(path.join(root, 'reject-profile'), '1');
    void rpc('config/batchWrite', { edits: [{ keyPath: 'default_permissions', value: ':danger-full-access', mergeStrategy: 'replace' }] });
    const held = path.join(root, 'profile-held');
    await until(() => fs.existsSync(held), 'helper restriction pending');
    let early: RestrictionReply | undefined;
    const started = rpc('turn/start', { threadId, model: 'gpt-test', input: [{ type: 'text', text: 'hello' }] }).then(result => { early = result; return result; });
    await until(() => Boolean(early) || Number(fs.readFileSync(held, 'utf8')) >= 3, 'turn waits for restriction');
    assert.equal(early, undefined, `turn replied before restriction: ${JSON.stringify(early)}`);
    assert.equal(fs.existsSync(path.join(root, 'turn-started')), false);
    fs.writeFileSync(path.join(root, 'release-profile'), '1');
    const result = await started;
    if (reject) {
      assert.match(result.error?.message ?? '', /restricted permissions could not be applied/);
      assert.equal(fs.existsSync(path.join(root, 'turn-started')), false);
    } else {
      assert.ifError(result.error);
      assert.equal(result.result?.turn?.status, 'inProgress');
      assert.equal(fs.existsSync(path.join(root, 'turn-started')), true);
    }
  });

  test('desktop opens a delegated helper and changes permissions during its live turn', { timeout: 20000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), 'a166-'));
    const socketPath = path.join(root, 'bridge.sock'), log = path.join(root, 'bridge.log');
    const engine = path.join(root, 'engine.mjs');
    fs.writeFileSync(engine, `#!${process.execPath}\nawait import(${JSON.stringify(self)});\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine,
      ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: log };
    const bridge = spawn(process.execPath, [process.env.HELPER_TEST_BRIDGE ?? path.join(source, 'acp-bridge.mts')], { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const bridgePid = bridge.pid; assert.ok(bridgePid);
    let stderr = '';
    let app: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
    let desktop: DesktopClient | undefined, mcp: Client | undefined, observer: WebSocket | undefined, sse: ReadableStreamDefaultReader<Uint8Array> | undefined;
    bridge.stderr.on('data', data => { stderr += data; });
    t.after(async () => {
      await sse?.cancel(); observer?.close(); await mcp?.close(); await app?.close(); desktop?.close();
      if (bridge.exitCode === null && bridge.signalCode === null) {
        const ended = once(bridge, 'exit'); bridge.kill('SIGTERM');
        const timer = setTimeout(() => process.kill(-bridgePid, 'SIGKILL'), 2000);
        await ended; clearTimeout(timer);
      }
      try { process.kill(-bridgePid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      removeTestTempDir(root);
    });
    const until = async (predicate: () => unknown, label: string) => {
      const deadline = Date.now() + 8000;
      while (!predicate()) { assert.ok(Date.now() < deadline, `${label}: ${stderr}`); await pause(10); }
    };
    await until(() => ((fs.statSync(socketPath, { throwIfNoEntry: false })?.mode ?? 0) & 0o777) === 0o600, 'bridge startup');
    observer = new WebSocket(`ws+unix://${socketPath}:/`);
    await once(observer, 'open');
    const pending = new Map<number, (message: { result: RpcResult; error?: { message: string } }) => void>(); let seq = 0;
    const observerEvents: BridgeEvent[] = [];
    observer.on('message', data => { const msg = JSON.parse(String(data)); if (msg.method) observerEvents.push(msg); const waiter = pending.get(msg.id); if (waiter) { waiter(msg); pending.delete(msg.id); } });
    const socket = observer;
    const rpc = (method: string, params: object) => new Promise<{ result: RpcResult; error?: { message: string } }>(resolve => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'a166-parent' }, capabilities: { experimentalApi: true } });
    const parent = await rpc('thread/start', { model: 'claude/haiku', cwd: root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.ifError(parent.error);
    assert.equal(parent.result.model, 'claude/haiku');
    const mcpClient = new Client({ name: 'a166-desktop-test', version: '1' }); mcp = mcpClient;
    const mcpEnv = Object.fromEntries(Object.entries({ ...env, ELPIS_BRIDGE_URL: `ws+unix://${socketPath}:/`, ELPIS_PARENT_THREAD: parent.result.thread.id, ELPIS_AGENTS_LOG: path.join(root, 'agents.log') }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(source, 'elpis-agents-mcp.mts')], env: mcpEnv }));
    const delegate = async (allow_writes: boolean) => {
      const result = await mcpClient.callTool({ name: 'delegate', arguments: { model: 'gpt-test', task: 'Keep working for the desktop test', cwd: root, wait: false, allow_writes } });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(Array.isArray(result.content) && typeof result.content[0]?.text === 'string');
      const id = result.content[0].text.match(/Elpis thread ([\da-f-]{36})/)?.[1];
      assert.ok(id, result.content[0].text);
      await until(() => fs.existsSync(path.join(root, `${id}.json`)) && JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8')).thread.status.type === 'active', 'helper turn starts');
      return id;
    };
    const id = await delegate(true);
    desktop = await DesktopClient.connect({ socketPath, timeoutMs: 4000, settingsConfirmMs: 100, appHome: root, rewindHome: path.join(root, 'rewind'), archiveDirectory: path.join(root, 'archives'), spawnLinksFile: path.join(root, 'links.json'), workflowOptions: { stateDir: path.join(root, 'workflows') } });
    app = await startDesktopServer({ client: desktop, elpisHome: root, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing'), screenshots: path.join(root, 'shots') } });
    const launch = new URL(app.url), origin = launch.origin;
    const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
    const setCookie = session.headers.get('set-cookie'); assert.ok(setCookie);
    const cookie = setCookie.split(';')[0]; assert.ok(cookie);
    const request = async (route: string, body?: object) => {
      const response = await fetch(origin + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as ApiBody };
    };
    const events = await fetch(origin + '/api/events', { headers: { Cookie: cookie } });
    assert.ok(events.body); const reader = events.body.getReader(); sse = reader; let live = '';
    const readEvents = async () => { for (;;) { const result = await reader.read(); if (result.done) break; live += Buffer.from(result.value).toString(); } };
    const reading = readEvents();
    t.after(() => reading);
    const messages = (): BridgeEvent[] => live.split('\n\n').slice(0, -1).flatMap(block => block.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
    await t.test('a managed helper serves its dynamic tool on its owning connection while its parent is open', async () => {
      const connection = connectAppServer({ url: `ws+unix://${socketPath}:/`, name: 'elpis-agents' })
      try {
        await connection.ready
        let served = 0
        connection.requests.add(message => {
          if (message.method !== 'item/tool/call' || message.id === undefined) return false
          served++; connection.respond(message.id, { success: true, contentItems: [{ type: 'inputText', text: 'source result' }] }); return true
        })
        const started = await connection.call('thread/start', { model: 'gpt-test', cwd: root, elpisParentThreadId: parent.result.thread.id,
          dynamicTools: [{ name: 'orchestrator_probe', description: 'Read evidence', inputSchema: { type: 'object' } }] })
        const threadId = started.thread.id
        await connection.call('turn/start', { threadId, input: [{ type: 'text', text: '[dynamic-tool]' }] })
        await until(() => fs.existsSync(path.join(root, 'native-dynamic-response.json')), 'the dynamic tool response reaches the engine')
        const response = JSON.parse(fs.readFileSync(path.join(root, 'native-dynamic-response.json'), 'utf8')) as { result?: unknown }
        assert.deepEqual(response.result, { success: true, contentItems: [{ type: 'inputText', text: 'source result' }] })
        assert.equal(served, 1)
        assert.equal(observerEvents.some(message => message.method === 'item/tool/call'), false)
        await connection.call('turn/interrupt', { threadId })
      } finally { connection.close() }
    })
    await t.test('an engine subagent follows Full access independently of its parent Ask choice and never relays approval', async () => {
      const native = await rpc('thread/start', { model: 'gpt-test', cwd: root });
      assert.ifError(native.error);
      const parentId = native.result.thread.id;
      assert.ifError((await rpc('thread/settings/update', { threadId: parentId, approvalPolicy: 'on-request', permissions: ':workspace' })).error);
      assert.ifError((await rpc('turn/start', { threadId: parentId, input: [{ type: 'text', text: '[native-child]' }] })).error);
      let child: Row | undefined;
      await until(() => {
        child = fs.readdirSync(root).filter(name => /^[\da-f-]{36}\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Row).find(row => row.thread.parentThreadId === parentId);
        return child?.approvalPolicy === 'never' && child?.activePermissionProfile?.id === ':danger-full-access';
      }, 'native subagent applies the shared Full access default');
      assert.ok(child);
      const childId = child.thread.id;
      await until(() => fs.existsSync(path.join(root, 'native-child-decision.json')), 'native subagent approval is answered automatically');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'native-child-decision.json'), 'utf8')), { decision: 'accept' });
      assert.equal(observerEvents.some(message => message.method === 'item/commandExecution/requestApproval' && message.params.threadId === childId), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, `${parentId}.json`), 'utf8')).approvalPolicy, 'on-request', 'the parent keeps its own choice');
    });
    await t.test('sidebar and exact open requests return live history and turn', async () => {
      const listed = await request('/threads?limit=100');
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.ok(listed.body.data);
      assert.ok(listed.body.data.some(thread => thread.id === id && thread.parentThreadId === parent.result.thread.id));
      const history = await request(`/threads/${id}?limit=100`);
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.ok(history.body.data);
      assert.ok(history.body.data.some(entry => entry.item?.type === 'userMessage'));
      const opened = await request(`/threads/${id}/resume`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.ok(opened.body.activeTurnId);
      await until(() => messages().some(msg => msg.method === 'item/agentMessage/delta' && msg.params?.threadId === id && msg.params.delta.includes('LIVE')), 'desktop SSE receives live helper items');
    });
    await t.test('delegate_status and the desktop receive each helper event once, preserving repeated words', async () => {
      const streamed = await delegate(true);
      assert.equal((await request(`/threads/${streamed}/resume`, {})).status, 200);
      await until(() => messages().filter(msg => msg.method === 'item/agentMessage/delta' && msg.params?.threadId === streamed && msg.params.delta.includes('LIVE')).length >= 2, 'desktop receives two complete streamed batches');
      const stopped = await mcpClient.callTool({ name: 'delegate_stop', arguments: { thread_id: streamed } });
      assert.ok(!stopped.isError, JSON.stringify(stopped));
      const status = await mcpClient.callTool({ name: 'delegate_status', arguments: { thread_id: streamed } });
      assert.ok(!status.isError, JSON.stringify(status));
      assert.ok(Array.isArray(status.content) && typeof status.content[0]?.text === 'string');
      const report: string = status.content[0].text;
      const answer = report.split('Answer:\n')[1];
      assert.ok(answer, report);
      const lines = answer.trim().split('\n');
      for (const [index, line] of lines.entries()) assert.equal(line, `read read LIVE ${index + 1}`, 'each real delta is delivered once, even when adjacent deltas have identical text');
      const commands = report.match(/Commands it ran: (.*)/)?.[1]?.split('; ');
      assert.deepEqual(commands, lines.map((_, index) => `printf ${index + 1}`), 'each command is listed once');
      await until(() => messages().some(msg => msg.method === 'turn/completed' && msg.params?.threadId === streamed), 'desktop sees the helper stop');
      const events = messages().filter(msg => msg.params?.threadId === streamed);
      const ticks = events.filter(msg => msg.method === 'item/agentMessage/delta' && msg.params.delta.startsWith('LIVE'));
      assert.equal(new Set(ticks.map(msg => msg.params.delta)).size, ticks.length, 'desktop SSE never doubles a text piece');
      for (const tick of ticks) {
        const matched = tick.params.delta.match(/\d+/); assert.ok(matched);
        const n = matched[0];
        assert.equal(events.filter(msg => msg.method === 'item/completed' && msg.params.item?.id === `command-${n}`).length, 1, 'desktop receives one command completion');
      }
      assert.equal(observerEvents.filter(msg => msg.method === 'item/agentMessage/delta' && msg.params.threadId === streamed).length, 0, 'a parent observer that never opened the helper receives no helper transcript');
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
        const saved = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8'));
        assert.equal(saved.approvalPolicy, permissions === 'full' ? 'never' : 'on-request', 'resuming a helper preserves its own menu choice');
        assert.equal(saved.sandboxPolicy.type, sandbox);
      }
      const previous = messages().length;
      await until(() => messages().slice(previous).some(msg => msg.method === 'item/agentMessage/delta' && msg.params?.threadId === id), 'helper remains live after permission changes');
    });
    await t.test('a missing chat is refused; the user can choose a helper mode above its automatic scope', async () => {
      const missing = await request(`/threads/${randomUUID()}/permissions`, { permissions: 'full' });
      assert.equal(missing.status, 502);
      assert.match(missing.body.error ?? '', /thread not found/);
      const restricted = await delegate(false);
      const opened = await request(`/threads/${restricted}/resume`, {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const changed = await request(`/threads/${restricted}/permissions`, { permissions: 'full' });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, `${restricted}.json`), 'utf8')).sandboxPolicy.type, 'dangerFullAccess');
      assert.equal((await request(`/threads/${restricted}/resume`, {})).status, 200);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, `${restricted}.json`), 'utf8')).sandboxPolicy.type, 'dangerFullAccess', 'an explicit helper choice survives reopening');
    });
    await t.test('a native subagent already starting is stopped when managed settings forbid its automatic policy', async () => {
      const parent = await rpc('thread/start', { model: 'gpt-test', cwd: root, approvalPolicy: 'on-request', permissions: ':workspace', elpisPermissionSource: 'chat' });
      assert.ifError(parent.error);
      fs.writeFileSync(path.join(root, 'requirements.json'), JSON.stringify({ allowedApprovalPolicies: ['on-request'], allowedSandboxModes: ['workspace-write'] }));
      assert.ifError((await rpc('turn/start', { threadId: parent.result.thread.id, input: [{ type: 'text', text: '[native-child]' }] })).error);
      let child: Row | undefined;
      await until(() => {
        child = fs.readdirSync(root).filter(name => /^[\da-f-]{36}\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Row).find(row => row.thread.parentThreadId === parent.result.thread.id);
        return child?.thread.turns[0]?.status === 'interrupted';
      }, 'managed rejection stops the child even if its turn started before requirements were read');
      assert.ok(child);
      const childId = child.thread.id;
      assert.deepEqual([child.approvalPolicy, child.activePermissionProfile?.id], ['on-request', ':workspace'], 'the forbidden Full access mode was never applied');
      assert.equal(observerEvents.some(message => message.method === 'item/commandExecution/requestApproval' && message.params.threadId === childId), false);
      fs.writeFileSync(path.join(root, 'requirements.json'), JSON.stringify({ allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['workspace-write'] }));
      fs.writeFileSync(path.join(root, 'permission-defaults.json'), JSON.stringify({ approval_policy: 'on-request', default_permissions: ':workspace' }));
      assert.ifError((await rpc('turn/start', { threadId: child.thread.id, input: [{ type: 'text', text: 'Continue under the allowed default' }] })).error);
      await until(() => observerEvents.some(message => message.method === 'item/agentMessage/delta' && message.params.threadId === childId), 'a previously blocked child continues when the new default is allowed');
      const resumed = JSON.parse(fs.readFileSync(path.join(root, `${child.thread.id}.json`), 'utf8'));
      assert.deepEqual([resumed.approvalPolicy, resumed.activePermissionProfile.id], ['never', ':workspace']);
    });
  });
}
