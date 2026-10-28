import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { checkInventory, discoverTests } from '../scripts/test-gate.mjs';

const inventory = JSON.parse(await fs.readFile(new URL('../test-inventory.json', import.meta.url), 'utf8'));
test('new unassigned tests, duplicate ownership and stale entries fail the gate', async () => {
  const files = await discoverTests();
  assert.throws(() => checkInventory(inventory, [...files, 'tests/new.test.mjs']), /Unassigned test: tests\/new.test.mjs/);
  assert.throws(() => checkInventory({ ...inventory, ui: [...inventory.ui, inventory.fast[0]] }, files), /Duplicate test:/);
  assert.throws(() => checkInventory({ ...inventory, fast: [...inventory.fast, 'tests/gone.test.mjs'] }, files), /Missing test file:/);
});
test('discovery includes new specs and legacy node:test files outside existing test directories', async t => {
  const cache = path.join(os.homedir(), '.cache', 'elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const directory = createTestTempDir(path.join(cache, 'inventory-'));
  t.after(() => removeTestTempDir(directory));
  await fs.mkdir(path.join(directory, 'feature'));
  await fs.mkdir(path.join(directory, 'node_modules'));
  await fs.writeFile(path.join(directory, 'feature', 'added.spec.ts'), '');
  await fs.writeFile(path.join(directory, 'feature', 'legacy.mjs'), "import test from 'node:test';");
  await fs.writeFile(path.join(directory, 'node_modules', 'excluded.test.cjs'), '');
  const files = await discoverTests(directory);
  assert.deepEqual(files, ['feature/added.spec.ts', 'feature/legacy.mjs']);
  assert.throws(() => checkInventory({ fast: [], bridge: [], desktop: [], ui: [], 'opt-in': [] }, files), /Unassigned test: feature\/added.spec.ts/);
});

// A fake app: gate scripts run against it with private locks and a short per-file limit, so no build or browser starts.
const passing = "import test from 'node:test'; test('ok', () => {});";
async function fakeApp(t, files, inventory, build = 'node -e 0') {
  const cache = path.join(os.homedir(), '.cache', 'elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const dir = createTestTempDir(path.join(cache, 'gate-'));
  t.after(() => removeTestTempDir(dir));
  await fs.mkdir(path.join(dir, 'tests'));
  await fs.mkdir(path.join(dir, 'bridge'));
  await fs.mkdir(path.join(dir, 'tmp'));
  await fs.writeFile(path.join(dir, 'bridge', 'build-resources.mjs'), '');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build } }));
  await fs.writeFile(path.join(dir, 'test-inventory.json'), JSON.stringify({ fast: [], bridge: [], desktop: [], ui: [], 'opt-in': [], ...inventory }));
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(dir, 'tests', name), source);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=gate', '-c', 'user.email=gate@test', 'commit', '-qm', 'fake app');
  const locks = { build: path.join(dir, 'build.lock'), ui: path.join(dir, 'ui.lock') };
  const gate = (args, seconds = 30) => new Promise((resolve, reject) => {
    const source = `import { main } from ${JSON.stringify(new URL('../scripts/test-gate.mjs', import.meta.url).href)}; await main(...JSON.parse(process.argv[1]));`;
    // Without NODE_TEST_CONTEXT the gate's own `node --test` children report as they do outside this runner.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify([args, { dir, locks, seconds }])],
      { env: { ...env, TMPDIR: path.join(dir, 'tmp'), ELPIS_PLAYWRIGHT_PACKAGE: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => resolve({ code, out }));
  });
  return { dir, locks, gate };
}

test('a failing fast file does not stop the desktop and UI tiers; a failing renderer build does', async t => {
  const files = { 'fast.test.mjs': "import test from 'node:test'; test('fails', () => { throw new Error('boom'); });", 'desktop.test.mjs': passing, 'ui.test.mjs': passing };
  const inventory = { fast: ['tests/fast.test.mjs'], desktop: ['tests/desktop.test.mjs'], ui: ['tests/ui.test.mjs'] };
  const { code, out } = await (await fakeApp(t, files, inventory)).gate(['fast', 'desktop', 'ui']);
  assert.equal(code, 1);
  assert.match(out, /^FAIL tests\/fast.test.mjs/m);
  assert.match(out, /^PASS tests\/desktop.test.mjs/m);
  assert.match(out, /^PASS tests\/ui.test.mjs/m);
  const broken = await (await fakeApp(t, files, inventory, 'node -e "process.exit(3)"')).gate(['desktop', 'ui']);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /^FAIL renderer-build/m);
  assert.doesNotMatch(broken.out, /^RUN tests\//m);
});

test('the per-file limit excludes the shared-lock wait, and a timed-out file leaves no process behind', async t => {
  const leftover = path.join(os.tmpdir(), `elpis-gate-leftover-${process.pid}`);
  const files = { 'quick.test.mjs': passing, 'hangs.test.mjs': `import test from 'node:test'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
test('hangs', async () => { const child = spawn('bash', ['-c', 'trap "" TERM; exec sleep 30'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(leftover)}, String(child.pid)); await new Promise(() => {}); });` };
  const { locks, gate } = await fakeApp(t, files, { ui: ['tests/quick.test.mjs', 'tests/hangs.test.mjs'] });
  // Another worker holds the UI lock for longer than the file limit.
  const holder = spawn('flock', [locks.ui, 'bash', '-c', 'echo held; sleep 3'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const { code, out } = await gate(['ui'], 2);
  const pid = Number(await fs.readFile(leftover, 'utf8').catch(() => 0));
  await fs.rm(leftover, { force: true });
  let alive = false;
  if (pid) try { process.kill(pid, 0); alive = true; process.kill(pid, 'SIGKILL'); } catch {}
  assert.equal(code, 1);
  assert.match(out, /^PASS tests\/quick.test.mjs/m);
  assert.match(out, /^TIMEOUT tests\/hangs.test.mjs/m);
  assert.ok(pid, 'the hanging file started');
  assert.equal(alive, false, 'the timed-out file left a process running');
});
