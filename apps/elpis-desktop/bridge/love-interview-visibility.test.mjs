import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoveAgents } from './love-agents.mjs';
import { interviewRuntime } from '../tests/love-interview-runtime.mjs';
import { runAcpNode } from './acp-nodes.mjs';

test('saved interview chats show only the real answers and decoded agent question', async t => {
  const f = await interviewRuntime(); t.after(() => f.close());
  const conversation = [{ role: 'assistant', text: 'What would you like to write?' }, { role: 'user', text: 'A garden letter.' }];
  f.answer('{"question":"Who will read it?"}');
  const result = await runAcpNode(f.nodeSpec({ name: 'Writer', model: 'gpt-6-luna', prompt: 'Writer' }), { task: `Continue the interview. Conversation:\n${JSON.stringify(conversation)}` }, { cwd: f.root, timeoutMs: 5000 });
  const history = await f.client.readThread(result.sessionId);
  assert.doesNotMatch(JSON.stringify(history), /Continue the interview|Conversation:|\\"question\\"/);
  assert.deepEqual(history.data.slice().reverse().map(e => e.item.text ?? e.item.content[0].text), ['What would you like to write?', 'A garden letter.', 'Who will read it?']);
  const first = await f.client.readThread(result.sessionId, { limit: 1 });
  const second = await f.client.readThread(result.sessionId, { limit: 1, cursor: first.nextCursor });
  assert.equal(first.data[0].item.text, 'Who will read it?');
  assert.equal(second.data[0].item.content[0].text, 'A garden letter.');
  assert.doesNotMatch(JSON.stringify(await f.client.listThreads()), /Continue the interview|Conversation:|\\"question\\"/);
  f.answer('{"result":"keep normal task output"}');
  const normal = await runAcpNode(f.nodeSpec({ name: 'Writer', model: 'gpt-6-luna', prompt: 'Writer' }), { task: 'Show an API example.' }, { cwd: f.root, timeoutMs: 5000 });
  assert.equal((await f.client.readThread(normal.sessionId)).data[0].item.text, '{"result":"keep normal task output"}');
  f.answer('{"question":');
  const broken = await runAcpNode(f.nodeSpec({ name: 'Writer', model: 'gpt-6-luna', prompt: 'Writer' }), { task: 'Continue the interview. Conversation:\n[]' }, { cwd: f.root, timeoutMs: 5000 });
  const error = await f.client.readThread(broken.sessionId);
  assert.equal(error.data.length, 1);
  assert.match(error.data[0].item.text, /invalid interview reply/);
  assert.doesNotMatch(JSON.stringify(error), /Continue the interview|Conversation:|\\"question\\"/);
});

test('real ACP interview never exposes an internal user prompt or JSON through desktop history/events', async t => {
  const f = await interviewRuntime(); t.after(() => f.close());
  await f.runner.interview({ id: 'writer', cwd: f.root });
  const chats = await f.client.listThreads();
  const leaked = JSON.stringify({ chats, events: f.visible });
  assert.doesNotMatch(leaked, /Continue the interview|Conversation:|\\"question\\"/, 'the chat screen receives neither the invented user message nor the raw JSON reply');
  assert.deepEqual(chats.data, [], 'interview calls do not create chats');
  assert.deepEqual((await f.agent()).interview.messages, [{ role: 'assistant', text: 'What would you like to write?' }]);
  const calls = f.requests.filter(r => r.method === 'turn/start').length;
  await f.runner.interview({ id: 'writer', cwd: f.root });
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, calls, 'reopening saves/asks the first question once');
  f.answer('{"question":"Who will read it?"}');
  await f.runner.interview({ id: 'writer', cwd: f.root, message: 'A letter about the garden.' });
  f.answer('{"task":"Write a garden letter for my sister."}');
  await f.runner.interview({ id: 'writer', cwd: f.root, message: 'My sister.' });
  const interview = (await f.agent()).interview;
  assert.deepEqual(interview.messages.map(m => [m.role, m.text]), [
    ['assistant', 'What would you like to write?'], ['user', 'A letter about the garden.'],
    ['assistant', 'Who will read it?'], ['user', 'My sister.'],
  ]);
  assert.equal(interview.proposal, 'Write a garden letter for my sister.');
  assert.equal((await f.agent()).task, '');
  assert.deepEqual((await f.client.listThreads()).data, []);
  f.answer('Here is the garden letter.');
  await f.runner.run({ id: 'writer', cwd: f.root, confirm: true });
  const completed = (await f.client.listThreads()).data;
  assert.equal(completed.length, 1, 'only the confirmed execution creates a chat');
  assert.equal(completed[0].turns[0].items[0].content[0].text, interview.proposal);
  assert.equal(completed[0].turns[0].items[1].text, 'Here is the garden letter.');
});

test('malformed replies and protocol errors stay readable and never reach a chat', async t => {
  const f = await interviewRuntime(); t.after(() => f.close());
  for (const reply of ['{"question":', '{"question":"{\\"task\\":\\"leak\\"}"}', '{"task":"{\\"question\\":\\"leak\\"}"}']) {
    f.answer(reply);
    await assert.rejects(f.runner.interview({ id: 'writer', cwd: f.root }), /interview reply/);
    assert.doesNotMatch((await f.agent()).interview.error, /[{}]/);
  }
  f.fail('{"error":{"message":"private wire details"}}');
  await assert.rejects(f.runner.interview({ id: 'writer', cwd: f.root }), /could not ask/i);
  assert.doesNotMatch((await f.agent()).interview.error, /[{}]|private wire details/);
  assert.deepEqual((await f.client.listThreads()).data, []);
  f.answer('{"question":"What would you like to write?"}');
  await f.runner.interview({ id: 'writer', cwd: f.root });
  assert.equal((await f.agent()).interview.messages.length, 1);
});

test('reload during an active interview waits for its saved result without duplicating the answer', async t => {
  const f = await interviewRuntime(); t.after(() => f.close());
  await f.runner.interview({ id: 'writer', cwd: f.root });
  f.hold(); f.answer('{"question":"Who will read it?"}');
  const pending = f.runner.interview({ id: 'writer', cwd: f.root, message: 'A letter.' });
  while (!(await f.agent()).interview.busy) await new Promise(r => setTimeout(r, 10));
  await assert.rejects(f.runner.interview({ id: 'writer', cwd: f.root }), /already interviewing/);
  while (!f.requests.some(r => r.method === 'turn/start' && r.params.input[0].text.includes('A letter.'))) await new Promise(r => setTimeout(r, 10));
  f.resume(); await pending;
  const reopened = createLoveAgents(f.store, { nodeSpec: f.nodeSpec });
  t.after(() => reopened.close());
  await reopened.interview({ id: 'writer', cwd: f.root });
  assert.equal((await f.agent()).interview.messages.length, 3);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 2);
});
