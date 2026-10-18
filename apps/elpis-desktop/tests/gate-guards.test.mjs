import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { heldByAncestor, missingPlaywright, passRecord, requirePass } from '../scripts/gate-guards.mjs';

const tiers = ['fast', 'bridge', 'desktop', 'ui'];
const passed = name => ({ name, code: 0 });

test('a UI run under a parent that already holds the UI lock is refused (it would wait on itself for ever)', () => {
  const locks = [{ pid: 10, path: '/tmp/elpis-desktop-ui.lock' }, { pid: 50, path: '/tmp/other.lock' }];
  const parentOf = pid => ({ 30: 20, 20: 10, 10: 1, 40: 1, 60: 50, 50: 1 })[pid] ?? 0;
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 30, locks, parentOf), 10);
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 40, locks, parentOf), null, 'another worker holding it is just waited for');
  assert.equal(heldByAncestor('/tmp/elpis-desktop-ui.lock', 60, locks, parentOf), null, 'only that lock counts');
});

test('a UI run without Playwright stops at once with the fix, instead of failing every file', () => {
  const absent = () => { throw new Error('Cannot find module'); };
  assert.match(missingPlaywright({}, absent), /ELPIS_PLAYWRIGHT_PACKAGE/);
  assert.equal(missingPlaywright({ ELPIS_PLAYWRIGHT_PACKAGE: '/opt/playwright' }, absent), null);
  assert.equal(missingPlaywright({}, () => '/repo/node_modules/playwright/index.js'), null);
});

test('only a full, clean, all-green gate run is recorded as a pass for its commit', () => {
  const files = [passed('fast'), passed('bridge'), passed('desktop'), passed('renderer-build'), passed('tests/a.test.cjs')];
  const record = passRecord({ commit: 'abc123', clean: true, selected: tiers, tiers, files });
  assert.equal(record.commit, 'abc123');
  assert.equal(record.files, 5);
  assert.equal(passRecord({ commit: 'abc123', clean: true, selected: ['fast', 'bridge'], tiers, files }), null, 'a partial run');
  assert.equal(passRecord({ commit: 'abc123', clean: false, selected: tiers, tiers, files }), null, 'uncommitted changes');
  assert.equal(passRecord({ commit: 'abc123', clean: true, selected: tiers, tiers, files: [...files, { name: 'tests/b.test.cjs', code: 1 }] }), null, 'a failure');
});

test('installing needs a recorded pass for the exact commit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-records-'));
  await assert.rejects(requirePass(dir, 'abc123'), /full test gate has not passed on abc123/);
  await fs.writeFile(path.join(dir, 'abc123.json'), JSON.stringify({ commit: 'abc123', files: 5 }));
  assert.equal((await requirePass(dir, 'abc123')).files, 5);
  await assert.rejects(requirePass(dir, 'def456'), /def456/, 'a pass on another commit does not count');
});
