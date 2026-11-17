const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apply, view } = require('../lib/attention-state.cts');

test('a visible window wins for the same reply in either delivery order, but a later reply remains unread', () => {
  const complete = (read: boolean) => ({ kind: 'complete', id: 'a', turn: 't1', read, plan: false });
  for (const order of [[false, true], [true, false]] as [boolean, boolean][]) {
    let state = apply(null, complete(order[0]));
    state = apply(state, complete(order[1]));
    assert.deepEqual(view(state).unread, []);
    state = apply(state, { ...complete(false), turn: 't2' });
    assert.deepEqual(view(state).unread, ['a']);
    state = apply(state, complete(false));
    assert.deepEqual(view(state).unread, ['a'], 'a duplicate old reply does not change the newer reply');
  }
});

test('manual unread and legacy unread survive automatic reads and restarts; explicit read clears them', () => {
  let state = JSON.stringify({ unread: ['legacy'], plans: { legacy: 'plan' } });
  state = apply(state, { kind: 'complete', id: 'manual', turn: 'one', read: false, plan: false });
  state = apply(state, { kind: 'unread', id: 'manual' });
  state = apply(state, { kind: 'complete', id: 'manual', turn: 'one', read: true, plan: false });
  for (const id of ['legacy', 'manual']) state = apply(state, { kind: 'read', id, manual: false });
  assert.deepEqual(view(state).unread.sort(), ['legacy', 'manual']);
  assert.equal(view(state).plans.legacy, 'plan');
  state = apply(state, { kind: 'read', id: 'legacy', manual: true });
  assert.deepEqual(view(state).unread, ['manual']);
});

test('independent chats and plan clearing do not overwrite each other', () => {
  let state = apply(null, { kind: 'complete', id: 'a', turn: 'one', read: false, plan: true });
  state = apply(state, { kind: 'complete', id: 'b', turn: 'two', read: false, plan: false });
  state = apply(state, { kind: 'clearPlan', id: 'a', turn: 'old' });
  assert.equal(view(state).plans.a, 'one');
  state = apply(state, { kind: 'read', id: 'a', manual: true });
  assert.deepEqual(view(state).unread, ['b']);
  state = apply(state, { kind: 'clearPlan', id: 'a', turn: 'one' });
  assert.equal(view(state).plans.a, undefined);
  state = apply(state, { kind: 'complete', id: 'a', turn: 'one', read: false, plan: true });
  assert.equal(view(state).plans.a, undefined, 'a repeated completion cannot restore a dismissed plan');
  state = apply(state, { kind: 'complete', id: 'a', turn: 'new', read: false, plan: true });
  state = apply(state, { kind: 'clearPlan', id: 'a', turn: 'one' });
  assert.equal(view(state).plans.a, 'new', 'an old dismissal cannot clear a newer plan');
  state = apply(state, { kind: 'clearPlan', id: 'a' });
  state = apply(state, { kind: 'complete', id: 'a', turn: 'new', read: false, plan: true });
  assert.equal(view(state).plans.a, undefined, 'starting a new turn dismisses the plan permanently');
});

test('displaying an older reply does not mark a newer unloaded reply read', () => {
  let state = apply(null, { kind: 'complete', id: 'a', turn: 'old', read: false, plan: false });
  state = apply(state, { kind: 'complete', id: 'a', turn: 'new', read: false, plan: false });
  state = apply(state, { kind: 'read', id: 'a', turn: 'old', manual: false });
  assert.deepEqual(view(state).unread, ['a']);
  state = apply(state, { kind: 'read', id: 'a', turn: 'new', manual: false });
  assert.deepEqual(view(state).unread, []);
});
