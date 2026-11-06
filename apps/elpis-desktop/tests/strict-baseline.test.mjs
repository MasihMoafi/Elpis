// The strict-check ratchet (scripts/strict-baseline.mjs): a count may only go down, a new file must be clean, and the
// linter really reports a dropped promise (so the lint gate cannot pass by checking nothing).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
