// lib/run-log.ts: the Workflows run log adds, on each poll, only what changed: a task that finished between polls still
// logs its start, a report is logged once even while the status stays the same, and failures say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskLogLines } from '../lib/run-log.ts';

const name = agent => ({ a: 'Quillon · Answer 1', b: 'Veyra · Answer 2' })[agent] ?? agent;
const texts = lines => lines.map(line => line.text);

test('agents that finish between polls keep their start, task, check and report entries', () => {
  const seen = {}, reported = new Set();
  assert.deepEqual(texts(taskLogLines([{ id: 'a', status: 'pending' }, { id: 'a-check', status: 'pending' }], seen, reported, name, 1)), []);
  assert.deepEqual(texts(taskLogLines([{ id: 'a', status: 'succeeded', result: { summary: 'done' } }, { id: 'a-check', status: 'succeeded' }], seen, reported, name, 2)), [
    'AGENT STARTED · Quillon · Answer 1', 'TASK DONE · Quillon · Answer 1', 'REPORT RECEIVED · DATASTORE CAPTURED · Quillon · Answer 1',
    'CHECK STARTED · Quillon · Answer 1', 'CHECK PASSED · Quillon · Answer 1']);
});

test('a report arriving after its task completed is captured once though the status stays the same', () => {
  const seen = {}, reported = new Set();
  taskLogLines([{ id: 'b', status: 'running' }], seen, reported, name);
  assert.deepEqual(texts(taskLogLines([{ id: 'b', status: 'succeeded' }], seen, reported, name)), ['TASK DONE · Veyra · Answer 2'], 'no report yet');
  assert.deepEqual(texts(taskLogLines([{ id: 'b', status: 'succeeded', result: { relocated: [{ from: 'x.md', to: 'agents/b/x.md' }] } }], seen, reported, name)),
    ['REPORT RECEIVED · DATASTORE CAPTURED · Veyra · Answer 2', 'FILE MOVED INTO ITS FOLDER · x.md → agents/b/x.md · Veyra · Answer 2']);
  assert.deepEqual(texts(taskLogLines([{ id: 'b', status: 'succeeded', result: {} }], seen, reported, name)), [], 'never twice');
});

test('failures and blocked inputs say why, with the fail tone', () => {
  const lines = taskLogLines([{ id: 'a-check', status: 'failed', failureReason: 'The answer file is missing' }, { id: 'b', status: 'blocked' }], {}, new Set(), name);
  assert.deepEqual(lines.map(line => [line.text, line.tone]), [['CHECK FAILED · Quillon · Answer 1 · The answer file is missing', 'fail'], ['INPUT BLOCKED · Veyra · Answer 2', 'fail']]);
});
