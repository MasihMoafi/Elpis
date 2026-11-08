import { createTestTempDir, removeTestTempDir } from './temp-root.cts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { heldByAncestor, missingPlaywright, passRecord, requirePass } from '../scripts/gate-guards.mts';
import { discoverTests } from '../scripts/test-gate.mts';

const tiers = ['fast', 'bridge', 'desktop', 'ui'];
const passed = (name: string) => ({ name, code: 0 });

test('test discovery counts registrations and excludes hook-only helpers', async t => {
  const dir = createTestTempDir(path.join(os.tmpdir(), 'test-discovery-'));
  t.after(() => removeTestTempDir(dir));
  const fixtures = {
    'support.mts': "import { afterEach } from 'node:test'; afterEach(() => {}); export const helper = 1;",
    'helper.test.mts': "import { beforeEach } from 'node:test'; beforeEach(() => {});",
    'behavior.mts': "import { test as scenario } from 'node:test'; scenario('real case', () => {});",
    'common.cts': "const { it: scenario } = require('node:test'); scenario('real case', () => {});",
    'default.cts': "const scenario = require('node:test'); scenario('real case', () => {});",
    'comment.mts': "// import { test } from 'node:test'; test('not registered', () => {});",
    'hook-namespace.mts': "import test from 'node:test'; test.before(() => {});",
    'namespace.mts': "import * as runner from 'node:test'; runner.test.skip('registered', () => {});",
    'program.test.mts': "// This executable assertion program does not use 'node:test'.\nimport assert from 'node:assert/strict'; assert.equal(1, 1);",
  };
  await Promise.all(Object.entries(fixtures).map(([name, source]) => fs.writeFile(path.join(dir, name), source)));
  assert.deepEqual(await discoverTests(dir), ['behavior.mts', 'common.cts', 'default.cts', 'namespace.mts', 'program.test.mts']);
});

test('a UI run under a parent that already holds the UI lock is refused (it would wait on itself for ever)', () => {
  const locks = [{ pid: 10, path: '/tmp/elpis-desktop-ui.lock' }, { pid: 50, path: '/tmp/other.lock' }];
  const parents: Record<number, number> = { 30: 20, 20: 10, 10: 1, 40: 1, 60: 50, 50: 1 };
  const parentOf = (pid: number) => parents[pid] ?? 0;
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 30, locks, parentOf), 10);
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 40, locks, parentOf), null, 'another worker holding it is just waited for');
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 60, locks, parentOf), null, 'only that lock counts');
});

test('a UI run without Playwright stops at once with the fix, instead of failing every file', () => {
  const absent = () => { throw new Error('Cannot find module'); };
  const message = missingPlaywright({}, absent);
  assert.ok(message !== null);
  assert.match(message, /ELPIS_PLAYWRIGHT_PACKAGE/);
  assert.equal(missingPlaywright({ ELPIS_PLAYWRIGHT_PACKAGE: '/opt/playwright' }, absent), null);
  assert.equal(missingPlaywright({}, () => '/repo/node_modules/playwright/index.js'), null);
});

test('only a full, clean, all-green gate run is recorded as a pass for its commit', () => {
  const files = [passed('fast'), passed('bridge'), passed('desktop'), passed('renderer-build'), passed('tests/a.test.cjs')];
  const record = passRecord({ start: { commit: 'abc123', clean: true }, commit: 'abc123', clean: true, selected: tiers, tiers, files });
  assert.ok(record !== null);
  assert.equal(record.commit, 'abc123');
  assert.equal(record.files, 5);
  assert.equal(passRecord({ start: { commit: 'abc123', clean: true }, commit: 'abc123', clean: true, selected: ['fast', 'bridge'], tiers, files }), null, 'a partial run');
  assert.equal(passRecord({ start: { commit: 'abc123', clean: true }, commit: 'abc123', clean: false, selected: tiers, tiers, files }), null, 'uncommitted changes');
  assert.equal(passRecord({ start: { commit: 'abc123', clean: true }, commit: 'abc123', clean: true, selected: tiers, tiers, files: [...files, { name: 'tests/b.test.cjs', code: 1 }] }), null, 'a failure');
});

test('installing needs a recorded pass for the exact commit', async t => {
  const dir = createTestTempDir(path.join(os.tmpdir(), 'gate-records-'));
  t.after(() => removeTestTempDir(dir));
  await assert.rejects(requirePass(dir, 'abc123'), /full test gate has not passed on abc123/);
  await fs.writeFile(path.join(dir, 'abc123.json'), JSON.stringify({ commit: 'abc123', files: 5 }));
  assert.equal((await requirePass(dir, 'abc123')).files, 5);
  await assert.rejects(requirePass(dir, 'def456'), /def456/, 'a pass on another commit does not count');
});

