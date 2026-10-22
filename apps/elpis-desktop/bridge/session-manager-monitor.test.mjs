import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionManagerMonitor, reviewPrompt, reviewReason, runSessionManagerReview } from './session-manager-monitor.mjs';

const NOW = Date.UTC(2026, 9, 21, 9, 0);
const chat = (id, { active = false, minutesAgo = 120, parent, ephemeral } = {}) =>
  ({ id, cwd: '/tmp/project-a', status: { type: active ? 'active' : 'idle' }, createdAt: Math.floor((NOW - minutesAgo * 60000) / 1000), ...(parent ? { parentThreadId: parent } : {}), ...(ephemeral ? { ephemeral } : {}) });
const isManager = id => id === 'manager';

test('three of his chats running at once call for a review; two do not', () => {
  const two = [chat('a', { active: true }), chat('b', { active: true }), chat('c')];
  assert.equal(reviewReason(two, { isManager, now: NOW }), null);
  const three = [...two.slice(0, 2), chat('c', { active: true })];
  assert.deepEqual(reviewReason(three, { isManager, now: NOW }), { key: 'running:a,b,c', text: '3 chats are running at once' });
});

test('helpers, side chats and the manager itself never count', () => {
  const threads = [chat('a', { active: true }), chat('b', { active: true }), chat('helper', { active: true, parent: 'a' }),
    chat('side', { active: true, ephemeral: true }), chat('manager', { active: true })];
  assert.equal(reviewReason(threads, { isManager, now: NOW }), null);
});

test('three chats started within twenty minutes call for a review; an older third does not', () => {
  const recent = [chat('a', { minutesAgo: 1 }), chat('b', { minutesAgo: 10 }), chat('c', { minutesAgo: 19 })];
  assert.deepEqual(reviewReason(recent, { isManager, now: NOW }), { key: 'created:a,b,c', text: '3 chats were started in the last 20 minutes' });
  const older = [...recent.slice(0, 2), chat('c', { minutesAgo: 21 })];
  assert.equal(reviewReason(older, { isManager, now: NOW }), null);
});

function harness(threads, review = async () => {}) {
  const timers = [], reviews = [], logs = [];
  const monitor = createSessionManagerMonitor({
    list: async () => ({ data: threads() }), isManager, now: () => NOW, log: line => logs.push(line),
    review: async reason => { reviews.push(reason.key); await review(reason); },
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: id => { timers[id - 1] = null; },
  });
  const fire = async () => { const pending = timers.splice(0).filter(Boolean); for (const fn of pending) fn(); await new Promise(resolve => setImmediate(resolve)); };
  return { monitor, reviews, logs, fire };
}

test('a burst of starts is read once, an unchanged set is reviewed once, and a new set again', async () => {
  let threads = [chat('a', { active: true }), chat('b', { active: true }), chat('c', { active: true })];
  const h = harness(() => threads);
  for (const id of ['a', 'b', 'c']) h.monitor.observe({ method: 'turn/started', params: { threadId: id } });
  await h.fire();
  assert.deepEqual(h.reviews, ['running:a,b,c:/tmp/project-a']);
  h.monitor.observe({ method: 'turn/started', params: { threadId: 'a' } });
  await h.fire();
  assert.deepEqual(h.reviews, ['running:a,b,c:/tmp/project-a'], 'the same running set is not reviewed twice');
  threads = [...threads, chat('d', { active: true })];
  h.monitor.observe({ method: 'thread/status/changed', params: { threadId: 'd', status: { type: 'active' } } });
  await h.fire();
  assert.deepEqual(h.reviews, ['running:a,b,c:/tmp/project-a', 'running:a,b,c,d:/tmp/project-a']);
});

test('events that start nothing, and the manager\'s own turns, never wake it', async () => {
  const h = harness(() => [chat('a', { active: true }), chat('b', { active: true }), chat('c', { active: true })]);
  h.monitor.observe({ method: 'turn/completed', params: { threadId: 'a' } });
  h.monitor.observe({ method: 'thread/status/changed', params: { threadId: 'a', status: { type: 'idle' } } });
  h.monitor.observe({ method: 'turn/started', params: { threadId: 'manager' } });
  await h.fire();
  assert.deepEqual(h.reviews, []);
});

