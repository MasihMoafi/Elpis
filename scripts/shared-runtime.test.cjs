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
const CONFIGURATION = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_EXECUTABLE', 'CLAUDE_CONFIG_DIR', 'ELPIS_CLAUDE_PRUNE', 'ELPIS_CLAUDE_USAGE_URL', 'ELPIS_NO_AGY', 'AGY_BIN', 'AGY_DEFAULT_MODEL', 'ACP_ADAPTER', 'ACP_BRIDGE_STORE', 'ACP_BRIDGE_NO_AGENTS', 'ELPIS_AGENT_TOOLS', 'CODEX_AUTH_HOME'];

// An engine that speaks just enough: stdio for `app-server`, a WebSocket on a unix socket for `--listen`.
const fakeEngine = (name, version = '1') => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n// fake engine ${version}\nconst fs = require('fs');\nconst WebSocket = require(${JSON.stringify(path.join(tools, 'node_modules/ws'))});\nconst args = process.argv.slice(2);\nconst log = s => process.env.FAKE_ENGINE_LOG && fs.appendFileSync(process.env.FAKE_ENGINE_LOG, process.pid + ' ' + args.join(' ') + ' ' + s + '\\n');\nlog('start');\nconst sessions = [], conns = new Set();\nlet seq = 0;\nfunction handle(msg, send, mode, conn) {\n  if (msg.method === 'initialize') return send({ id: msg.id, result: { mode, pid: process.pid, conn, client: msg.params && msg.params.clientInfo && msg.params.clientInfo.name } });\n  if (msg.method === 'thread/start') { const id = 't' + (++seq) + '-' + process.pid; sessions.push(id); send({ id: msg.id, result: { thread: { id } } }); for (const c of conns) c.send(JSON.stringify({ method: 'thread/started', params: { thread: { id } } })); return; }\n  if (msg.method === 'thread/loaded/list') return send({ id: msg.id, result: { data: sessions.slice() } });\n  if (msg.method === 'held/request') { log('held ' + msg.id); return; }\n  if (msg.method === 'emit/notify') { send({ method: 'note/one', params: { n: 1 } }); return send({ id: msg.id, result: { done: true } }); }\n  if (msg.method === 'emit/partial') { const line = JSON.stringify({ method: 'note/split', params: { text: 'a-b' } }) + '\\n'; process.stdout.write(line.slice(0, 12)); return setTimeout(() => { process.stdout.write(line.slice(12)); send({ id: msg.id, result: { done: true } }); }, 150); }\n  if (msg.id !== undefined) send({ id: msg.id, result: { echo: msg.method, mode, pid: process.pid } });\n}\nif (args[0] === 'app-server' && args[1] === '--listen') {\n  const sock = args[2].replace(/^unix:\\/\\//, '');\n  const server = require('http').createServer();\n  const wss = new WebSocket.Server({ server });\n  let n = 0;\n  wss.on('connection', ws => { conns.add(ws); const conn = ++n; ws.on('close', () => conns.delete(ws)); ws.on('message', d => handle(JSON.parse(String(d)), m => ws.send(JSON.stringify(m)), 'shared', conn)); });\n  server.listen(sock);\n  process.on('SIGTERM', () => { try { fs.unlinkSync(sock); } catch {} process.exit(0); });\n} else if (args[0] === 'app-server') {\n  process.on('SIGTERM', () => process.exit(0));\n  require('readline').createInterface({ input: process.stdin }).on('line', line => handle(JSON.parse(line), m => process.stdout.write(JSON.stringify(m) + '\\n'), 'private', 0));\n} else { process.exit(9); }\n`, { mode: 0o755 });
  return file;
};

