// lib/follow-ups.ts: several queued messages for one chat: first in line goes first, one can be sent now (steering the
// running turn), removed, or all cleared, and clearing sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mts';

const values = new Map<string, string>(), posts: { path: string; body: { text: string; expectedTurnId: string } }[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } } });
globalThis.fetch = async (url, init) => { if (typeof init?.body !== 'string') throw new Error('expected a JSON request body'); posts.push({ path: new URL(String(url), 'http://x').pathname, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
const modulePath = '../lib/' + 'follow-ups.ts';
const { clearFollowUps, queueFollowUp, queuedFollowUps, removeFollowUp, sendFollowUpNow }: {
  clearFollowUps(threadId: string): void;
  queueFollowUp(threadId: string, text: string, attachments: never[], options: object, choice: string): boolean;
  queuedFollowUps(threadId: string): { id: string; text: string }[];
  removeFollowUp(threadId: string, id: string): void;
  sendFollowUpNow(threadId: string, id: string, activeTurnId: string): Promise<void>;
} = await import(modulePath);

test('a stack of queued messages sends one now into the running turn, removes one, and Clear all sends nothing', async () => {
  for (const text of ['alpha', 'beta', 'gamma', 'delta']) assert.equal(queueFollowUp('chat-a', text, [], {}, 'queue'), true);
  const texts = () => queuedFollowUps('chat-a').map(item => item.text);
  assert.deepEqual(texts(), ['alpha', 'beta', 'gamma', 'delta'], 'first in line goes first');
  const second = queuedFollowUps('chat-a')[1]; assert.ok(second);
  await sendFollowUpNow('chat-a', second.id, 'turn-1');
  assert.deepEqual(posts.map(post => [post.path.split('/').at(-1), post.body.text, post.body.expectedTurnId]), [['steer', 'beta', 'turn-1']]);
  const next = queuedFollowUps('chat-a')[1]; assert.ok(next);
  removeFollowUp('chat-a', next.id);
  assert.deepEqual(texts(), ['alpha', 'delta']);
  const saved = values.get('elpis-follow-ups-v1'); assert.ok(saved);
  assert.deepEqual(JSON.parse(saved)['chat-a'].map((item: { text: string }) => item.text), ['alpha', 'delta'], 'the queue is saved');
  clearFollowUps('chat-a');
  assert.deepEqual(texts(), []); assert.equal(posts.length, 1, 'Clear all sends nothing');
  assert.equal(queueFollowUp('chat-a', 'steer me', [], {}, 'steer'), false, 'with Steer chosen nothing is queued');
});
