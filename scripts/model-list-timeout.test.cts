// Exercise the bridge's real model/list response branch without starting the engine.
import type { Context } from 'node:vm';

type Timer = { fn: () => void; ms: number };
type ModelResponse = { result: { data: { model: string }[] } };
type ModelContext = Context & { run: () => Promise<void> };

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm: typeof import('node:vm') = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.MODEL_BRIDGE_PATH || path.join(__dirname, '../tools/elpis-claude/acp-bridge.mjs'), 'utf8');
const start = source.indexOf('    if (parsed && pendingModelList.has(parsed.id)');
const end = source.indexOf('    ws.send(helpersMarked ?', start);
assert(start >= 0 && end > start, 'bridge model/list response must be found');

function fixture(catalogFor: () => Promise<unknown>) {
  const timers = new Set<Timer>(), replies: ModelResponse[] = [];
  const ctx = vm.createContext({
    parsed: { id: 'models', result: { data: [{ id: 'native', model: 'native' }] } },
    pendingModelList: new Set(['models']),
    AGENTS: [{ key: 'claude', prefix: 'claude/', label: 'Claude', description: 'Subscription', signedOut: () => false }],
    catalogFor,
    setTimeout: (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => { const timer = { fn: () => fn(...args), ms }; timers.add(timer); return timer; },
    clearTimeout: (timer: Timer) => timers.delete(timer),
    ws: { send: (value: string) => replies.push(JSON.parse(value) as ModelResponse) }, log: () => {},
  }) as ModelContext;
  vm.runInContext(`globalThis.run = async function () { ${source.slice(start, end)} }`, ctx);
  return { run: ctx.run, timers, replies, fire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } } };
}

test('a fast cached catalogue leaves no 30-second timer behind', async () => {
  const f = fixture(() => Promise.resolve({ models: [{ value: 'sonnet', name: 'Sonnet' }], efforts: {}, fallback: null }));
  await f.run();
  const reply = f.replies[0]; assert(reply);
  assert.deepEqual(reply.result.data.map(model => model.model), ['claude/sonnet', 'native']);
  assert.equal(f.timers.size, 0, 'the settled catalogue must cancel its fallback timer');
});

test('a stalled catalogue still yields native models after the timeout', async () => {
  const f = fixture(() => new Promise(() => {}));
  const pending = f.run();
  await Promise.resolve();
  assert.equal(f.timers.size, 1);
  f.fire();
  await pending;
  const reply = f.replies[0]; assert(reply);
  assert.deepEqual(reply.result.data.map(model => model.model), ['native']);
  assert.equal(f.timers.size, 0);
});
