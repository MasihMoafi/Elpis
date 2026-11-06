// lib/follow-ups.ts: several queued messages for one chat: first in line goes first, one can be sent now (steering the
// running turn), removed, or all cleared, and clearing sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mjs';

const values = new Map(), posts = [];
globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } };
globalThis.fetch = async (url, init) => { posts.push({ path: new URL(String(url), 'http://x').pathname, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; };
const { clearFollowUps, queueFollowUp, queuedFollowUps, removeFollowUp, sendFollowUpNow } = await import('../lib/follow-ups.ts');

test('a stack of queued messages sends one now into the running turn, removes one, and Clear all sends nothing', async () => {
  for (const text of ['alpha', 'beta', 'gamma', 'delta']) assert.equal(queueFollowUp('chat-a', text, [], {}, 'queue'), true);
  const texts = () => queuedFollowUps('chat-a').map(item => item.text);
  assert.deepEqual(texts(), ['alpha', 'beta', 'gamma', 'delta'], 'first in line goes first');
  await sendFollowUpNow('chat-a', queuedFollowUps('chat-a')[1].id, 'turn-1');
  assert.deepEqual(posts.map(post => [post.path.split('/').at(-1), post.body.text, post.body.expectedTurnId]), [['steer', 'beta', 'turn-1']]);
  removeFollowUp('chat-a', queuedFollowUps('chat-a')[1].id);
  assert.deepEqual(texts(), ['alpha', 'delta']);
  assert.deepEqual(JSON.parse(values.get('elpis-follow-ups-v1'))['chat-a'].map(item => item.text), ['alpha', 'delta'], 'the queue is saved');
  clearFollowUps('chat-a');
  assert.deepEqual(texts(), []); assert.equal(posts.length, 1, 'Clear all sends nothing');
  assert.equal(queueFollowUp('chat-a', 'steer me', [], {}, 'steer'), false, 'with Steer chosen nothing is queued');
});
