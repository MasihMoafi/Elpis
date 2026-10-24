import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createExperimentLab } from './experiment-lab.mjs';
import { startDesktopServer } from './server.mjs';

const stage = { id: 'answer', title: 'Answer', instruction: 'Answer independently.', kind: 'implement', dependsOn: [] };
const input = () => ({ pattern: 'voting', task: 'What is 19 + 23?', expected: '42', repetitions: 2, stages: [stage] });
class Client extends EventEmitter {
  calls = []; count = 0; prompts = []; auth = 'ChatGPT'; fail = false; hang = false; missingUsage = false;
  // Answer for the nth pattern-arm turn (1-based); the single-agent arm always answers 42.
  patternAnswer = () => '42'; patternTurns = 0;
  async providers() { return { openai: { auth: { state: 'signedIn', method: this.auth } } }; }
  async sideRpc(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { model: params.model, modelProvider: params.modelProvider, thread: { id: `00000000-0000-0000-0000-${String(++this.count).padStart(12, '0')}`, ephemeral: true } };
    if (method === 'turn/start') {
      const prompt = params.input[0].text;
      this.prompts.push(prompt);
      const answer = prompt.includes('Your role: Answer') ? this.patternAnswer(++this.patternTurns) : '42';
      if (!this.hang) setTimeout(() => {
        if (!this.missingUsage) this.emit('side', { method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } } });
        this.emit('side', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ answer, report: 'Computed the sum.' }) } } });
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

