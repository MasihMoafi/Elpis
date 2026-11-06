// The strict-check ratchet (scripts/strict-baseline.mjs): a count may only go down, a new file must be clean, and the
// linter really reports a dropped promise (so the lint gate cannot pass by checking nothing).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { compare, lintCounts } from '../scripts/strict-baseline.mjs';

test('a count above the baseline, or any finding in an unlisted file, fails', () => {
  const baseline = { 'bridge/a.mjs:TS7006': 3 };
  assert.deepEqual(compare(baseline, { 'bridge/a.mjs:TS7006': 4 }).worse, ['bridge/a.mjs:TS7006: 3 -> 4']);
  assert.deepEqual(compare(baseline, { 'bridge/a.mjs:TS7006': 3, 'bridge/new.mjs:TS7006': 1 }).worse, ['bridge/new.mjs:TS7006: 0 -> 1']);
});

test('equal counts pass and lower counts are reported for locking in', () => {
  const baseline = { 'bridge/a.mjs:TS7006': 3, 'bridge/b.mjs:TS2339': 1 };
  assert.deepEqual(compare(baseline, { ...baseline }), { worse: [], better: [] });
  assert.deepEqual(compare(baseline, { 'bridge/a.mjs:TS7006': 3 }), { worse: [], better: ['bridge/b.mjs:TS2339: 1 -> 0'] });
});

test('a staged-files check judges only the files it linted', () => {
  const baseline = { 'bridge/a.mjs:no-unused-vars': 1, 'bridge/b.mjs:no-unused-vars': 2 };
  assert.deepEqual(compare(baseline, { 'bridge/a.mjs:no-unused-vars': 1 }, ['bridge/a.mjs']), { worse: [], better: [] });
  assert.deepEqual(compare(baseline, { 'bridge/a.mjs:no-unused-vars': 2 }, ['bridge/a.mjs']).worse, ['bridge/a.mjs:no-unused-vars: 1 -> 2']);
});

test('the linter reports a dropped promise and passes an awaited one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-lint-probe-'));
  try {
    const dropped = path.join(dir, 'dropped.mjs');
    const awaited = path.join(dir, 'awaited.mjs');
    fs.writeFileSync(dropped, 'async function save() { await Promise.resolve() }\nsave()\nexport {}\n');
    fs.writeFileSync(awaited, 'async function save() { await Promise.resolve() }\nawait save()\nexport {}\n');
    assert.equal(lintCounts([dropped])[`${dropped}:typescript(no-floating-promises)`], 1);
    assert.deepEqual(lintCounts([awaited]), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('type counts ignore dependencies outside the desktop while still detecting errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-types-probe-'));
  try {
    const app = path.join(root, 'apps', 'elpis-desktop');
    const external = path.join(root, 'tools', 'example');
    for (const dir of ['scripts', 'bridge']) fs.mkdirSync(path.join(app, dir), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(path.resolve('node_modules'), path.join(app, 'node_modules'), 'dir');
    fs.copyFileSync(path.resolve('scripts/strict-baseline.mjs'), path.join(app, 'scripts/strict-baseline.mjs'));
    fs.writeFileSync(path.join(app, 'bridge/build-resources.mjs'), '');
    fs.writeFileSync(path.join(app, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, noEmit: true, noUncheckedSideEffectImports: true, skipLibCheck: true, types: [] }, include: ['bridge/*.mjs'] }));
    fs.writeFileSync(path.join(app, 'bridge/check.mjs'), "import '../../../tools/example/check.mjs';\n");
    fs.writeFileSync(path.join(external, 'check.mjs'), "import 'outside-package';\n/** @type {number} */ const value = 'bad';\n");
    fs.writeFileSync(path.join(app, 'strict-baseline.json'), JSON.stringify({ types: { '../../tools/example/check.mjs:TS2307': 1, '../../tools/example/check.mjs:TS2322': 1 } }));
    const run = () => spawnSync(process.execPath, ['scripts/strict-baseline.mjs', 'types'], { cwd: app, encoding: 'utf8' });
    const before = run();
    assert.equal(before.status, 0, before.stderr);
    fs.mkdirSync(path.join(external, 'node_modules/outside-package'), { recursive: true });
    fs.writeFileSync(path.join(external, 'node_modules/outside-package/index.d.ts'), 'export {};\n');
    const after = run();
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
    fs.writeFileSync(path.join(external, 'check.mjs'), "import 'outside-package';\n/** @type {number} */ const value = 'bad';\n/** @type {number} */ const other = 'bad';\n");
    const worse = run();
    assert.equal(worse.status, 1);
    assert.match(worse.stderr, /TS2322: 1 -> 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
