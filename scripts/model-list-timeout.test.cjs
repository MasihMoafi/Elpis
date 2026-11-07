// Exercise the bridge's subscription catalogue merge without starting the engine.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addSubscriptionModels } = require('../tools/elpis-claude/bridge-model-list.mts');

function fixture(t, catalogFor) {
  const timers = new Set(), data = [{ id: 'native', model: 'native' }];
  const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms, ...args) => { const timer = { fn: () => fn(...args), ms }; timers.add(timer); return timer; };
  global.clearTimeout = timer => timers.delete(timer);
  t.after(() => { global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout; });
  const agents = [{ key: 'claude', prefix: 'claude/', label: 'Claude', description: 'Subscription', signedOut: () => false }];
  return { run: () => addSubscriptionModels(data, agents, catalogFor, () => {}), timers, data, fire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } } };
}

test('a fast cached catalogue leaves no 30-second timer behind', async t => {
  const f = fixture(t, () => Promise.resolve({ models: [{ value: 'sonnet', name: 'Sonnet' }], efforts: {}, fallback: null }));
  await f.run();
  assert.deepEqual(f.data.map(model => model.model), ['claude/sonnet', 'native']);
  assert.equal(f.timers.size, 0, 'the settled catalogue must cancel its fallback timer');
});

test('a stalled catalogue still yields native models after the timeout', async t => {
  const f = fixture(t, () => new Promise(() => {}));
  const pending = f.run();
  await Promise.resolve();
  assert.equal(f.timers.size, 1);
  f.fire();
  await pending;
  assert.deepEqual(f.data.map(model => model.model), ['native']);
  assert.equal(f.timers.size, 0);
});
