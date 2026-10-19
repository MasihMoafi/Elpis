import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkInventory, discoverTests } from '../scripts/test-gate.mjs';

const inventory = JSON.parse(await fs.readFile(new URL('../test-inventory.json', import.meta.url), 'utf8'));
test('every desktop app test belongs to exactly one tier', async () => {
  checkInventory(inventory, await discoverTests());
});
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
