// Masih (21 October): helper chats must be told apart in the app as in the terminal, which names them "Plato [worker]".
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLabel, title } from '../lib/api.ts';

const helper = { id: '01a15b2a-0000-7000-8000-00000000abcd', source: { subAgent: { thread_spawn: {} } }, agentNickname: 'Plato', agentRole: 'worker', preview: 'You are a worker…' };

test('an unnamed helper is shown by its terminal label, not as an untitled agent', () => {
  assert.equal(agentLabel(helper), 'Plato [worker]');
  assert.equal(title(helper), 'Plato [worker]');
  assert.equal(title({ ...helper, agentRole: null }), 'Plato');
  assert.equal(title({ ...helper, agentNickname: null }), '[worker]');
});

test('names and ordinary chats keep their titles', () => {
  assert.equal(title({ ...helper, name: 'Fix the ledger' }), 'Fix the ledger');
  assert.equal(title({ id: 'chat', source: 'vscode', agentNickname: 'Plato', preview: 'hello there' }), 'hello there');
  assert.match(title({ ...helper, agentNickname: null, agentRole: null }), /^Untitled agent · /);
});
