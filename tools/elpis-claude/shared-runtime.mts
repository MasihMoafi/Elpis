import { PROXY_ENV_NAMES, environmentDigest, differingNames, codeIdentity, versionOf, readJson, writeDirectSuccessor, isDirectSuccessor, managedSuccessorPair, selectSuccessorEngine } from './runtime-identity.mts';
export { environmentDigest, codeIdentity } from './runtime-identity.mts'
import { probe, removeStaleSocket, runtimeDir, cleanEngineDir, isEngineOf } from './runtime-transport.mts';
export { probe, runtimeDir, createBridgeServer, stopBridgeListener, allowEngines, drainFile, createDrainServer, bridgeUrl, createEngine, shutdownRuntime } from './runtime-transport.mts'
import { note, pause, exists, startToken, alive, terminatePid, usable } from './runtime-process.mts';
export { startToken } from './runtime-process.mts'
import type { Runtime, EngineInfo, CodeIdentity, BridgeState } from './runtime-types.mts';
// One Elpis bridge per ELPIS_HOME, one native app-server per bridge.
//
// The bridge (acp-bridge.mts) calls createBridgeServer(), createEngine(), bridgeUrl() and
// shutdownRuntime(). Run as `node shared-runtime.mts <bridge script>`, this file is the launcher's
// helper: it makes sure exactly one bridge serves this ELPIS_HOME and prints its endpoint
// (`unix:///abs/path`) on stdout, nothing else. Errors go to stderr with a non-zero exit.
//
// Without ELPIS_SHARED_BRIDGE everything behaves as before: a loopback TCP listener, and one
// private `app-server` per connection. With it, the bridge listens on ELPIS_BRIDGE_SOCKET and every
// connection except the delegate tool's ("elpis-agents", whose engine `kill()` is what stops a
// helper) shares one native app-server on a bridge-owned socket, reached over WebSocket-on-Unix.
// One Elpis bridge per ELPIS_HOME, one native app-server per bridge.
//

//

import { spawn, spawnSync } from "node:child_process";

import { randomBytes } from "node:crypto";
import fs from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./log-redaction.mts";

