'use strict';
// tools/elpis-claude/shared-runtime.mjs: the transport under the shared bridge.
//  A. engines in shared mode against a fake engine: two clients share one engine, the delegate tool
//     (elpis-agents) stays private, a closing client leaves the engine up, failures are visible.
//  B. the same against the native candidate: two connections see one real session.
//  C. the launcher helper and tools/elpis-claude/elpis-claude: one bridge per ELPIS_HOME under a
//     race, stale cleanup, a different installed version is reported and left alone.
// Usage: node scripts/shared-runtime.test.cjs /absolute/path/to/elpis-engine
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message } = require('../editors/vscode/test/runtime-eval');

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'provide the absolute path of the engine binary');
const tools = path.resolve(__dirname, '../tools/elpis-claude');
const runtimePath = path.join(tools, 'shared-runtime.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esr-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(predicate, label, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(25);
  }
}
const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const tracked = new Set(); // pids to stop at the end

// An engine that speaks just enough: stdio for `app-server`, a WebSocket on a unix socket for `--listen`.
const fakeEngine = (name, version = '1') => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n// fake engine ${version}\nconst fs = require('fs');\nconst WebSocket = require(${JSON.stringify(path.join(tools, 'node_modules/ws'))});\nconst args = process.argv.slice(2);\nconst log = s => process.env.FAKE_ENGINE_LOG && fs.appendFileSync(process.env.FAKE_ENGINE_LOG, process.pid + ' ' + args.join(' ') + ' ' + s + '\\n');\nlog('start');\nconst sessions = [], conns = new Set();\nlet seq = 0;\nfunction handle(msg, send, mode, conn) {\n  if (msg.method === 'initialize') return send({ id: msg.id, result: { mode, pid: process.pid, conn, client: msg.params && msg.params.clientInfo && msg.params.clientInfo.name } });\n  if (msg.method === 'thread/start') { const id = 't' + (++seq) + '-' + process.pid; sessions.push(id); send({ id: msg.id, result: { thread: { id } } }); for (const c of conns) c.send(JSON.stringify({ method: 'thread/started', params: { thread: { id } } })); return; }\n  if (msg.method === 'thread/loaded/list') return send({ id: msg.id, result: { data: sessions.slice() } });\n  if (msg.id !== undefined) send({ id: msg.id, result: { echo: msg.method, mode, pid: process.pid } });\n}\nif (args[0] === 'app-server' && args[1] === '--listen') {\n  const sock = args[2].replace(/^unix:\\/\\//, '');\n  const server = require('http').createServer();\n  const wss = new WebSocket.Server({ server });\n  let n = 0;\n  wss.on('connection', ws => { conns.add(ws); const conn = ++n; ws.on('close', () => conns.delete(ws)); ws.on('message', d => handle(JSON.parse(String(d)), m => ws.send(JSON.stringify(m)), 'shared', conn)); });\n  server.listen(sock);\n  process.on('SIGTERM', () => { try { fs.unlinkSync(sock); } catch {} process.exit(0); });\n} else if (args[0] === 'app-server') {\n  process.on('SIGTERM', () => process.exit(0));\n  require('readline').createInterface({ input: process.stdin }).on('line', line => handle(JSON.parse(line), m => process.stdout.write(JSON.stringify(m) + '\\n'), 'private', 0));\n} else { process.exit(9); }\n`, { mode: 0o755 });
  return file;
};

// A client of one engine surface (what acp-bridge.mjs reads and writes).
function wire(engine) {
  const c = { frames: [], waiters: [], exited: false, errors: [] };
  let buf = '';
  engine.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line); c.frames.push(msg);
      for (const w of c.waiters.splice(0)) w();
    }
  });
  engine.stdout.on('exit', () => { c.exited = true; });
  engine.stdin.on('error', e => c.errors.push(e.message));
  let id = 0;
  c.request = async (method, params) => {
    const mine = `r${++id}`;
    engine.stdin.write(JSON.stringify({ id: mine, method, params }) + '\n');
    return until(() => c.frames.find(f => f.id === mine), `${method} answer`);
  };
  c.event = method => c.frames.filter(f => f.method === method);
  c.init = async name => (await c.request('initialize', { clientInfo: { name, version: '1' }, capabilities: {} })).result;
  c.engine = engine;
  return c;
}

