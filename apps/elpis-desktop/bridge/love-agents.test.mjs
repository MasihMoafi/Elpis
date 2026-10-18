import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { agentGraph, createLoveAgents } from './love-agents.mjs';

const card = (id, task = 'Do the task') => ({ id, type: 'rectangle', version: 1, versionNonce: 0, customData: { loveAgent: { preset: 'researcher', name: id, prompt: 'Be precise', model: 'gpt-6-luna', provider: 'openai', task } } });
const arrow = (a, b) => ({ id: `${a}-${b}`, type: 'arrow', startBinding: { elementId: a }, endBinding: { elementId: b }, endArrowhead: 'arrow' });
function fixture(elements, { fail = false, timeoutMs = 1000 } = {}) {
  const client = new EventEmitter(), calls = [];
  const scene = { elements, files: {}, appState: {} };
  client.models = async () => ({ data: [{ model: 'gpt-6-luna' }] });
  client.createThread = async body => { calls.push(['create', body]); return { thread: { id: `chat-${calls.length}` } }; };
  client.send = async (id, body) => {
    calls.push(['send', id, body]);
    // Deliberately finish before send's acknowledgement to exercise the subscription race.
    client.emit('event', { type: 'message', data: { method: 'item/completed', params: { threadId: id, turnId: 'turn', item: { type: 'agentMessage', phase: 'final_answer', text: `Answer for ${id}: ${body.text}` } } } });
    client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { id: 'turn', status: fail ? 'failed' : 'completed', error: fail ? { message: 'Fixture failure' } : null } } } });
    return { turn: { id: 'turn' } };
  };
  client.interrupt = async (...args) => { calls.push(['interrupt', ...args]); };
  const store = { read: async () => ({ scene }), save: async incoming => { scene.elements = incoming.elements; return { scene }; } };
  return { runner: createLoveAgents(client, store, { timeoutMs }), client, calls, scene };
}
test('answers follow native arrows, final text and real named chats are saved', async () => {
  const f = fixture([card('a', 'Unique seed'), card('b'), arrow('a', 'b'), card('unrelated')]);
  await f.runner.run({ id: 'a' });
  const sends = f.calls.filter(c => c[0] === 'send');
  assert.equal(sends.length, 2);
  assert.match(sends[1][2].text, /Answer for chat-1: Unique seed/);
  assert.equal(f.calls[0][1].model, 'gpt-6-luna');
  assert.equal(f.calls[0][1].permissions, 'ask');
  assert.equal(f.scene.elements[1].customData.loveAgent.status, 'completed');
  assert.equal(f.scene.elements[1].customData.loveAgent.threadId, 'chat-3');
  assert.equal(f.client.listenerCount('event'), 0);
});
test('loops, missing task and malformed cards fail before creating chats', async () => {
  for (const elements of [[card('a'), card('b'), arrow('a','b'), arrow('b','a')], [card('a', '')], [card('a'), { ...card('b'), customData: { loveAgent: {} } }]]) {
    const f = fixture(elements);
    await assert.rejects(f.runner.run({ id: 'a' }));
    assert.equal(f.calls.length, 0);
  }
});
test('a failed predecessor stops successors and preserves an inspectable error', async () => {
  const f = fixture([card('a'), card('b'), arrow('a','b')], { fail: true });
  await assert.rejects(f.runner.run({ id: 'a' }), /Fixture failure/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.scene.elements[0].customData.loveAgent.status, 'failed');
  assert.match(f.scene.elements[0].customData.loveAgent.error, /Fixture failure/);
});
test('a second run is refused while a board run is active; timeout interrupts', async () => {
  const f = fixture([card('a')], { timeoutMs: 30 });
  f.client.send = async () => ({ turn: { id: 'turn' } });
  const first = f.runner.run({ id: 'a' });
  await assert.rejects(f.runner.run({ id: 'a' }), /already running/);
  await assert.rejects(first, /timed out/);
  assert.equal(f.calls.filter(c => c[0] === 'interrupt').length, 1);
  assert.equal(f.client.listenerCount('event'), 0);
});
test('fan-in includes both named answers and duplicate arrows run a source only once', async () => {
  const f = fixture([card('a','First seed'), card('b','Second seed'), card('sink',''), arrow('a','sink'), arrow('b','sink'), { ...arrow('a','sink'), id: 'duplicate' }]);
  await f.runner.run({ id: 'sink', cwd: '/workspace' });
  const sends = f.calls.filter(c => c[0] === 'send');
  assert.equal(sends.length, 3);
  assert.match(sends[2][2].text, /First seed/); assert.match(sends[2][2].text, /Second seed/);
  assert.match(sends[2][2].text, /"name":"a"/); assert.match(sends[2][2].text, /"name":"b"/);
  assert.equal(f.calls[0][1].cwd, '/workspace');
});
test('deleted cards/arrows and plain lines cannot transfer an answer; reverse arrows do', () => {
  const cards = [card('a'), card('b')];
  for (const edge of [{ ...arrow('a','b'), isDeleted: true }, { ...arrow('a','b'), type: 'line' }, { ...arrow('a','b'), endArrowhead: null }]) assert.equal(agentGraph([...cards, edge], 'a').length, 1);
  const graph = agentGraph([...cards, { ...arrow('b','a'), startArrowhead: 'arrow', endArrowhead: null }], 'b');
  assert.deepEqual(graph.map(n => n.id), ['a','b']);
});
test('commentary is never passed off as a final answer, even on a completed turn', async () => {
  const f = fixture([card('a'), card('b'), arrow('a','b')]);
  f.client.send = async id => {
    f.client.emit('event', { type: 'message', data: { method: 'item/completed', params: { threadId: id, item: { type: 'agentMessage', phase: 'commentary', text: 'Only progress' } } } });
    f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { status: 'completed', items: [] } } } });
  };
  await assert.rejects(f.runner.run({ id: 'a' }), /without an answer/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});
test('oversized handoffs fail visibly before creating or sending to a successor', async () => {
  const f = fixture([card('a'), card('b'), arrow('a','b')]);
  f.client.send = async id => f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'x'.repeat(32000) }] } } } });
  await assert.rejects(f.runner.run({ id: 'a' }), /Connected answers exceed/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.scene.elements[1].customData.loveAgent.status, 'failed');
});
