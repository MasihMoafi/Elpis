// One Elpis bridge per ELPIS_HOME, one native app-server per bridge.
//
// The bridge (acp-bridge.mjs) calls createBridgeServer(), createEngine(), bridgeUrl() and
// shutdownRuntime(). Run as `node shared-runtime.mjs <bridge script>`, this file is the launcher's
// helper: it makes sure exactly one bridge serves this ELPIS_HOME and prints its endpoint
// (`unix:///abs/path`) on stdout, nothing else. Errors go to stderr with a non-zero exit.
//
// Without ELPIS_SHARED_BRIDGE everything behaves as before: a loopback TCP listener, and one
// private `app-server` per connection. With it, the bridge listens on ELPIS_BRIDGE_SOCKET and every
// connection except the delegate tool's ("elpis-agents", whose engine `kill()` is what stops a
// helper) shares one native app-server on a bridge-owned socket, reached over WebSocket-on-Unix.
import { WebSocketServer, WebSocket } from "ws";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = () => Boolean(process.env.ELPIS_SHARED_BRIDGE);
const homeDir = () => process.env.ELPIS_HOME || `${process.env.HOME}/.elpis-next`;
const engineBin = () => process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;
const note = (s) => process.stderr.write(`[shared-runtime] ${s}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A unix socket path must fit sockaddr_un (108 bytes, with the terminator).
const SOCKET_PATH_MAX = 100;
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isSocket = (p) => { try { return fs.lstatSync(p).isSocket(); } catch { return false; } };

// ---- processes: a pid alone can be reused, so a start token goes with it ------------------------

// Linux: field 22 of /proc/<pid>/stat (clock ticks since boot); elsewhere ps's start time.
export function startToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {}
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
function alive(pid, token) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  return token == null || startToken(pid) === token;
}
async function terminate(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  if (await Promise.race([gone, pause(ms).then(() => false)]) === false) {
    child.kill("SIGKILL");
    await Promise.race([gone, pause(2000)]);
  }
}
async function terminatePid(pid, token, ms = 5000) {
  if (!alive(pid, token)) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let waited = 0; waited < ms && alive(pid, token); waited += 50) await pause(50);
  if (alive(pid, token)) { try { process.kill(pid, "SIGKILL"); } catch {} for (let i = 0; i < 40 && alive(pid, token); i++) await pause(50); }
}

// ---- sockets ------------------------------------------------------------------------------------

// { ok: true } when something accepts connections at the path, else the connect error's code.
function probe(sock, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done({ ok: false, code: "ETIMEDOUT" }));
    socket.once("connect", () => done({ ok: true }));
    socket.once("error", (e) => done({ ok: false, code: e.code ?? String(e) }));
  });
}
// Removes a socket file nothing listens on. Never touches a living socket or a non-socket.
async function removeStaleSocket(sock) {
  if (!exists(sock)) return;
  if (!isSocket(sock)) throw new Error(`${sock} exists and is not a socket; refusing to remove it`);
  const r = await probe(sock);
  if (r.ok) throw new Error(`${sock} is served by a living process; refusing to remove it`);
  if (r.code !== "ECONNREFUSED" && r.code !== "ENOENT") throw new Error(`cannot tell whether ${sock} is stale (${r.code})`);
  fs.rmSync(sock, { force: true });
}

// ---- private runtime directory --------------------------------------------------------------------

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} must be a real directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}
// One directory per ELPIS_HOME under a uid-only base. The path is hashed so its length is fixed.
export function runtimeDir(home = homeDir()) {
  let real = path.resolve(home);
  try { real = fs.realpathSync.native(real); } catch {}
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  const bases = [
    process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, "elpis-bridge"),
    path.join(os.tmpdir(), `elpis-bridge-${process.getuid()}`),
  ].filter(Boolean);
  for (const base of bases) {
    const dir = path.join(base, key);
    const sock = path.join(dir, "bridge.sock");
    if (Buffer.byteLength(sock) > SOCKET_PATH_MAX) continue;
    ensurePrivateDir(base);
    ensurePrivateDir(dir);
    return { home: real, dir, sock, state: path.join(dir, "state.json"), lock: path.join(dir, "launch.lock"), log: path.join(dir, "daemon.log") };
  }
  throw new Error(`no runtime directory with a socket path under ${SOCKET_PATH_MAX} bytes (set XDG_RUNTIME_DIR or TMPDIR to a shorter path)`);
}

// ---- the bridge's listener ------------------------------------------------------------------------

// The published listener: its socket is identified by device and inode, so that a socket (or state
// file) a later bridge publishes at the same path is never mistaken for this one's.
let listener = null; // { server, sock, id, stopped, closed }
let stopped = false; // a listener was stopped: no engine starts until the next createBridgeServer
export function createBridgeServer() {
  stopped = false;
  if (!shared()) return new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.PORT ?? 47820) });
  const sock = process.env.ELPIS_BRIDGE_SOCKET;
  if (!sock || !path.isAbsolute(sock)) throw new Error("ELPIS_SHARED_BRIDGE needs an absolute ELPIS_BRIDGE_SOCKET");
  const server = http.createServer((req, res) => { res.statusCode = 426; res.end("WebSocket upgrade required\n"); });
  const entry = listener = { server, sock, id: null, stopped: false, closed: null };
  // An upgrade that was accepted just before the listener stopped is refused too.
  const wss = new WebSocketServer({ server, verifyClient: () => !entry.stopped });
  // After the caller has attached its handlers; a failure surfaces as the server's 'error'.
  setImmediate(() => {
    if (entry.stopped) return;
    removeStaleSocket(sock).then(() => {
      if (entry.stopped) return;
      server.listen(sock, () => {
        if (entry.stopped) { try { if (fs.lstatSync(sock).isSocket()) fs.rmSync(sock, { force: true }); } catch {} return; } // stopped while binding
        fs.chmodSync(sock, 0o600);
        const st = fs.lstatSync(sock);
        entry.id = `${st.dev}:${st.ino}`;
      });
    }, (e) => wss.emit("error", e));
  });
  return wss;
}
// Synchronous and idempotent: stops accepting, then removes this bridge's own socket and state, and
// nothing a later bridge published. Returns when the server has closed.
export function stopBridgeListener() {
  const entry = listener;
  if (!entry) return Promise.resolve();
  if (entry.stopped) return entry.closed;
  entry.stopped = true;
  stopped = true;
  const sock = entry.sock;
  const stateFile = path.join(path.dirname(sock), "state.json");
  try { if (JSON.parse(fs.readFileSync(stateFile, "utf8")).pid === process.pid) fs.rmSync(stateFile, { force: true }); } catch {}
  // Closing a server unlinks whatever is at its path. If another bridge's socket has replaced ours,
  // it is moved aside for the instant that takes.
  let aside = null;
  try {
    const st = fs.lstatSync(sock);
    if (st.isSocket() && entry.id === `${st.dev}:${st.ino}`) fs.rmSync(sock, { force: true });
    else if (st.isSocket() && entry.id !== null) { aside = `${sock}.aside-${process.pid}`; fs.renameSync(sock, aside); }
  } catch { aside = null; }
  entry.closed = new Promise((resolve) => {
    try { entry.server.close(() => resolve()); } catch { resolve(); }
    entry.server.closeIdleConnections?.();
    setTimeout(resolve, 2000).unref();
  });
  if (aside) { try { if (fs.existsSync(sock)) fs.rmSync(aside, { force: true }); else fs.renameSync(aside, sock); } catch {} }
  return entry.closed;
}
export function bridgeUrl(wss) {
  const address = wss.address();
  if (typeof address === "string") return `ws+unix://${address}:/`;
  if (!address && shared()) return `ws+unix://${process.env.ELPIS_BRIDGE_SOCKET}:/`;
  return `ws://127.0.0.1:${address.port}`;
}

