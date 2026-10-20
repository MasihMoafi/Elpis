import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcpNode } from './acp-nodes.mjs';

// A scripted agent on the official ACP SDK (tools/elpis-claude/test/fake-acp-agent.mjs); it logs what reaches it.
const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function agentSpec(t, name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'agent.jsonl');
  const received = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { dir, received, spec: { name, command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: log, FAKE_ACP_NAME: name, ...extra.env }, ...extra.spec } };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('handshake, model choice and instructions go over ACP; the final answer is the last message', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A', { env: { FAKE_ACP_MODELS: 'm-fast,m-slow' }, spec: { model: 'm-slow', instructions: 'Be exact.' } });
  const updates = [], sessions = [];
  const result = await runAcpNode(a.spec, { task: 'Unique seed 41c9' }, { cwd: a.dir, onUpdate: update => updates.push(update), onSession: id => sessions.push(id) });
  assert.equal(result.answer, 'A(m-slow) answered: Unique seed 41c9');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(sessions, [result.sessionId]);
  const got = a.received();
  assert.equal(got.find(m => m.method === 'initialize').params.protocolVersion, 1);
  const created = got.find(m => m.method === 'session/new').params;
  assert.equal(created.cwd, a.dir);
  assert.deepEqual(created._meta, { systemPrompt: { append: 'Be exact.' } });
  assert.deepEqual(got.find(m => m.method === 'session/set_config_option').params, { sessionId: result.sessionId, configId: 'model', value: 'm-slow' });
  assert.deepEqual(got.find(m => m.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'Unique seed 41c9' }]);
  assert.ok(updates.some(u => u.sessionUpdate === 'tool_call'), 'updates reach the caller as they stream');
  assert.ok(updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Thinking about it.'));
  assert.ok(got.some(m => m.closed), 'the agent process is closed after its answer');
});

test('a model the agent does not offer fails before any prompt', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A', { env: { FAKE_ACP_MODELS: 'm-fast' }, spec: { model: 'm-missing' } });
  await assert.rejects(runAcpNode(a.spec, { task: 'x' }, { cwd: a.dir }), /A does not offer the model m-missing/);
  const b = agentSpec(t, 'B', { spec: { model: 'any' } });
  await assert.rejects(runAcpNode(b.spec, { task: 'x' }, { cwd: b.dir }), /B does not offer a model choice/);
  assert.equal([...a.received(), ...b.received()].some(m => m.method === 'session/prompt'), false);
});

test('instructions go in the prompt for an agent that takes no system prompt', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A', { spec: { instructions: 'Role: critic.', instructionsInPrompt: true } });
  await runAcpNode(a.spec, { task: 'Judge it' }, { cwd: a.dir });
  const got = a.received();
  assert.equal(got.find(m => m.method === 'session/new').params._meta, undefined);
  assert.match(got.find(m => m.method === 'session/prompt').params.prompt[0].text, /^Instructions:\nRole: critic\.\n\nJudge it$/);
});

test('permission requests go to onPermission; the chosen option reaches the agent; no answer rejects', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A');
  const asked = [];
  const allowed = await runAcpNode(a.spec, { task: '[permission] write it' }, { cwd: a.dir, onPermission: request => { asked.push(request); return 'allow_once'; } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolCall.title, 'Write notes.txt');
  assert.deepEqual(asked[0].options.map(o => o.optionId), ['allow_once', 'reject_once']);
  assert.match(allowed.answer, /permission: allow_once/);
  const b = agentSpec(t, 'B');
  const refused = await runAcpNode(b.spec, { task: '[permission] write it' }, { cwd: b.dir });
  assert.match(refused.answer, /permission: reject_once/, 'without a handler the request fails closed');
  assert.deepEqual(b.received().find(m => m.permission).permission, { outcome: 'selected', optionId: 'reject_once' });
  const c = agentSpec(t, 'C');
  await runAcpNode(c.spec, { task: '[permission] write it' }, { cwd: c.dir, onPermission: () => 'not-offered' });
  assert.deepEqual(c.received().find(m => m.permission).permission, { outcome: 'selected', optionId: 'reject_once' }, 'an option the agent did not offer is not sent');
});

