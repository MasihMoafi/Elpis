import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundProcessesDisabled, listBackgroundProcesses, processView } from '../lib/background-processes.mts';

const job = (id: string) => ({ itemId: id, processId: id, command: `run ${id}`, cwd: '/tmp' });

test('all pages are read and incomplete or repeated pages never mean no processes', async () => {
  const calls: string[] = [];
  const result = await listBackgroundProcesses(async cursor => {
    calls.push(cursor ?? 'first');
    return cursor ? { data: [job('two')], nextCursor: null } : { data: [job('one')], nextCursor: 'next' };
  });
  assert.deepEqual(calls, ['first', 'next']);
  assert.deepEqual(result.map(row => row.processId), ['one', 'two']);
  await assert.rejects(listBackgroundProcesses(async () => ({ data: [], nextCursor: 'same' })));
  await assert.rejects(listBackgroundProcesses(async () => ({ data: null, nextCursor: null })));
  await assert.rejects(listBackgroundProcesses(async () => ({ state: 'disabled' })), BackgroundProcessesDisabled);
});

test('running processes remain inspectable after the turn, with live output and no invented result', () => {
  const entries = [{ turnId: 'ended', item: { id: 'one', type: 'commandExecution', aggregatedOutput: 'working' } }];
  assert.deepEqual(processView([job('one'), job('two')], entries), [
    { ...job('one'), output: 'working' }, { ...job('two'), output: '' },
  ]);
  assert.deepEqual(processView([], entries), [], 'exit is reflected only by a fresh authoritative list');
});
