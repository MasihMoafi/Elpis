import test from 'node:test';
import assert from 'node:assert/strict';
import { liveEventItemKey, mergeHistoryWithLive, mergeLiveItem, runtimeErrorNotice } from '../lib/live-events.ts';

const params = (fields = {}) => ({ threadId: 'chat', turnId: 'turn', itemId: 'cmd', ...fields });

test('command output appears before completion, stays ordered and preserves the recorded command', () => {
  const other = { turnId: 'earlier', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'older' } };
  let entries = [other, { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'build', status: 'inProgress' } }];
  entries = mergeLiveItem(entries, 'item/commandExecution/outputDelta', params({ delta: 'Compiling\n' }), 'chat');
  entries = mergeLiveItem(entries, 'item/commandExecution/outputDelta', params({ delta: 'Checking\n' }), 'chat');
  assert.equal(entries[1].item.aggregatedOutput, 'Compiling\nChecking\n');
  assert.equal(entries[1].item.command, 'build');
  assert.equal(entries[0], other, 'an item with the same ID in another turn stays untouched');
  entries = mergeLiveItem(entries, 'item/completed', params({ item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'Final output', status: 'completed' } }), 'chat');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].item.aggregatedOutput, 'Final output', 'completion is authoritative, not another appended delta');
});

test('early deltas create visible items and reasoning summaries keep their indices', () => {
  let entries = mergeLiveItem([], 'item/commandExecution/outputDelta', params({ delta: 'Working' }), 'chat');
  assert.equal(entries[0].item.type, 'commandExecution');
  entries = mergeLiveItem(entries, 'item/reasoning/summaryTextDelta', params({ itemId: 'reason', summaryIndex: 1, delta: 'Second' }), 'chat');
  entries = mergeLiveItem(entries, 'item/reasoning/summaryTextDelta', params({ itemId: 'reason', summaryIndex: 0, delta: 'First' }), 'chat');
  entries = mergeLiveItem(entries, 'item/reasoning/summaryTextDelta', params({ itemId: 'reason', summaryIndex: 1, delta: ' part' }), 'chat');
  assert.deepEqual(entries[1].item.summary, ['First', 'Second part']);
  entries = mergeLiveItem(entries, 'item/agentMessage/delta', params({ itemId: 'reply', delta: 'Hello' }), 'chat');
  assert.equal(entries[2].item.text, 'Hello', 'ordinary reply streaming stays supported');
  entries = mergeLiveItem(entries, 'item/fileChange/outputDelta', params({ itemId: 'change', delta: 'Patch applied' }), 'chat');
  assert.equal(entries[3].item.output, 'Patch applied');
});

test('unrelated chats, unsupported events and malformed deltas never change the transcript', () => {
  const entries = [{ turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'Keep' } }];
  for (const [method, value] of [
    ['item/commandExecution/outputDelta', params({ threadId: 'other', delta: 'Private' })],
    ['item/commandExecution/outputDelta', params({ delta: 4 })],
    ['item/reasoning/summaryTextDelta', params({ delta: 'Invalid', summaryIndex: -1 })],
    ['item/started', params({ item: {} })],
    ['turn/started', params({ delta: 'Unrelated' })],
  ]) assert.equal(mergeLiveItem(entries, method, value, 'chat'), entries);
});

test('runtime retry and failure notices are readable and missing errors stay absent', () => {
  assert.equal(runtimeErrorNotice({ error: { message: 'Connection interrupted' }, willRetry: true }), 'Connection interrupted — retrying…');
  assert.equal(runtimeErrorNotice({ error: { message: 'Request failed' }, willRetry: false }), 'Request failed');
  assert.equal(runtimeErrorNotice({}), null);
  assert.equal(runtimeErrorNotice({ error: { message: 4 } }), null);
});