async function main() {
  const runtime = await import(pathToFileURL(runtimePath));
  const home = path.join(root, 'home'), xdg = path.join(root, 'xdg');
  fs.mkdirSync(home); fs.mkdirSync(xdg, { mode: 0o700 });
  const fake = fakeEngine('engine-fake');
  const engineLog = path.join(root, 'engine.log');
  const bridgeDir = path.join(root, 'sock');
  fs.mkdirSync(bridgeDir, { mode: 0o700 });
  const set = (env) => { for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v); };
  set({ HOME: home, ELPIS_HOME: home, CODEX_HOME: home, XDG_RUNTIME_DIR: xdg, ELPIS_ENGINE_BIN: fake, FAKE_ENGINE_LOG: engineLog, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock') });
  const sharedEngines = () => new Set(readLines(engineLog).filter(l => l.includes('--listen')).map(l => Number(l.split(' ')[0])));

  // ---- A. fake engine -------------------------------------------------------------------------
  const a = wire(runtime.createEngine()), b = wire(runtime.createEngine());
  const [ia, ib] = [await a.init('codex-tui'), await b.init('codex-tui')];
  assert.equal(ia.mode, 'shared'); assert.equal(ib.mode, 'shared');
  assert.equal(ia.pid, ib.pid, 'both clients are on one engine');
  assert.equal(sharedEngines().size, 1, 'one shared engine was started');
  assert.notEqual(ia.conn, ib.conn, 'but on separate connections');
  const engineSocket = fs.readdirSync(bridgeDir).filter(n => n.startsWith('engine-'));
  assert.equal(engineSocket.length, 1);
  assert.equal((fs.statSync(path.join(bridgeDir, engineSocket[0])).mode & 0o077), 0, 'the engine directory is private');
  const { result: { thread } } = await a.request('thread/start', { cwd: root });
  assert.deepEqual((await b.request('thread/loaded/list', {})).result.data, [thread.id], 'B sees the session A started');
  await until(() => b.event('thread/started').some(e => e.params.thread.id === thread.id), 'B hears thread/started');
  assert.equal(a.event('thread/started').length, 1, 'A hears it once');
  pass('two clients share one engine and see the same session');

  const helper = wire(runtime.createEngine());
  const ih = await helper.init('elpis-agents');
  assert.equal(ih.mode, 'private'); assert.notEqual(ih.pid, ia.pid);
  assert.deepEqual((await helper.request('thread/loaded/list', {})).result.data, [], 'the helper does not see the shared sessions');
  assert.equal(helper.engine.pid, ih.pid);
  const sharedPid = ia.pid;
  helper.engine.kill();
  await until(() => !alive(ih.pid), 'private engine of the helper stops');
  assert(alive(sharedPid), 'killing a helper engine leaves the shared engine');
  assert.equal((await a.request('thread/loaded/list', {})).result.data.length, 1);
  pass('the delegate tool keeps a private engine even in shared mode; killing it stops only it');

  a.engine.kill();
  assert.equal(a.exited, true);
  await pause(300);
  assert(alive(sharedPid), 'closing a client leaves the shared engine up');
  const c = wire(runtime.createEngine());
  assert.equal((await c.init('codex-tui')).pid, sharedPid);
  assert.deepEqual((await c.request('thread/loaded/list', {})).result.data, [thread.id], 'a later client finds the session');
  assert.equal((await b.request('thread/loaded/list', {})).result.data.length, 1, 'the other client keeps working');
  pass('closing a client does not stop the shared engine; a later client finds the session');

  // frames written before the connection opens are kept, in order
  const d = wire(runtime.createEngine());
  for (const n of [1, 2, 3]) d.engine.stdin.write(JSON.stringify({ id: `q${n}`, method: n === 1 ? 'initialize' : 'x/' + n, params: { clientInfo: { name: 'codex-tui' } } }) + '\n');
  await until(() => d.frames.length === 3, 'queued frames answered');
  assert.deepEqual(d.frames.map(f => f.id), ['q1', 'q2', 'q3']);
  pass('frames written while the engine connects are delivered in order');

  // the engine dies: connected clients are told, a new client starts a new engine
  process.kill(sharedPid, 'SIGKILL');
  await until(() => b.exited && c.exited && d.exited, 'clients learn the engine is gone');
  b.engine.stdin.write(JSON.stringify({ id: 'late', method: 'thread/loaded/list' }) + '\n');
  assert(b.frames.some(f => f.id === 'late' && /closed|ended/.test(f.error?.message)), 'a request after the loss gets an error answer, not silence');
  const e = wire(runtime.createEngine());
  const ie = await e.init('codex-tui');
  assert.notEqual(ie.pid, sharedPid, 'a fresh engine serves later clients');
  assert.deepEqual((await e.request('thread/loaded/list', {})).result.data, []);
  pass('a lost engine is reported to its clients and replaced for later ones');

  // an engine that cannot start answers requests with an error and is retried
  set({ ELPIS_ENGINE_BIN: path.join(root, 'missing-engine') });
  await runtime.shutdownRuntime();
  const f = wire(runtime.createEngine());
  f.engine.stdin.write(JSON.stringify({ id: 'first', method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }) + '\n');
  const failure = await until(() => f.frames.find(x => x.id === 'first'), 'error answer');
  assert(failure.error && /native engine/.test(failure.error.message), JSON.stringify(failure));
  set({ ELPIS_ENGINE_BIN: fake });
  const g = wire(runtime.createEngine());
  assert.equal((await g.init('codex-tui')).mode, 'shared');
  pass('an engine that cannot start answers with an error, and the next client retries');

  // shutdown stops what this bridge started and removes what it made
  const h = wire(runtime.createEngine());
  const ih2 = await h.init('elpis-agents');
  const wss = runtime.createBridgeServer();
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  assert.equal(runtime.bridgeUrl(wss), `ws+unix://${process.env.ELPIS_BRIDGE_SOCKET}:/`);
  assert.equal(fs.statSync(process.env.ELPIS_BRIDGE_SOCKET).mode & 0o077, 0, 'the bridge socket is private');
  const sharedNow = (await g.request('thread/loaded/list', {})).result && sharedEngines();
  const livePids = [ih2.pid, ...[...sharedNow].filter(alive)];
  await runtime.shutdownRuntime();
  await until(() => livePids.every(pid => !alive(pid)), 'shutdown stops every engine this bridge started');
  assert.deepEqual(fs.readdirSync(bridgeDir), [], 'sockets and the engine directory are gone');
  pass('shutdownRuntime stops its engines and removes its sockets and directory');
  set({ ELPIS_SHARED_BRIDGE: undefined, ELPIS_BRIDGE_SOCKET: undefined, PORT: '0' });
  const standalone = runtime.createBridgeServer();
  await new Promise(resolve => standalone.once('listening', resolve));
  assert.match(runtime.bridgeUrl(standalone), /^ws:\/\/127\.0\.0\.1:\d+$/);
  const plain = wire(runtime.createEngine());
  assert.equal(plain.engine.constructor.name, 'ChildProcess');
  assert.equal((await plain.init('codex-tui')).mode, 'private');
  plain.engine.kill();
  await new Promise(resolve => standalone.close(resolve));
  await runtime.shutdownRuntime();
  pass('without ELPIS_SHARED_BRIDGE: loopback listener and one private engine per connection, as before');

  // the bridge never takes over a socket a living process serves, nor replaces a file; it replaces a dead one
  const taken = path.join(bridgeDir, 'taken.sock');
  const holder = net.createServer().listen(taken);
  await new Promise(resolve => holder.once('listening', resolve));
  set({ ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: taken });
  const refusedServer = runtime.createBridgeServer();
  const refusal = await Promise.race([new Promise(resolve => refusedServer.once('error', resolve)), pause(3000).then(() => ({ message: 'no error: it took over a living socket' }))]);
  assert.match(refusal.message, /living process/); assert(isSocket(taken));
  const probeSocket = net.connect(taken);
  await new Promise((resolve, reject) => probeSocket.once('connect', resolve).once('error', reject)); // the holder still serves
  probeSocket.destroy();
  await new Promise(resolve => holder.close(resolve));
  fs.writeFileSync(taken, 'plain file');
  const fileServer = runtime.createBridgeServer();
  assert.match((await Promise.race([new Promise(resolve => fileServer.once('error', resolve)), pause(3000).then(() => ({ message: 'no error: it replaced a file' }))])).message, /not a socket/);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'plain file');
  fs.rmSync(taken);
  const deadHolder = net.createServer().listen(taken);
  await new Promise(resolve => deadHolder.once('listening', resolve));
  deadHolder.close(); // closing unlinks on most systems; recreate a dead socket file
  if (!fs.existsSync(taken)) { const maker = spawnSync(process.execPath, ['-e', `const s=require('net').createServer().listen(${JSON.stringify(taken)},()=>process.kill(process.pid,'SIGKILL'))`]); void maker; }
  assert(isSocket(taken), 'a dead socket file exists');
  const replaced = runtime.createBridgeServer();
  await new Promise((resolve, reject) => { replaced.once('listening', resolve); replaced.once('error', reject); });
  await new Promise(resolve => replaced.close(resolve));
  await runtime.shutdownRuntime();
  fs.rmSync(taken, { force: true });
  pass('the bridge listener refuses a living socket or a file at its path and replaces a dead socket');
  set({ ELPIS_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock') });

  // ---- B. native candidate --------------------------------------------------------------------
  const provider = new Provider();
  await provider.start();
  const nativeHome = path.join(root, 'native-home'), cwd = path.join(root, 'native-cwd');
  fs.mkdirSync(nativeHome); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(nativeHome, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nsandbox_mode="workspace-write"\n[features]\nsubagents=false\n[model_providers.fixture]\nname="Shared runtime fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  set({ HOME: nativeHome, ELPIS_HOME: nativeHome, CODEX_HOME: nativeHome, CODEX_AUTH_HOME: nativeHome, ELPIS_ENGINE_BIN: binary, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock'), PORT: undefined });
  try {
    const n1 = wire(runtime.createEngine()), n2 = wire(runtime.createEngine()), nh = wire(runtime.createEngine());
    await n1.init('codex-tui'); await n2.init('codex-tui'); await nh.init('elpis-agents');
    n1.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); n2.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); nh.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const started = (await n1.request('thread/start', { cwd, model: 'gpt-5.5' })).result.thread.id;
    await until(() => n2.event('thread/started').some(m => m.params.thread.id === started), 'native: second connection hears of the session');
    assert.deepEqual((await n2.request('thread/loaded/list', {})).result.data, [started]);
    provider.actions.push(message('SHARED_DONE'));
    await n1.request('turn/start', { threadId: started, input: [{ type: 'text', text: 'go', text_elements: [] }] });
    await until(() => n2.event('thread/status/changed').filter(m => m.params.threadId === started).at(-1)?.params.status.type === 'idle', 'native: status reaches the second connection');
    const seen = n2.event('thread/status/changed').filter(m => m.params.threadId === started).map(m => m.params.status.type);
    assert(seen.includes('active') && seen.at(-1) === 'idle', seen.join());
    await n1.request('thread/name/set', { threadId: started, name: 'Shared name' });
    await until(() => n2.event('thread/name/updated').some(m => m.params.threadName === 'Shared name'), 'native: rename reaches the second connection');
    assert.equal((await n2.request('thread/read', { threadId: started, includeTurns: false })).result.thread.status.type, 'idle');
    assert.deepEqual((await nh.request('thread/loaded/list', {})).result.data, [], 'native: the delegate connection has its own engine');
    const nativePid = n1.engine.pid;
    assert.equal(n2.engine.pid, nativePid);
    assert.notEqual(nh.engine.pid, nativePid);
    n1.engine.kill();
    await pause(500);
    assert(alive(nativePid), 'native: closing a client leaves the shared engine');
    assert.deepEqual((await n2.request('thread/loaded/list', {})).result.data, [started]);
    pass('native engine: two connections see one session, its status and rename; helper stays private; a closing client leaves it');
    const privatePid = nh.engine.pid;
    await runtime.shutdownRuntime();
    await until(() => !alive(nativePid) && !alive(privatePid), 'native engines stop at shutdown');
    assert.deepEqual(fs.readdirSync(bridgeDir), []);
    pass('native engine: shutdownRuntime stops the shared and private engines and leaves nothing behind');
    assert(!provider.error, provider.error?.message);
  } finally { provider.close(); }

  // ---- C. launcher helper -----------------------------------------------------------------------
  await launcherGroup(runtime);
}

// A fake bridge: listens through createBridgeServer, hands each connection an engine, stops on SIGTERM.
function fakeBridgeDir(name, extra = '') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'bridge.mjs'), `// ${name}\nimport fs from 'node:fs';\nimport { createBridgeServer, createEngine, shutdownRuntime } from ${JSON.stringify(pathToFileURL(runtimePath).href)};\nfs.appendFileSync(process.env.FAKE_BRIDGE_STARTS, process.pid + '\\n');\n${extra}\nconst wss = createBridgeServer();\nwss.on('error', e => { console.error('bridge error: ' + e.message); process.exit(1); });\nwss.on('connection', ws => {\n  const engine = createEngine();\n  engine.stdout.on('data', d => { for (const l of String(d).split('\\n')) if (l) ws.send(l); });\n  ws.on('message', m => engine.stdin.write(String(m) + '\\n'));\n  ws.on('close', () => engine.kill());\n});\nprocess.on('SIGTERM', async () => { await shutdownRuntime(); process.exit(0); });\n`);
  return path.join(dir, 'bridge.mjs');
}

