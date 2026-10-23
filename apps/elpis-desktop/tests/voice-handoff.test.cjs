// Masih, 23 Oct: a voice chat's handoff envelope showed in the chat as if he had typed it ("we don't want this in the chat").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isVoiceHandoff } = require('../bridge/voice-handoff.cjs');

const user = text => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const handoff = '<realtime_delegation>\n  <input>Oh, how do I change the voice</input>\n  <transcript_delta>user:  Oh, how do I change the voice</transcript_delta>\n</realtime_delegation>';

test('a voice handoff envelope is left out; typed messages, even ones quoting the tag, stay', () => {
  assert.equal(isVoiceHandoff(user(handoff)), true);
  assert.equal(isVoiceHandoff(user(`  ${handoff}\n`)), true);
  assert.equal(isVoiceHandoff(user(`we don't want this in the chat: ${handoff}`)), false);
  assert.equal(isVoiceHandoff(user('How do I change the voice?')), false);
  assert.equal(isVoiceHandoff({ type: 'agentMessage', text: handoff }), false);
  assert.equal(isVoiceHandoff({ type: 'userMessage', content: [{ type: 'text', text: handoff }, { type: 'image', url: 'x' }] }), false);
});
