import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { childEnv } from '../bridge/tools.mjs';
import { runtimeTools } from '../bridge/runtime-paths.mjs';
import { existingSocket } from '../bridge/client.mjs';

const run = promisify(execFile);

// Reuse the installed launcher's single-runtime lock and provider bridge. Opening the
// app must not require an open terminal or create an independent conversation engine.
export async function ensureInstalledRuntime({ env = process.env } = {}) {
  if (env.ELPIS_APP_BRIDGE_SOCKET || env.ELPIS_BRIDGE_SOCKET) return;
  // The ordinary app joins the current private runtime. An explicit engine choice
  // still goes through the installed launcher's identity and configuration guard.
  if (!env.ELPIS_ENGINE_BIN) {
    let socketPath;
    try { socketPath = existingSocket(undefined, env); }
    catch (error) { if (error.status !== 503) throw error; }
    if (socketPath && await new Promise(resolve => {
      const socket = net.createConnection(socketPath);
      const done = connected => { socket.destroy(); resolve(connected); };
      socket.setTimeout(1000);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    })) {
      // 27 Oct: after an engine install, Restart reopened the app on the engine already running, so "Update ready"
      // never went away. A runtime from another installation is asked to hand over to the selected one (its working
      // chats finish where they are: shared-runtime.mjs); when it cannot, the app keeps the running one.
      let running, selected;
      try { running = JSON.parse(fs.readFileSync(path.join(path.dirname(socketPath), 'state.json'), 'utf8')).engine; } catch { /* unknown: keep it */ }
      try { selected = fs.realpathSync(path.join(env.HOME || os.homedir(), '.local', 'bin', 'elpis-next')); } catch { /* none selected */ }
      if (running && selected && running !== selected) await startRuntime(env, selected).catch(error => console.error(`Elpis kept the running engine: ${error.message}`));
      return;
    }
  }
  const selected = env.ELPIS_ENGINE_BIN || path.join(env.HOME || os.homedir(), '.local', 'bin', 'elpis-next');
  let engine;
  try { engine = fs.realpathSync(selected); }
  catch { throw new Error('Install Elpis before opening the app. The Elpis runtime executable could not be found.'); }
  await startRuntime(env, engine);
}

/** Runs the installation's launcher helper: it starts that bridge, or has a running one from another installation hand over to it. */
async function startRuntime(env, engine) {
  const bridgeDir = runtimeTools(engine);
  const helper = path.join(bridgeDir, 'shared-runtime.mjs');
  const bridge = path.join(bridgeDir, 'acp-bridge.mjs');
  if (!fs.existsSync(helper) || !fs.existsSync(bridge)) {
    throw new Error('The selected Elpis installation is missing its provider bridge. Reinstall Elpis, or connect to an existing runtime with ELPIS_APP_BRIDGE_SOCKET.');
  }
  // Electron leaves some descriptors inheritable, among them the DevTools listener of a
  // --remote-debugging-port launch. The shared runtime outlives the app, so it would keep that
  // port bound after the app quits; close every inherited descriptor above stderr first.
  const closeInherited = 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-" 2>/dev/null; done; exec "$@"';
  await run('/bin/bash', ['-c', closeInherited, 'elpis-runtime', env.ELPIS_NODE_BIN || 'node', helper, bridge], {
    env: { ...childEnv(env), ELPIS_ENGINE_BIN: engine, NODE_USE_ENV_PROXY: '1' },
    timeout: 30000, maxBuffer: 65536,
  });
}
