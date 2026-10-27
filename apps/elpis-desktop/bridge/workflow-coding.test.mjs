import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowRuns } from './workflow-acp.mjs';
import { workflowModelRoutes } from './workflow-models.mjs';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { EventEmitter } from 'node:events';

const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (id, extra = {}) => ({ id, title: id, kind: 'explore', instruction: 'Tiny evidence', dependsOn: [], writeScopes: [], acceptanceCriteria: ['Observed evidence'], ...extra });
async function until(read, check) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (check(value)) return value; await pause(20); }
  assert.fail('Workflow condition did not settle');
}
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wfrun-test-'));
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@elpis.local', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/seed'), 'base'); git('add', 'src/seed'); git('commit', '-qm', 'base');
  const log = id => { const file = path.join(home, `${id}.jsonl`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
  const runnerOptions = { stateDir: path.join(home, 'state'), timeoutMs: 10000,
    nodeSpec: node => { const spec = { name: node.name, command: process.execPath, args: [FAKE], model: node.model?.replace(/^(claude|agy)\//, ''),
      env: { FAKE_ACP_NAME: `${node.provider ?? 'default'}-${node.name}`, FAKE_ACP_MODELS: 'm-fast,m-slow,opus,gpt-6.1-sol,gemini-4-argon-high', FAKE_ACP_EFFORTS: 'low,high', FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
        ...(node.name === 'Mother' ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Reviewed the candidate diff and tests' }) } : {}),
        ...(options.env?.[node.name] ?? {}) } }; return options.nodeSpec?.(node, spec) ?? spec; }, ...options.runner };
  const runs = createWorkflowRuns(runnerOptions);
  t.after(async () => { runs.close(); await until(() => runs.list(), list => list.every(record => record.status !== 'running')); execFileSync('gio', ['trash', home]); });
  const start = (tasks, extra = {}) => runs.start({ rootThreadId: 'root', name: 'Coding team', tasks, maxConcurrency: 2, ...extra }, { cwd, model: 'm-fast', modelProvider: 'openai' });
  const record = async id => (await runs.list()).find(record => record.id === id);
  const finished = id => until(() => record(id), record => record.status !== 'running');
  return { home, cwd, git, log, runs, start, record, finished, runnerOptions, restore: () => createWorkflowRuns(runnerOptions) };
}

test('node models and advertised effort are applied before prompting; unavailable effort fails before work', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const started = await f.start([task('chosen', { provider: 'custom', model: 'm-slow', reasoningEffort: 'high' }), task('unsupported', { reasoningEffort: 'xhigh' })]);
  const result = await f.finished(started.graphId);
  const chosen = result.tasks.find(task => task.id === 'chosen');
  assert.equal(chosen.status, 'succeeded'); assert.match(chosen.result.summary, /custom-chosen\(m-slow\)/);
  const sent = f.log('chosen'), configs = sent.filter(row => row.method === 'session/set_config_option');
  assert.deepEqual(configs.map(row => [row.params.configId, row.params.value]), [['model', 'm-slow'], ['effort', 'high']]);
  assert.equal(result.tasks.find(task => task.id === 'unsupported').status, 'failed');
  assert.match(result.tasks.find(task => task.id === 'unsupported').failureReason, /effort.*xhigh/i);
  assert.equal(f.log('unsupported').some(row => row.method === 'session/prompt'), false);
});

test('all automatic workflow roles and Mother use Full access and log offered decisions; missing allow and verifier scope escape cannot grant more access', { timeout: 20000 }, async t => {
  const env = {};
  for (const id of ['check-implement', 'check-fix', 'verify']) env[id] = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed the requested check' }) };
  env.refused = { FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify([{ optionId: 'deny-only', kind: 'reject_once', name: 'Reject' }]) };
  env.nested = { FAKE_ACP_PERMISSION_SESSION: 'nested-workflow-agent' };
  env.explore = { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/evidence', text: 'workflow evidence' }), FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify([{ optionId: 'grant-this-call', kind: 'allow_once', name: 'Allow this call' }]) };
  const f = fixture(t, { env });
  const tasks = [task('explore'), task('implement', { kind: 'implement', writeScopes: ['src'] }), task('fix', { kind: 'fix', writeScopes: ['src'] }),
    task('check-implement', { kind: 'verify', dependsOn: ['implement'] }), task('check-fix', { kind: 'verify', dependsOn: ['fix'] }), task('verify', { kind: 'verify' }), task('nested'), task('refused')]
    .map(task => ({ ...task, instruction: '[permission]', ...(task.id === 'explore' ? { writeScopes: ['src'] } : {}) }));
  const started = await f.start(tasks, { isolation: 'worktree', autoMerge: true });
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded', completed.error);
  for (const node of [...completed.tasks, completed.mother]) {
    assert.ok(node.permissions?.length, `${node.title} recorded its automatic permission`);
    const calls = f.log(node.title), mode = calls.findIndex(row => row.method === 'session/set_mode');
    assert.equal(calls[mode]?.params.modeId, 'default', `${node.title} keeps the provider's permission checks active`);
    assert.ok(mode < calls.findIndex(row => row.method === 'session/prompt'));
  }
  assert.equal(completed.tasks.find(task => task.id === 'explore').permissions[0].optionId, 'grant-this-call', 'the offered ID is opaque and is never invented');
  assert.equal(completed.tasks.find(task => task.id === 'nested').permissions[0].optionId, 'allow_once', 'the automatic policy also covers this process’s subagents');
  assert.equal(completed.tasks.find(task => task.id === 'refused').permissions[0].optionId, null);
  assert.deepEqual(f.log('refused').find(row => row.permission).permission, { outcome: 'selected', optionId: 'deny-only' });

  const g = fixture(t, { env: { rogue: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/seed', text: 'forbidden verifier edit' }), FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Agent claims a pass' }) } } });
  const rogue = await g.start([task('rogue', { kind: 'verify', instruction: '[permission]' })], { isolation: 'worktree', autoMerge: true });
  const rejected = await g.finished(rogue.graphId);
  assert.equal(rejected.status, 'failed'); assert.match(rejected.tasks[0].failureReason, /outside its write scopes/);
  assert.equal(fs.readFileSync(path.join(g.cwd, 'src/seed'), 'utf8'), 'base');
  assert.equal(rejected.review, undefined, 'a verifier scope escape cannot reach review or merge');
});

