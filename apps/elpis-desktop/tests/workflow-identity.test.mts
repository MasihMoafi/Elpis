// lib/workflow-identity.ts: a run's chats fold under it once each, in run order, with checks and the Mother marked; its
// row says how the run went.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mts';
const { runSummary, workflowMembers } = await import('../lib/workflow-identity.ts');

const run = (status: string, tasks: NonNullable<import('../lib/workflow-identity.ts').WorkflowRun['tasks']>, extra = {}) => ({ id: 'run-1', rootThreadId: 'root', status, tasks, ...extra });

test('a run row counts a step done only when it and its checks passed, and names a run that ended badly', () => {
  const tasks = [{ id: 'a', kind: 'implement', status: 'succeeded' }, { id: 'a-check', kind: 'verify', dependsOn: ['a'], status: 'succeeded' },
    { id: 'b', kind: 'implement', status: 'succeeded' }, { id: 'b-check', kind: 'verify', dependsOn: ['b'], status: 'failed' }];
  assert.equal(runSummary(run('succeeded', tasks)), '1 of 2 done');
  assert.equal(runSummary(run('failed', tasks)), 'Failed · 1 of 2 done');
  assert.equal(runSummary(run('cancelled', [])), 'Cancelled · 0 of 0 done');
});

test('members are each chat once, in run order, with checks and the Mother marked and the root left out', () => {
  const tasks = [{ id: 'a', title: 'Write', assignedThreadId: 't-a' }, { id: 'c', title: 'Check', kind: 'verify', assignedThreadId: 't-c' },
    { id: 'd', title: '', threads: ['t-a', 't-d'] }, { id: 'e', title: 'Root', assignedThreadId: 'root' }];
  assert.deepEqual(workflowMembers(run('running', tasks, { mother: { sessionId: 't-m' } })), [
    { threadId: 't-a', title: 'Write' }, { threadId: 't-c', title: 'Check', check: true }, { threadId: 't-d', title: 'Step' }, { threadId: 't-m', title: 'Mother agent', mother: true }]);
});
