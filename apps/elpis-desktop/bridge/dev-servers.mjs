import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, object } from './client.mjs';
import { projectDirectory } from './folders.mjs';
import { childEnv } from './tools.mjs';

const quote = value => /^[\w./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
async function readJson(file) {
  try {
    if ((await fs.stat(file)).size > 256 * 1024) throw Error('too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new BridgeError(`Could not read ${path.basename(file)}: ${error instanceof SyntaxError ? 'invalid JSON' : error.message}`);
  }
}
async function candidatesIn(cwd) {
  const launch = await readJson(path.join(cwd, '.elpis/launch.json'));
  if (launch && (!Array.isArray(launch.configurations) || launch.configurations.length > 30)) throw new BridgeError('launch.json must contain a configurations list (at most 30 servers)');
  const candidates = (launch?.configurations ?? []).map(value => {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100
      || typeof value.runtimeExecutable !== 'string' || !value.runtimeExecutable || value.runtimeExecutable.includes('\0')
      || !Array.isArray(value.runtimeArgs) || value.runtimeArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new BridgeError('Invalid server configuration in launch.json: provide name, runtimeExecutable, runtimeArgs and port');
    return { name: value.name, command: [value.runtimeExecutable, ...value.runtimeArgs].map(quote).join(' '), port: value.port, source: 'launch' };
  });
  const pkg = await readJson(path.join(cwd, 'package.json'));
  const files = await fs.readdir(cwd);
  const runner = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.some(name => name === 'bun.lock' || name === 'bun.lockb') ? 'bun' : files.includes('yarn.lock') ? 'yarn' : 'npm';
  for (const name of ['dev', 'start', 'serve']) if (typeof pkg?.scripts?.[name] === 'string' && pkg.scripts[name].trim() && !candidates.some(c => c.name === name)) candidates.push({ name, command: `${runner} run ${name}`, source: 'package', runner });
  if (new Set(candidates.map(c => c.name)).size !== candidates.length) throw new BridgeError('Duplicate server names in launch.json');
  return candidates;
}
async function freePort(port = 0) {
  const socket = net.createServer();
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); });
    return socket.address().port;
  } catch { throw new BridgeError(`Port ${port} is already in use. Stop that server, then try again.`); }
  finally { if (socket.listening) await new Promise(resolve => socket.close(resolve)); }
}
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
async function killGroup(row) {
  if (row.stopping) return row.stopping;
  const pid = row.groupPid;
  if (!pid) return;
  // Retire ownership once. A later Stop must never signal a reused process-group ID.
  row.groupPid = null;
  row.stopping = (async () => {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 6 && groupAlive(pid); i++) await delay(50);
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  })();
  return row.stopping;
}
const publicRow = ({ name, command, status, url, pid, logs, error }) => ({ name, command, status, url, pid, logs, error });

/** Owns only process groups started by this bridge; a URL or a port never grants permission to kill a process. */
export function createDevServers() {
  const projects = new Map(), pending = new Map(); let closed = false;
  const folder = async cwd => fs.realpath(await projectDirectory(cwd));
  const state = cwd => ({ servers: [...(projects.get(cwd)?.values() ?? [])].map(publicRow) });
  async function start(cwd, name) {
    cwd = await folder(cwd);
    if (closed) throw new BridgeError('Preview service is closed');
    if (typeof name !== 'string') throw new BridgeError('Provide a detected server name');
    // Starts in one folder share launch.json; serialize them so neither choice is lost.
    const key = cwd;
    if (pending.has(key)) { await pending.get(key).catch(() => {}); return start(cwd, name); }
    const task = (async () => {
      const candidate = (await candidatesIn(cwd)).find(c => c.name === name);
      if (!candidate) throw new BridgeError('Dev server command not found. Detect dev server again.');
      const rows = projects.get(cwd) ?? new Map(); projects.set(cwd, rows);
      const previous = rows.get(name);
      if (previous && ['starting', 'running'].includes(previous.status)) return state(cwd);
      const port = await freePort(candidate.port);
      if (candidate.source === 'package') {
        const file = path.join(cwd, '.elpis/launch.json'), launch = await readJson(file) ?? { version: '0.0.1', configurations: [] };
        launch.configurations.push({ name, runtimeExecutable: candidate.runner, runtimeArgs: ['run', name], port });
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(launch, null, 2)}\n`);
      }
      if (closed) throw new BridgeError('Preview service is closed');
      const row = { name, command: candidate.command, status: 'starting', url: `http://127.0.0.1:${port}/`, pid: null, logs: '', error: null };
      rows.set(name, row);
      const env = { ...childEnv(process.env), PORT: String(port) };
      for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key];
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', candidate.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      row.pid = child.pid; row.groupPid = child.pid;
      const append = chunk => {
        const text = chunk.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); row.logs = (row.logs + text).slice(-65536);
        const match = row.logs.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+(?:\/[^\s]*)?/);
        if (match) row.url = match[0].replace('0.0.0.0', '127.0.0.1');
      };
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.once('error', error => { row.status = 'failed'; row.error = `Dev server failed to start: ${error.message}`; });
      child.once('exit', (code, signal) => {
        if (row.status !== 'stopped') { row.status = 'failed'; row.error = `Dev server exited (${signal ?? code}).`; }
        // A shell can exit before its descendants. Its original group is still ours.
        void killGroup(row).catch(() => {});
      });
      const deadline = Date.now() + 30000;
      while (row.status === 'starting' && Date.now() < deadline) {
        try {
          const response = await fetch(row.url, { signal: AbortSignal.timeout(500), redirect: 'manual' });
          await response.body?.cancel();
          if (row.status === 'starting') row.status = 'running';
        } catch { await delay(100); }
      }
      if (row.status === 'starting') { row.status = 'failed'; row.error = 'Dev server did not respond within 30 seconds. View logs and try again.'; await killGroup(row); }
      if (row.status === 'failed') throw new BridgeError(row.error);
      return state(cwd);
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return {
    async detect(cwd) { return { candidates: await candidatesIn(await folder(cwd)) }; },
    async status(cwd) { return state(await folder(cwd)); },
    start,
    async stop(cwd, name) {
      cwd = await folder(cwd); const row = projects.get(cwd)?.get(name);
      if (!row) throw new BridgeError('This server was not started by this preview');
      row.status = 'stopped'; await killGroup(row); return state(cwd);
    },
    async close() { closed = true; await Promise.all([...projects.values()].flatMap(rows => [...rows.values()].map(async row => { row.status = 'stopped'; await killGroup(row); }))); },
  };
}

/** Same-origin authenticated routes are dispatched by server.mjs before reaching this handler. */
export async function devServerRequest(manager, method, url, body) {
  if (method === 'GET' && url.pathname === '/api/dev-servers') {
    if ([...url.searchParams.keys()].some(key => key !== 'cwd') || url.searchParams.getAll('cwd').length !== 1) throw new BridgeError('Provide exactly one cwd');
    return manager.status(url.searchParams.get('cwd'));
  }
  const action = url.pathname.slice('/api/dev-servers/'.length);
  if (method !== 'POST' || !['detect', 'start', 'stop'].includes(action)) throw new BridgeError('Unknown preview operation', 404);
  const input = object(body, action === 'detect' ? ['cwd'] : ['cwd', 'name']);
  return manager[action](input.cwd, input.name);
}
