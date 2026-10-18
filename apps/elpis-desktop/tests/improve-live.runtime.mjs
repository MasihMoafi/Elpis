// One subscription acceptance check. Uses the actual source and gpt-6-luna in an isolated runtime and worktree.
// node tests/improve-live.runtime.mjs /absolute/installed/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from '../bridge/client.mjs';
import { createImprovements } from '../bridge/improve.mjs';
const exec = promisify(execFile), engine = await fs.realpath(process.argv[2]);
const appRoot = fileURLToPath(new URL('..', import.meta.url)), sourceRoot = path.resolve(appRoot, '../..');
const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
const root = await fs.mkdtemp(path.join(cache, 'improve-live-')), home = path.join(root, 'home');
await fs.mkdir(home, { mode: 0o700 });
await fs.copyFile(path.join(process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), 'auth.json'), path.join(home, 'auth.json'));
await fs.chmod(path.join(home, 'auth.json'), 0o600);
const socketPath = path.join(root, 'bridge.sock'), log = await fs.open(path.join(root, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [path.join(path.dirname(engine), 'tools/elpis-claude/acp-bridge.mjs')], { stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELPIS_HOME: home, ELPIS_ENGINE_BIN: engine, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ACP_BRIDGE_STORE: path.join(home, 'sessions.json'), NODE_USE_ENV_PROXY: '1' } });
const ended = once(bridge, 'exit');
let client, manager, row;
const evidence = process.env.ELPIS_IMPROVE_EVIDENCE || '/tmp/elpis-improve-live.json';
const say = value => process.stdout.write(`${new Date().toISOString()} ${value}\n`);
try {
  for (let i = 0; ; i++) {
    if (bridge.exitCode !== null) throw Error(`Private bridge exited; see ${path.join(root, 'bridge.log')}`);
    if (await fs.stat(socketPath).then(() => true, () => false)) break;
    if (i > 200) throw Error('Private bridge did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  client = await DesktopClient.connect({ socketPath, rewindHome: path.join(root, 'rewind'), githubConnector: { instructions: async () => '' } });
  manager = await createImprovements({ client, sourceRoot, stateDir: path.join(root, 'changes') });
  const file = 'apps/elpis-desktop/components/new-agent-form.tsx';
  const before = await fs.readFile(path.join(sourceRoot, file), 'utf8');
  const map = JSON.parse(await fs.readFile(path.join(appRoot, 'out/elpis-source-map.json'), 'utf8'));
  const id = Object.keys(map).find(id => map[id].file === file); assert.ok(id);
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
  row = await manager.start({ request: `Live acceptance check: change only the New agent form's button label "Choose folder" to "Browse folder" in ${file}. Add tests/improve-label-live.test.cjs using tests/parity-fixture.cjs: click Agents, click New agent, assert a button named Browse folder exists. First run the test against the old build and record its failure. Make the label edit, use flock /tmp/elpis-desktop-build.lock npm run -s build, then run that one UI test and typecheck. Set ELPIS_PLAYWRIGHT_PACKAGE=/home/masih/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright and ELPIS_CHROMIUM=/usr/bin/google-chrome for Playwright. Run UI tests with flock /tmp/elpis-desktop-ui.lock and write output to /tmp. Commit only these two files. No installs, packaging, source-tree edits outside this worktree, or full UI suite. The tiny image is a transport fixture; use the source file for this label change.`, target: { id, label: 'Choose folder', image } });
  say(`Luna chat ${row.thread.id}; branch ${row.branch}`);
  const deadline = Date.now() + 20 * 60000;
  let last;
  while (Date.now() < deadline) {
    const status = await manager.get(row.id);
    if (status.status !== last) { say(status.status + (status.error ? `: ${status.error}` : '')); last = status.status; }
    if (['review', 'checks-failed', 'needs-check', 'send-error'].includes(status.status)) { row = status; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  row = await manager.get(row.id);
  assert.equal(row.status, 'review', JSON.stringify({ status: row.status, error: row.error, checks: row.checks }));
  assert.ok(row.checks.passed); assert.ok(row.diff.includes('+') && row.diff.includes('Browse folder'));
  assert.equal(await fs.readFile(path.join(sourceRoot, file), 'utf8'), before, 'the source checkout is untouched');
  await fs.writeFile(evidence, JSON.stringify({ branch: row.branch, commit: row.head, cwd: row.cwd, threadId: row.thread.id, checks: row.checks, diff: row.diff }, null, 2));
  say(`PASS: source unchanged, committed label diff, measured build and tests; ${evidence}`);
} finally {
  manager?.close(); client?.close(); bridge.kill('SIGTERM'); await ended; await log.close();
  // Keep the committed worktree for inspection; discard copied authentication and private runtime state.
  await exec('gio', ['trash', home]);
  if (row) say(`Worktree evidence: ${row.cwd}`);
}
