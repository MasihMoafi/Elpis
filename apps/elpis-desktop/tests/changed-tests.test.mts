// The push hook's test runner runs only changed small unit tests (the fast tier) and never builds (Masih: "Please don't
// do builds locally"); bridge, desktop and browser tests are left to GitHub and the push goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTestTempDir, removeTestTempDir } from './temp-root.cts';

async function app(t: test.TestContext, { changed = ['unit', 'bridge', 'ui'] } = {}) {
  const cache = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const repo = createTestTempDir(path.join(cache, 'changed-tests-'));
  t.after(() => removeTestTempDir(repo));
  const root = path.join(repo, 'apps/elpis-desktop'), bin = path.join(repo, 'bin'), marks = path.join(repo, 'marks');
  for (const dir of ['scripts', 'tests']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.mkdir(bin); await fs.mkdir(marks);
  await fs.copyFile(new URL('../scripts/changed-tests.mts', import.meta.url), path.join(root, 'scripts/changed-tests.mts'));
  const inventory = { fast: ['tests/unit.test.mjs'], bridge: ['tests/bridge.test.mjs'], ui: ['tests/ui.test.mjs'], 'opt-in': [] };
  await fs.writeFile(path.join(root, 'test-inventory.json'), JSON.stringify(inventory));
  await fs.writeFile(path.join(repo, '.gitignore'), 'apps/elpis-desktop/out/\nbin/\nmarks/\n');
  // Any build tool the runner could start leaves a mark.
  for (const tool of ['npm', 'npx', 'next']) await fs.writeFile(path.join(bin, tool), `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, 'build'))}\n`, { mode: 0o755 });
  const quiet = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  const git = (...args: string[]) => execFileSync('git', [...quiet, ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const name of changed) await fs.writeFile(path.join(root, `tests/${name}.test.mjs`),
    `import test from 'node:test'; import fs from 'node:fs'; test('${name}', () => fs.writeFileSync(${JSON.stringify(path.join(marks, name))}, ''));\n`);
  git('add', '.'); git('commit', '-qm', 'tests');
  const head = git('rev-parse', 'HEAD');
  const run = (extra: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['scripts/changed-tests.mts', base], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  };
  const ran = async () => (await fs.readdir(marks)).sort();
  return { repo, root, head, run, ran };
}

test('changed unit tests run; bridge and browser tests are left to GitHub; nothing is built', async t => {
  const { run, ran } = await app(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub runs the other 2 changed test file\(s\)/);
  assert.deepEqual(await ran(), ['unit']);
});

test('even with a build of HEAD in out/, browser tests do not run here', async t => {
  const { root, head, run, ran } = await app(t);
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'out/.commit'), `${head}\n`);
  assert.equal(run().status, 0);
  assert.deepEqual(await ran(), ['unit']);
});

test('only browser tests changed: the push goes through with nothing run', async t => {
  const { run, ran } = await app(t, { changed: ['ui'] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub runs the other 1 changed test file/);
  assert.deepEqual(await ran(), []);
});

// Git runs hooks with GIT_DIR set; the runner then found no changed test at all and every push skipped them.
test('inside a push hook, with GIT_DIR set, the changed unit test is still found and run', async t => {
  const { repo, run, ran } = await app(t);
  const result = run({ GIT_DIR: path.join(repo, '.git') });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /no changed desktop test files/);
  assert.deepEqual(await ran(), ['unit']);
});
