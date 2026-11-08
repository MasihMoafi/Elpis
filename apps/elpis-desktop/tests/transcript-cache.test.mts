import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptCache } from '../lib/transcript-cache.mts';

const transcript = (text: string) => ({ entries: [{ turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text } }], cursor: 'earlier' });
test('transcript cache evicts least recently read chats by count and text budget', () => {
  const cache = new TranscriptCache();
  for (const id of ['a', 'b', 'c', 'd']) cache.set(id, transcript(id));
  assert.equal(cache.get('a')?.cursor, 'earlier');
  cache.set('e', transcript('e'));
  assert.equal(cache.has('b'), false); assert.equal(cache.has('a'), true);
  const large = 'x'.repeat(700000);
  for (const id of ['f', 'g', 'h', 'i']) cache.set(id, transcript(large));
  assert.equal(cache.has('a'), false); assert.equal(cache.has('f'), false);
  assert.equal(cache.get('i')?.entries[0]?.item.text?.length, large.length);
  cache.set('i', transcript('x'.repeat(3 * 1024 * 1024)));
  assert.equal(cache.has('i'), false, 'an oversized active transcript must not survive navigation');
});