test('Mother uses Claude Opus to approve the reviewed commit; a rejected review never merges', { timeout: 20000 }, async t => {
  for (const mode of ['approve', 'reject', 'next-stage']) {
    const approved = mode !== 'reject';
    const f = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'mother review evidence\n' }) }, Mother: { FAKE_ACP_ANSWER: JSON.stringify({ passed: approved, summary: approved ? 'Observed passing checks' : 'Regression remains' }) } } });
    const baseline = f.git('rev-parse', 'HEAD');
    const run = await f.start([task('writer', { writeScopes: ['src'] })], { isolation: 'worktree', autoMerge: mode !== 'next-stage', ...(mode === 'next-stage' ? { next: { name: 'Next stage' } } : {}) });
    const completed = await f.finished(run.graphId);
    assert.equal(completed.mother.model, 'claude/opus');
    assert.equal(f.log('Mother').find(row => row.method === 'session/set_config_option').params.value, 'opus');
    assert.match(f.log('Mother').find(row => row.method === 'session/prompt').params.prompt[0].text, /candidate|commit/i);
    if (approved) {
      assert.equal(completed.status, 'succeeded', completed.error); assert.equal(completed.review.status, 'merged');
      assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'mother review evidence\n');
    } else {
      assert.equal(completed.status, 'failed'); assert.match(completed.error, /Regression remains/);
      assert.equal(f.git('rev-parse', 'HEAD'), baseline); assert.equal(fs.existsSync(path.join(f.cwd, 'src/result')), false);
      // A temporary Mother failure can be retried without rerunning or changing the children's work.
      const before = f.log('writer').length;
      f.runnerOptions.nodeSpec = node => ({ name: node.name, command: process.execPath, args: [FAKE], model: 'opus', env: { FAKE_ACP_MODELS: 'opus', FAKE_ACP_EFFORTS: 'low', FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Rechecked passing candidate' }) } });
      const retried = await f.restore().merge(run.graphId);
      assert.equal(retried.review.status, 'merged');
      assert.equal(retried.review.error, undefined, 'a successful retry clears the previous failure');
      assert.equal(f.log('writer').length, before);
    }
  }
});

