import test from 'node:test';
import assert from 'node:assert/strict';
import { readDraft, writeDraft } from '../lib/drafts.ts';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('drafts recover exact multiline text independently for each chat and new chat', () => {
  const window = storage();
  const value = 'First line\n\nمتن فارسی — unsent instructions';
  assert.equal(writeDraft('new', value, window), true);
  assert.equal(writeDraft('chat-a', 'Continue reviewing', window), true);
  assert.equal(writeDraft('chat-b', 'Do not send yet', window), true);
  assert.equal(readDraft('new', window), value);
  assert.equal(readDraft('chat-a', window), 'Continue reviewing');
  assert.equal(readDraft('chat-b', window), 'Do not send yet');
  assert.equal(writeDraft('chat-a', '', window), true);
  assert.equal(readDraft('chat-a', window), '');
  assert.equal(readDraft('chat-b', window), 'Do not send yet');
  assert.equal(readDraft('new', window), value);
  assert.equal(readDraft('chat-b', storage()), '', 'another window has no access to this window draft store');
});

test('storage failures are reported without throwing or claiming that the draft was saved', () => {
  const denied = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota exceeded'); }, removeItem() { throw new Error('Denied'); } };
  assert.equal(readDraft('new', denied), '');
  assert.equal(writeDraft('new', 'Keep in memory', denied), false);
  assert.equal(writeDraft('new', '', denied), false);
});
