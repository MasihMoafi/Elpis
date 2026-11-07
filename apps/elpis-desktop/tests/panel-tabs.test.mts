import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOrder, neighbour } from '../lib/panel-tabs.ts';

test('terminals and pages keep the order they appeared in, whichever kind they are', () => {
  let order = mergeOrder([], ['t:1']);
  order = mergeOrder(order, ['t:1', 'b:9']);
  order = mergeOrder(order, ['t:1', 't:2', 'b:9']);
  assert.deepEqual(order, ['t:1', 'b:9', 't:2']);
  assert.deepEqual(mergeOrder(order, ['t:2', 'b:9']), ['b:9', 't:2'], 'closed tabs leave the order');
  assert.deepEqual(mergeOrder(order, []), []);
});

test('closing a tab shows its right neighbour, else its left, else nothing', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(neighbour(order, 'b'), 'c');
  assert.equal(neighbour(order, 'c'), 'b');
  assert.equal(neighbour(order, 'a'), 'b');
  assert.equal(neighbour(['a'], 'a'), null);
  assert.equal(neighbour(order, 'gone'), 'c');
});


test('browser insertion order is retained beside its source across mixed panel tabs', () => {
  assert.deepEqual(mergeOrder(['t:1', 'b:a', 'b:b', 'f:files'], ['t:1', 'b:a', 'b:new', 'b:b', 'f:files'], ['b:a', 'b:new', 'b:b']), ['t:1', 'b:a', 'b:new', 'b:b', 'f:files']);
});