test('Restart blocks Lab admission and execution even when the engine reports no active threads', { timeout: 15000 }, async () => {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'lab-restart-'));
  const client = new Client(); client.hang = true; client.close = () => {};
  client.listThreads = async () => ({ data: [], nextCursor: null });
  let release, admitted;
  const admission = new Promise(resolve => { release = resolve; }), admitting = new Promise(resolve => { admitted = resolve; });
  const providers = client.providers.bind(client);
  client.providers = async () => { admitted(); await admission; return providers(); };
  const app = await startDesktopServer({ client, elpisHome: dir, trashFile: path.join(dir, 'trash.json'),
    loveSpot: { directory: path.join(dir, 'drawing'), screenshots: path.join(dir, 'screenshots') } });
  let starting;
  try {
    const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
    const session = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const post = body => fetch(`${url.origin}/api/experiment-lab`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal(await app.canRestart(), true);
    // 24 Oct: chats run in the background service, which outlives the window; a running chat no longer blocks the update.
    client.listThreads = async () => ({ data: [{ id: 'busy-chat', status: { type: 'active' } }], nextCursor: null });
    assert.equal(await app.canRestart(), true, 'a running chat keeps running across the restart');
    starting = post({ ...input(), repetitions: 1 });
    await admitting;
    assert.equal(await app.canRestart(), false, 'Lab is admitting a run before any model thread exists');
    release(); const response = await starting;
    assert.equal(response.status, 200); assert.equal((await response.json()).record.status, 'running');
    assert.equal(await app.canRestart(), false, 'ephemeral Lab work is not represented by thread/list');
    assert.equal((await post({ action: 'stop' })).status, 200);
    assert.equal(await app.canRestart(), true);
    client.auth = 'API key';
    assert.equal((await post(input())).status, 409);
    assert.equal(await app.canRestart(), true, 'a rejected admission releases the guard');
  } finally {
    release(); await starting?.catch(() => {}); await app.close(); execFileSync('gio', ['trash', dir]);
  }
});

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
  const app = await startDesktopServer({ client, staticDir: path.dirname(file), elpisHome: path.dirname(file), trashFile: path.join(path.dirname(file), 'trash.json'),
    loveSpot: { directory: path.join(path.dirname(file), 'drawing'), screenshots: path.join(path.dirname(file), 'screenshots') } });
  t.after(() => app.close());
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const session = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const post = (data, authenticated = true) => fetch(`${url.origin}/api/experiment-lab`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  assert.equal((await post(input(), false)).status, 401);
  assert.equal((await post({ ...input(), repetitions: 0 })).status, 400);
  assert.equal(client.calls.length, 0);
  const initial = await fetch(`${url.origin}/api/experiment-lab`, { headers: { Cookie: cookie } });
  assert.deepEqual(await initial.json(), { record: null, entries: [] });
  const response = await post({ ...input(), repetitions: 1 });
  assert.equal(response.status, 200); const started = await response.json(); assert.equal(started.record.status, 'running');
  assert.deepEqual(started.entries.map(entry => entry.id), [started.record.id]);
  const deadline = Date.now() + 10000;
  let record;
  do {
    const result = await fetch(`${url.origin}/api/experiment-lab`, { headers: { Cookie: cookie } });
    record = (await result.json()).record;
    if (record.trials.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(record.trials.length, 2);
  const selected = await fetch(`${url.origin}/api/experiment-lab?id=${record.id}`, { headers: { Cookie: cookie } });
  assert.equal((await selected.json()).record.id, record.id);
  const missing = await fetch(`${url.origin}/api/experiment-lab?id=missing`, { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.equal((await post({ action: 'stop', unexpected: true })).status, 400);
});

const until = (extra = {}) => ({ ...input(), stopWhen: 'solved', ...extra });

test('until-solved keeps repeating past one turn and stops only when the pattern’s answer passes the check', async () => {
  const { client, lab, file } = await fixture(); client.patternAnswer = n => n < 3 ? '41' : '42';
  await lab.start(until());
  const result = await finish(lab);
  assert.equal(result.status, 'completed'); assert.equal(result.stopReason, 'solved'); assert.equal(result.request.stopWhen, 'solved'); assert.equal(result.request.repetitions, 10);
  assert.equal(result.trials.length, 6, 'three paired repetitions, before the safety stop of ten');
  assert.deepEqual(result.trials.filter(t => t.arm === 'pattern').map(t => t.passed), [false, false, true]);
  assert.ok(result.trials.every(t => t.error === null && t.endedAt));
  assert.equal(client.listenerCount('side'), 0);
  assert.deepEqual(await createExperimentLab({ client, file }).read(), result, 'the chosen mode and outcome survive reopening');
});

test('until-solved never treats a finished turn as a finished task: an unsolved task ends at the cap, saying so', async () => {
  const { client, lab } = await fixture(); client.patternAnswer = () => '41';
  await lab.start(until({ repetitions: 3 }));
  const result = await finish(lab);
  assert.equal(result.status, 'completed'); assert.equal(result.stopReason, 'limit');
  assert.equal(result.request.repetitions, 10); assert.equal(result.trials.length, 20); assert.ok(result.trials.every(t => t.endedAt && t.error === null));
  assert.ok(result.trials.filter(t => t.arm === 'pattern').every(t => !t.passed));
});

test('until-solved stops at the first failed trial instead of retrying forever', async () => {
  const { client, lab } = await fixture(); client.fail = true;
  await lab.start(until({ repetitions: 10 }));
  const result = await finish(lab);
  assert.equal(result.status, 'failed'); assert.equal(result.stopReason, 'error');
  assert.match(result.error, /rate limited/);
  assert.equal(result.trials.length, 1); assert.equal(client.prompts.length, 1);
});

test('Stop ends an until-solved run as stopped, not solved', async () => {
  const { client, lab } = await fixture({ timeoutMs: 10000 }); client.hang = true;
  await lab.start(until());
  await new Promise(resolve => setTimeout(resolve, 10));
  await lab.stop();
  const result = await finish(lab);
  assert.equal(result.status, 'stopped'); assert.equal(result.stopReason, 'stopped');
  assert.equal(client.listenerCount('side'), 0);
});

test('fixed-count runs ignore the check: every repetition runs even once the pattern passes', async () => {
  const { lab } = await fixture();
  await lab.start({ ...input(), repetitions: 3, stopWhen: 'count' });
  const result = await finish(lab);
  assert.equal(result.trials.length, 6); assert.equal(result.stopReason, 'count');
});

test('an unknown stop condition is refused before any model call', async () => {
  const { client, lab } = await fixture();
  await assert.rejects(lab.start({ ...input(), stopWhen: 'forever' }), /stop/i);
  assert.equal(client.calls.length, 0);
});

test('until-solved requires no repetition choice and always stores the fixed safety limit; fixed count still uses its number', async () => {
  const { lab } = await fixture();
  await lab.start({ ...until(), repetitions: undefined });
  const solved = await finish(lab);
  assert.equal(solved.request.repetitions, 10);
  await lab.start({ ...input(), stopWhen: 'count', repetitions: 4 });
  const fixed = await finish(lab);
  assert.equal(fixed.request.repetitions, 4); assert.equal(fixed.trials.length, 8);
  await assert.rejects(lab.start({ ...input(), repetitions: undefined, stopWhen: 'count' }), /Repetitions/);
});

test('a new run keeps older results in newest-first history and reopens each by ID', async () => {
  const { lab, client, file } = await fixture();
  await lab.start({ ...input(), repetitions: 1 });
  const first = await finish(lab);
  await lab.start({ ...input(), task: 'Another question?', expected: '43', repetitions: 1 });
  const second = await finish(lab);
  assert.deepEqual((await lab.list()).map(entry => entry.id), [second.id, first.id]);
  assert.deepEqual(await lab.read(first.id), first);
  const reopened = createExperimentLab({ client, file });
  assert.deepEqual(await reopened.read(first.id), first);
  assert.deepEqual(await reopened.read(), second);
});

test('an old single latest record becomes the first saved history entry without losing evidence', async () => {
  const { lab, client, file } = await fixture();
  await lab.start({ ...input(), repetitions: 1 });
  const legacy = await finish(lab);
  await fs.writeFile(file, JSON.stringify(legacy));
  const migrated = createExperimentLab({ client, file });
  assert.deepEqual(await migrated.read(), legacy);
  assert.deepEqual((await migrated.list()).map(entry => entry.id), [legacy.id]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2, records: [legacy] });
});
