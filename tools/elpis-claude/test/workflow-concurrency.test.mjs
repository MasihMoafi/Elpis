import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
import { readWorkflowConcurrency, safeWorkflowConcurrency, saveWorkflowConcurrency } from '../workflow-concurrency.mjs';

test('workflow concurrency has one persisted value and rejects unsupported choices', async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), 'workflow-concurrency-'));
  t.after(() => removeTestTempDir(home));
  assert.equal(readWorkflowConcurrency(home), 4);
  await saveWorkflowConcurrency(home, 1);
  assert.equal(readWorkflowConcurrency(home), 1);
  for (const value of [0, 5, 1.5, '2', null]) await assert.rejects(saveWorkflowConcurrency(home, value));
  assert.equal(readWorkflowConcurrency(home), 1, 'invalid edits leave the saved value intact');
  fs.writeFileSync(path.join(home, 'workflow-concurrency.json'), '{broken');
  assert.throws(() => readWorkflowConcurrency(home), /concurrency/i);
  assert.equal(safeWorkflowConcurrency(home), 1, 'a damaged setting never raises the worker limit');
});
