import test from 'node:test';
import assert from 'node:assert/strict';
import { canBack, canForward, startHistory, step, visit } from '../lib/nav-history.ts';

const chat = threadId => ({ view: 'chat', threadId });
const agents = { view: 'agents', threadId: null };
const everything = () => true;
const walk = (...places) => places.reduce((history, place) => visit(history, place), startHistory(places[0]));

test('visiting a place after the current one makes Back available and Forward not', () => {
  const history = walk(chat(null), chat('a'), chat('b'));
  assert.equal(canBack(history), true); assert.equal(canForward(history), false);
  assert.deepEqual(history.places.map(place => place.threadId), [null, 'a', 'b']);
});

test('visiting the place already shown changes nothing', () => {
  const history = walk(chat('a'), chat('b'));
  assert.equal(visit(history, chat('b')), history);
});

test('Back and Forward walk the stack one place at a time and stop at its ends', () => {
  let history = walk(chat('a'), agents, chat('b'));
  const back = step(history, -1, everything); history = back.history;
  assert.deepEqual(back.place, agents);
  history = step(history, -1, everything).history;
  assert.equal(canBack(history), false); assert.equal(canForward(history), true);
  assert.equal(step(history, -1, everything), null);
  const forward = step(history, 1, everything);
  assert.deepEqual(forward.place, agents);
  assert.equal(step(step(forward.history, 1, everything).history, 1, everything), null);
});

test('visiting a new place after going Back drops the places that were ahead', () => {
  let history = walk(chat('a'), chat('b'), chat('c'));
  history = step(step(history, -1, everything).history, -1, everything).history;
  history = visit(history, chat('d'));
  assert.deepEqual(history.places.map(place => place.threadId), ['a', 'd']);
  assert.equal(canForward(history), false);
});

test('a place that can no longer be shown is skipped', () => {
  const history = walk(chat('a'), chat('gone'), chat('c'));
  const back = step(history, -1, place => place.threadId !== 'gone');
  assert.deepEqual(back.place, chat('a'));
  assert.equal(back.history.index, 0);
  assert.equal(step(history, -1, place => place.threadId === 'c'), null, 'no usable place that way');
});

test('the stack keeps the last hundred places', () => {
  let history = startHistory(chat('0'));
  for (let i = 1; i <= 150; i++) history = visit(history, chat(String(i)));
  assert.equal(history.places.length, 100);
  assert.equal(history.places.at(-1).threadId, '150'); assert.equal(history.places[0].threadId, '51');
  assert.equal(history.index, 99);
});