test('a delayed history read keeps command and reply completions received after that read began', () => {
  const earlier = { turnId: 'earlier', item: { id: 'reply', type: 'agentMessage', text: 'Stored earlier reply' } };
  const snapshot = [earlier, { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', status: 'inProgress', aggregatedOutput: 'Compiling' } }];
  let current = mergeLiveItem([], 'item/commandExecution/outputDelta', params({ delta: 'Compiling\n' }), 'chat');
  current = mergeLiveItem(current, 'item/completed', params({ item: { id: 'cmd', type: 'commandExecution', status: 'completed', aggregatedOutput: 'Build complete', exitCode: 0 } }), 'chat');
  current = mergeLiveItem(current, 'item/agentMessage/delta', params({ itemId: 'reply', delta: 'It worked' }), 'chat');
  current = mergeLiveItem(current, 'item/completed', params({ item: { id: 'reply', type: 'agentMessage', text: 'It worked. Checks passed.' } }), 'chat');

  const result = mergeHistoryWithLive(current, snapshot, new Set(['turn:cmd', 'turn:reply']));
  assert.deepEqual(result, [earlier, current[0], current[1]], 'an older GET response cannot remove a finished command or final reply');
  assert.equal(result[0], earlier, 'snapshot-only history remains authoritative and ordered');
  assert.equal(snapshot[1].item.status, 'inProgress', 'the input snapshot is not mutated');
});

test('history overlays use the full item key and ignore unrelated changes and untouched stale history', () => {
  const earlier = { turnId: 'earlier', item: { id: 'same', type: 'agentMessage', text: 'Authoritative earlier text' } };
  const later = { turnId: 'turn', item: { id: 'same', type: 'agentMessage', text: 'Snapshot before completion' } };
  const snapshotOnly = { turnId: 'turn', item: { id: 'other', type: 'agentMessage', text: 'Snapshot-only message' } };
  const completed = { turnId: 'turn', item: { id: 'same', type: 'agentMessage', text: 'Final live reply' } };
  const current = [
    { turnId: 'earlier', item: { id: 'same', type: 'agentMessage', text: 'Stale earlier text' } },
    { turnId: 'stale', item: { id: 'discard', type: 'agentMessage', text: 'Not in this history page' } },
    completed,
  ];
  assert.deepEqual(mergeHistoryWithLive(current, [earlier, later, snapshotOnly], new Set(['turn:same', 'unrelated:other'])), [earlier, completed, snapshotOnly]);
});

test('history stays authoritative when no matching event arrived after the read', () => {
  const snapshot = [{ turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'Authoritative snapshot' } }];
  const current = [
    { turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'Stale local reply' } },
    { turnId: 'stale', item: { id: 'old', type: 'agentMessage', text: 'Should not survive' } },
  ];
  assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set()), snapshot);
  assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set(['different:reply'])), snapshot);
});

test('an unbased reply suffix cannot replace its full fetched history item', () => {
  let current = mergeLiveItem([], 'item/agentMessage/delta', params({ itemId: 'reply', delta: 'late ' }), 'chat');
  current = mergeLiveItem(current, 'item/agentMessage/delta', params({ itemId: 'reply', delta: 'suffix' }), 'chat');
  assert.equal(current[0].item.text, 'late suffix', 'early output stays visible before a snapshot exists');
  assert.deepEqual(mergeHistoryWithLive(current, [], new Set(['turn:reply'])), current);

  const snapshot = [{ turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'The full recorded reply so far', phase: 'commentary' } }];
  assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set(['turn:reply'])), snapshot, 'do not replace a recorded prefix or guess how the suffix overlaps it');
});

test('unbased command deltas cannot remove fetched command, cwd or earlier output', () => {
  let current = mergeLiveItem([], 'item/commandExecution/outputDelta', params({ delta: 'recent ' }), 'chat');
  current = mergeLiveItem(current, 'item/commandExecution/outputDelta', params({ delta: 'output' }), 'chat');
  const snapshot = [{ turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'cargo build', cwd: '/workspace', status: 'inProgress', aggregatedOutput: 'Configuring\nCompiling\nRecorded output so far' } }];
  assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set(['turn:cmd'])), snapshot);
  assert.equal(current[0].item.aggregatedOutput, 'recent output', 'reconciliation does not mutate the live input');
});

