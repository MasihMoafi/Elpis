// lib/failed-turn.ts: a failed turn's kind decides its card: an overloaded model (its own kind, or HTTP 529 anywhere in
// the details) offers another model; usage and rate limits say so, with the reset time in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureKind, plainResetTime } from '../lib/failed-turn.ts';

test('overload is the server\'s kind or HTTP 529 at any depth; limits are usage or rate limits', () => {
  for (const info of ['serverOverloaded', { httpStatusCode: 529 }, { httpConnectionFailed: { httpStatusCode: 529 } }]) assert.equal(failureKind(info).overloaded, true, JSON.stringify(info));
  assert.deepEqual(failureKind('usageLimitExceeded'), { overloaded: false, usage: true, limited: true });
  assert.deepEqual(failureKind('rateLimitExceeded'), { overloaded: false, usage: false, limited: true }, 'a rate limit offers no model switch');
  assert.deepEqual(failureKind({ httpConnectionFailed: { httpStatusCode: 502 } }), { overloaded: false, usage: false, limited: false });
  assert.deepEqual(failureKind(undefined), { overloaded: false, usage: false, limited: false });
});

test('the reset time reads in words', () => {
  assert.equal(plainResetTime('You hit the limit. Resets in 2h 5m.'), 'You hit the limit. Resets in 2 hours and 5 minutes.');
  assert.equal(plainResetTime('Resets in 1d 3h 1m'), 'Resets in 1 day, 3 hours, and 1 minute');
  assert.equal(plainResetTime('Try again later.'), 'Try again later.');
});
