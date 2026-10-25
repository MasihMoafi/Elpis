import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowRuns } from './workflow-acp.mjs';
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
    nodeSpec: node => ({ name: node.name, command: process.execPath, args: [FAKE], model: node.model?.replace(/^(claude|agy)\//, ''),
      env: { FAKE_ACP_NAME: `${node.provider ?? 'default'}-${node.name}`, FAKE_ACP_MODELS: 'm-fast,m-slow,opus,gpt-6.1-sol,gemini-4-argon-high', FAKE_ACP_EFFORTS: 'low,high', FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
        ...(node.name === 'Mother' ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Reviewed the candidate diff and tests' }) } : {}),
        ...(options.env?.[node.name] ?? {}) } }), ...options.runner };
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
