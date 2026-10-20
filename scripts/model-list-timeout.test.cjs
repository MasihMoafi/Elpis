// Exercise the bridge's real model/list response branch without starting the engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.MODEL_BRIDGE_PATH || path.join(__dirname, '../tools/elpis-claude/acp-bridge.mjs'), 'utf8');
const start = source.indexOf('    if (parsed && pendingModelList.has(parsed.id)');
const end = source.indexOf('    ws.send(helpersMarked ?', start);
assert(start >= 0 && end > start, 'bridge model/list response must be found');

function fixture(catalogFor) {
  const timers = new Set(), replies = [];
  const ctx = vm.createContext({
    parsed: { id: 'models', result: { data: [{ id: 'native', model: 'native' }] } },
    pendingModelList: new Set(['models']),
    AGENTS: [{ key: 'claude', prefix: 'claude/', label: 'Claude', description: 'Subscription', signedOut: () => false }],
    catalogFor,
    setTimeout: (fn, ms, ...args) => { const timer = { fn: () => fn(...args), ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    ws: { send: value => replies.push(JSON.parse(value)) }, log: () => {},
  });
  vm.runInContext(`globalThis.run = async function () { ${source.slice(start, end)} }`, ctx);
  return { run: ctx.run, timers, replies, fire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } } };
}

test('a fast cached catalogue leaves no 30-second timer behind', async () => {
  const f = fixture(() => Promise.resolve({ models: [{ value: 'sonnet', name: 'Sonnet' }], efforts: {}, fallback: null }));
  await f.run();
  assert.deepEqual(f.replies[0].result.data.map(model => model.model), ['claude/sonnet', 'native']);
  assert.equal(f.timers.size, 0, 'the settled catalogue must cancel its fallback timer');
});

test('a stalled catalogue still yields native models after the timeout', async () => {
  const f = fixture(() => new Promise(() => {}));
  const pending = f.run();
  await Promise.resolve();
  assert.equal(f.timers.size, 1);
  f.fire();
  await pending;
  assert.deepEqual(f.replies[0].result.data.map(model => model.model), ['native']);
  assert.equal(f.timers.size, 0);
});