// ---- engines --------------------------------------------------------------------------------------

const privateEngines = new Set(); // ChildProcess spawned by this bridge
const proxies = new Set();
let sharedEngine = null; // { promise, child, dir, sock }

function spawnPrivate() {
  const child = spawn(engineBin(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  privateEngines.add(child);
  child.once("exit", () => privateEngines.delete(child));
  return child;
}

// The native engine's own socket, in an `engine-*` directory only this bridge writes to; engine.json
// lets the launcher find (and stop) an engine whose bridge died.
function startSharedEngine() {
  const entry = { promise: null, child: null, dir: null, sock: null };
  sharedEngine = entry;
  entry.promise = (async () => {
    const parent = process.env.ELPIS_BRIDGE_SOCKET ? path.dirname(process.env.ELPIS_BRIDGE_SOCKET) : null;
    if (!parent) throw new Error("ELPIS_SHARED_BRIDGE needs ELPIS_BRIDGE_SOCKET");
    ensurePrivateDir(parent);
    entry.dir = fs.mkdtempSync(path.join(parent, "engine-"));
    entry.sock = path.join(entry.dir, "e.sock");
    let tail = "";
    const child = entry.child = spawn(engineBin(), ["app-server", "--listen", `unix://${entry.sock}`], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-4000); note(`engine: ${String(chunk).trimEnd()}`); });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(`exited (${signal ?? code})`)));
    child.once("exit", () => {
      note(`native engine ${child.pid} exited`);
      if (sharedEngine === entry) sharedEngine = null;
      for (const p of [...proxies]) p.engineGone();
      cleanEngineDir(entry.dir);
    });
    const failed = new Promise((resolve) => child.once("error", (e) => resolve(`failed to start: ${e.message}`)));
    fs.writeFileSync(path.join(entry.dir, "engine.json"), JSON.stringify({ pid: child.pid, token: startToken(child.pid), bridgePid: process.pid, bridgeToken: startToken(process.pid) }), { mode: 0o600 });
    const deadline = Date.now() + 30000;
    for (;;) {
      const stop = await Promise.race([exited, failed, pause(50).then(() => null)]);
      if (stop) throw new Error(`native engine ${stop} before it listened${tail ? `: ${tail.trim()}` : ""}`);
      if ((await probe(entry.sock)).ok) return entry;
      if (Date.now() > deadline) { await terminate(child); throw new Error("native engine did not listen within 30 s"); }
    }
  })();
  entry.promise.catch(() => { if (sharedEngine === entry) sharedEngine = null; cleanEngineDir(entry.dir); });
  return entry;
}
// Removes an engine directory made by a bridge, and, if the engine left its socket target behind in
// the native socket directory (the symlink points there), that dead socket. Only a real directory
// of this user named `engine-*` is removed, and only socket files of this user are touched.
function cleanEngineDir(dir) {
  if (!dir || !path.basename(dir).startsWith("engine-")) return;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid()) return;
  } catch { return; }
  try {
    const link = path.join(dir, "e.sock");
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(link);
      const owned = (() => { try { const t = fs.lstatSync(target); return t.isSocket() && t.uid === process.getuid(); } catch { return false; } })();
      if (owned && path.basename(path.dirname(target)).startsWith("codex-daemon-")) probe(target).then((r) => { if (!r.ok) fs.rmSync(target, { force: true }); });
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
// Whether `pid` is the engine this directory's record describes: same start token and, where the
// kernel shows command lines, an `app-server` listening on this directory's socket.
function isEngineOf(info, dir) {
  if (!info || !alive(info.pid, info.token)) return false;
  if (!fs.existsSync("/proc/self/stat")) return true; // no command lines to read: the start token stands
  try {
    const argv = fs.readFileSync(`/proc/${info.pid}/cmdline`, "utf8").split("\0");
    return argv.includes("app-server") && argv.includes(`unix://${path.join(dir, "e.sock")}`);
  } catch { return false; }
}

// What the bridge sees of an engine in shared mode. The first frame decides: `initialize` from the
// delegate tool gets a private engine, everything else the shared one. Same surface as a child, plus
// the guarantee a pipe lacks: when the engine or its connection ends unexpectedly, every request
// that was queued or already sent and not answered gets one JSON-RPC error answer, then `exit`.
class EngineProxy {
  constructor() {
    this.stdin = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stdin.write = (chunk) => { this.#write(String(chunk)); return true; };
    this.stdin.end = () => {};
    this.mode = null;
    this.pid = undefined;
    this.pending = []; // frames before the connection opens
    this.inflight = new Map(); // JSON id -> id of requests written and not yet answered
    this.scan = ""; // a private engine's stdout, for answers (the bridge still gets every chunk as it came)
    this.socket = null;
    this.child = null;
    this.gone = false;
    this.closing = false;
    proxies.add(this);
  }
  #error(id, why) { this.stdout.emit("data", `${JSON.stringify({ id, error: { code: -32603, message: why } })}\n`); }
  #answered(text) {
    for (const line of text.split("\n")) {
      if (!line.includes('"id"')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.id !== undefined && !msg.method) this.inflight.delete(JSON.stringify(msg.id));
    }
  }
  #fail(why) {
    const unanswered = [...this.inflight.values()];
    this.inflight.clear();
    for (const frame of this.pending.splice(0)) {
      try { if (JSON.parse(frame).id === undefined) note(`dropped ${JSON.parse(frame).method ?? "a message"}: ${why}`); } catch {}
    }
    for (const id of unanswered) this.#error(id, why);
    if (this.stdin.listenerCount("error")) this.stdin.emit("error", new Error(why)); else note(why);
  }
  #write(text) {
    for (const frame of text.split("\n")) {
      if (!frame) continue;
      let msg = null;
      try { msg = JSON.parse(frame); } catch {}
      if (this.gone || (!this.mode && stopped)) {
        const why = this.gone ? "the engine connection is closed" : "the bridge is shutting down";
        if (!this.gone) this.#end(why);
        if (msg?.id !== undefined && msg.method) this.#error(msg.id, why); else note(`dropped ${msg?.method ?? "a message"}: ${why}`);
        continue;
      }
      if (!this.mode) this.#choose(frame, msg);
      if (msg?.id !== undefined && msg.method) this.inflight.set(JSON.stringify(msg.id), msg.id);
      this.#send(frame);
    }
  }
  #choose(first, msg) {
    const helper = msg?.method === "initialize" && msg.params?.clientInfo?.name === "elpis-agents";
    this.mode = helper ? "private" : "shared";
    if (helper) {
      const child = this.child = spawnPrivate();
      this.pid = child.pid;
      child.stdout.on("data", (d) => { this.scan = (this.scan + d.toString("latin1")).slice(-1 << 20); const cut = this.scan.lastIndexOf("\n"); if (cut >= 0) { this.#answered(this.scan.slice(0, cut)); this.scan = this.scan.slice(cut + 1); } this.stdout.emit("data", d); });
      child.stdin.on("error", (e) => (this.stdin.listenerCount("error") ? this.stdin.emit("error", e) : note(`engine input: ${e.message}`)));
      // After its output has been read, so an answer already in the pipe is not replaced by an error.
      child.once("close", (code, signal) => this.#end(`the helper's engine exited (${signal ?? code})`));
      return;
    }
    (sharedEngine ?? startSharedEngine()).promise.then((engine) => {
      if (this.gone) return;
      this.pid = engine.child.pid;
      const socket = this.socket = new WebSocket(`ws+unix://${engine.sock}:/`);
      socket.on("open", () => { for (const frame of this.pending.splice(0)) socket.send(frame); });
      socket.on("message", (data) => { const text = String(data); this.#answered(text); this.stdout.emit("data", `${text}\n`); });
      socket.on("error", (e) => note(`engine connection: ${e.message}`));
      // 'close' follows the last message, so nothing the engine answered is rejected.
      socket.on("close", () => this.#end("the native engine connection closed"));
    }, (e) => this.#end(e.message));
  }
  #send(frame) {
    if (this.child) { this.child.stdin.write(`${frame}\n`); return; }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
    else this.pending.push(frame);
  }
  #end(why) {
    if (this.gone) return;
    this.gone = true;
    proxies.delete(this);
    if (this.closing) { this.pending.length = 0; this.inflight.clear(); } else this.#fail(why);
    this.stdout.emit("exit", why);
  }
  // The shared engine's process ended. Its connection reports it after the last message arrived.
  engineGone() {
    if (this.mode !== "shared" || this.gone) return;
    if (this.socket) setTimeout(() => this.socket.terminate(), 1000).unref();
    else this.#end("the shared native engine exited");
  }
  // Closes this connection only. A helper's private engine is stopped.
  kill() {
    this.closing = true;
    if (this.child) { this.child.kill(); return; }
    this.socket?.close();
    this.#end("closed");
  }
}

export function createEngine() {
  return shared() ? new EngineProxy() : spawnPrivate();
}

// Stops the engines this bridge started, and removes what it created (not the launcher's files of
// other bridges). Unpublishing comes first, so a launcher arriving now starts a new bridge instead
// of joining this one. The caller exits afterwards.
export async function shutdownRuntime() {
  const closed = stopBridgeListener();
  for (const p of [...proxies]) p.kill();
  const stopping = [...privateEngines].map((child) => terminate(child));
  const entry = sharedEngine;
  if (entry) {
    sharedEngine = null;
    stopping.push(entry.promise.then(() => terminate(entry.child), () => entry.child && terminate(entry.child)).then(() => cleanEngineDir(entry.dir)));
  }
  await Promise.all([closed, ...stopping]);
}

// ---- launcher helper -----------------------------------------------------------------------------

const sha = (data) => createHash("sha256").update(data).digest("hex");
// The environment the bridge inherits from the terminal that started it and that changes what it
// does: network proxy, the Claude and Antigravity programs and adapters, stores and auth homes.
// Request, working-directory, terminal and log-path variables are incidental and not listed.
const ENV_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_EXECUTABLE", "CLAUDE_CONFIG_DIR", "ELPIS_CLAUDE_PRUNE", "ELPIS_CLAUDE_USAGE_URL",
  "ELPIS_NO_AGY", "AGY_BIN", "AGY_DEFAULT_MODEL", "ACP_ADAPTER", "ACP_BRIDGE_STORE", "ACP_BRIDGE_NO_AGENTS", "ELPIS_AGENT_TOOLS",
  "CODEX_HOME", "CODEX_AUTH_HOME",
];
// Salted hashes of the set variables, so a state file never holds a proxy URL or a key.
export function environmentDigest(env, salt) {
  const digest = {};
  for (const name of ENV_NAMES) if (env[name] !== undefined) digest[name] = sha(`${salt}\0${name}\0${env[name]}`);
  return digest;
}
// The names whose value differs between a running bridge's record and this launch.
function differingNames(recorded, env) {
  if (!recorded?.envSalt || !recorded.env) return ENV_NAMES.filter((name) => env[name] !== undefined);
  const now = environmentDigest(env, recorded.envSalt);
  return ENV_NAMES.filter((name) => now[name] !== recorded.env[name]);
}
// What must match between the running bridge and a new launch besides the environment: the bridge's
// own code and packages, the engine, and the node that runs it.
export function codeIdentity(bridgeScript, node = process.execPath) {
  const script = fs.realpathSync(bridgeScript);
  const dir = path.dirname(script);
  const files = {};
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs") || n === "package.json" || n === "package-lock.json").sort()) files[name] = sha(fs.readFileSync(path.join(dir, name)));
  let modules = null;
  try {
    const adapter = JSON.parse(fs.readFileSync(path.join(dir, "node_modules/@agentclientprotocol/claude-agent-acp/package.json"), "utf8"));
    modules = { path: fs.realpathSync(path.join(dir, "node_modules")), adapter: adapter.version };
  } catch {}
  const bin = engineBin();
  let engine;
  try {
    const real = fs.realpathSync(bin);
    const st = fs.statSync(real);
    engine = { path: real, id: st.size <= 1 << 20 ? sha(fs.readFileSync(real)) : `${st.size}:${st.mtimeMs}` };
  } catch (e) { throw new Error(`engine binary ${bin} is not usable: ${e.message}`); }
  let runtime;
  try {
    const real = fs.realpathSync(node);
    const st = fs.statSync(real);
    runtime = { path: real, version: node === process.execPath ? process.version : null, id: `${st.size}:${st.mtimeMs}` };
  } catch (e) { throw new Error(`node ${node} is not usable: ${e.message}`); }
  // The script's own path too: its helpers (adapters, MCP server) load from beside it for as long as the bridge lives.
  return { hash: sha(JSON.stringify({ script, files, modules, engine, runtime })).slice(0, 16), script, engine: engine.path };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

// A lock file naming its holder's pid and start token; one whose holder is gone is taken over.
async function acquireLock(file) {
  const me = `${process.pid} ${startToken(process.pid)}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, me); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8") === me) fs.rmSync(file, { force: true }); } catch {} };
    } catch (e) { if (e.code !== "EEXIST") throw e; }
    let text = ""; let age = 0;
    try { text = fs.readFileSync(file, "utf8"); age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
    const [pid, ...token] = text.split(" ");
    const dead = text ? !alive(Number(pid), token.join(" ")) : age > 2000;
    if (dead) { try { if (fs.readFileSync(file, "utf8") === text) fs.rmSync(file, { force: true }); } catch {} continue; }
    if (Date.now() > deadline) throw new Error(`another launcher (pid ${pid}) has held ${file} for 30 s`);
    await pause(50);
  }
}

// Engines whose bridge is gone: stopped, so they stop holding threads' writer locks.
async function reapOrphans(rt) {
  for (const name of fs.readdirSync(rt.dir)) {
    if (!name.startsWith("engine-")) continue;
    const dir = path.join(rt.dir, name);
    const info = readJson(path.join(dir, "engine.json"));
    if (info && alive(info.bridgePid, info.bridgeToken)) continue; // its bridge is still shutting down
    if (isEngineOf(info, dir)) {
      note(`stopping native engine ${info.pid} left behind by a bridge that exited`);
      await terminatePid(info.pid, info.token);
    }
    cleanEngineDir(dir);
  }
}

function tailOf(file, from) {
  try { return fs.readFileSync(file, "utf8").slice(from).trim().split("\n").slice(-20).join("\n"); } catch { return ""; }
}

async function ensureBridge(rt, bridgeScript, identity) {
  const state = readJson(rt.state);
  const reachable = await probe(rt.sock);
  if (state && alive(state.pid, state.token)) {
    if (reachable.ok) {
      const config = differingNames(state, process.env);
      if (state.identity === identity.hash && !config.length) return;
      const lines = [];
      if (state.identity !== identity.hash) {
        lines.push(`an Elpis bridge for ${rt.home} is already running from a different installation, so this terminal was not started.`,
          `  running: bridge ${state.script}, engine ${state.engine} (pid ${state.pid})`,
          `  this launch: bridge ${identity.script}, engine ${identity.engine}`);
        if (config.length) lines.push(`  its configuration also differs (${config.join(", ")}; values not shown)`);
      } else {
        lines.push(`an Elpis bridge for ${rt.home} is already running with a different configuration, so this terminal was not started.`,
          `  differing variables: ${config.join(", ")} (values not shown); running bridge pid ${state.pid}`);
      }
      lines.push("Close the Elpis terminals that use the running bridge; it exits once they are closed and it is idle. No sessions are lost. Then start Elpis again.");
      throw new Error(lines.join("\n"));
    }
    for (let i = 0; i < 100 && alive(state.pid, state.token); i++) { await pause(100); if ((await probe(rt.sock)).ok) return ensureBridge(rt, bridgeScript, identity); }
    if (alive(state.pid, state.token)) throw new Error(`the Elpis bridge (pid ${state.pid}) is running but does not accept connections at ${rt.sock} (it may be shutting down; try again in a few seconds); see ${rt.log}`);
  } else if (reachable.ok) {
    throw new Error(`${rt.sock} is served by a process this launcher did not record; close the Elpis terminals using it and start again`);
  }
  // Nothing living: remove what a crashed bridge left.
  fs.rmSync(rt.state, { force: true });
  await removeStaleSocket(rt.sock);
  await reapOrphans(rt);

  const from = exists(rt.log) ? fs.statSync(rt.log).size : 0;
  const fd = fs.openSync(rt.log, "a", 0o600);
  const child = spawn(process.execPath, [bridgeScript], {
    detached: true, stdio: ["ignore", fd, fd], cwd: process.env.HOME || "/",
    env: { ...process.env, ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: rt.sock },
  });
  fs.closeSync(fd);
  let early = null;
  child.once("exit", (code, signal) => { early = `exited (${signal ?? code})`; });
  child.once("error", (e) => { early = `failed to start: ${e.message}`; });
  child.unref();
  if (!child.pid) { await pause(50); throw new Error(`the bridge ${early ?? "did not start"}`); }
  const envSalt = randomBytes(16).toString("hex");
  fs.writeFileSync(rt.state, JSON.stringify({ pid: child.pid, token: startToken(child.pid), identity: identity.hash, envSalt, env: environmentDigest(process.env, envSalt), script: identity.script, engine: identity.engine, socket: rt.sock, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (early || !alive(child.pid)) {
      fs.rmSync(rt.state, { force: true });
      throw new Error(`the bridge ${early ?? "exited"} before it listened.\n${tailOf(rt.log, from)}`);
    }
    if ((await probe(rt.sock)).ok) return;
    if (Date.now() > deadline) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
      fs.rmSync(rt.state, { force: true });
      throw new Error(`the bridge did not listen on ${rt.sock} within 20 s; stopped it.\n${tailOf(rt.log, from)}`);
    }
    await pause(50);
  }
}

async function launcherMain(bridgeScript) {
  if (!bridgeScript) throw new Error("usage: node shared-runtime.mjs <bridge script>");
  bridgeScript = path.resolve(bridgeScript);
  const identity = codeIdentity(bridgeScript);
  const rt = runtimeDir();
  const release = await acquireLock(rt.lock);
  try { await ensureBridge(rt, bridgeScript, identity); } finally { release(); }
  await new Promise((resolve) => process.stdout.write(`unix://${rt.sock}\n`, resolve));
}

const runAsLauncher = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (runAsLauncher) {
  launcherMain(process.argv[2]).then(() => process.exit(0), (e) => { process.stderr.write(`elpis-claude: ${e.message}\n`); process.exit(1); });
}
