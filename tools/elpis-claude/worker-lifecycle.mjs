// The Claude Code processes the adapter starts (workers) load only the MCP servers Elpis passes,
// and leave no process behind: each runs in its own process group, which ends with it.
import { spawn } from 'node:child_process';

const STARTS_WORKER = new Set(['session/new', 'session/load', 'session/resume']);
const GRACE_MS = 2000;
const groups = new Map(); // a worker's process group -> its ending, once begun

// A request that can start a worker gets strict MCP config, so Claude Code ignores the user's own
// servers (ELPIS_WORKER_USER_MCP=1 keeps them), and the spawn below. `mcpServers` is untouched.
export function workerRequest(msg) {
  if (!STARTS_WORKER.has(msg?.method) || !msg.params) return msg;
  const meta = msg.params._meta ?? {}, claudeCode = meta.claudeCode ?? {};
  const options = { ...claudeCode.options, spawnClaudeCodeProcess: spawnWorker, ...(process.env.ELPIS_WORKER_USER_MCP !== '1' && { strictMcpConfig: true }) };
  return { ...msg, params: { ...msg.params, _meta: { ...meta, claudeCode: { ...claudeCode, options } } } };
}

// The Agent SDK's own spawn, in a new process group. Its stderr goes to the adapter's, which the bridge logs.
export function spawnWorker({ command, args, cwd, env, signal }) {
  const child = spawn(command, args, { cwd, env, signal, detached: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  if (child.pid) {
    groups.set(child.pid, null);
    child.once('exit', () => endGroup(child.pid));
  }
  return child;
}

const toGroup = (pgid, name) => { try { process.kill(-pgid, name); return true; } catch { return false; } };

// SIGTERM to every process left in the group (MCP servers keep it after the worker is gone),
// SIGKILL after GRACE_MS to any still there.
function endGroup(pgid) {
  if (!groups.get(pgid)) {
    const ending = new Promise(resolve => {
      if (!toGroup(pgid, 'SIGTERM')) return resolve();
      const started = Date.now();
      const timer = setInterval(() => {
        if (toGroup(pgid, 0) && Date.now() - started < GRACE_MS) return;
        clearInterval(timer);
        toGroup(pgid, 'SIGKILL');
        resolve();
      }, 100);
    }).then(() => { groups.delete(pgid); });
    groups.set(pgid, ending);
  }
  return groups.get(pgid);
}

export const endWorkers = () => Promise.all([...groups.keys()].map(endGroup));