test('authenticated HTTP task workflows use Claude Mother by default, expose the run, and refuse invalid or late requests', { timeout: 20000 }, async t => {
  const f = fixture(t, { env: {
    Reproduce: { FAKE_ACP_WRITE: JSON.stringify({ file: 'tests/regression.txt', text: 'failing reproduction' }) },
    Fix: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'fixed' }) },
    Review: { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Independent passing regression' }) },
  } });
  const ROOT = '00000000-0000-0000-0000-000000000001', socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  const root = { id: ROOT, cwd: f.cwd, source: 'cli', model: 'm-fast', modelProvider: 'openai', status: { type: 'idle' } };
  socket.send = raw => {
    const message = JSON.parse(raw); socket.sent.push(message); if (!message.id) return;
    const result = message.method === 'model/list' ? { data: ['m-fast', 'claude/opus', 'gpt-6.1-sol', 'agy/gemini-4-argon-high'].map(model => ({ id: model, model })) }
      : message.method === 'thread/start' ? { thread: { ...root, model: message.params.model ?? root.model } }
      : ['thread/read', 'thread/resume'].includes(message.method) ? { thread: root }
      : ['workGraph/list', 'thread/list'].includes(message.method) ? { data: [] } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: message.id, result })));
  };
  const client = new DesktopClient(socket, { appHome: f.home, archiveDirectory: path.join(f.home, 'archives'), rewindHome: path.join(f.home, 'rewind'), spawnLinksFile: path.join(f.home, 'spawns.json'), githubConnector: { instructions: async () => '' }, workflowOptions: f.runnerOptions });
  await client.initialize();
  const app = await startDesktopServer({ client, elpisHome: f.home, trashFile: path.join(f.home, 'trash.json'), loveSpot: { directory: path.join(f.home, 'drawing'), screenshots: path.join(f.home, 'screenshots') } });
  try {
    const launch = new URL(app.url), origin = launch.origin;
    assert.equal((await fetch(`${origin}/api/workflows/presets`)).status, 401);
    const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get('token') }) });
    const headers = { Origin: origin, Cookie: auth.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
    const request = (route, body) => fetch(`${origin}/api${route}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const presets = await (await request('/workflows/presets')).json();
    assert.deepEqual(presets.data.map(preset => preset.name), ['Fix a bug', 'UI change']);
    assert.ok(presets.data.every(preset => preset.steps.length === 4));
    const invalid = await request('/workflows/presets', { preset: 'missing', goal: 'Tiny task', cwd: f.cwd }); assert.equal(invalid.status, 400);
    assert.equal(socket.sent.some(message => message.method === 'thread/start'), false);
    await client.createThread({ cwd: f.cwd, agents: true });
    assert.equal(socket.sent.findLast(message => message.method === 'thread/start').params.model, 'claude/opus');
    await client.createThread({ cwd: f.cwd });
    assert.equal(socket.sent.findLast(message => message.method === 'thread/start').params.model, undefined, 'ordinary chats keep their default');
    const response = await request('/workflows/presets', { preset: 'bug', goal: 'Tiny test and fix', cwd: f.cwd }); assert.equal(response.status, 200);
    const started = await response.json();
    const completed = await until(async () => (await (await request(`/workflows/${started.graphId}`)).json()).run, record => record.status !== 'running');
    assert.equal(completed.status, 'succeeded', completed.error); assert.equal(completed.review.status, 'merged');
    assert.deepEqual(completed.tasks.map(task => task.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'agy/gemini-4-argon-high']);
    assert.equal(new Set(completed.tasks.map(task => task.cwd)).size, 3);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'fixed');
    assert.equal((await request(`/workflows/${started.graphId}/nodes/fix/messages`, { text: 'Too late' })).status, 409);
    assert.equal((await request(`/workflows/${started.graphId}/merge`, { unexpected: true })).status, 400);
    assert.equal((await request('/workflows/11111111-1111-1111-1111-111111111111')).status, 404);
  } finally { await app.close(); }
});

test('isolated nodes with the same scope run concurrently in different branches; shared-checkout nodes serialize', { timeout: 20000 }, async t => {
  for (const isolated of [true, false]) {
    const f = fixture(t), tasks = ['first', 'second', 'queued'].map(id => task(id, { instruction: '[hang]', writeScopes: ['src'] }));
    const started = await f.start(tasks, isolated ? { isolation: 'worktree' } : {});
    await until(() => f.log('first'), log => log.some(row => row.method === 'session/prompt'));
    if (isolated) await until(() => f.log('second'), log => log.some(row => row.method === 'session/prompt'));
    else { await pause(150); assert.equal(f.log('second').length, 0); }
    assert.equal(f.log('queued').length, 0, 'concurrency cap still applies');
    if (isolated) {
      const record = await f.record(started.graphId), [a, b] = record.tasks;
      assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.worktree.branch, b.worktree.branch);
      assert.equal(f.git('rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: a.cwd, encoding: 'utf8' }).trim());
      assert.equal(f.log('first').find(row => row.method === 'session/new').params.cwd, a.cwd);
    }
    f.runs.cancel('root'); assert.equal((await f.finished(started.graphId)).status, 'cancelled');
    assert.equal(f.log('queued').length, 0);
  }
});

test('live ACP progress survives reload; steering waits for tools and records delivery; ended nodes refuse messages', { timeout: 20000 }, async t => {
  const env = { live: {} }, g = fixture(t, { env });
  const release = path.join(g.home, 'release-tool'), finish = path.join(g.home, 'finish');
  Object.assign(env.live, { FAKE_ACP_TOOL_RELEASE: release, FAKE_ACP_RELEASE: finish });
  const run = await g.start([task('live', { instruction: '[tool-flight] [wait]' })]);
  await until(() => g.log('live'), log => log.some(row => row.toolStarted));
  const running = await g.record(run.graphId);
  assert.ok(running.tasks[0].progress?.some(row => row.text?.includes('Thinking about it.')), 'live text is available before completion');
  assert.ok(running.tasks[0].progress.some(row => row.title === 'Read notes' && row.status === 'in_progress'));
  const accepted = await g.runs.steer(run.graphId, 'live', { id: 'message-1', text: 'Include planted steering evidence.' });
  assert.equal(accepted.message.status, 'pending');
  await pause(80); assert.equal(g.log('live').some(row => row.method === '_session/steering'), false, 'a foreground tool is never interrupted');
  fs.writeFileSync(release, 'release');
  await until(() => g.record(run.graphId), record => record.tasks[0].messages?.[0]?.status === 'delivered');
  const duplicate = await g.runs.steer(run.graphId, 'live', { id: 'message-1', text: 'Include planted steering evidence.' });
  assert.equal(duplicate.message.status, 'delivered');
  assert.equal(g.log('live').filter(row => row.method === '_session/steering').length, 1, 'retries do not deliver twice');
  fs.writeFileSync(finish, 'finish');
  const completed = await g.finished(run.graphId); assert.match(completed.tasks[0].result.summary, /planted steering evidence/);
  await assert.rejects(g.runs.steer(run.graphId, 'live', { text: 'Too late' }), /not running/i);
  const restored = createWorkflowRuns({ stateDir: path.join(g.home, 'state') });
  const saved = (await restored.list())[0];
  assert.deepEqual(saved.tasks[0].progress, completed.tasks[0].progress);
  assert.deepEqual(saved.tasks[0].messages, completed.tasks[0].messages);
  await assert.rejects(restored.steer('missing', 'live', { text: 'No such run' }), /not found/i);
});

test('isolated results expose commits and diff; final review merges only a successful run into its unchanged clean source', { timeout: 20000 }, async t => {
  for (const mode of ['merge', 'dirty', 'advanced', 'failed']) {
    const f = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'planted review evidence\n' }) }, check: { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed planted review evidence' }) } } });
    const baseline = f.git('rev-parse', 'HEAD');
    const started = await f.start([task('writer', { kind: 'implement', writeScopes: ['src'], ...(mode === 'failed' ? { instruction: '[crash]' } : {}) }), task('check', { kind: 'verify', dependsOn: ['writer'] })], { isolation: 'worktree' });
    const result = await f.finished(started.graphId);
    assert.equal(f.git('rev-parse', 'HEAD'), baseline, 'source never changes before review');
    assert.equal(fs.existsSync(path.join(f.cwd, 'src/result')), false);
    if (mode === 'failed') { await assert.rejects(f.runs.merge(started.graphId), /successful|succeeded/i); continue; }
    assert.equal(result.review.status, 'ready');
    const changes = result.tasks[0].result;
    assert.match(changes.diff, /\+planted review evidence/); assert.match(changes.candidateCommit, /^[a-f0-9]{40}$/);
    assert.ok(changes.commits.some(commit => commit.sha === changes.candidateCommit));
    if (mode === 'dirty') fs.writeFileSync(path.join(f.cwd, 'src/seed'), 'user edit');
    if (mode === 'advanced') { fs.writeFileSync(path.join(f.cwd, 'src/seed'), 'new commit'); f.git('add', 'src/seed'); f.git('commit', '-qm', 'source advanced'); }
    // A restarted bridge can merge the persisted candidate, without rerunning any model.
    const restored = f.restore();
    if (mode !== 'merge') {
      const head = f.git('rev-parse', 'HEAD');
      await assert.rejects(restored.merge(started.graphId), /project changed|not merged/i);
      assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(fs.existsSync(path.join(f.cwd, 'src/result')), false);
      assert.equal(fs.readFileSync(path.join(f.cwd, 'src/seed'), 'utf8'), mode === 'dirty' ? 'user edit' : 'new commit');
    } else {
      const merged = await restored.merge(started.graphId); assert.equal(merged.review.status, 'merged');
      assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'planted review evidence\n');
      const head = f.git('rev-parse', 'HEAD'); await restored.merge(started.graphId); assert.equal(f.git('rev-parse', 'HEAD'), head, 'merge retries are idempotent');
    }
  }
});


test('Default workflow nodes skip an exhausted subscription and record their actual healthy route', { timeout: 20000 }, async t => {
  const routes = [{ model: 'claude/opus', provider: 'claude', exhausted: true, reason: 'Weekly usage limit reached' }, { model: 'm-fast', provider: 'openai', exhausted: false }];
  const f = fixture(t, { runner: { modelRoutes: async () => routes } });
  const run = await f.runs.start({ rootThreadId: 'root', name: 'Quota routing', tasks: [task('default-node')] }, { cwd: f.cwd, model: 'claude/opus', modelProvider: 'claude' });
  const completed = await f.finished(run.graphId);
  assert.equal(completed.status, 'succeeded', completed.error);
  assert.deepEqual(completed.tasks[0].routing.requested, { model: 'claude/opus', provider: 'claude' });
  assert.deepEqual(completed.tasks[0].routing.actual, { model: 'm-fast', provider: 'openai' });
  assert.equal(f.log('default-node').some(row => row.method === 'session/set_config_option' && row.params.value === 'opus'), false, 'known exhausted Claude never receives a model turn');
  assert.match(completed.tasks[0].routing.attempts[0].reason, /Weekly/);
});

test('resume preserves successful nodes and the same run while retrying a failed dependent', { timeout: 20000 }, async t => {
  const offline = path.join(os.tmpdir(), `workflow-offline-${process.pid}-${Date.now()}`);
  fs.writeFileSync(offline, 'offline'); t.after(() => { if (fs.existsSync(offline)) execFileSync('gio', ['trash', offline]); });
  const f = fixture(t, { env: { second: { FAKE_ACP_OFFLINE: offline } } });
  const run = await f.start([task('first'), task('second', { dependsOn: ['first'] })]);
  const failed = await f.finished(run.graphId); assert.equal(failed.status, 'failed');
  const original = failed.tasks[0].result, before = f.log('first').filter(row => row.method === 'session/prompt').length;
  execFileSync('gio', ['trash', offline]);
  const resumed = await f.runs.resume(run.graphId, { cwd: f.cwd, model: 'm-fast', modelProvider: 'openai' }, {});
  assert.equal(resumed.graphId, run.graphId, 'recovery keeps the original workflow');
  const completed = await f.finished(run.graphId);
  assert.equal(completed.status, 'succeeded', completed.error);
  assert.deepEqual(completed.tasks[0].result, original, 'successful evidence stays byte-for-byte');
  assert.equal(f.log('first').filter(row => row.method === 'session/prompt').length, before, 'the successful node is not replayed');
  assert.equal(f.log('second').filter(row => row.method === 'session/prompt').length, 2);
});


test('subscription recovery routes exclude API billing, expired limits and managed-provider escapes', () => {
  const models = ['m-fast', 'claude/opus', 'agy/gemini-4-argon-high'].map(model => ({ model }));
  const providers = { openai: { auth: { state: 'signedIn', method: 'API key' }, usage: [] }, claude: { state: 'connected', usage: [{ secondary: { usedPercent: 100, resetsAt: Date.now() / 1000 - 60 } }] }, gemini: { state: 'connected', usage: [] }, openrouter: [{ keySet: true }] };
  const routes = workflowModelRoutes(models, providers, {});
  assert.deepEqual(routes.map(route => route.provider), ['claude', 'agy'], 'a stored API key never authorizes automatic paid fallback');
  assert.equal(routes[0].exhausted, false, 'an expired usage window does not block a fresh allowance');
  assert.deepEqual(workflowModelRoutes(models, providers, { modelProvider: 'claude' }).map(route => route.provider), ['claude'], 'managed connection restrictions apply before routing');
  assert.deepEqual(workflowModelRoutes(models, { ...providers, claude: { state: 'notConnected', signedOut: true }, gemini: { state: 'notConnected' } }, {}), [], 'signed-out subscriptions are unavailable');
});

for (const [error, kind, recovers] of [
  ['Weekly usage limit reached', 'usage_limit_reached', true],
  ['Claude (ACP) error: You have hit your weekly limit.', 'provider_error', true],
  ['Weekly report failed because the file is missing', 'provider_error', false],
  ['Please review the weekly limit documentation', 'provider_error', false],
]) test(`quota recovery classifies ${error} without replaying unrelated failures`, { timeout: 20000 }, async t => {
  let f;
  f = fixture(t, { runner: {
    modelRoutes: async () => [{ model: 'claude/opus', provider: 'claude' }, { model: 'm-fast', provider: 'openai' }],
    nodeSpec: node => ({ name: node.name, command: process.execPath, args: [FAKE], model: node.model.replace(/^(claude|agy)\//, ''), env: {
      FAKE_ACP_NAME: `${node.provider}-${node.name}`, FAKE_ACP_MODELS: 'opus,m-fast', FAKE_ACP_LOG: path.join(f.home, `${node.name}.jsonl`),
      ...(node.provider === 'claude' ? { FAKE_ACP_PROMPT_ERROR: error, FAKE_ACP_ERROR_KIND: kind } : {}),
    } }),
  } });
  const started = await f.start([task('limited', { model: 'claude/opus', provider: 'claude' })]);
  const completed = await f.finished(started.graphId), node = completed.tasks[0];
  assert.equal(completed.status, recovers ? 'succeeded' : 'failed', completed.error);
  assert.deepEqual(node.routing.attempts.map(attempt => [attempt.provider, attempt.status]), recovers ? [['claude', 'failed'], ['openai', 'succeeded']] : [['claude', 'failed']]);
  assert.deepEqual(node.routing.actual, recovers ? { model: 'm-fast', provider: 'openai' } : { model: 'claude/opus', provider: 'claude' });
  assert.ok(node.routing.attempts[0].reason.includes(error));
  assert.equal(f.log('limited').filter(row => row.method === 'session/prompt').length, recovers ? 2 : 1, 'only quota failures reach another subscription');
  if (recovers) assert.equal(completed.mother, undefined, 'successful quota recovery does not create an unnecessary supervisor turn');
});

test('Mother actually steers a running sibling after a node fails without blindly replaying the failed operation', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env });
  const offline = path.join(f.home, 'offline'), release = path.join(f.home, 'tool-release'), finish = path.join(f.home, 'finish'); fs.writeFileSync(offline, 'offline');
  env.bad = { FAKE_ACP_OFFLINE: offline };
  env.live = { FAKE_ACP_TOOL_RELEASE: release, FAKE_ACP_HOLD_TOOL: '1', FAKE_ACP_RELEASE: finish, FAKE_ACP_HOLD_TURN: '1' };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'steer', taskId: 'live', message: 'Include MOTHER_GUIDANCE_2710 in your final evidence.', reason: 'The independent sibling can finish while the unavailable node waits for manual recovery.' }) };
  const started = await f.start([task('seed'), task('live', { instruction: 'Continue the independent work.' }), task('bad', { dependsOn: ['seed'] })]);
  await until(() => f.log('Mother'), log => log.some(row => row.method === 'session/prompt'));
  assert.equal(f.log('live').some(row => row.method === '_session/steering'), false, 'Mother waits for a foreground tool before steering');
  fs.writeFileSync(release, 'done');
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.decision === 'steer' && decision.delivery === 'currentTurn'));
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'failed', 'the genuinely failed node remains visible for recovery');
  assert.match(completed.tasks.find(node => node.id === 'live').result.summary, /MOTHER_GUIDANCE_2710/);
  const decision = completed.mother.decisions.find(decision => decision.decision === 'steer');
  assert.equal(decision.taskId, 'live'); assert.equal(decision.delivery, 'currentTurn');
  assert.equal(f.log('Mother').filter(row => row.method === 'session/prompt').length, 1, 'supervision is one bounded actual ACP decision');
  assert.equal(f.log('bad').filter(row => row.method === 'session/prompt').length, 1, 'a generic provider failure never blindly replays the operation');
});

test('isolated workflow recovery keeps successful candidate commits and reuses the failed workspace', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env }), offline = path.join(f.home, 'offline'); fs.writeFileSync(offline, 'offline');
  env.writer = { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/preserved', text: 'preserved candidate evidence' }) };
  env.check = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed preserved candidate evidence' }) };
  env.second = { FAKE_ACP_OFFLINE: offline };
  const started = await f.start([task('writer', { kind: 'implement', writeScopes: ['src'] }), task('check', { kind: 'verify', dependsOn: ['writer'] }), task('second', { dependsOn: ['check'] })], { isolation: 'worktree' });
  const failed = await f.finished(started.graphId); assert.equal(failed.status, 'failed');
  const candidate = failed.tasks[0].result.candidateCommit, workspace = failed.tasks.find(node => node.id === 'second').cwd;
  const calls = f.log('writer').filter(row => row.method === 'session/prompt').length;
  execFileSync('gio', ['trash', offline]);
  const resumed = await f.runs.resume(started.graphId, { cwd: f.cwd, model: 'm-fast', modelProvider: 'openai' });
  assert.equal(resumed.graphId, started.graphId);
  const completed = await f.finished(started.graphId); assert.equal(completed.status, 'succeeded', completed.error);
  assert.equal(completed.tasks[0].result.candidateCommit, candidate);
  assert.equal(completed.tasks.find(node => node.id === 'second').cwd, workspace, 'the failed node continues in its existing worktree');
  assert.equal(f.log('writer').filter(row => row.method === 'session/prompt').length, calls, 'successful writers are never replayed');
  assert.equal(fs.readFileSync(path.join(completed.review.path, 'src/preserved'), 'utf8'), 'preserved candidate evidence');
  assert.equal(fs.existsSync(path.join(f.cwd, 'src/preserved')), false, 'recovery still waits for a verified merge');
});


test('legacy later-round recovery refuses missing feedback evidence without changing saved work', async t => {
  const f = fixture(t), id = randomUUID();
  const retained = { id, rootThreadId: randomUUID(), status: 'failed', round: 2, roundLimit: 3, tasks: [task('legacy', { status: 'failed' })] };
  const file = path.join(f.home, 'state', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, 'utf8');
  const restored = createWorkflowRuns({ stateDir: path.dirname(file) });
  await assert.rejects(restored.resume(id, { cwd: f.cwd }, {}), /earlier-round evidence/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.log('legacy').length, 0, 'no node is replayed with missing feedback');
});


test('recovery refuses an independently resumed assigned agent without changing the saved run', async t => {
  const f = fixture(t), id = randomUUID(), rootThreadId = randomUUID(), childId = randomUUID();
  const retained = { id, rootThreadId, status: 'failed', round: 1, projectCwd: f.cwd, tasks: [task('evidence', { assignedThreadId: childId, status: 'failed' })] };
  const file = path.join(f.home, 'state', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, 'utf8');
  const restored = createWorkflowRuns({ ...f.runnerOptions, observeThread: async threadId => ({ id: threadId, status: { type: threadId === childId ? 'active' : 'idle' } }) });
  t.after(() => restored.close());
  await assert.rejects(restored.resume(id, { cwd: f.cwd }), /already working/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'status and recovery model remain untouched');
  assert.equal(f.log('evidence').length, 0, 'recovery does not start another agent');
});


for (const failure of ['failed verification', 'invalid verification', 'corrected verification', 'out-of-scope candidate']) test(`Mother supervises ${failure} with one visible corrective decision`, { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env });
  env.evidence = failure === 'out-of-scope candidate'
    ? { FAKE_ACP_WRITE: JSON.stringify({ file: 'outside-report', text: 'Preserve this rejected candidate' }) }
    : { FAKE_ACP_ANSWER: failure === 'failed verification' ? JSON.stringify({ passed: false, summary: 'Required evidence is missing' }) : 'No structured verification evidence' };
  if (failure === 'corrected verification') {
    let attempts = 0;
    Object.defineProperty(env, 'evidence', { get: () => ({ FAKE_ACP_ANSWER: JSON.stringify({ passed: ++attempts > 1, summary: 'Observed the requested evidence after focused correction' }) }) });
  }
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'retry', taskId: 'evidence', instruction: 'Inspect the failed evidence and correct only the existing scope.', reason: 'The retained result needs one focused correction.' }) };
  const started = await f.start([task('evidence', { kind: failure === 'out-of-scope candidate' ? 'explore' : 'verify', writeScopes: failure === 'out-of-scope candidate' ? ['src'] : [] })], failure === 'out-of-scope candidate' ? { isolation: 'worktree' } : {});
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, failure === 'corrected verification' ? 'succeeded' : 'failed');
  assert.equal(completed.mother?.decisions.length, 1, 'Mother makes a single bounded decision even if the correction also fails');
  assert.equal(completed.mother.decisions[0].decision, 'retry');
  assert.equal(f.log('Mother').filter(row => row.method === 'session/prompt').length, 1);
  assert.equal(f.log('evidence').filter(row => row.method === 'session/prompt').length, 2, 'the correction executes exactly once');
  if (failure === 'corrected verification') {
    assert.equal(completed.tasks[0].failureReason, null, 'a corrected task cannot retain a current failure');
    assert.match(completed.tasks[0].result.summary, /Observed the requested evidence/);
    assert.match(f.log('evidence').filter(row => row.method === 'session/prompt')[1].params.prompt[0].text, /Mother's corrective guidance/);
  } else {
    assert.match(completed.tasks[0].failureReason, failure === 'out-of-scope candidate' ? /outside its write scopes/ : /Check failed/);
    assert.equal(completed.tasks[0].result, null);
  }
  if (failure === 'out-of-scope candidate') {
    assert.equal(fs.readFileSync(path.join(completed.tasks[0].cwd, 'outside-report'), 'utf8'), 'Preserve this rejected candidate');
    assert.equal(fs.existsSync(path.join(f.cwd, 'outside-report')), false, 'rejected work never reaches the source checkout');
  }
});

for (const activeMember of ['nested', 'next-stage', 'unrelated']) test(`recovery checks paginated ${activeMember} work before starting an agent`, async t => {
  let restored;
  t.after(async () => { if (!restored) return; restored.close(); await until(() => restored.list(), list => list.every(record => record.status !== 'running')); });
  const f = fixture(t), id = randomUUID(), rootThreadId = randomUUID(), childId = randomUUID(), nextId = randomUUID();
  const retained = { id, rootThreadId, status: 'failed', round: 1, projectCwd: f.cwd, tasks: [task('evidence', { assignedThreadId: childId, status: 'failed' })], next: { threadId: randomUUID(), tasks: [task('next', { assignedThreadId: nextId, status: 'failed' })] } };
  const file = path.join(f.home, 'state', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, 'utf8'), pages = [];
  restored = createWorkflowRuns({ ...f.runnerOptions,
    observeThread: async threadId => ({ id: threadId, status: { type: threadId === 'foreign' || activeMember === 'next-stage' && threadId === nextId || activeMember === 'nested' && threadId === 'grandchild' ? 'active' : 'idle' } }),
    listThreadDescendants: async options => {
      pages.push(options);
      return options.cursor ? { data: [{ id: 'grandchild', source: { subAgent: { thread_spawn: { parent_thread_id: childId } } }, status: { type: activeMember === 'nested' ? 'active' : 'idle' } }, { id: 'foreign', parentThreadId: rootThreadId, status: { type: 'active' } }], nextCursor: null }
        : { data: [{ id: childId, parentThreadId: rootThreadId, status: { type: 'idle' } }, { id: nextId, parentThreadId: retained.next.threadId, status: { type: 'idle' } }], nextCursor: 'second' };
    },
  });
  if (activeMember !== 'unrelated') {
    await assert.rejects(restored.resume(id, { cwd: f.cwd }), /already working/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'refused recovery preserves the saved run and model');
    assert.equal(f.log('evidence').length, 0);
  } else {
    await restored.resume(id, { cwd: f.cwd });
    await until(() => restored.list(), list => list.every(record => record.status !== 'running'));
    assert.ok(f.log('evidence').some(row => row.method === 'session/prompt'), 'unrelated live work cannot block recovery');
    assert.deepEqual(pages.map(page => page.cursor ?? null), [null, 'second']);
  }
});


const checkpointRoutes = async () => [
  { model: 'm-fast', provider: 'openai', efforts: ['low', 'high'], defaultEffort: 'high' },
  { model: 'claude/opus', provider: 'claude', exhausted: true, efforts: ['low'] },
];
const checkpointDecision = (action = 'steer') => ({ action, taskId: 'live', message: 'Include ACTIVE_MOTHER_EVIDENCE in the current report.', summary: 'Observed the completed read; the report still needs source evidence.', reason: 'The live checkpoint shows that the source check can be made more specific.' });

test('active Mother observes a completed-tool checkpoint and injects useful guidance into the same child turn', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes } }), finish = path.join(f.home, 'finish');
  env.live = { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify(checkpointDecision()) };
  const started = await f.start([task('live')]);
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.kind === 'checkpoint' && decision.status === 'delivered'));
  const working = await f.record(started.graphId);
  assert.equal(working.status, 'running');
  assert.equal(f.log('live').filter(row => row.method === 'session/prompt').length, 1, 'supervision never starts another child turn');
  assert.equal(f.log('live').filter(row => row.method === '_session/steering').length, 1);
  assert.equal(f.log('Mother').filter(row => row.method === 'session/prompt').length, 1);
  assert.ok(f.log('Mother').some(row => row.method === 'session/set_config_option' && row.params.configId === 'model' && row.params.value === 'm-fast'), 'Mother uses the chosen connected subscription');
  assert.ok(f.log('Mother').some(row => row.method === 'session/set_config_option' && row.params.configId === 'effort' && row.params.value === 'low'), 'Mother never inherits the expensive default effort');
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded');
  assert.match(completed.tasks[0].result.summary, /ACTIVE_MOTHER_EVIDENCE/);
  assert.equal(completed.supervisionReviews, 1);
  assert.equal(completed.mother.decisions.find(decision => decision.kind === 'checkpoint').summary, checkpointDecision().summary);
});

for (const race of ['finished', 'cancelled', 'manual']) test(`active Mother discards ${race} guidance without creating or cancelling another child turn`, { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes } });
  const finish = path.join(f.home, 'finish'), motherFinish = path.join(f.home, 'mother-finish');
  env.live = { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify(checkpointDecision()), FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: motherFinish };
  const started = await f.start([task('live')]);
  await until(() => f.log('Mother'), log => log.some(row => row.method === 'session/prompt'));
  if (race === 'manual') {
    await f.runs.steer(started.graphId, 'live', { id: 'human-guidance', text: 'Keep HUMAN_PRIORITY in this report.' });
    await until(() => f.record(started.graphId), record => record.tasks[0].messages?.some(message => message.id === 'human-guidance' && message.status === 'delivered'));
    fs.writeFileSync(motherFinish, 'done');
    await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.kind === 'checkpoint' && decision.status === 'not_delivered'));
    assert.equal((await f.record(started.graphId)).status, 'running', 'discarding stale Mother advice does not stop the child');
    fs.writeFileSync(finish, 'done');
  } else if (race === 'cancelled') f.runs.cancel('root');
  else fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, race === 'cancelled' ? 'cancelled' : 'succeeded');
  const decisions = completed.mother.decisions.filter(decision => decision.kind === 'checkpoint');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, 'not_delivered');
  const injected = f.log('live').filter(row => row.method === '_session/steering');
  assert.equal(injected.length, race === 'manual' ? 1 : 0, 'only explicit human guidance can enter the stale target');
  assert.equal(f.log('live').filter(row => row.method === 'session/prompt').length, 1);
  if (race === 'manual') assert.match(completed.tasks[0].result.summary, /HUMAN_PRIORITY/);
});

for (const unavailable of ['mother-busy', 'no-low-effort']) test(`active Mother skips ${unavailable} without blocking productive child work`, { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: {
    modelRoutes: unavailable === 'no-low-effort' ? async () => [{ model: 'm-fast', provider: 'openai', efforts: ['high'], defaultEffort: 'high' }] : checkpointRoutes,
    observeThread: async id => ({ id, status: { type: unavailable === 'mother-busy' ? 'active' : 'idle' } }),
  } });
  const finish = path.join(f.home, 'finish'); env.live = { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  const started = await f.start([task('live')]);
  await until(() => f.record(started.graphId), record => record.tasks[0].activeReview?.status === 'skipped');
  assert.equal(f.log('Mother').length, 0, 'an unavailable reviewer never starts a model turn');
  assert.equal((await f.record(started.graphId)).status, 'running');
  fs.writeFileSync(finish, 'done');
  assert.equal((await f.finished(started.graphId)).status, 'succeeded');
});

test('active Mother review budget caps observation only and every child still completes', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes } }), finish = path.join(f.home, 'finish');
  for (const id of ['one', 'two', 'three', 'four']) env[id] = { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'continue', summary: 'Observed the live evidence; continue the current scoped work.', reason: 'The checkpoint is consistent with its acceptance criteria.' }) };
  const started = await f.start(['one', 'two', 'three', 'four'].map(id => task(id)), { maxConcurrency: 4 });
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.filter(decision => decision.kind === 'checkpoint' && decision.status === 'observed').length === 3);
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.tasks.filter(task => task.status === 'succeeded').length, 4);
  assert.equal(completed.supervisionReviews, 3);
  assert.equal(f.log('Mother').filter(row => row.method === 'session/prompt').length, 3);
  assert.equal(completed.mother.decisions.filter(decision => decision.kind === 'checkpoint').length, 3);
});

test('active Mother coalesces substantive report chunks without needing a tool or opening a second child turn', { timeout: 20000 }, async t => {
  const textAgent = `const readline=require('node:readline');let held;const send=(v)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+String.fromCharCode(10));const reply=(id,result)=>send({id,result});const update=(text)=>send({method:'session/update',params:{sessionId:'text-session',update:{sessionUpdate:'agent_message_chunk',messageId:'report',content:{type:'text',text}}}});readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')reply(m.id,{protocolVersion:1});else if(m.method==='session/new')reply(m.id,{sessionId:'text-session',configOptions:[{id:'model',type:'select',options:[{value:'m-fast',name:'m-fast'}]}]});else if(m.method==='session/prompt'){held=m.id;for(let n=0;n<12;n++)update('Observed source evidence from the scoped report. ');}else if(m.method==='_session/steering'){reply(m.id,{outcome:'injected'});update(m.params.prompt[0].text);reply(held,{stopReason:'end_turn'});}else if(m.method==='session/cancel'){reply(held,{stopReason:'cancelled'});}else if(m.id!==undefined)reply(m.id,{});});`;
  let f;
  f = fixture(t, { runner: { modelRoutes: checkpointRoutes, nodeSpec: node => node.name === 'Mother'
    ? { name: node.name, command: process.execPath, args: [FAKE], model: node.model, env: { FAKE_ACP_MODELS: 'm-fast', FAKE_ACP_EFFORTS: 'low', FAKE_ACP_LOG: path.join(f.home, 'Mother.jsonl'), FAKE_ACP_ANSWER: JSON.stringify(checkpointDecision()) } }
    : { name: node.name, command: process.execPath, args: ['-e', textAgent], model: node.model } } });
  const started = await f.start([task('live')]);
  await until(() => f.record(started.graphId), record => record.tasks[0].progress?.some(entry => entry.kind === 'text' && entry.text.length >= 240));
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded', completed.error);
  assert.equal(completed.supervisionReviews, 1);
  assert.match(completed.tasks[0].result.summary, /ACTIVE_MOTHER_EVIDENCE/);
  assert.equal(f.log('Mother').filter(row => row.method === 'session/prompt').length, 1, 'many chunks produce one review');
});


