import test from 'node:test';
import assert from 'node:assert/strict';
import { insertTranscript } from '../lib/dictation.ts';
import { chatProvider } from '../lib/api.ts';

test('dictation uses the original selection and keeps surrounding text', () => {
  assert.deepEqual(insertTranscript('Before OLD after', { text: 'Before OLD after', start: 7, end: 10 }, 'گفتار'), { text: 'Before گفتار after', caret: 12 });
  assert.deepEqual(insertTranscript('', { text: '', start: 0, end: 0 }, 'Hello'), { text: 'Hello', caret: 5 });
});

test('later typing is preserved and empty recognition does not erase a draft', () => {
  assert.deepEqual(insertTranscript('Newer edits', { text: 'old', start: 0, end: 3 }, 'Speech'), { text: 'Newer edits Speech', caret: 18 });
  assert.deepEqual(insertTranscript('draft', { text: 'draft', start: 0, end: 5 }, ''), { text: 'draft', caret: 5 });
});

test('the microphone follows the chat provider: a subscription by its model prefix, else the chat provider, else the engine default', () => {
  assert.equal(chatProvider('claude/opus', 'openai', 'openai'), 'claude'); // the engine still reports its own provider for a subscription
  assert.equal(chatProvider('agy/gemini', undefined, 'openrouter'), 'gemini');
  assert.equal(chatProvider('openai/gpt-5', 'openrouter', 'openai'), 'openrouter');
  assert.equal(chatProvider('gpt-6-sol', undefined, 'openrouter'), 'openrouter');
  assert.equal(chatProvider('', undefined, null), 'openai'); // the engine's default provider when none is configured
});
