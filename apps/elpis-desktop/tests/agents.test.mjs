import test from 'node:test';
import assert from 'node:assert/strict';
import { agentState, mergeListedThreads } from '../lib/agents.ts';

test('native waiting flags and pending requests take priority over Working', () => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) assert.equal(agentState({ id: 'child', status: { type: 'active', activeFlags: [flag] } }), 'waiting');
  assert.equal(agentState({ id: 'child', status: { type: 'idle' } }, new Set(['child'])), 'waiting');
  assert.equal(agentState({ id: 'other', status: { type: 'active' } }, new Set(['child'])), 'working');
  assert.equal(agentState({ id: 'child', status: { type: 'idle' } }), 'idle');
  assert.equal(agentState({ id: 'child', status: { type: 'systemError' } }), 'error');
  assert.equal(agentState({ id: 'child' }), 'unknown');
});

test('head refresh keeps older loaded conversations and updates existing child status without duplicates', () => {
  const current = [{ id: 'new' }, { id: 'older' }, { id: 'child', parentThreadId: 'new', status: { type: 'active' } }];
  const result = mergeListedThreads(current, [{ id: 'new', name: 'Renamed' }, { id: 'child', parentThreadId: 'new', status: { type: 'idle' } }], new Set(), true);
  assert.deepEqual(result.map(t => t.id), ['new', 'child', 'older']);
  assert.equal(result[1].status.type, 'idle');
});

test('later pages remain through a first-page refresh and deleted rows never reappear', () => {
  let rows = mergeListedThreads([{ id: 'parent' }, { id: 'gpt-a', parentThreadId: 'parent' }], [{ id: 'gpt-a', parentThreadId: 'parent' }, { id: 'agy', parentThreadId: 'parent' }]);
  rows = mergeListedThreads(rows, [{ id: 'gpt-a', parentThreadId: 'parent', model: 'gpt-6-luna' }]);
  assert.deepEqual(rows.map(t => t.id), ['parent', 'gpt-a', 'agy']);
  assert.deepEqual(mergeListedThreads(rows, [{ id: 'agy' }], new Set(['agy'])).map(t => t.id), ['parent', 'gpt-a']);
});
