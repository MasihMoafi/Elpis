import { BridgeError } from './validate.mts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Image history can exceed 8 MiB; keep runtime messages and HTTP responses bounded together.
export const MAX_BRIDGE_MESSAGE_BYTES = 100 * 1024 * 1024;

/** The Elpis home the runtime uses: its config, sessions and logs. */
export const elpisHome = (env = process.env) => path.resolve(env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'));

// Mirrors shared-runtime.mts's path derivation, but never creates directories or starts a runtime.
export function existingSocket(explicit?: string, env: NodeJS.ProcessEnv = process.env) {
  const provided = explicit || env.ELPIS_APP_BRIDGE_SOCKET || env.ELPIS_BRIDGE_SOCKET;
  let candidates;
  if (provided) candidates = [provided.replace(/^unix:\/\//, '')];
  else {
    let home = elpisHome(env);
    try { home = fs.realpathSync(home); } catch {}
    const key = createHash('sha256').update(home).digest('hex').slice(0, 16);
    candidates = ([env.XDG_RUNTIME_DIR && path.join(env.XDG_RUNTIME_DIR, 'elpis-bridge', key, 'bridge.sock'),
      path.join(os.tmpdir(), `elpis-bridge-${process.getuid?.()}`, key, 'bridge.sock')].filter(Boolean)) as string[];
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new BridgeError('Bridge socket must be an absolute Unix socket path');
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { continue; }
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new BridgeError('Bridge socket must be private and owned by the current user', 403);
    }
    return candidate;
  }
  throw new BridgeError('No running Elpis bridge found. Start Elpis, or set ELPIS_APP_BRIDGE_SOCKET to its existing Unix socket.', 503);
}
