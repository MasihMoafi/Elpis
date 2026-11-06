// Smart Prune rows: what counts as a prune record, the line a reader sees (lib/smart-prune.ts), and a live prune landing
// once, in the turn it belongs to, however often the engine delivers it (lib/live-events.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneOf, pruneSummary } from '../lib/smart-prune.ts';
import { mergeLiveItem } from '../lib/live-events.ts';

const prune = { attemptId: 'attempt-1', callId: 'command-1', tool: 'cargo test -p core', sourceTokens: 6300, admittedTokens: 182, kept: 'the 2 failing tests', failureReason: null };

test('a prune row says what was cut and kept; a failed one says the full output was kept', () => {
  assert.equal(pruneSummary(prune), '✂ Smart Prune · cargo test -p core · 6.3k → 182 tokens · kept: the 2 failing tests');
  assert.equal(pruneSummary({ ...prune, failureReason: 'The pruner\ntimed out.' }), '✂ Smart Prune failed · kept the full output · The pruner timed out.');
  assert.equal(pruneSummary({ ...prune, kept: null }), '✂ Smart Prune · cargo test -p core · 6.3k → 182 tokens · kept: reason unavailable');
});

test('only a complete prune record is shown; a malformed one adds no row', () => {
  assert.equal(pruneOf(prune), prune);
  for (const bad of [null, 'prune', { ...prune, sourceTokens: '6300' }, { ...prune, kept: 3 }, { ...prune, callId: undefined }]) assert.equal(pruneOf(bad), null);
});

test('a live prune delivered twice is one row, and a late prune stays in its own turn after the next one starts', () => {
  const done = (turnId, id, item) => ['item/completed', { threadId: 'chat-a', turnId, item: { id, ...item } }];
  let entries = [{ turnId: 't4', item: { id: 'command-1', type: 'commandExecution' } }];
  const event = done('t4', 'prune-1', { type: 'smartPrune', prune });
  entries = mergeLiveItem(entries, ...event, 'chat-a');
  entries = mergeLiveItem(entries, ...event, 'chat-a');
  assert.equal(entries.filter(entry => entry.item.id === 'prune-1').length, 1);
  entries = mergeLiveItem(entries, ...done('t5', 'next-user', { type: 'userMessage', content: [{ type: 'text', text: 'Second turn' }] }), 'chat-a');
  entries = mergeLiveItem(entries, ...done('t4', 'prune-2', { type: 'smartPrune', prune: { ...prune, callId: 'command-2', tool: 'git status' } }), 'chat-a');
  assert.deepEqual(entries.map(entry => `${entry.turnId}:${entry.item.id}`), ['t4:command-1', 't4:prune-1', 't5:next-user', 't4:prune-2']);
  assert.equal(mergeLiveItem(entries, ...event, 'chat-b'), entries, 'another chat\'s event changes nothing');
});
