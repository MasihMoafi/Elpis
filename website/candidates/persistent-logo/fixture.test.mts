import test from 'node:test';
import assert from 'node:assert/strict';
import { accounting, initialState, nextRequest, sentPrefix, windowTokens } from './fixture.mjs';
test('source choice changes admission only at the next request', () => {
  const initial = initialState();
  const pending = { ...initial, selected: false };
  assert.equal(accounting(initial).used, 48_000);
  assert.equal(accounting(pending).used, 48_000);
  assert.equal(accounting(pending).pending, true);
  assert.equal(accounting(nextRequest(pending)).used, 47_200);
  assert.equal(accounting(nextRequest(pending)).pending, false);
});
test('fresh output waits until admission and accounting conserves full capacity', () => {
  const prefix = JSON.stringify(sentPrefix);
  for (const stage of [0, 1, 2]) {
    const result = accounting({ ...initialState(), stage });
    assert.equal(result.used, stage === 2 ? 51_600 : 48_000);
    assert.equal(result.used + result.free, windowTokens);
    assert.equal(result.saved, stage === 2 ? 9_000 : 0);
    assert.equal(JSON.stringify(sentPrefix), prefix);
  }
});
