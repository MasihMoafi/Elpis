import test from 'node:test';
import assert from 'node:assert/strict';
import { entryKey, rememberSubmittedMessages, submittedContent, withSubmittedMessages } from '../lib/submitted-messages.ts';

const entry = (turnId, id, text) => ({ turnId, item: { id, type: 'userMessage', content: [{ type: 'text', text }] } });
const sent = (patch = {}) => ({ key: 'local', scope: 'chat', content: submittedContent('Again', []), previousKeys: [], newTurn: true, ...patch });

test('a submission is immediate, excludes old identical prompts, and keeps its keys on the recorded echo', () => {
  const old = entry('old-turn', 'old-user', 'Again'), pending = sent({ previousKeys: [entryKey(old)] });
  assert.equal(withSubmittedMessages([old], [pending], 'chat').length, 2);
  const echo = entry('new-turn', 'new-user', 'Again');
  const result = withSubmittedMessages([old, echo], [pending], 'chat');
  assert.equal(result.length, 2);
  assert.equal(result[1].clientKey, 'local'); assert.equal(result[1].clientTurnKey, 'local');
  assert.equal(result[1].item, echo.item);
  assert.deepEqual(withSubmittedMessages([old], [pending], 'other-chat'), [old]);
  assert.deepEqual(withSubmittedMessages([old], [{ ...pending, failed: true }], 'chat'), [old]);
});

test('early work and history echoes keep the submitted turn identity, including an echo before HTTP acknowledgement', () => {
  const work = { turnId: 'real-turn', item: { id: 'answer', type: 'agentMessage', text: 'Working' } };
  const pending = sent({ turnId: 'real-turn' });
  const before = withSubmittedMessages([work], [pending], 'chat');
  assert.equal(before[0].clientPending, true); assert.equal(before[1].clientTurnKey, 'local');
  const echo = entry('real-turn', 'real-user', 'Again');
  const after = withSubmittedMessages([echo, work], [pending], 'chat');
  assert.equal(after.length, 2); assert.equal(after[0].clientKey, before[0].clientKey);
  assert.equal(after[1].clientTurnKey, before[1].clientTurnKey);
  assert.equal(withSubmittedMessages([echo], [sent()], 'chat')[0].clientKey, 'local');
  const unrelated = entry('other-turn', 'other-user', 'Again');
  assert.equal(withSubmittedMessages([unrelated], [pending], 'chat').length, 2, 'an acknowledged turn cannot consume another client’s identical prompt');
});

test('steering keeps the existing turn identity and repeated prompts each reconcile once', () => {
  const first = entry('active', 'first', 'Again'), second = entry('active', 'second', 'Again');
  const result = withSubmittedMessages([first, second], [sent({ turnId: 'active', newTurn: false }), sent({ key: 'local-2', turnId: 'active', newTurn: false })], 'chat');
  assert.deepEqual(result.map(item => item.clientKey), ['local', 'local-2']);
  assert.equal(result.some(item => item.clientTurnKey), false);
  assert.equal(withSubmittedMessages([first], [sent({ failed: true })], 'chat').length, 1, 'a refused HTTP request never hides an item the engine already recorded');
});

test('text files and image-only sends reconcile against recorded attachment content', () => {
  const content = submittedContent('', [{ id: 'file', name: 'guide.txt', type: 'text', mimeType: 'text/plain', text: 'Planted text' }, { id: 'pic', name: 'pic.png', type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]);
  const echo = { turnId: 'turn', item: { id: 'user', type: 'userMessage', content: [content[0], { type: 'localImage', path: '/recorded/image.png' }] } };
  assert.equal(withSubmittedMessages([echo], [sent({ content })], 'chat').length, 1);
  assert.equal(withSubmittedMessages([entry('turn', 'wrong', '')], [sent({ content })], 'chat').length, 2, 'an empty message cannot consume attached files');
});

test('history removal after an observed echo never resurrects a sent prompt', () => {
  const echo = entry('turn', 'user', 'Again'), [observed] = rememberSubmittedMessages([echo], [sent({ turnId: 'turn' })], 'chat');
  assert.equal(withSubmittedMessages([echo], [observed], 'chat').length, 1);
  assert.deepEqual(withSubmittedMessages([], [observed], 'chat'), [], 'rewind, compaction or another client may remove a recorded item');
});

test('a message sent while the agent works shows right below the last message, not at the start of its turn (R2)', () => {
  const ask = entry('active', 'ask', 'Build it'), work = { turnId: 'active', item: { id: 'work', type: 'agentMessage', text: 'Working on it' } };
  const pending = sent({ turnId: 'active', newTurn: false, previousKeys: [entryKey(ask), entryKey(work)] });
  assert.deepEqual(withSubmittedMessages([ask, work], [pending], 'chat').map(item => item.item.id), ['ask', 'work', 'local']);
  const later = { turnId: 'active', item: { id: 'later', type: 'agentMessage', text: 'More' } };
  assert.deepEqual(withSubmittedMessages([ask, work, later], [pending], 'chat').map(item => item.item.id), ['ask', 'work', 'local', 'later'], 'what the agent writes afterwards comes after it');
  const fresh = { turnId: 'new', item: { id: 'early', type: 'agentMessage', text: 'Hi' } };
  assert.deepEqual(withSubmittedMessages([ask, work, fresh], [sent({ turnId: 'new', previousKeys: [entryKey(ask), entryKey(work)] })], 'chat').map(item => item.item.id), ['ask', 'work', 'local', 'early'], 'a new turn still opens with the message');
});
