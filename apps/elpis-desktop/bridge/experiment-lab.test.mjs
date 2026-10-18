import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createExperimentLab } from './experiment-lab.mjs';
import { startDesktopServer } from './server.mjs';

const stage = { id: 'answer', title: 'Answer', instruction: 'Answer independently.', kind: 'implement', dependsOn: [] };
const input = () => ({ pattern: 'voting', task: 'What is 19 + 23?', expected: '42', repetitions: 2, stages: [stage] });
class Client extends EventEmitter {
  calls = []; count = 0; prompts = []; auth = 'ChatGPT'; fail = false; hang = false; missingUsage = false;
  async providers() { return { openai: { auth: { state: 'signedIn', method: this.auth } } }; }
  async sideRpc(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { model: params.model, modelProvider: params.modelProvider, thread: { id: `00000000-0000-0000-0000-${String(++this.count).padStart(12, '0')}`, ephemeral: true } };
    if (method === 'turn/start') {
      this.prompts.push(params.input[0].text);
      if (!this.hang) setTimeout(() => {
        if (!this.missingUsage) this.emit('side', { method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } } });
        this.emit('side', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ answer: '42', report: 'Computed the sum.' }) } } });
        this.emit('side', { method: 'turn/completed', params: { threadId: params.threadId, turn: { status: this.fail ? 'failed' : 'completed', error: this.fail ? { message: 'rate limited' } : null } } });
      }, 2);
      return { turn: { id: `turn-${params.threadId}` } };
    }
    return {};
  }
}
async function fixture(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-lab-test-'));
  const client = new Client(), file = path.join(dir, 'latest.json');
  const lab = createExperimentLab({ client, file, ...options });
  return { client, lab, file };
}
async function finish(lab) {
  for (let i = 0; i < 100; i++) {
    const value = await lab.read();
    if (value && value.status !== 'running') return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Lab did not finish');
}

test('paired repetitions fix subscription/model/check, alternate order, preserve raw evidence and survive reopening', async () => {
  const { client, lab, file } = await fixture();
  const initial = await lab.start(input());
  const result = await finish(lab);
  assert.equal(result.status, 'completed');
  assert.equal(initial.status, 'running', 'a returned snapshot cannot change underneath a reader');
  assert.deepEqual(result.trials.map(t => t.arm), ['baseline', 'pattern', 'pattern', 'baseline']);
  assert.equal(result.trials.length, 4);
  assert.ok(result.trials.every(t => t.passed === true && t.tokens === 15 && t.elapsedMs >= 0));
  assert.ok(result.trials.every(t => t.steps[0].prompt.includes(input().task) && t.steps[0].output.answer === '42'));
  assert.ok(client.calls.filter(c => c.method === 'thread/start').every(c => c.params.model === 'gpt-6-luna' && c.params.modelProvider === 'openai' && c.params.sandbox === 'read-only' && c.params.config.forced_login_method === 'chatgpt'));
  assert.ok(client.prompts.every(p => !p.includes('Expected answer') && !p.includes('"42"')));
  assert.equal(client.listenerCount('side'), 0);
  assert.deepEqual(await createExperimentLab({ client, file }).read(), result);
});

test('invalid repetitions, loops, missing dependencies, empty board and API-key accounts make no model calls', async () => {
  const { client, lab } = await fixture();
  for (const invalid of [
    { ...input(), repetitions: 0 }, { ...input(), repetitions: 11 }, { ...input(), repetitions: 1.5 },
    { ...input(), expected: ' ' }, { ...input(), stages: [] },
    { ...input(), stages: [{ ...stage, dependsOn: ['absent'] }] },
    { ...input(), stages: [{ ...stage, dependsOn: ['answer'] }] },
    { ...input(), model: 'other' },
  ]) await assert.rejects(lab.start(invalid));
  client.auth = 'API key';
  await assert.rejects(lab.start(input()), /ChatGPT/);
  assert.equal(client.calls.length, 0);
});

test('DAG branches see only ancestors; join waits for both and the expected answer remains private', async () => {
  const { client, lab } = await fixture();
  await lab.start({ ...input(), repetitions: 1, stages: [
    { ...stage, id: 'left', title: 'Left' }, { ...stage, id: 'right', title: 'Right' },
    { ...stage, id: 'join', title: 'Join', dependsOn: ['left', 'right'] },
  ] });
  const record = await finish(lab), steps = record.trials.find(t => t.arm === 'pattern').steps;
  assert.equal(steps.length, 3);
  assert.match(steps[2].prompt, /Left/); assert.match(steps[2].prompt, /Right/);
  assert.doesNotMatch(steps[0].prompt, /Computed the sum/);
  assert.doesNotMatch(steps[1].prompt, /Computed the sum/);
  assert.equal(record.trials.find(t => t.arm === 'pattern').tokens, 45);
  assert.equal(client.listenerCount('side'), 0);
});

test('model failures remain failed observations; absent token usage stays unknown', async () => {
  const { client, lab } = await fixture(); client.fail = true; client.missingUsage = true;
  await lab.start({ ...input(), repetitions: 1 });
  const result = await finish(lab);
  assert.equal(result.trials.length, 2);
  assert.ok(result.trials.every(t => !t.passed && t.tokens === null && /rate limited/.test(t.error)));
  assert.equal(client.listenerCount('side'), 0);
});

test('an incorrect final answer fails its declared check even when every model turn completes', async () => {
  const { lab } = await fixture();
  await lab.start({ ...input(), repetitions: 1, expected: '43' });
  const result = await finish(lab);
  assert.ok(result.trials.every(t => t.answer === '42' && t.passed === false && t.error === null));
});

test('a failed branch blocks its descendants without dropping a successful sibling’s evidence', async () => {
  const { client, lab } = await fixture();
  const rpc = client.sideRpc.bind(client);
  client.sideRpc = async (method, params) => {
    if (method === 'thread/start' && client.count === 2) throw Error('Branch unavailable');
    return rpc(method, params);
  };
  await lab.start({ ...input(), repetitions: 1, stages: [
    { ...stage, id: 'left', title: 'Left' }, { ...stage, id: 'right', title: 'Right' },
    { ...stage, id: 'join', title: 'Join', dependsOn: ['left', 'right'] },
  ] });
  const result = await finish(lab), trial = result.trials.find(t => t.arm === 'pattern');
  assert.equal(trial.passed, false); assert.match(trial.error, /Branch unavailable/);
  assert.equal(trial.steps.length, 2); assert.equal(trial.steps.filter(s => s.output).length, 1);
  assert.equal(client.listenerCount('side'), 0);
});

test('model fallback is refused before a turn starts and the unexpected thread is released', async () => {
  const { client, lab } = await fixture(), rpc = client.sideRpc.bind(client);
  client.sideRpc = async (method, params) => {
    const result = await rpc(method, params);
    return method === 'thread/start' ? { ...result, model: 'unexpected' } : result;
  };
  await lab.start({ ...input(), repetitions: 1 });
  const result = await finish(lab);
  assert.ok(result.trials.every(t => !t.passed && /changed/.test(t.error)));
  assert.equal(client.prompts.length, 0);
  assert.equal(client.calls.filter(c => c.method === 'thread/unsubscribe').length, 2);
  assert.equal(client.listenerCount('side'), 0);
});

test('timeout and Stop interrupt turns, retain partial evidence, reject overlap and detach listeners', async () => {
  for (const stop of [false, true]) {
    const { client, lab } = await fixture({ timeoutMs: stop ? 10000 : 20 }); client.hang = true;
    await lab.start({ ...input(), repetitions: 1 });
    await assert.rejects(lab.start(input()), /running/);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (stop) await lab.stop();
    const result = await finish(lab);
    assert.equal(result.status, stop ? 'stopped' : 'completed');
    assert.ok(result.trials.length > 0);
    assert.ok(client.calls.some(c => c.method === 'turn/interrupt'));
    assert.equal(client.listenerCount('side'), 0);
  }
});

test('an unclean bridge restart marks an unfinished record interrupted instead of running forever', async () => {
  const { file, client } = await fixture();
  await fs.writeFile(file, JSON.stringify({ status: 'running', trials: [], id: 'interrupted' }));
  const record = await createExperimentLab({ client, file }).read();
  assert.equal(record.status, 'interrupted');
});

test('the HTTP route requires a private session, returns the record envelope and validates before calling the model', async t => {
  const { client, file } = await fixture(); client.close = () => {};
  const app = await startDesktopServer({ client, staticDir: path.dirname(file), elpisHome: path.dirname(file), trashFile: path.join(path.dirname(file), 'trash.json') });
  t.after(() => app.close());
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const session = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const post = (data, authenticated = true) => fetch(`${url.origin}/api/experiment-lab`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  assert.equal((await post(input(), false)).status, 401);
  assert.equal((await post({ ...input(), repetitions: 0 })).status, 400);
  assert.equal(client.calls.length, 0);
  const initial = await fetch(`${url.origin}/api/experiment-lab`, { headers: { Cookie: cookie } });
  assert.deepEqual(await initial.json(), { record: null });
  const response = await post({ ...input(), repetitions: 1 });
  assert.equal(response.status, 200); assert.equal((await response.json()).record.status, 'running');
  await new Promise(resolve => setTimeout(resolve, 30));
  const result = await fetch(`${url.origin}/api/experiment-lab`, { headers: { Cookie: cookie } });
  assert.equal((await result.json()).record.trials.length, 2);
  assert.equal((await post({ action: 'stop', unexpected: true })).status, 400);
});