test('cancel by signal sends session/cancel and answers a pending permission as cancelled', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A');
  const controller = new AbortController();
  const run = runAcpNode(a.spec, { task: '[hang] wait' }, { cwd: a.dir, signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!a.received().some(m => m.method === 'session/prompt') && Date.now() < deadline) await pause(10);
  assert.ok(a.received().some(m => m.method === 'session/prompt'), 'the fake ACP agent never received the prompt');
  controller.abort();
  await assert.rejects(run, /cancelled/);
  assert.ok(a.received().some(m => m.method === 'session/cancel'));
  const b = agentSpec(t, 'B');
  const waiting = new AbortController();
  const held = runAcpNode(b.spec, { task: '[permission]' }, { cwd: b.dir, signal: waiting.signal, onPermission: () => { setTimeout(() => waiting.abort(), 20); return new Promise(() => {}); } });
  await assert.rejects(held, /cancelled/);
  assert.deepEqual(b.received().find(m => m.permission).permission, { outcome: 'cancelled' });
});

test('a timeout cancels over ACP, and an agent that ignores it is stopped', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A');
  // Include enough time for the SDK handshake when every bridge test file starts together.
  await assert.rejects(runAcpNode(a.spec, { task: '[hang]' }, { cwd: a.dir, timeoutMs: 3000 }), /timed out/);
  assert.ok(a.received().some(m => m.method === 'session/cancel'));
  const b = agentSpec(t, 'B');
  let pid;
  const started = Date.now();
  await assert.rejects(runAcpNode(b.spec, { task: '[ignore-cancel]' }, { cwd: b.dir, timeoutMs: 3000, graceMs: 200, onSpawn: child => { pid = child.pid; } }), /timed out/);
  assert.ok(b.received().some(m => m.method === 'session/cancel'));
  assert.ok(Date.now() - started < 5000);
  assert.equal(alive(pid), false, 'the agent process is gone');
});

test('a crashed node rejects with its exit code and stderr; a missing command is named', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A');
  await assert.rejects(runAcpNode(a.spec, { task: '[crash]' }, { cwd: a.dir }), error => /A exited \(code 5\) before answering/.test(error.message) && /crashed on purpose/.test(error.message) && error.status === 502);
  await assert.rejects(runAcpNode({ name: 'Ghost', command: '/nonexistent/acp-agent', args: [] }, { task: 'x' }, { cwd: a.dir }), /Could not start Ghost/);
});

test('turns that end without a usable answer fail visibly', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A');
  await assert.rejects(runAcpNode(a.spec, { task: '[empty]' }, { cwd: a.dir }), /A finished without an answer/);
  await assert.rejects(runAcpNode(a.spec, { task: '[commentary-only]' }, { cwd: a.dir }), /A finished without an answer/);
  await assert.rejects(runAcpNode(a.spec, { task: '[refuse]' }, { cwd: a.dir }), /A stopped: refusal/);
  await assert.rejects(runAcpNode(a.spec, { task: 'x', inputs: [{ name: 'big', answer: 'y'.repeat(32000) }] }, { cwd: a.dir }), error => error.status === 413);
  assert.equal(a.received().filter(m => m.method === 'session/prompt').length, 3, 'an oversized handoff never starts a turn');
});

test('two nodes: the first final answer arrives in the second node\'s session/prompt', { timeout: 20000 }, async t => {
  const a = agentSpec(t, 'A'), b = agentSpec(t, 'B');
  const first = await runAcpNode(a.spec, { task: 'Unique seed 9d2e' }, { cwd: a.dir });
  const second = await runAcpNode(b.spec, { task: 'Review the source', inputs: [{ name: 'A', answer: first.answer }] }, { cwd: b.dir });
  const prompt = b.received().find(m => m.method === 'session/prompt').params.prompt[0].text;
  assert.ok(prompt.startsWith('Review the source\n\nAnswers from connected agents (source material):\n'));
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('\n[') + 1)), [{ name: 'A', answer: 'A(default) answered: Unique seed 9d2e' }]);
  assert.equal(prompt.includes('Thinking about it.'), false, 'progress text is not handed off');
  assert.match(second.answer, /^B\(default\) answered: Review the source/);
  const alone = agentSpec(t, 'C');
  await runAcpNode(alone.spec, { task: 'Review the source' }, { cwd: alone.dir });
  assert.equal(alone.received().find(m => m.method === 'session/prompt').params.prompt[0].text.includes('9d2e'), false);
});