test('active Mother drops queued advice when human guidance arrives during the next foreground tool', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes }, nodeSpec: (node, spec) => node.name === 'live' ? { ...spec, instructionsInPrompt: true, instructions: '[tool-race]' } : spec });
  const nextTool = path.join(f.home, 'next-tool'), finish = path.join(f.home, 'finish');
  env.live = { FAKE_ACP_NEXT_TOOL_RELEASE: nextTool, FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify(checkpointDecision()) };
  const started = await f.start([task('live', { instruction: 'Continue the scoped report.' })]);
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.kind === 'checkpoint' && decision.summary));
  assert.equal(f.log('live').some(row => row.method === '_session/steering'), false, 'automatic advice waits for the foreground tool');
  await f.runs.steer(started.graphId, 'live', { id: 'human-during-tool', text: 'Follow HUMAN_AFTER_TOOL and preserve the working tool.' });
  fs.writeFileSync(nextTool, 'done');
  await until(() => f.record(started.graphId), record => record.tasks[0].messages?.some(message => message.id === 'human-during-tool' && message.status === 'delivered'));
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.mother.decisions.find(decision => decision.kind === 'checkpoint').status, 'not_delivered');
  assert.equal(f.log('live').filter(row => row.method === '_session/steering').length, 1, 'only human advice reaches the current turn');
  assert.equal(f.log('live').some(row => row.interruptedTool), false);
  assert.match(completed.tasks[0].result.summary, /HUMAN_AFTER_TOOL/);
  assert.doesNotMatch(completed.tasks[0].result.summary, /ACTIVE_MOTHER_EVIDENCE/);
});

