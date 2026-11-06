// lib/improve-reason.ts: Improve Elpis offers a change only once build and tests passed on the exact commit under review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeBlockedReason } from '../lib/improve-reason.ts';

const passed = { status: 'ready', dirty: false, head: 'abc', checks: { passed: true, head: 'abc', commands: [{ command: 'npm test', code: 0 }] } };

test('a change is usable only when its checks passed on this commit with nothing uncommitted', () => {
  assert.equal(changeBlockedReason(passed, false), '');
  assert.equal(changeBlockedReason(null, false), 'Loading change…');
  assert.equal(changeBlockedReason({ ...passed, status: 'checking' }, false), 'Checking build and tests…');
  assert.equal(changeBlockedReason(passed, true), 'Wait for the current action to finish.');
  assert.equal(changeBlockedReason({ ...passed, dirty: true }, false), 'Commit this change, then run build and tests.');
  assert.equal(changeBlockedReason({ ...passed, checks: null }, false), 'Run build and tests on this commit.');
  assert.equal(changeBlockedReason({ ...passed, head: 'def' }, false), 'The commit changed after checks passed. Run build and tests again.');
});

test('a failed check names the command and its exit code, else the error', () => {
  const failed = commands => ({ ...passed, error: 'Runner crashed', checks: { passed: false, head: 'abc', commands } });
  assert.equal(changeBlockedReason(failed([{ command: 'npm run build', code: 0 }, { command: 'npm test', code: 1 }]), false), 'Check failed: npm test (exit 1). See the output below.');
  assert.equal(changeBlockedReason(failed([]), false), 'Runner crashed');
  assert.equal(changeBlockedReason({ ...failed([]), error: null }, false), 'Build or test checks failed. Run build and tests again.');
});