test('a full start or completion establishes authority after an unbased delta', () => {
  for (const method of ['item/started', 'item/completed']) {
    for (const [deltaMethod, fullItem] of [
      ['item/agentMessage/delta', { id: 'reply', type: 'agentMessage', text: 'Full reply' }],
      ['item/commandExecution/outputDelta', { id: 'cmd', type: 'commandExecution', command: 'build', cwd: '/workspace', aggregatedOutput: 'Full command output', status: method === 'item/completed' ? 'completed' : 'inProgress' }],
    ]) {
      let current = mergeLiveItem([], deltaMethod, params({ itemId: fullItem.id, delta: 'unbased suffix' }), 'chat');
      current = mergeLiveItem(current, method, params({ item: fullItem }), 'chat');
      const snapshot = [{ turnId: 'turn', item: { id: fullItem.id, type: fullItem.type, text: 'Old snapshot', aggregatedOutput: 'Old output' } }];
      assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set([`turn:${fullItem.id}`])), current, `${method} remains authoritative for ${fullItem.type}`);
    }
  }
});

test('deltas with a full baseline retain that baseline and overlay older history', () => {
  for (const [method, fullItem, field] of [
    ['item/agentMessage/delta', { id: 'reply', type: 'agentMessage', text: 'Recorded prefix ' }, 'text'],
    ['item/commandExecution/outputDelta', { id: 'cmd', type: 'commandExecution', command: 'build', cwd: '/workspace', aggregatedOutput: 'Recorded output\n' }, 'aggregatedOutput'],
  ]) {
    const snapshot = [{ turnId: 'turn', item: fullItem }];
    const current = mergeLiveItem(snapshot, method, params({ itemId: fullItem.id, delta: 'new output' }), 'chat');
    const merged = mergeHistoryWithLive(current, snapshot, new Set([`turn:${fullItem.id}`]));
    assert.equal(merged[0].item[field], fullItem[field] + 'new output');
    if (fullItem.type === 'commandExecution') {
      assert.equal(merged[0].item.command, 'build'); assert.equal(merged[0].item.cwd, '/workspace');
    }
  }
});

test('history keeps snapshot order, appends new live items in order and deduplicates full keys', () => {
  const entry = (id, text) => ({ turnId: 'turn', item: { id, type: 'agentMessage', text } });
  const a = entry('a', 'Final snapshot A'), b = entry('b', 'Final live B'), c = entry('c', 'Final live C'), d = entry('d', 'Live D');
  const snapshot = [entry('a', 'Earlier snapshot A'), a, entry('b', 'Snapshot B')];
  const current = [entry('b', 'Earlier live B'), b, entry('c', 'Earlier live C'), c, d];
  assert.deepEqual(mergeHistoryWithLive(current, snapshot, new Set(['turn:b', 'turn:c', 'turn:d'])), [a, b, c, d]);
});

test('event item keys match supported item updates and reject malformed or unrelated events', () => {
  for (const method of ['item/started', 'item/completed']) {
    assert.equal(liveEventItemKey(method, params({ item: { id: 'started', type: 'commandExecution' } })), 'turn:started');
  }
  for (const method of ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/reasoning/summaryTextDelta']) {
    assert.equal(liveEventItemKey(method, params({ delta: 'Output', summaryIndex: 0 })), 'turn:cmd');
  }
  for (const [method, value] of [
    ['turn/started', params()],
    ['toString', params({ delta: 'Not an item event' })],
    ['constructor', params({ delta: 'Not an item event' })],
    ['item/started', params({ item: {} })],
    ['item/completed', params({ item: { id: 'valid' } })],
    ['item/completed', params({ item: { id: '', type: 'agentMessage' } })],
    ['item/agentMessage/delta', params({ turnId: '', delta: 'Invalid' })],
    ['item/agentMessage/delta', params({ itemId: '', delta: 'Invalid' })],
    ['item/agentMessage/delta', params({ delta: 4 })],
    ['item/reasoning/summaryTextDelta', params({ delta: 'Invalid', summaryIndex: -1 })],
    ['item/reasoning/summaryTextDelta', params({ delta: 'Invalid', summaryIndex: 1.5 })],
    ['item/reasoning/summaryTextDelta', params({ delta: 'Invalid', summaryIndex: 1025 })],
  ]) assert.equal(liveEventItemKey(method, value), null);
});
