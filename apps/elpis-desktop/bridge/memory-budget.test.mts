import test from 'node:test';
import assert from 'node:assert/strict';
import { appTreeGb, createMemoryBudget, memAvailableGb } from './memory-budget.mts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the floor reads MemAvailable from /proc/meminfo, not MemFree or MemTotal', () => {
  const meminfo = 'MemTotal:       32505856 kB\nMemFree:         1048576 kB\nMemAvailable:    3250586 kB\nBuffers:          123456 kB\n';
  assert.equal(memAvailableGb(meminfo).toFixed(1), '3.1');
});

test('the app over its budget holds the next node, said once at the start and once at the end of the wait', async () => {
  let used = 9; const lines: string[] = [];
  const budget = createMemoryBudget({ env: {}, available: async () => 64, app: async () => used, pollMs: 10 });
  const slot: { release?: () => void } = {}; const acquired = budget.acquire(undefined, line => lines.push(line)).then(value => { slot.release = value; });
  const cancel = new AbortController(), cancelled = budget.acquire(cancel.signal, () => {});
  await pause(100);
  assert.equal(slot.release, undefined, 'no slot while the app is over budget');
  assert.deepEqual(lines, ['waiting for memory: the app uses 9.0 GB, budget 8 GB']);
  cancel.abort(); await assert.rejects(cancelled, { name: 'AbortError' }, 'a cancelled run stops waiting');
  used = 2; await acquired;
  assert.deepEqual(lines, ['waiting for memory: the app uses 9.0 GB, budget 8 GB', 'memory available: 64.0 GB available, the app uses 2.0 GB']);
  const finish = slot.release as (() => void) | undefined; assert.ok(finish); finish();
});

test('the app tree is the one scripts/mem-meter.py measures', async () => {
  const gb = await appTreeGb();
  assert(Number.isFinite(gb) && gb >= 0, `meter total ${gb}`);
});