test('a review asked for while one runs waits for it; a failed review is reported, not retried', async () => {
  let threads = [chat('a', { active: true }), chat('b', { active: true }), chat('c', { active: true })], release;
  const first = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const h = harness(() => threads, async () => { calls++; if (calls === 1) await first; if (calls === 2) throw Error('busy engine'); });
  h.monitor.observe({ method: 'turn/started', params: { threadId: 'a' } });
  await h.fire();
  threads = [...threads, chat('d', { active: true })];
  h.monitor.observe({ method: 'turn/started', params: { threadId: 'd' } });
  await h.fire();
  assert.deepEqual(h.reviews, ['running:a,b,c:/tmp/project-a'], 'the second review waits');
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.reviews, ['running:a,b,c:/tmp/project-a', 'running:a,b,c,d:/tmp/project-a']);
  assert.match(h.logs.join('\n'), /review failed: busy engine/);
  assert.equal(calls, 2);
});

test('the prompt asks for scoped actions under the standing rule', () => {
  const text = reviewPrompt({ text: '3 chats are running at once' });
  assert.match(text, /3 chats are running at once/);
  assert.match(text, /Call your scoped tool directly/);
  assert.doesNotMatch(text, /archive/i, 'the manager never archives');
  assert.match(text, /grouping requires an explicit request and approval/);
});

test('review scope waits for the current manager turn and lasts through its own completion', async () => {
  const client = new EventEmitter(), actions = [];
  client.resume = async () => ({ activeTurnId: 'previous' });
  client.prepareSessionManager = async () => actions.push('prepare');
  client.send = async () => { actions.push('send'); return { turn: { id: 'review' } }; };
  const done = runSessionManagerReview(client, 'manager', {}, () => { actions.push('begin'); return () => actions.push('end'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, [], 'no authority while a previous turn runs');
  const complete = id => client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'manager', turn: { id } } } });
  complete('previous'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['prepare', 'begin', 'send']);
  complete('another-turn'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['prepare', 'begin', 'send']);
  complete('review'); await done;
  assert.deepEqual(actions, ['prepare', 'begin', 'send', 'end']);
  assert.equal(client.listenerCount('event'), 0);
});

test('failed send revokes project authority and completion before the send response is handled', async () => {
  const client = new EventEmitter(); let ended = 0;
  client.resume = async () => ({}); client.prepareSessionManager = async () => {};
  client.send = async () => { throw Error('not delivered'); };
  const begin = () => () => ended++;
  await assert.rejects(runSessionManagerReview(client, 'manager', {}, begin), /not delivered/);
  assert.equal(ended, 1); assert.equal(client.listenerCount('event'), 0);
  client.send = async () => {
    client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: 'manager', turn: { id: 'fast' } } } });
    return { turn: { id: 'fast' } };
  };
  await runSessionManagerReview(client, 'manager', {}, begin);
  assert.equal(ended, 2);
});

test('only the triggering project is reviewed and an ambiguous project check does nothing', async () => {
  const threads = [chat('a', { active: true }), { ...chat('b', { active: true }), cwd: '/tmp/project-b' }, chat('c', { active: true })];
  const reasons = [];
  const h = harness(() => threads, async reason => reasons.push(reason));
  await h.monitor.check(); assert.equal(reasons.length, 0);
  h.monitor.observe({ method: 'turn/started', params: { threadId: 'b' } }); await h.fire();
  assert.equal(reasons[0].cwd, '/tmp/project-b');
});


test('a disconnected real review revokes its project scope', async () => {
  const client = new EventEmitter(); let ended = 0;
  client.resume = async () => ({}); client.prepareSessionManager = async () => {};
  client.send = async () => ({ turn: { id: 'review' } });
  const promise = runSessionManagerReview(client, 'manager', {}, () => () => ended++);
  await new Promise(resolve => setImmediate(resolve));
  client.emit('event', { type: 'connection', data: { connected: false } });
  await assert.rejects(promise, /disconnected/);
  assert.equal(ended, 1); assert.equal(client.listenerCount('event'), 0);
});