async function launcherGroup(runtime) {
  const lroot = fs.mkdtempSync(path.join(root, 'l-'));
  let scenario = 0;
  // Each scenario gets its own ELPIS_HOME and runtime base, so its bridge is its own.
  function setup() {
    const n = ++scenario;
    const base = path.join(lroot, `s${n}`);
    const env = { ...process.env, HOME: path.join(base, 'h'), ELPIS_HOME: path.join(base, 'h'), XDG_RUNTIME_DIR: path.join(base, 'x'), FAKE_BRIDGE_STARTS: path.join(base, 'starts'), FAKE_ENGINE_LOG: path.join(base, 'engine.log'), ELPIS_ENGINE_BIN: fakeEngine(`engine-s${n}`) };
    delete env.ELPIS_SHARED_BRIDGE; delete env.ELPIS_BRIDGE_SOCKET; delete env.PORT;
    fs.mkdirSync(env.HOME, { recursive: true }); fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    const rt = () => path.join(env.XDG_RUNTIME_DIR, 'elpis-bridge', fs.readdirSync(path.join(env.XDG_RUNTIME_DIR, 'elpis-bridge'))[0]);
    return { env, starts: () => readLines(env.FAKE_BRIDGE_STARTS).map(Number), rt, state: () => JSON.parse(fs.readFileSync(path.join(rt(), 'state.json'), 'utf8')) };
  }
  const helper = (script, env, args = []) => new Promise(resolve => {
    const child = spawn(process.execPath, [runtimePath, script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  const endpointOf = out => { assert.match(out.stdout, /^unix:\/\/\/[^\n]+\/bridge\.sock\n$/, `stdout was ${JSON.stringify(out.stdout)}; stderr ${out.stderr}`); return out.stdout.trim().slice('unix://'.length); };
  const answers = async sock => {
    const ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = new Promise(resolve => ws.once('message', d => resolve(JSON.parse(String(d)))));
    ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
    const r = await reply; ws.close(); return r.result;
  };
  const stop = async pid => { try { process.kill(pid, 'SIGTERM'); } catch {} await until(() => !alive(pid), `pid ${pid} stops`, 10000).catch(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }); };

  // one bridge for a race of launchers; it outlives them; a living socket is never replaced
  let s = setup();
  const bridgeA = fakeBridgeDir('bridge-a');
  const outs = await Promise.all(Array.from({ length: 8 }, () => helper(bridgeA, s.env)));
  const socks = new Set(outs.map(endpointOf));
  assert.equal(socks.size, 1, 'every launcher got the same endpoint');
  assert.deepEqual(outs.map(o => o.code), Array(8).fill(0));
  assert.equal(s.starts().length, 1, `exactly one bridge was started: ${s.starts()}`);
  const sock = [...socks][0], bridgePid = s.starts()[0];
  tracked.add(bridgePid);
  assert.equal(s.state().pid, bridgePid);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(sock)).uid, process.getuid());
  assert.equal((await answers(sock)).mode, 'shared');
  const inode = fs.statSync(sock).ino;
  await pause(800);
  assert(alive(bridgePid), 'the bridge outlives the launchers');
  const again = await helper(bridgeA, s.env);
  assert.equal(endpointOf(again), sock);
  assert.equal(s.starts().length, 1, 'a later launch reuses it');
  assert.equal(fs.statSync(sock).ino, inode, 'the living socket was not replaced');
  pass('a race of launchers starts one detached bridge; the endpoint is the only output; the socket directory is private');

  // a different installed version is reported, not replaced
  const bridgeB = fakeBridgeDir('bridge-b');
  const refused = await helper(bridgeB, s.env);
  assert.equal(refused.code, 1); assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /different installation/); assert.match(refused.stderr, /Close the Elpis terminals/); assert.match(refused.stderr, /No sessions are lost/);
  assert(refused.stderr.includes(bridgeA) && refused.stderr.includes(bridgeB), refused.stderr);
  const otherEngine = await helper(bridgeA, { ...s.env, ELPIS_ENGINE_BIN: fakeEngine('engine-other', '2') });
  assert.equal(otherEngine.code, 1); assert.equal(otherEngine.stdout, ''); assert.match(otherEngine.stderr, /different installation/);
  assert(alive(bridgePid)); assert.equal(s.starts().length, 1);
  assert.equal(fs.statSync(sock).ino, inode);
  assert.equal((await answers(sock)).mode, 'shared', 'the running bridge still serves');
  pass('a different bridge or engine version is refused with the running one named, and left untouched');

  // stale: SIGKILL leaves the socket and state; an engine left behind is stopped; nothing else is
  const held = new WebSocket(`ws+unix://${sock}:/`);
  await new Promise(resolve => held.once('open', resolve));
  held.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
  const enginePid = await until(() => { const l = readLines(s.env.FAKE_ENGINE_LOG).find(x => x.includes('--listen')); return l && Number(l.split(' ')[0]); }, 'shared engine started');
  tracked.add(enginePid);
  process.kill(bridgePid, 'SIGKILL');
  await until(() => !alive(bridgePid), 'bridge killed');
  held.terminate();
  assert(alive(enginePid), 'the orphan engine outlives its bridge');
  assert(fs.existsSync(sock), 'the dead bridge left its socket');
  const revived = await helper(bridgeA, s.env);
  assert.equal(endpointOf(revived), sock);
  assert.equal(s.starts().length, 2, 'a replacement bridge started');
  assert.notEqual(s.starts()[1], bridgePid);
  tracked.add(s.starts()[1]);
  await until(() => !alive(enginePid), 'orphan engine stopped');
  assert.match(revived.stderr, /left behind/);
  assert.equal((await answers(sock)).mode, 'shared');
  pass('after a crash the launcher removes the stale socket and state, stops the orphaned engine, and starts one bridge');
  await stop(s.starts()[1]);

  // a recycled pid or foreign process in the records is never signalled; a stale launch lock is taken over
  s = setup();
  const rtdir = (() => { const probe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(runtimePath).href)}).then(m => console.log(JSON.stringify(m.runtimeDir())))`], { env: s.env, encoding: 'utf8' }); return JSON.parse(probe.stdout); })();
  const deadChild = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(rtdir.lock, `${deadChild.stdout} 1`);
  fs.writeFileSync(rtdir.state, JSON.stringify({ pid: process.pid, token: 'not-this-process', identity: 'x', script: 'x', engine: 'x' }));
  const decoy = path.join(rtdir.dir, 'engine-decoy');
  fs.mkdirSync(decoy, { mode: 0o700 });
  fs.writeFileSync(path.join(decoy, 'engine.json'), JSON.stringify({ pid: process.pid, token: 'not-this-process' }));
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  tracked.add(sleeper.pid);
  const running = path.join(rtdir.dir, 'engine-running');
  fs.mkdirSync(running, { mode: 0o700 });
  fs.writeFileSync(path.join(running, 'engine.json'), JSON.stringify({ pid: sleeper.pid, token: runtime.startToken(sleeper.pid), bridgePid: process.pid, bridgeToken: runtime.startToken(process.pid) }));
  const recovered = await helper(bridgeA, s.env);
  const sock2 = endpointOf(recovered);
  tracked.add(s.starts()[0]);
  assert(alive(process.pid)); assert(!fs.existsSync(decoy), 'the decoy directory was cleaned');
  assert.doesNotMatch(recovered.stderr, /left behind/, 'a process whose start token differs is not stopped');
  assert(alive(sleeper.pid) && fs.existsSync(running), 'an engine whose bridge is still alive is left alone');
  sleeper.kill();
  assert.equal(s.starts().length, 1);
  assert.equal((await answers(sock2)).mode, 'shared');
  pass('records naming a live pid with another start token are stale and the process is not signalled; a dead holder\'s lock is taken over');
  await stop(s.starts()[0]);

  // a living socket that is not ours, and a file in its place
  s = setup();
  fs.mkdirSync(path.join(s.env.XDG_RUNTIME_DIR, 'elpis-bridge'), { mode: 0o700 });
  const rt3 = JSON.parse(spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(runtimePath).href)}).then(m => console.log(JSON.stringify(m.runtimeDir())))`], { env: s.env, encoding: 'utf8' }).stdout);
  const foreign = net.createServer().listen(rt3.sock);
  await new Promise(resolve => foreign.once('listening', resolve));
  const unrecorded = await helper(bridgeA, s.env);
  assert.equal(unrecorded.code, 1); assert.equal(unrecorded.stdout, ''); assert.match(unrecorded.stderr, /did not record/);
  assert(isSocket(rt3.sock), 'a living socket is left in place'); assert.equal(s.starts().length, 0);
  await new Promise(resolve => foreign.close(resolve));
  fs.writeFileSync(rt3.sock, 'not a socket');
  const file = await helper(bridgeA, s.env);
  assert.equal(file.code, 1); assert.match(file.stderr, /not a socket/);
  assert.equal(fs.readFileSync(rt3.sock, 'utf8'), 'not a socket', 'a file in the socket\'s place is not removed');
  pass('a living or non-socket path at the bridge socket is never removed');

  // a bridge that dies on start is a visible failure with its own message
  s = setup();
  const crash = fakeBridgeDir('bridge-crash', "console.error('boom: cannot start'); process.exit(3);");
  const failed = await helper(crash, s.env);
  assert.equal(failed.code, 1); assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /exited/); assert.match(failed.stderr, /boom: cannot start/);
  assert(!fs.existsSync(path.join(s.rt(), 'state.json')), 'no record of a bridge that never ran');
  const badEngine = await helper(bridgeA, { ...s.env, ELPIS_ENGINE_BIN: path.join(root, 'nonexistent') });
  assert.equal(badEngine.code, 1); assert.equal(badEngine.stdout, ''); assert.match(badEngine.stderr, /not usable/);
  pass('a bridge that cannot start, or a missing engine, fails the launcher with the reason on stderr and nothing on stdout');

  // the runtime directory: a symlink is refused, a loose directory is tightened, a long path falls back
  s = setup();
  fs.symlinkSync(root, path.join(s.env.XDG_RUNTIME_DIR, 'elpis-bridge'));
  const linked = await helper(bridgeA, s.env);
  assert.equal(linked.code, 1); assert.match(linked.stderr, /real directory/); assert.equal(s.starts().length, 0);
  s = setup();
  fs.mkdirSync(path.join(s.env.XDG_RUNTIME_DIR, 'elpis-bridge'), { mode: 0o755 });
  fs.chmodSync(path.join(s.env.XDG_RUNTIME_DIR, 'elpis-bridge'), 0o755);
  const tightened = await helper(bridgeA, s.env);
  const sock4 = endpointOf(tightened); tracked.add(s.starts()[0]);
  assert.equal(fs.statSync(path.join(s.env.XDG_RUNTIME_DIR, 'elpis-bridge')).mode & 0o777, 0o700);
  await stop(s.starts()[0]);
  s = setup();
  const longBase = path.join(s.env.XDG_RUNTIME_DIR, 'a'.repeat(60), 'b'.repeat(40));
  fs.mkdirSync(longBase, { recursive: true });
  const fellBack = await helper(bridgeA, { ...s.env, XDG_RUNTIME_DIR: longBase, TMPDIR: s.env.XDG_RUNTIME_DIR });
  const sock5 = endpointOf(fellBack); tracked.add(s.starts()[0]);
  assert(Buffer.byteLength(sock5) <= 100, sock5);
  assert(sock5.startsWith(path.join(s.env.XDG_RUNTIME_DIR, `elpis-bridge-${process.getuid()}`)), sock5);
  await stop(s.starts()[0]);
  void sock4;
  pass('the runtime directory must be a real directory of this user, is made private, and a path too long for a socket falls back');

  // the real launcher script: arguments unchanged, the bridge outlives the terminal, a refusal runs no TUI
  s = setup();
  const toolDir = path.join(lroot, 'tools');
  fs.mkdirSync(toolDir);
  fs.copyFileSync(path.join(tools, 'elpis-claude'), path.join(toolDir, 'elpis-claude'));
  fs.chmodSync(path.join(toolDir, 'elpis-claude'), 0o755);
  fs.copyFileSync(runtimePath, path.join(toolDir, 'shared-runtime.mjs'));
  fs.symlinkSync(path.join(tools, 'node_modules'), path.join(toolDir, 'node_modules'));
  fs.copyFileSync(bridgeA, path.join(toolDir, 'acp-bridge.mjs'));
  const printer = path.join(lroot, 'tui');
  fs.writeFileSync(printer, '#!/bin/sh\nprintf "arg:%s\\n" "$@" > "$TUI_OUT"\nexit "${TUI_EXIT:-0}"\n', { mode: 0o755 });
  const tuiEnv = { ...s.env, ELPIS_ENGINE_BIN: printer, TUI_OUT: path.join(lroot, 'tui.out'), TUI_EXIT: '3' };
  const run = spawnSync(path.join(toolDir, 'elpis-claude'), ['resume', 'fixture session', '--flag=1'], { env: { ...tuiEnv, HOME: s.env.HOME }, encoding: 'utf8' });
  assert.equal(run.status, 3, 'the TUI\'s exit status passes through');
  const lines = fs.readFileSync(tuiEnv.TUI_OUT, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'arg:--remote'); assert.match(lines[1], /^arg:unix:\/\/\/.+\/bridge\.sock$/);
  assert.deepEqual(lines.slice(2), ['arg:resume', 'arg:fixture session', 'arg:--flag=1']);
  const bridgeAlive = s.starts()[0];
  tracked.add(bridgeAlive);
  await pause(500);
  assert(alive(bridgeAlive), 'the bridge outlives the terminal that started it');
  fs.writeFileSync(path.join(toolDir, 'acp-bridge.mjs'), fs.readFileSync(bridgeA, 'utf8') + '\n// newer\n');
  fs.rmSync(tuiEnv.TUI_OUT);
  const blocked = spawnSync(path.join(toolDir, 'elpis-claude'), [], { env: tuiEnv, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /different installation/);
  assert(!fs.existsSync(tuiEnv.TUI_OUT), 'no TUI starts when the version differs');
  assert(alive(bridgeAlive));
  pass('elpis-claude passes its arguments unchanged after --remote unix://…, leaves the bridge running, and starts no TUI against a different version');
  await stop(bridgeAlive);
}

const isSocket = p => { try { return fs.lstatSync(p).isSocket(); } catch { return false; } };

main().then(() => console.log(`${checks.length} checks. Evidence: ${root}`), error => { console.error(error.stack ?? error); process.exitCode = 1; console.log(`Evidence: ${root}`); })
  .finally(async () => {
    try { await (await import(pathToFileURL(runtimePath))).shutdownRuntime(); } catch {}
    for (const pid of tracked) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    // anything still running from this test's directory (bridges, engines)
    const left = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' }).stdout.split('\n').map(Number).filter(pid => pid && pid !== process.pid);
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    process.exit(process.exitCode ?? 0);
  });
