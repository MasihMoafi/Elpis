// The push hook's test runner never builds (Masih: "Please don't do builds locally"). Changed browser tests run only
// against a build of exactly HEAD already in out/; otherwise GitHub runs them and the push goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTestTempDir, removeTestTempDir } from './temp-root.cts';

async function app(t: test.TestContext, { changed = ['unit', 'ui'] } = {}) {
  const cache = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const repo = createTestTempDir(path.join(cache, 'changed-tests-'));
  t.after(() => removeTestTempDir(repo));
  const root = path.join(repo, 'apps/elpis-desktop'), bin = path.join(repo, 'bin'), marks = path.join(repo, 'marks');
  for (const dir of ['scripts', 'tests']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.mkdir(bin); await fs.mkdir(marks);
  await fs.copyFile(new URL('../scripts/changed-tests.mts', import.meta.url), path.join(root, 'scripts/changed-tests.mts'));
  await fs.writeFile(path.join(root, 'test-inventory.json'), JSON.stringify({ fast: ['tests/unit.test.mjs'], ui: ['tests/ui.test.mjs'], 'opt-in': [] }));
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
  const run = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['scripts/changed-tests.mts', base], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  };
  const ran = async () => (await fs.readdir(marks)).sort();
  return { root, head, run, ran };
}

test('without a build of HEAD, changed unit tests run, browser tests are left to GitHub, and nothing is built', async t => {
  const { run, ran } = await app(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub runs the 1 changed browser test\(s\); there is no build of \w{9} here\./);
  assert.deepEqual(await ran(), ['unit']);
});

test('a build of another commit in out/ is not used and not rebuilt', async t => {
  const { root, run, ran } = await app(t);
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'out/.commit'), `${'a'.repeat(40)}\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await ran(), ['unit']);
});

test('with a build of exactly HEAD in out/, the changed browser tests run here', async t => {
  const { root, head, run, ran } = await app(t);
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'out/.commit'), `${head}\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /GitHub runs/);
  assert.deepEqual(await ran(), ['ui', 'unit']);
});

test('only browser tests changed and no build: the push goes through with nothing run', async t => {
  const { run, ran } = await app(t, { changed: ['ui'] });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub runs the 1 changed browser test/);
  assert.deepEqual(await ran(), []);
});
