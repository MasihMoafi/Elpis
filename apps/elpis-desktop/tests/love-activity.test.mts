import test from 'node:test';
import assert from 'node:assert/strict';
import { loveActivity, newLoveReplies, chatOrigin } from '../lib/love-activity.ts';

const card = (output = '', extras = {}) => ({ id: 'reviewer', customData: { loveAgent: { name: 'Review', threadId: 'chat-review', output, ...extras } } });
test('identifies legacy board chats and named ACP chats without classifying ordinary chats', () => {
  assert.equal(chatOrigin({ id: 'legacy' }, { legacy: 'Review' }), 'Love Spot');
  assert.equal(chatOrigin({ id: 'new', name: 'Love Spot · Review' }), 'Love Spot');
  assert.equal(chatOrigin({ id: 'talk', name: 'Love Spot' }), 'Love Spot');
  assert.equal(chatOrigin({ id: 'workflow', name: 'Workflows · Verify' }), 'Workflows');
  assert.equal(chatOrigin({ id: 'ordinary', name: 'Love Spot ideas' }), undefined);
  assert.equal(chatOrigin({ id: 'ordinary', name: 'Review' }), undefined);
  assert.equal(chatOrigin({ id: 'toString' }), undefined);
});
test('only changed agent answers notify; initial history, running updates and deleted cards do not', () => {
  const agents = loveActivity([card()]);
  assert.deepEqual(newLoveReplies(null, agents), []);
  const before = new Map(agents.map(agent => [agent.id, agent.reply]));
  assert.deepEqual(newLoveReplies(before, loveActivity([card('Done reviewing') ])), ['reviewer']);
  assert.deepEqual(newLoveReplies(before, loveActivity([card('', { status: 'running' })])), []);
  assert.deepEqual(newLoveReplies(before, loveActivity([{ ...card('Done'), isDeleted: true }])), []);
  assert.deepEqual(newLoveReplies(before, loveActivity([card('', { interview: { messages: [{ role: 'assistant', text: 'Which project?' }] } })])), ['reviewer']);
  assert.deepEqual(loveActivity(null), []);
  assert.deepEqual(newLoveReplies(before, loveActivity([card(), { id: 'love-reply-turn1', type: 'text', text: 'Talk answer' }])), ['love-board-replies']);
  const answered = loveActivity([card(), { id: 'love-reply-turn1', type: 'text', text: 'Talk answer' }]);
  assert.deepEqual(newLoveReplies(new Map(answered.map(agent => [agent.id, agent.reply])), loveActivity([card(), { id: 'love-reply-turn1', type: 'text', text: 'Edited note' }])), [], 'Editing an old note is not a new answer');
  assert.doesNotThrow(() => loveActivity([card('', { interview: { messages: 'invalid drawing metadata' } })]));
});
