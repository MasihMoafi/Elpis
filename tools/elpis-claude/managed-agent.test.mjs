// managed-agent.mjs's event loop against a scripted client: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKey, parseArgs, runSession } from './managed-agent.mjs';

const sink = () => { const s = { text: '', write: chunk => { s.text += chunk; } }; return s; };
/** A client whose streams replay `scripts` in order (an Error entry drops the stream there); `history` answers list(). */
function client(scripts, history = []) {
  const calls = [];
  const stream = events => ({ async *[Symbol.asyncIterator]() { for (const e of events) { if (e instanceof Error) throw e; yield e; } } });
  return { calls, beta: { sessions: { events: {
    stream: async id => { calls.push(['stream', id]); return stream(scripts.shift() ?? []); },
    send: async (id, body) => { calls.push(['send', body.events[0].type, body.events[0]]); },
    list: id => { calls.push(['list', id]); return stream(history); },
  } } } };
}
const running = { id: 'e1', type: 'session.status_running' };
const say = (id, text) => ({ id, type: 'agent.message', content: [{ type: 'text', text }] });
const idle = (id, type) => ({ id, type: 'session.status_idle', stop_reason: { type } });

test('opens the stream before sending, prints agent text and stops at end_turn', async () => {
  const c = client([[idle('e0', 'end_turn'), running, say('e2', 'Hello '), say('e3', 'there'), idle('e4', 'end_turn'), say('e5', 'never')]]);
  const out = sink();
  assert.equal(await runSession(c, 's1', 'do it', out, sink()), 'end_turn');
  assert.deepEqual(c.calls.slice(0, 2).map(call => call.slice(0, 2)), [['stream', 's1'], ['send', 'user.message']]);
  assert.equal(out.text, 'Hello there', 'an idle before the session runs is not the end; nothing after the end is printed');
});

test('keeps going while the session waits on a tool decision, and denies it', async () => {
  const c = client([[running, { id: 'e2', type: 'agent.tool_use', name: 'bash', evaluated_permission: 'ask' }, idle('e3', 'requires_action'), say('e4', 'ok'), idle('e5', 'end_turn')]]);
  const out = sink();
  assert.equal(await runSession(c, 's1', 'x', out, sink()), 'end_turn');
  const confirmation = c.calls.find(call => call[1] === 'user.tool_confirmation');
  assert.deepEqual([confirmation[2].tool_use_id, confirmation[2].result], ['e2', 'deny']);
  assert.equal(out.text, 'ok');
});

test('a dropped stream reconnects, reads the history once and sends the message once', async () => {
  const c = client([[running, say('e2', 'A'), new Error('socket hang up')], [say('e3', 'B'), idle('e4', 'end_turn')]], [running, say('e2', 'A'), say('e3', 'B')]);
  const out = sink(), log = sink();
  assert.equal(await runSession(c, 's1', 'x', out, log), 'end_turn');
  assert.equal(out.text, 'AB', 'each event is printed once');
  assert.equal(c.calls.filter(call => call[1] === 'user.message').length, 1);
  assert.match(log.text, /reconnecting/);
});

test('the key comes from the environment or the private file, and arguments are checked', () => {
  assert.equal(apiKey({ ANTHROPIC_API_KEY: 'k1' }, '/nonexistent'), 'k1');
  assert.equal(apiKey({}, '/nonexistent'), null);
  assert.throws(() => parseArgs([]), /--message/);
  assert.equal(parseArgs(['--message', 'hi', '--budget-usd', '3']).budgetUsd, 3);
});