test('active Mother observes manual child-chat revisions without depending on workflow-node messaging', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes } });
  const finish = path.join(f.home, 'finish'), motherFinish = path.join(f.home, 'mother-finish');
  env.live = { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish };
  env.Mother = { FAKE_ACP_ANSWER: JSON.stringify(checkpointDecision()), FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: motherFinish };
  const started = await f.start([task('live')]);
  await until(() => f.log('Mother'), log => log.some(row => row.method === 'session/prompt'));
  const observed = await f.record(started.graphId);
  await f.runs.noteManualSteer('unrelated-chat');
  assert.equal((await f.record(started.graphId)).tasks[0].manualRevision, undefined, 'unrelated manual chats cannot supersede this review');
  await f.runs.noteManualSteer(observed.tasks[0].sessionId);
  fs.writeFileSync(motherFinish, 'done');
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.kind === 'checkpoint' && decision.status === 'not_delivered'));
  assert.equal(f.log('live').some(row => row.method === '_session/steering'), false, 'the owner notification itself never sends a model turn');
  fs.writeFileSync(finish, 'done');
  assert.equal((await f.finished(started.graphId)).status, 'succeeded');
});

test('active Mother review budget remains separate from one useful failure-recovery decision', { timeout: 20000 }, async t => {
  const env = {}, f = fixture(t, { env, runner: { modelRoutes: checkpointRoutes } }), finish = path.join(f.home, 'finish');
  let childAttempts = 0, motherAttempts = 0;
  Object.defineProperty(env, 'live', { get: () => ++childAttempts === 1
    ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: false, summary: 'Source evidence needs a focused correction.' }), FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: finish }
    : { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed the corrected source evidence.' }) } });
  Object.defineProperty(env, 'Mother', { get: () => ({ FAKE_ACP_ANSWER: JSON.stringify(++motherAttempts === 1
    ? { action: 'continue', summary: 'The source check is still running.', reason: 'Wait for its actual verification result.' }
    : { action: 'retry', taskId: 'live', instruction: 'Correct the missing source evidence and verify it once.', reason: 'The observed failed verification identifies a specific missing source.' }) }) });
  const started = await f.start([task('live', { kind: 'verify' })]);
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.kind === 'checkpoint' && decision.status === 'observed'));
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'succeeded', completed.error);
  assert.equal(completed.supervisionReviews, 1);
  assert.equal(completed.mother.decisions.filter(decision => decision.kind === 'checkpoint').length, 1);
  assert.equal(completed.mother.decisions.filter(decision => decision.decision === 'retry').length, 1);
  assert.equal(f.log('live').filter(row => row.method === 'session/prompt').length, 2, 'only the explicit correction starts a replacement attempt');
});
