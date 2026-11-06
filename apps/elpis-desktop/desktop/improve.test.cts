const test = require('node:test');
const assert = require('node:assert/strict');
const { regionRect }: typeof import('./improve.cts') = require('./improve.cts');
test('region capture bounds reject invalid or invisible areas', () => {
  assert.deepEqual(regionRect({ x: 95, y: 5, width: 20, height: 20 }, { width: 100, height: 80 }), { x: 95, y: 5, width: 5, height: 20 });
  for (const rect of [null, { x: NaN } as { x: number; y: number; width: number; height: number }, { x: 101, y: 0, width: 2, height: 2 }]) assert.throws(() => regionRect(rect, { width: 100, height: 80 }));
});
