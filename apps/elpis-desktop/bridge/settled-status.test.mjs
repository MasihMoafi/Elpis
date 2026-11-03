import test from 'node:test';
import assert from 'node:assert/strict';
import { settledStatus } from './client.mjs';

// 3 Nov: after an engine hand-over a chat stayed "Working" with no turn running, hiding Edit and Rewind.
test('a chat listed as working is idle once its newest turn has ended, and stays working while a turn runs', () => {
  const active = { type: 'active', activeFlags: [] };
  for (const status of ['completed', 'interrupted', 'failed']) assert.deepEqual(settledStatus(active, [{ id: 't', status }]), { type: 'idle' }, status);
  assert.equal(settledStatus(active, [{ id: 't', status: 'inProgress' }]), active, 'a running turn keeps it working');
  assert.equal(settledStatus(active, []), active, 'no listed turn yet (a first turn still running) keeps it working');
  assert.equal(settledStatus(active, null), active, 'an unreadable list keeps the status');
  assert.deepEqual(settledStatus({ type: 'idle' }, [{ status: 'inProgress' }]), { type: 'idle' }, 'only "active" is corrected');
});
