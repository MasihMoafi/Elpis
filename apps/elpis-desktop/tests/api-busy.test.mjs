// lib/api.ts: the bridge refuses a second action on a busy chat before doing anything, so a send asks again a moment
// later, a bounded number of times, and then shows the refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/api.ts';

const BUSY = { ok: false, status: 409, json: async () => ({ error: 'Another operation on this conversation is pending' }) };
async function counted(t, reply) {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls = { n: 0 }; globalThis.fetch = async () => reply(++calls.n); return calls;
}

test('a send refused as busy goes through once the other action ends, asking again after each refusal and no more', async t => {
  const calls = await counted(t, n => n < 3 ? BUSY : { ok: true, status: 200, json: async () => ({ sent: true }) });
  assert.deepEqual(await api('/threads/chat-a/turns', { text: 'Make the heading bigger' }), { sent: true });
  assert.equal(calls.n, 3);
});

test('a chat that stays busy gets one try and five more, then the refusal; other errors are not retried', async t => {
  const calls = await counted(t, () => BUSY);
  await assert.rejects(api('/threads/chat-a/turns', { text: 'x' }), /Another operation on this conversation is pending/);
  assert.equal(calls.n, 6);
  calls.n = 0; globalThis.fetch = async () => { calls.n++; return { ok: false, status: 500, json: async () => ({ error: 'Broken' }) }; };
  await assert.rejects(api('/threads/chat-a/turns', { text: 'x' }), /Broken/);
  assert.equal(calls.n, 1);
});
