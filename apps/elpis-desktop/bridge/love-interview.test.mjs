import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLoveAgents } from './love-agents.mjs';
const fake = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const card = { id: 'a', type: 'rectangle', version: 1, customData: { loveAgent: { preset: 'researcher', name: 'Researcher', prompt: 'ROLE_SEED: careful researcher', task: '', model: 'gpt-6-luna', provider: 'test', interview: { messages: [] } } } };
function fixture(t, answer = { question: 'Which claim should I investigate?' }) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'interview-')), log = path.join(dir, 'acp.jsonl');
  const scene = { elements: [structuredClone(card)], files: {}, appState: {} };
  let spawned = 0;
  const store = { read: async () => ({ scene }), save: async s => Object.assign(scene, s) };
  const runner = createLoveAgents(store, { timeoutMs: 3000, nodeSpec: node => { spawned++; return { name: node.name, command: process.execPath, args: [fake], instructions: node.prompt, env: { FAKE_ACP_LOG: log, FAKE_ACP_ANSWER: typeof answer === 'string' ? answer : JSON.stringify(answer) } }; } });
  t.after(async () => { await runner.close?.(); execFileSync('gio', ['trash', dir]); });
  return { runner, scene, dir, spawned: () => spawned, agent: () => scene.elements[0].customData.loveAgent, log: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
test('first question is from the role ACP agent and persists once without a task run', async t => {
  const f = fixture(t);
  await f.runner.interview({ id: 'a', cwd: f.dir });
  assert.deepEqual(f.agent().interview.messages, [{ role: 'assistant', text: 'Which claim should I investigate?' }]);
  assert.equal(f.agent().task, '');
  assert.match(f.log().find(e => e.method === 'session/new').params._meta.systemPrompt.append, /ROLE_SEED/);
  await f.runner.interview({ id: 'a', cwd: f.dir });
  assert.equal(f.spawned(), 1, 'reopening does not ask again');
  await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }), /task before running/);
});
test('an answer reaches ACP and the proposal stays unaccepted', async t => {
  const f = fixture(t, { task: 'Check ANSWER_SEED using primary sources.' });
  f.agent().interview.messages = [{ role: 'assistant', text: 'What claim?' }];
  await f.runner.interview({ id: 'a', message: 'ANSWER_SEED', cwd: f.dir });
  assert.match(f.log().find(e => e.method === 'session/prompt').params.prompt[0].text, /ANSWER_SEED/);
  assert.equal(f.agent().interview.proposal, 'Check ANSWER_SEED using primary sources.');
  assert.equal(f.agent().task, '');
  assert.equal(f.agent().interview.messages.length, 2);
  await f.runner.run({ id: 'a', cwd: f.dir, confirm: true });
  assert.equal(f.agent().task, 'Check ANSWER_SEED using primary sources.');
  assert.equal(f.agent().status, 'completed');
});
test('malformed answer is visible, retains the reply, and does not invent a question', async t => {
  const f = fixture(t, 'not JSON');
  f.agent().interview.messages = [{ role: 'assistant', text: 'What claim?' }];
  await assert.rejects(f.runner.interview({ id: 'a', message: 'RETAIN_SEED', cwd: f.dir }), /interview reply/);
  assert.equal(f.agent().interview.messages.at(-1).text, 'RETAIN_SEED');
  assert.match(f.agent().interview.error, /interview reply/);
  assert.equal(f.agent().interview.busy, false);
});
test('overlapping interviews on one card refuse a duplicate', async t => {
  const f = fixture(t);
  const first = f.runner.interview({ id: 'a', cwd: f.dir });
  await assert.rejects(f.runner.interview({ id: 'a', cwd: f.dir }), /already/);
  await first; assert.equal(f.spawned(), 1);
});
test('a late answer never restores a deleted card', async t => {
  const f = fixture(t);
  const first = f.runner.interview({ id: 'a', cwd: f.dir });
  const deadline = Date.now() + 2000;
  while (!f.spawned() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.spawned());
  f.scene.elements[0].isDeleted = true;
  await assert.rejects(first, /no longer/);
  assert.equal(f.scene.elements[0].isDeleted, true);
  assert.deepEqual(f.agent().interview.messages, []);
});
test('invalid inputs and an unasked answer never spawn an agent', async t => {
  const f = fixture(t);
  for (const input of [{ id: 'missing' }, { id: 'a', message: '' }, { id: 'a', message: 'x'.repeat(16001) }, { id: 'a', cwd: 'relative' }, { id: 'a', message: 'no prior question' }]) await assert.rejects(f.runner.interview(input));
  assert.equal(f.spawned(), 0);
});