// A lock file naming its holder's pid and start token; one whose holder is gone is taken over.
async function acquireLock(file: string) {
  const me = `${process.pid} ${startToken(process.pid)}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, me); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8") === me) fs.rmSync(file, { force: true }); } catch {} };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
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
async function reapOrphans(rt: Runtime) {
  for (const name of fs.readdirSync(rt.dir)) {
    if (!name.startsWith("engine-")) continue;
    const dir = path.join(rt.dir, name);
    const info = readJson<EngineInfo>(path.join(dir, "engine.json"));
    if (info && alive(info.bridgePid as number, info.bridgeToken)) continue; // its bridge is still shutting down
    if (isEngineOf(info, dir)) {
      note(`stopping native engine ${info.pid} left behind by a bridge that exited`);
      await terminatePid(info.pid, info.token);
    }
    cleanEngineDir(dir);
  }
}

function tailOf(file: string, from: number) {
  try { return fs.readFileSync(file, "utf8").slice(from).trim().split("\n").slice(-20).join("\n"); } catch { return ""; }
}

// Older bundles have no control RPC. Linux's socket table can still tell whether their
// listener has accepted connections, without attaching a new terminal to that bridge.
// The launch lock prevents another launcher from joining between this check and SIGTERM.
async function retireUnattachedBridge(rt: Runtime, state: BridgeState) {
  if (process.platform !== "linux") return false;
  await pause(100); // let the reachability probe's accepted socket close
  const sockets = spawnSync("ss", ["-xHn", "state", "connected", "src", rt.sock], { encoding: "utf8", timeout: 2000 });
  if (sockets.status !== 0 || sockets.stdout.trim()) return false;
  const recorded = readJson<BridgeState>(rt.state);
  if (recorded?.pid !== state.pid || recorded?.token !== state.token) return false;
  if (alive(state.pid, state.token)) {
    note(`stopping unattached bridge ${state.pid} gracefully before switching installations`);
    try { process.kill(state.pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
  // Never force-kill a bridge or start its replacement before its save/shutdown completes.
  for (let i = 0; i < 100 && alive(state.pid, state.token); i++) await pause(100);
  if (alive(state.pid, state.token)) throw new Error(`the unattached Elpis bridge (pid ${state.pid}) has not finished saving and stopping; try again in a few seconds; see ${rt.log}`);
  return true;
}

async function ensureBridge(rt: Runtime, bridgeScript: string, identity: CodeIdentity): Promise<{ engine: string; running: string } | undefined> {
  const state = readJson<BridgeState>(rt.state);
  const reachable = await probe(rt.sock);
  if (state && alive(state.pid, state.token)) {
    if (reachable.ok) {
      const config = differingNames(state, process.env);
      if (state.identity === identity.hash && !config.length) return;
      // Same installation, only proxy settings differ: never refuse (1 Nov, Masih: "I hate such errs"). An idle bridge
      // restarts with this launch's settings; one in use is joined and keeps its own until its terminals close.
      if (state.identity === identity.hash && config.every(name => PROXY_ENV_NAMES.includes(name))) {
        if (await retireUnattachedBridge(rt, state)) return ensureBridge(rt, bridgeScript, identity);
        note(`joining the running Elpis bridge (pid ${state.pid}); it keeps its proxy settings until its other terminals close`);
        return;
      }
      const directHandover = config.length > 0 && config.every(name => PROXY_ENV_NAMES.includes(name))
        && PROXY_ENV_NAMES.every(name => process.env[name] === undefined);
      if (state.identity !== identity.hash && directHandover && usable(state.engine) && await managedSuccessorPair(state, identity)) {
        writeDirectSuccessor(rt, identity.script);
        fs.writeFileSync(rt.successor, identity.script, { mode: 0o600 });
        return { engine: state.engine, running: state.script };
      }
      if (state.identity !== identity.hash && !config.length && await retireUnattachedBridge(rt, state)) return ensureBridge(rt, bridgeScript, identity);
      // Like the desktop app, a terminal joins the Elpis that is already running instead of refusing (19 Oct: every
      // install made while the app was open stopped `elpis` from starting). It uses that installation's engine, so the
      // pair matches. The running bridge hands over to this installation within seconds; chats working then finish in it (acp-bridge.mts startDrain).
      if (state.identity !== identity.hash && !config.length && usable(state.engine)) {
        fs.writeFileSync(rt.successor, identity.script, { mode: 0o600 });
        return { engine: state.engine, running: state.script };
      }
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
  const directSuccessor = isDirectSuccessor(rt, identity.script);
  if (directSuccessor && PROXY_ENV_NAMES.some(name => process.env[name] !== undefined)) {
    throw new Error("The direct handover cannot start with proxy variables.");
  }
  // Nothing living: remove what a crashed bridge left.
  fs.rmSync(rt.state, { force: true });
  fs.rmSync(rt.successor, { force: true });
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
    if ((await probe(rt.sock)).ok) {
      if (directSuccessor) fs.rmSync(rt.successorDirect, { force: true });
      return;
    }
    if (Date.now() > deadline) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
      fs.rmSync(rt.state, { force: true });
      throw new Error(`the bridge did not listen on ${rt.sock} within 20 s; stopped it.\n${tailOf(rt.log, from)}`);
    }
    await pause(50);
  }
}

async function launcherMain(bridgeScript: string | undefined) {
  if (!bridgeScript) throw new Error("usage: node shared-runtime.mts <bridge script>");
  bridgeScript = path.resolve(bridgeScript);
  const rt = runtimeDir();
  const release = await acquireLock(rt.lock);
  let joined, identity;
  try {
    await selectSuccessorEngine(rt, bridgeScript);
    identity = codeIdentity(bridgeScript);
    joined = await ensureBridge(rt, bridgeScript, identity);
  } finally { release(); }
  if (joined) process.stderr.write(`elpis: using the Elpis already running (${versionOf(joined.running)}); this installation (${versionOf(identity.script)}) takes over in a few seconds; chats working now finish first.\n`);
  await new Promise((resolve) => process.stdout.write(`unix://${rt.sock}\n${joined ? `engine ${joined.engine}\n` : ""}`, resolve));
}

const runAsLauncher = (() => { try { return fs.realpathSync(process.argv[1] as string) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (runAsLauncher) {
  launcherMain(process.argv[2]).then(() => process.exit(0), (e) => { process.stderr.write(`elpis-claude: ${redactSecrets(e.message)}\n`); process.exit(1); });
}