test('the gate records only the clean commit present before its tests run', async () => {
  const fixtures = os.tmpdir();
  await fs.mkdir(fixtures, { recursive: true });
  for (const scenario of ['clean', 'commit', 'dirty-start', 'dirty-end', 'resource-failure', 'renderer-failure', 'fast-only', 'desktop-only']) {
    const dir = createTestTempDir(path.join(fixtures, 'gate-state-'));
    const root = path.join(dir, 'repo'), home = path.join(dir, 'home');
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      for (const sub of ['scripts', 'tests', 'bridge', 'desktop', 'ui', 'bin']) await fs.mkdir(path.join(root, sub), { recursive: true });
      await fs.mkdir(home);
      // This fixture builds no app; its lifecycle checks must not wait on workstation build locks.
      await fs.writeFile(path.join(root, 'bin/flock'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
      await fs.symlink(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'));
      const scripts = new URL('../scripts/', import.meta.url);
      for (const file of ['test-gate.mts', 'gate-guards.mts']) await fs.copyFile(new URL(file, scripts), path.join(root, 'scripts', file));
      await fs.writeFile(path.join(root, 'test-inventory.json'), JSON.stringify({ fast: ['tests/state.test.mjs'], bridge: ['bridge/idle.test.mjs'], desktop: ['desktop/idle.test.mjs'], ui: ['ui/idle.test.mjs'], 'opt-in': [] }));
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node renderer.mjs' } }));
      await fs.writeFile(path.join(root, '.gitignore'), 'bridge/resources/\nout/\n');
      await fs.writeFile(path.join(root, 'renderer.mjs'), "import fs from 'node:fs'; if(process.env.GATE_SCENARIO === 'renderer-failure') process.exit(2); fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/index.html', 'built renderer');");
      await fs.writeFile(path.join(root, 'bridge/build-resources.mts'), "import fs from 'node:fs'; if(process.env.GATE_SCENARIO === 'resource-failure') process.exit(2); fs.mkdirSync('bridge/resources', {recursive:true}); fs.writeFileSync('bridge/resources/rag.md', 'built resource');");
      for (const sub of ['bridge', 'desktop', 'ui']) await fs.writeFile(path.join(root, sub, 'idle.test.mjs'), "import { test } from 'node:test'; test('idle', () => {});\n");
      await fs.appendFile(path.join(root, 'ui/idle.test.mjs'), "import assert from 'node:assert/strict'; import fs from 'node:fs'; test('renderer exists before UI tests', () => assert.equal(fs.readFileSync('out/index.html','utf8'), 'built renderer'));\n");
      await fs.writeFile(path.join(root, 'probe'), 'original');
      await fs.writeFile(path.join(root, 'tests/state.test.mjs'), `import { test } from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
test('mutate during the real gate', () => {
  if (fs.readFileSync('bridge/resources/rag.md', 'utf8') !== 'built resource') throw Error('resource missing before fast tier');
  const scenario = process.env.GATE_SCENARIO;
  if (scenario === 'commit') execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'during gate']);
  if (scenario === 'dirty-start') fs.writeFileSync('probe', 'original');
  if (scenario === 'dirty-end') fs.writeFileSync('probe', 'changed');
});
`);
      git(['init', '-q']); git(['config', 'user.name', 'Gate test']); git(['config', 'user.email', 'gate@example.invalid']);
      git(['add', 'scripts/test-gate.mts', 'scripts/gate-guards.mts', 'test-inventory.json', 'package.json', '.gitignore', 'renderer.mjs', 'bridge/build-resources.mts', 'bridge/idle.test.mjs', 'desktop/idle.test.mjs', 'ui/idle.test.mjs', 'bin/flock', 'probe', 'tests/state.test.mjs']);
      git(['commit', '-qm', 'fixture']);
      if (scenario === 'dirty-start') await fs.writeFile(path.join(root, 'probe'), 'changed');
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, GATE_SCENARIO: scenario, ELPIS_PLAYWRIGHT_PACKAGE: '/fixture/not-used' };
      delete env.NODE_TEST_CONTEXT; // The nested gate must execute its tests rather than skip recursive runners.
      const args = ['scripts/test-gate.mts', ...(scenario === 'fast-only' ? ['fast'] : scenario === 'desktop-only' ? ['desktop'] : [])];
      let output;
      try { output = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) {
        if (!scenario.endsWith('-failure')) throw error;
        assert.ok(error instanceof Error && 'status' in error && 'stdout' in error && typeof error.stdout === 'string');
        assert.equal(error.status, 1); output = error.stdout;
      }
      if (scenario === 'resource-failure') { assert.match(output, /FAIL bridge-resources/); assert.doesNotMatch(output, /RUN tests\/state\.test\.mjs|renderer-build/); }
      if (scenario === 'renderer-failure') { assert.match(output, /PASS desktop\/idle\.test\.mjs[\s\S]*FAIL renderer-build/); assert.doesNotMatch(output, /ui\/idle\.test\.mjs/); }
      if (scenario === 'fast-only') { assert.match(output, /PASS bridge-resources[\s\S]*PASS tests\/state\.test\.mjs/); assert.doesNotMatch(output, /renderer-build/); }
      if (scenario === 'desktop-only') { assert.match(output, /PASS desktop\/idle\.test\.mjs/); assert.doesNotMatch(output, /renderer-build/); }
      const commit = git(['rev-parse', 'HEAD']);
      const record = path.join(home, '.local/state/elpis-gate', `${commit}.json`);
      if (scenario === 'clean') {
        assert.match(output, /Recorded a full pass/);
        assert.equal(JSON.parse(await fs.readFile(record, 'utf8')).commit, commit);
      } else {
        assert.doesNotMatch(output, /Recorded a full pass/, scenario);
        await assert.rejects(fs.access(record), { code: 'ENOENT' }, scenario);
      }
    } finally { removeTestTempDir(dir); }
  }
});