// A client of one engine surface (what acp-bridge.mjs reads and writes).
function wire(engine) {
  const c = { frames: [], waiters: [], exited: false, errors: [], raw: [], order: [] };
  let buf = '';
  engine.stdout.on('data', chunk => {
    c.raw.push(String(chunk));
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line); c.frames.push(msg); c.order.push(msg.id ?? msg.method);
      for (const w of c.waiters.splice(0)) w();
    }
  });
  engine.stdout.on('exit', () => { c.exited = true; c.order.push('exit'); });
  engine.stdin.on('error', e => c.errors.push(e.message));
  let id = 0;
  c.request = async (method, params) => {
    const mine = `r${++id}`;
    engine.stdin.write(JSON.stringify({ id: mine, method, params }) + '\n');
    return until(() => c.frames.find(f => f.id === mine), `${method} answer`);
  };
  c.send = (method, id, params = {}) => engine.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  c.errorsFor = id => c.frames.filter(f => f.id === id && f.error);
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
  f.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 'second', method: 'thread/list' }) + '\n');
  const failure = await until(() => f.frames.find(x => x.id === 'first'), 'error answer');
  assert(failure.error && /native engine/.test(failure.error.message), JSON.stringify(failure));
  await until(() => f.errorsFor('second').length, 'error answer for the queued request');
  await pause(300);
  assert.deepEqual([f.errorsFor('first').length, f.errorsFor('second').length, f.frames.length], [1, 1, 2], 'each queued request is answered once; the notification is not an answer');
  set({ ELPIS_ENGINE_BIN: fake });
  const g = wire(runtime.createEngine());
  assert.equal((await g.init('codex-tui')).mode, 'shared');
  pass('an engine that cannot start answers with an error, and the next client retries');

  // a request the engine received and had not answered when the engine died is answered with an error, once
  const waitHeld = id => until(() => readLines(engineLog).some(l => l.endsWith(` held ${id}`)), `the engine received ${id}`);
  const k1 = wire(runtime.createEngine()), k2 = wire(runtime.createEngine());
  await k1.init('codex-tui'); await k2.init('codex-tui');
  assert.equal((await k1.request('emit/notify', {})).result.done, true);
  k1.send('held/request', 'h1'); k2.send('held/request', 'h2'); k2.send('held/request', 'h3');
  await Promise.all(['h1', 'h2', 'h3'].map(waitHeld));
  const victim = (await k1.request('x/ping', {})).result.pid;
  const startsBefore = sharedEngines().size;
  process.kill(victim, 'SIGKILL');
  await until(() => k1.exited && k2.exited, 'both clients learn the engine is gone');
  await pause(1300); // past the engine-gone fallback
  for (const [k, ids] of [[k1, ['h1']], [k2, ['h2', 'h3']]]) {
    for (const id of ids) {
      assert.equal(k.errorsFor(id).length, 1, `${id} is answered exactly once`);
      assert.match(k.errorsFor(id)[0].error.message, /engine/);
      assert(k.order.indexOf(id) < k.order.indexOf('exit'), 'the answer comes before exit');
    }
    assert.equal(k.frames.filter(x => x.error).length, ids.length, 'requests that were answered are not failed');
  }
  assert.equal(k1.event('note/one').length, 1, 'notifications received before the loss are kept');
  k1.send('later/request', 'l1'); k1.send('initialize', 'l2', { clientInfo: { name: 'codex-tui' } });
  assert.equal(k1.errorsFor('l1').length, 1); assert.equal(k1.errorsFor('l2').length, 1);
  assert.equal(sharedEngines().size, startsBefore, 'a dead proxy does not start an engine for itself');
  // a deliberate close is quiet
  const k3 = wire(runtime.createEngine());
  await k3.init('codex-tui');
  k3.send('held/request', 'h4'); await waitHeld('h4');
  k3.engine.kill();
  await pause(300);
  assert.equal(k3.frames.filter(x => x.error).length, 0); assert.deepEqual(k3.errors, []); assert.equal(k3.exited, true);
  // the same for the delegate tool's private engine, whose stdout is a pipe: chunks arrive as written
  const hp = wire(runtime.createEngine());
  await hp.init('elpis-agents');
  assert.equal((await hp.request('emit/partial', {})).result.done, true);
  const splitLine = JSON.stringify({ method: 'note/split', params: { text: 'a-b' } }) + '\n';
  assert(hp.raw.join('').includes(splitLine), 'a line the engine wrote in two parts arrives whole');
  assert.equal(hp.event('note/split').length, 1);
  hp.send('held/request', 'h5'); await waitHeld('h5');
  process.kill(hp.engine.pid, 'SIGKILL');
  await until(() => hp.exited, 'the helper learns its engine is gone');
  assert.equal(hp.errorsFor('h5').length, 1); assert.equal(hp.frames.filter(x => x.error).length, 1);
  assert(hp.order.indexOf('h5') < hp.order.indexOf('exit'));
  hp.send('later/request', 'l3');
  assert.equal(hp.errorsFor('l3').length, 1);
  pass('a request the engine had received but not answered gets exactly one error when the engine dies (shared and private); answered ones, notifications and split chunks are kept; a deliberate close is quiet');

  // shutdown stops what this bridge started and removes what it made
  const h = wire(runtime.createEngine());
  const ih2 = await h.init('elpis-agents');
  const wss = runtime.createBridgeServer();
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  assert.equal(runtime.bridgeUrl(wss), `ws+unix://${process.env.ELPIS_BRIDGE_SOCKET}:/`);
  assert.equal(fs.statSync(process.env.ELPIS_BRIDGE_SOCKET).mode & 0o077, 0, 'the bridge socket is private');
  const live = wire(runtime.createEngine());
  await live.init('codex-tui');
  const sharedNow = sharedEngines();
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

  // stopBridgeListener: synchronous unpublish; a later bridge's socket and state are never touched
  const stopSock = path.join(bridgeDir, 'stop.sock'), stopState = path.join(bridgeDir, 'state.json');
  set({ ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: stopSock });
  fs.writeFileSync(stopState, JSON.stringify({ pid: process.pid }));
  const stoppable = runtime.createBridgeServer();
  await new Promise((resolve, reject) => { stoppable.once('listening', resolve); stoppable.once('error', reject); });
  const joined = new WebSocket(`ws+unix://${stopSock}:/`);
  await new Promise((resolve, reject) => { joined.once('open', resolve); joined.once('error', reject); });
  const closing = runtime.stopBridgeListener();
  assert(!fs.existsSync(stopSock), 'the socket is gone in the same tick');
  assert(!fs.existsSync(stopState), 'so is this bridge\'s state');
  assert(closing instanceof Promise); assert.equal(runtime.stopBridgeListener(), closing, 'stopping twice is the same stop');
  const refusedLate = await new Promise(resolve => net.connect(stopSock).once('connect', () => resolve('connected')).once('error', e => resolve(e.code)));
  assert(['ENOENT', 'ECONNREFUSED'].includes(refusedLate), `a client arriving now gets ${refusedLate}`);
  joined.terminate(); await closing;
  const newDaemon = spawn('sleep', ['60'], { stdio: 'ignore' }); tracked.add(newDaemon.pid);
  const newcomer = net.createServer().listen(stopSock);
  await new Promise(resolve => newcomer.once('listening', resolve));
  fs.writeFileSync(stopState, JSON.stringify({ pid: newDaemon.pid }));
  runtime.stopBridgeListener(); await runtime.shutdownRuntime(); await runtime.shutdownRuntime();
  assert(isSocket(stopSock), 'a bridge that started afterwards keeps its socket through repeated shutdowns');
  const probeNew = net.connect(stopSock); await new Promise((resolve, reject) => probeNew.once('connect', resolve).once('error', reject)); probeNew.destroy();
  assert.equal(JSON.parse(fs.readFileSync(stopState, 'utf8')).pid, newDaemon.pid, 'and its state');
  // a connection that reaches this bridge while it closes starts no engine
  const enginesBefore = sharedEngines().size;
  const latecomer = wire(runtime.createEngine());
  latecomer.send('initialize', 'late', { clientInfo: { name: 'codex-tui' } });
  assert.match(latecomer.errorsFor('late')[0]?.error.message ?? '', /shutting down/);
  await pause(200);
  assert.equal(sharedEngines().size, enginesBefore, 'no engine was started'); assert(!fs.readdirSync(bridgeDir).some(n => n.startsWith('engine-')));
  await new Promise(resolve => newcomer.close(resolve)); fs.rmSync(stopState, { force: true });
  // its socket was replaced by another bridge's before it stopped: the replacement and that bridge's state stay
  fs.rmSync(stopState, { force: true });
  const replaced2 = runtime.createBridgeServer();
  await new Promise((resolve, reject) => { replaced2.once('listening', resolve); replaced2.once('error', reject); });
  fs.rmSync(stopSock);
  const usurper = net.createServer().listen(stopSock);
  await new Promise(resolve => usurper.once('listening', resolve));
  fs.writeFileSync(stopState, JSON.stringify({ pid: newDaemon.pid }));
  await runtime.stopBridgeListener();
  assert(isSocket(stopSock), 'a socket this bridge did not create is not removed'); assert.equal(JSON.parse(fs.readFileSync(stopState, 'utf8')).pid, newDaemon.pid, 'nor a state it does not own');
  await new Promise(resolve => usurper.close(resolve)); fs.rmSync(stopState, { force: true }); newDaemon.kill();
  // stopped before it ever bound
  const unborn = runtime.createBridgeServer();
  runtime.stopBridgeListener();
  await pause(400);
  assert(!fs.existsSync(stopSock), 'a listener stopped before binding never binds'); assert.equal(unborn.address(), null);
  await runtime.shutdownRuntime();
  pass('stopBridgeListener unpublishes synchronously and idempotently, refuses later clients and engines, and never removes a later bridge\'s socket or state');
  set({ ELPIS_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock') });

  // ---- B. native candidate --------------------------------------------------------------------
  const provider = new Provider();
  await provider.start();
  const nativeHome = path.join(root, 'native-home'), cwd = path.join(root, 'native-cwd');
  fs.mkdirSync(nativeHome); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(nativeHome, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nsandbox_mode="workspace-write"\n[features]\nsubagents=false\n[model_providers.fixture]\nname="Shared runtime fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  set({ HOME: nativeHome, ELPIS_HOME: nativeHome, CODEX_HOME: nativeHome, CODEX_AUTH_HOME: nativeHome, ELPIS_ENGINE_BIN: binary, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: path.join(bridgeDir, 'bridge.sock'), PORT: undefined });
  try {
    const nativeWss = runtime.createBridgeServer(); // a bridge lives where its engines do
    await new Promise((resolve, reject) => { nativeWss.once('listening', resolve); nativeWss.once('error', reject); });
    const n1 = wire(runtime.createEngine()), n2 = wire(runtime.createEngine()), nh = wire(runtime.createEngine());
    await n1.init('codex-tui'); await n2.init('codex-tui'); await nh.init('elpis-agents');
    n1.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); n2.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); nh.engine.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const startAnswer = await n1.request('thread/start', { cwd, model: 'gpt-5.5' });
    assert(startAnswer.result, `thread/start: ${JSON.stringify(startAnswer.error)}`);
    const started = startAnswer.result.thread.id;
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
  fs.writeFileSync(path.join(dir, 'bridge.mjs'), `// ${name}\nimport fs from 'node:fs';\nimport { createBridgeServer, createEngine, shutdownRuntime, stopBridgeListener } from ${JSON.stringify(pathToFileURL(runtimePath).href)};\nfs.appendFileSync(process.env.FAKE_BRIDGE_STARTS, process.pid + '\\n');\n${extra}\nconst wss = createBridgeServer();\nwss.on('error', e => { console.error('bridge error: ' + e.message); process.exit(1); });\nwss.on('connection', ws => {\n  const engine = createEngine();\n  engine.stdout.on('data', d => { for (const l of String(d).split('\\n')) if (l) ws.send(l); });\n  ws.on('message', m => engine.stdin.write(String(m) + '\\n'));\n  ws.on('close', () => engine.kill());\n});\nprocess.on('SIGTERM', async () => { const closed = stopBridgeListener(); if (process.env.FAKE_BRIDGE_SLOW_STOP) await new Promise(r => setTimeout(r, Number(process.env.FAKE_BRIDGE_SLOW_STOP))); await shutdownRuntime(); await closed; process.exit(0); });\n`);
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
    for (const name of CONFIGURATION) delete env[name]; // what the bridge keeps from its first terminal is set per scenario
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

  // the bridge keeps its first terminal's environment: a later terminal that differs is refused by name, not value
  s = setup();
  const secret = 'sekrit-token-XYZ', other = 'other-secret-QRS';
  const first = { ...s.env, HTTPS_PROXY: `http://user:${secret}@proxy.invalid:10808`, TERM: 'xterm-256color', PWD: '/one', OLDPWD: '/zero', ACP_BRIDGE_LOG: path.join(lroot, 'one.log') };
  const started = await helper(bridgeA, first);
  const sockE = endpointOf(started); tracked.add(s.starts()[0]);
  const joinedLater = await helper(bridgeA, { ...first, TERM: 'screen-256color', PWD: '/two', OLDPWD: '/one', ACP_BRIDGE_LOG: path.join(lroot, 'two.log'), COLUMNS: '80' });
  assert.equal(endpointOf(joinedLater), sockE); assert.equal(s.starts().length, 1, 'terminal, working directory and log path are not configuration');
  const bridgeNow = s.starts()[0];
  for (const [what, env, name] of [
    ['another proxy', { ...first, HTTPS_PROXY: `http://user:${other}@elsewhere.invalid:1` }, 'HTTPS_PROXY'],
    ['no proxy (nopr)', Object.fromEntries(Object.entries(first).filter(([k]) => k !== 'HTTPS_PROXY')), 'HTTPS_PROXY'],
    ['a custom adapter', { ...first, ACP_ADAPTER: path.join(lroot, 'adapter.js') }, 'ACP_ADAPTER'],
    ['another Claude program', { ...first, CLAUDE_CODE_EXECUTABLE: path.join(lroot, 'claude') }, 'CLAUDE_CODE_EXECUTABLE'],
    ['another store', { ...first, ACP_BRIDGE_STORE: path.join(lroot, 'store.json') }, 'ACP_BRIDGE_STORE'],
  ]) {
    const refusedEnv = await helper(bridgeA, env);
    assert.equal(refusedEnv.code, 1, what); assert.equal(refusedEnv.stdout, '', what);
    assert(refusedEnv.stderr.includes(name), `${what}: names ${name}`); assert.match(refusedEnv.stderr, /different configuration/); assert.match(refusedEnv.stderr, /No sessions are lost/);
    for (const value of [secret, other]) assert(!refusedEnv.stderr.includes(value), `${what}: no secret on stderr`);
    assert(alive(bridgeNow), `${what}: the running bridge is not signalled`);
  }
  assert.equal(s.starts().length, 1);
  assert(!fs.readFileSync(path.join(s.rt(), 'state.json'), 'utf8').includes(secret), 'the state file holds no proxy value');
  assert(!fs.readFileSync(path.join(s.rt(), 'state.json'), 'utf8').includes('proxy.invalid'));
  const changedFiles = fakeBridgeDir('bridge-pkg');
  fs.writeFileSync(path.join(path.dirname(changedFiles), 'package.json'), '{"name":"one"}');
  const pkgEnv = setup();
  const pkgStart = await helper(changedFiles, pkgEnv.env); endpointOf(pkgStart); tracked.add(pkgEnv.starts()[0]);
  fs.writeFileSync(path.join(path.dirname(changedFiles), 'package.json'), '{"name":"two"}');
  const pkgRefused = await helper(changedFiles, pkgEnv.env);
  assert.equal(pkgRefused.code, 1); assert.match(pkgRefused.stderr, /different installation/); assert(alive(pkgEnv.starts()[0]));
  const copy = path.join(lroot, 'bridge-copy'); fs.mkdirSync(copy);
  for (const name of fs.readdirSync(path.dirname(bridgeA))) fs.copyFileSync(path.join(path.dirname(bridgeA), name), path.join(copy, name));
  const sameContentElsewhere = await helper(path.join(copy, 'bridge.mjs'), first);
  assert.equal(sameContentElsewhere.code, 1); assert.match(sameContentElsewhere.stderr, /different installation/);
  await stop(bridgeNow); await stop(pkgEnv.starts()[0]);
  const idA = runtime.codeIdentity(bridgeA), idB = runtime.codeIdentity(bridgeA, '/bin/sh');
  assert.equal(runtime.codeIdentity(bridgeA).hash, idA.hash); assert.notEqual(idA.hash, idB.hash, 'the node binary is part of the identity');
  assert.deepEqual(runtime.environmentDigest({ HTTPS_PROXY: 'a', TERM: 'x' }, 's1'), runtime.environmentDigest({ HTTPS_PROXY: 'a', TERM: 'y', PWD: '/' }, 's1'));
  assert.notDeepEqual(runtime.environmentDigest({ HTTPS_PROXY: 'a' }, 's1'), runtime.environmentDigest({ HTTPS_PROXY: 'a' }, 's2'), 'salted');
  // eight launchers with the same environment, a proxy among it, still start one bridge
  s = setup();
  const raceEnv = { ...s.env, HTTPS_PROXY: `http://user:${secret}@proxy.invalid:10808`, NODE_USE_ENV_PROXY: '1' };
  const raced = await Promise.all(Array.from({ length: 8 }, () => helper(bridgeA, { ...raceEnv, PWD: `/dir${Math.random()}` })));
  assert.deepEqual(raced.map(o => o.code), Array(8).fill(0)); assert.equal(new Set(raced.map(endpointOf)).size, 1); assert.equal(s.starts().length, 1);
  tracked.add(s.starts()[0]); await stop(s.starts()[0]);
  pass('a bridge keeps its first terminal\'s configuration: proxy, adapter, program, store, packages, node and path differences are refused by name and never by value; incidental variables and an identical race are not');

  // idle shutdown against a new launch: the closing bridge is unpublished at once, the new one is separate, nothing leaks
  s = setup();
  const slowEnv = { ...s.env, FAKE_BRIDGE_SLOW_STOP: '1500' };
  const bridgeSlow = fakeBridgeDir('bridge-slow');
  const slowStart = await helper(bridgeSlow, slowEnv);
  const sockSlow = endpointOf(slowStart), oldPid = s.starts()[0]; tracked.add(oldPid);
  const oldClient = new WebSocket(`ws+unix://${sockSlow}:/`);
  await new Promise((resolve, reject) => { oldClient.once('open', resolve); oldClient.once('error', reject); });
  oldClient.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
  await until(() => readLines(s.env.FAKE_ENGINE_LOG).some(l => l.includes('--listen')), 'the old bridge started its engine');
  const oldEngine = Number(readLines(s.env.FAKE_ENGINE_LOG).find(l => l.includes('--listen')).split(' ')[0]); tracked.add(oldEngine);
  process.kill(oldPid, 'SIGTERM');
  await until(() => !fs.existsSync(sockSlow), 'the closing bridge unpublishes its socket');
  assert(alive(oldPid), 'the old bridge is still shutting down');
  const fresh = await helper(bridgeSlow, slowEnv);
  assert.equal(endpointOf(fresh), sockSlow);
  assert.equal(s.starts().length, 2, 'a launch during the old bridge\'s shutdown starts its own bridge'); const newPid = s.starts()[1]; tracked.add(newPid);
  assert.notEqual(newPid, oldPid);
  const newClient = new WebSocket(`ws+unix://${sockSlow}:/`);
  await new Promise((resolve, reject) => { newClient.once('open', resolve); newClient.once('error', reject); });
  newClient.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
  await until(() => readLines(s.env.FAKE_ENGINE_LOG).filter(l => l.includes('--listen')).length === 2, 'the new bridge started its engine');
  await until(() => !alive(oldPid), 'the old bridge exits', 20000);
  const newEngine = Number(readLines(s.env.FAKE_ENGINE_LOG).filter(l => l.includes('--listen'))[1].split(' ')[0]); tracked.add(newEngine);
  assert(!alive(oldEngine), 'the old engine was stopped'); assert(alive(newEngine) && alive(newPid), 'the new bridge and its engine are untouched by the old one\'s exit');
  assert.equal(s.state().pid, newPid); assert.equal((await answers(sockSlow)).mode, 'shared');
  assert.equal(fs.readdirSync(s.rt()).filter(n => n.startsWith('engine-')).length, 1, 'one engine directory remains');
  oldClient.terminate(); newClient.terminate(); await stop(newPid);
  pass('a launch during an idle shutdown gets its own bridge and engine; the closing bridge removes only what is its own and leaks no engine');

  // owned paths and live processes: only an engine of this directory is stopped; a symlinked directory is never followed
  s = setup();
  const rt6 = JSON.parse(spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(runtimePath).href)}).then(m => console.log(JSON.stringify(m.runtimeDir())))`], { env: s.env, encoding: 'utf8' }).stdout);
  const stranger = spawn('sleep', ['60'], { stdio: 'ignore' }); tracked.add(stranger.pid);
  const goneBridge = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const notEngine = path.join(rt6.dir, 'engine-notmine'); fs.mkdirSync(notEngine, { mode: 0o700 });
  fs.writeFileSync(path.join(notEngine, 'engine.json'), JSON.stringify({ pid: stranger.pid, token: runtime.startToken(stranger.pid), bridgePid: Number(goneBridge), bridgeToken: '1' }));
  const target = path.join(lroot, 'victim-dir'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'sentinel'), 'keep');
  fs.writeFileSync(path.join(target, 'engine.json'), JSON.stringify({ pid: stranger.pid, token: runtime.startToken(stranger.pid), bridgePid: Number(goneBridge), bridgeToken: '1' }));
  fs.symlinkSync(target, path.join(rt6.dir, 'engine-link'));
  const cleaned = await helper(bridgeA, s.env);
  endpointOf(cleaned); tracked.add(s.starts()[0]);
  assert(alive(stranger.pid), 'a process whose token matches but which is not an engine of that directory is not stopped');
  assert(!fs.existsSync(notEngine), 'its record directory is removed');
  assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'keep', 'a symlinked engine-* entry is not followed');
  assert(fs.lstatSync(path.join(rt6.dir, 'engine-link')).isSymbolicLink());
  assert.doesNotMatch(cleaned.stderr, /left behind/);
  stranger.kill(); await stop(s.starts()[0]);
  pass('cleanup stops only an engine whose command line names its own directory and never follows or removes a symlinked entry');

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
