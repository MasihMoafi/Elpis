import test from 'node:test';
import assert from 'node:assert/strict';
import { appTreeGb, createMemoryBudget, memAvailableGb } from './memory-budget.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the floor reads MemAvailable from /proc/meminfo, not MemFree or MemTotal', () => {
  const meminfo = 'MemTotal:       32505856 kB\nMemFree:         1048576 kB\nMemAvailable:    3250586 kB\nBuffers:          123456 kB\n';
  assert.equal(memAvailableGb(meminfo).toFixed(1), '3.1');
});

test('the app over its budget holds the next node, said once at the start and once at the end of the wait', async () => {
  let used = 7; const lines = [];
  const budget = createMemoryBudget({ env: { ELPIS_APP_MEMORY_BUDGET_GB: '6' }, available: async () => 64, app: async () => used, pollMs: 10 });
  let release; const acquired = budget.acquire(undefined, line => lines.push(line)).then(value => { release = value; });
  const cancel = new AbortController(), cancelled = budget.acquire(cancel.signal, () => {});
  await pause(100);
  assert.equal(release, undefined, 'no slot while the app is over budget');
  assert.deepEqual(lines, ['waiting for memory: the app uses 7.0 GB, budget 6 GB']);
  cancel.abort(); await assert.rejects(cancelled, { name: 'AbortError' }, 'a cancelled run stops waiting');
  used = 2; await acquired;
  assert.deepEqual(lines, ['waiting for memory: the app uses 7.0 GB, budget 6 GB', 'memory available: 64.0 GB available, the app uses 2.0 GB']);
  release();
});

test('the app tree is the one scripts/mem-meter.py measures', async () => {
  const gb = await appTreeGb();
  assert(Number.isFinite(gb) && gb >= 0, `meter total ${gb}`);
});
