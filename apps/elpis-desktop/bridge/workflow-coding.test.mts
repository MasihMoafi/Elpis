import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowRuns } from './workflow-acp.mts';
import { workflowModelRoutes } from './workflow-models.mts';
import { DesktopClient } from './client.mts';
import { startDesktopServer } from './server.mts';
import { EventEmitter } from 'node:events';
import type { StoredTask, WorkflowOptions, WorkflowParams, WorkflowRecord } from './workflow-acp/types.mts';

type NodeSpec = NonNullable<WorkflowOptions['nodeSpec']>;
type FakeLog = { method?: string; params?: { configId?: string; value?: string; modeId?: string; cwd?: string; prompt?: { text: string }[] }; permission?: { outcome: string; optionId: string }; toolStarted?: boolean };
type FixtureOptions = { env?: Record<string, NodeJS.ProcessEnv>; nodeSpec?: (node: Parameters<NodeSpec>[0], spec: ReturnType<NodeSpec>) => ReturnType<NodeSpec> | undefined; runner?: Partial<WorkflowOptions> };
type StartOptions = Omit<Partial<WorkflowParams>, 'next'> & { next?: Record<string, unknown> };
type SocketMessage = { id?: number; method: string; params: Record<string, unknown> };

function required<T>(value: T | null | undefined): T { assert.ok(value); return value; }
function logParams(row: FakeLog | undefined) { return required(required(row).params); }
function logPrompt(row: FakeLog | undefined) { return required(required(logParams(row).prompt)[0]).text; }
// gio trash refuses /tmp, so test roots live where the trash works.
const TEST_ROOT = path.join(os.homedir(), '.cache/elpis-tests'); fs.mkdirSync(TEST_ROOT, { recursive: true });

const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mts', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const task = (id: string, extra: Partial<StoredTask> = {}): WorkflowParams['tasks'][number] => ({ id, title: id, kind: 'explore', instruction: 'Tiny evidence', dependsOn: [], writeScopes: [], acceptanceCriteria: ['Observed evidence'], ...extra });
async function until<T>(read: () => T | Promise<T>, check: (value: T) => unknown): Promise<T> {
  for (let n = 0; n < 300; n++) { const value = await read(); if (check(value)) return value; await pause(20); }
  assert.fail('Workflow condition did not settle');
}
function fixture(t: TestContext, options: FixtureOptions = {}) {
  const home = fs.mkdtempSync(path.join(TEST_ROOT, 'wfrun-test-'));
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@elpis.local', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/seed'), 'base'); git('add', 'src/seed'); git('commit', '-qm', 'base');
  const log = (id: string): FakeLog[] => { const file = path.join(home, `${id}.jsonl`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeLog) : []; };
  const runnerOptions: WorkflowOptions & { nodeSpec: NodeSpec } = { stateDir: path.join(home, 'state'), timeoutMs: 10000,
    nodeSpec: node => { const spec = { name: node.name, command: process.execPath, args: [FAKE], model: node.model?.replace(/^(claude|agy)\//, ''),
      env: { FAKE_ACP_NAME: `${node.provider ?? 'default'}-${node.name}`, FAKE_ACP_MODELS: 'm-fast,m-slow,opus,gpt-6.1-sol,gemini-4-argon-high', FAKE_ACP_EFFORTS: 'low,medium,high', FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
        ...(node.name === 'Mother agent' ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Reviewed the candidate diff and tests' }) } : {}),
        ...(options.env?.[node.name] ?? {}) } }; return options.nodeSpec?.(node, spec) ?? spec; }, ...options.runner };
  const runs = createWorkflowRuns(runnerOptions);
  t.after(async () => { runs.close(); await until(() => runs.list(), list => list.every(record => record.status !== 'running')); execFileSync('gio', ['trash', home]); });
  const start = (tasks: WorkflowParams['tasks'], extra: StartOptions = {}) => runs.start({ rootThreadId: 'root', name: 'Coding team', tasks, maxConcurrency: 2, ...extra } as WorkflowParams, { cwd, model: 'm-fast', modelProvider: 'openai' });
  const record = async (id: string) => { const result = (await runs.list()).find(record => record.id === id); assert.ok(result); return result; };
  const finished = (id: string) => until(() => record(id), record => record.status !== 'running');
  return { home, cwd, git, log, runs, start, record, finished, runnerOptions, restore: () => createWorkflowRuns(runnerOptions) };
}

/** What a run left in its repository: its folder, its `elpis/<id>/` branches and its registered worktrees. */
function leftovers(f: ReturnType<typeof fixture>, id: string) {
  const elpis = `${f.cwd}-elpis`;
  return { folder: fs.existsSync(path.join(elpis, 'workflows', id)), elpis: fs.existsSync(elpis),
    branches: f.git('for-each-ref', '--format=%(refname:short)', `refs/heads/elpis/${id}/`).split('\n').filter(Boolean),
    worktrees: f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ') && line.includes(`/workflows/${id}/`)) };
}
const NOTHING = { folder: false, elpis: false, branches: [], worktrees: [] };

/** A desktop client on the fixture's workflow state, over a stand-in runtime socket whose one chat is ROOT. */
const ROOT = '00000000-0000-0000-0000-000000000001';
function desktopClient(f: ReturnType<typeof fixture>) {
  const socket = new EventEmitter() as EventEmitter & { sent: SocketMessage[]; close: () => void; send: (raw: string) => void }; socket.sent = []; socket.close = () => {};
  const root = { id: ROOT, cwd: f.cwd, source: 'cli', model: 'm-fast', modelProvider: 'openai', status: { type: 'idle' } };
  socket.send = raw => {
    const message = JSON.parse(raw) as SocketMessage; socket.sent.push(message); if (!message.id) return;
    const result = message.method === 'model/list' ? { data: ['m-fast', 'claude/opus', 'gpt-6.1-sol', 'agy/gemini-4-argon-high'].map(model => ({ id: model, model })) }
      : message.method === 'thread/start' ? { thread: { ...root, model: message.params.model ?? root.model } }
      : ['thread/read', 'thread/resume'].includes(message.method) ? { thread: root }
      : ['workGraph/list', 'thread/list'].includes(message.method) ? { data: [] } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: message.id, result })));
  };
  const client = new DesktopClient(socket, { appHome: f.home, archiveDirectory: path.join(f.home, 'archives'), rewindHome: path.join(f.home, 'rewind'), spawnLinksFile: path.join(f.home, 'spawns.json'), githubConnector: { instructions: async () => '' }, workflowOptions: f.runnerOptions });
  return { client, socket };
}

test('node models and advertised effort are applied before prompting; unavailable effort fails before work', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const started = await f.start([task('chosen', { provider: 'custom', model: 'm-slow', reasoningEffort: 'high' }), task('unsupported', { reasoningEffort: 'xhigh' })]);
  const result = await f.finished(started.graphId);
  const chosen = required(result.tasks.find(task => task.id === 'chosen'));
  assert.equal(chosen.status, 'succeeded'); assert.match(required(chosen.result).summary, /custom-chosen\(m-slow\)/);
  const sent = f.log('chosen'), configs = sent.filter(row => row.method === 'session/set_config_option');
  assert.deepEqual(configs.map(row => [logParams(row).configId, logParams(row).value]), [['model', 'm-slow'], ['effort', 'high']]);
  assert.equal(required(result.tasks.find(task => task.id === 'unsupported')).status, 'failed');
  assert.match(required(required(result.tasks.find(task => task.id === 'unsupported')).failureReason), /effort.*xhigh/i);
  assert.equal(f.log('unsupported').some(row => row.method === 'session/prompt'), false);
});

test('all automatic workflow roles and Mother agent use Full access and log offered decisions; missing allow and verifier scope escape cannot grant more access', { timeout: 20000 }, async t => {
  const env: Record<string, NodeJS.ProcessEnv> = {};
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
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  for (const node of [...completed.tasks, required(completed.mother)]) {
    assert.ok(node.permissions?.length, `${node.title} recorded its automatic permission`);
    const calls = f.log(node.title), mode = calls.findIndex(row => row.method === 'session/set_mode');
    assert.equal(calls[mode]?.params?.modeId, 'default', `${node.title} keeps the provider's permission checks active`);
    assert.ok(mode < calls.findIndex(row => row.method === 'session/prompt'));
  }
  assert.equal(required(required(required(completed.tasks.find(task => task.id === 'explore')).permissions)[0]).optionId, 'grant-this-call', 'the offered ID is opaque and is never invented');
  assert.equal(required(required(required(completed.tasks.find(task => task.id === 'nested')).permissions)[0]).optionId, 'allow_once', 'the automatic policy also covers this process’s subagents');
  assert.equal(required(required(required(completed.tasks.find(task => task.id === 'refused')).permissions)[0]).optionId, null);
  assert.deepEqual(required(f.log('refused').find(row => row.permission)).permission, { outcome: 'selected', optionId: 'deny-only' });

  const g = fixture(t, { env: { rogue: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/seed', text: 'forbidden verifier edit' }), FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Agent claims a pass' }) } } });
  const rogue = await g.start([task('rogue', { kind: 'verify', instruction: '[permission]' })], { isolation: 'worktree', autoMerge: true });
  const rejected = await g.finished(rogue.graphId);
  assert.equal(rejected.status, 'failed'); assert.match(required(required(rejected.tasks[0]).failureReason), /outside its write scopes/);
  assert.equal(fs.readFileSync(path.join(g.cwd, 'src/seed'), 'utf8'), 'base');
  assert.equal(rejected.review, undefined, 'a verifier scope escape cannot reach review or merge');
});

// 1 Nov live runs: Haiku saved answer-1.md, then answer-3.md, at the project root instead of in its folder, even after a
// correction, and the Voting run failed. A new file outside the agent's folders is moved into its first folder by Elpis
// itself; changing a file that already exists outside them still fails the agent.
test('a new file saved outside the agent\'s folder is moved into it; an existing file changed outside still fails', { timeout: 20000 }, async t => {
  const pass = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'The answer is in src/answer.md' }) };
  const team = () => [task('writer', { kind: 'implement', writeScopes: ['src'] }), task('check', { kind: 'verify', dependsOn: ['writer'] })];
  const f = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'answer.md', text: 'misplaced' }) }, check: pass } });
  const done = await f.finished((await f.start(team(), { isolation: 'worktree', autoMerge: true })).graphId);
  assert.equal(done.status, 'succeeded', done.error ?? required(done.tasks[0]).failureReason ?? undefined);
  assert.equal(f.log('writer').filter(row => row.method === 'session/prompt').length, 1, 'no extra model turn');
  const writer = required(done.tasks.find(item => item.id === 'writer'));
  assert.deepEqual(required(writer.result).relocated, [{ from: 'answer.md', to: 'src/answer.md' }]);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'src/answer.md'), 'utf8'), 'misplaced');
  assert.equal(fs.existsSync(path.join(f.cwd, 'answer.md')), false, 'nothing lands outside the folder');
  fs.writeFileSync(path.join(f.cwd, 'README.md'), 'base'); f.git('add', 'README.md'); f.git('commit', '-qm', 'readme');
  const g = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/../README.md', text: 'edited outside' }) }, check: pass } });
  fs.writeFileSync(path.join(g.cwd, 'README.md'), 'base'); g.git('add', 'README.md'); g.git('commit', '-qm', 'readme');
  const failed = await g.finished((await g.start(team(), { isolation: 'worktree' })).graphId);
  assert.equal(failed.status, 'failed'); assert.match(required(required(failed.tasks.find(item => item.id === 'writer')).failureReason), /outside its write scopes: README\.md/);
});

test('Mother agent uses Claude Opus to approve the reviewed commit; a rejected review never merges', { timeout: 20000 }, async t => {
  for (const mode of ['approve', 'reject', 'next-stage']) {
    const approved = mode !== 'reject';
    const f = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'mother review evidence\n' }) }, 'Mother agent': { FAKE_ACP_ANSWER: JSON.stringify({ passed: approved, summary: approved ? 'Observed passing checks' : 'Regression remains' }) } } });
    const baseline = f.git('rev-parse', 'HEAD');
    const run = await f.start([task('writer', { writeScopes: ['src'] })], { isolation: 'worktree', autoMerge: mode !== 'next-stage', ...(mode === 'next-stage' ? { next: { name: 'Next stage' } } : {}) });
    const completed = await f.finished(run.graphId);
    assert.equal(required(completed.mother).model, 'claude/opus');
    assert.equal(logParams(f.log('Mother agent').find(row => row.method === 'session/set_config_option')).value, 'opus');
    assert.match(logPrompt(f.log('Mother agent').find(row => row.method === 'session/prompt')), /candidate|commit/i);
    if (approved) {
      assert.equal(completed.status, 'succeeded', completed.error ?? undefined); assert.equal(required(completed.review).status, 'merged');
      assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'mother review evidence\n');
    } else {
      assert.equal(completed.status, 'failed'); assert.match(required(completed.error), /Regression remains/);
      assert.equal(f.git('rev-parse', 'HEAD'), baseline); assert.equal(fs.existsSync(path.join(f.cwd, 'src/result')), false);
      // A temporary Mother failure can be retried without rerunning or changing the children's work.
      const before = f.log('writer').length;
      f.runnerOptions.nodeSpec = node => ({ name: node.name, command: process.execPath, args: [FAKE], model: 'opus', env: { FAKE_ACP_MODELS: 'opus', FAKE_ACP_EFFORTS: 'low', FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Rechecked passing candidate' }) } });
      const retried = await f.restore().merge(run.graphId);
      assert.equal(required(retried.review).status, 'merged');
      assert.equal(retried.review.error, undefined, 'a successful retry clears the previous failure');
      assert.equal(f.log('writer').length, before);
    }
  }
});

test('authenticated HTTP task workflows use Claude Mother agent by default, expose the run, and refuse invalid or late requests', { timeout: 20000 }, async t => {
  const f = fixture(t, { env: {
    Reproduce: { FAKE_ACP_WRITE: JSON.stringify({ file: 'tests/regression.txt', text: 'failing reproduction' }) },
    Fix: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'fixed' }) },
    Review: { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Independent passing regression' }) },
  } });
  const { client, socket } = desktopClient(f);
  await client.initialize();
  const app = await startDesktopServer({ client, elpisHome: f.home, trashFile: path.join(f.home, 'trash.json'), loveSpot: { directory: path.join(f.home, 'drawing'), screenshots: path.join(f.home, 'screenshots') } });
  try {
    const launch = new URL(app.url), origin = launch.origin;
    assert.equal((await fetch(`${origin}/api/workflows/presets`)).status, 401);
    const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get('token') }) });
    const headers = { Origin: origin, Cookie: required(required(auth.headers.get('set-cookie')).split(';')[0]), 'Content-Type': 'application/json' };
    const request = (route: string, body?: unknown) => fetch(`${origin}/api${route}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const presets = await (await request('/workflows/presets')).json() as { data: { name: string; steps: unknown[] }[] };
    assert.deepEqual(presets.data.map(preset => preset.name), ['Fix a bug', 'UI change']);
    assert.ok(presets.data.every(preset => preset.steps.length === 4));
    const invalid = await request('/workflows/presets', { preset: 'missing', goal: 'Tiny task', cwd: f.cwd }); assert.equal(invalid.status, 400);
    assert.equal(socket.sent.some(message => message.method === 'thread/start'), false);
    await client.createThread({ cwd: f.cwd, agents: true });
    assert.equal(required(socket.sent.findLast(message => message.method === 'thread/start')).params.model, 'claude/opus');
    await client.createThread({ cwd: f.cwd });
    assert.equal(required(socket.sent.findLast(message => message.method === 'thread/start')).params.model, undefined, 'ordinary chats keep their default');
    const response = await request('/workflows/presets', { preset: 'bug', goal: 'Tiny test and fix', cwd: f.cwd }); assert.equal(response.status, 200);
    const started = await response.json() as { graphId: string };
    const completed = await until(async () => (await (await request(`/workflows/${started.graphId}`)).json() as { run: WorkflowRecord }).run, record => record.status !== 'running');
    assert.equal(completed.status, 'succeeded', completed.error ?? undefined); assert.equal(required(completed.review).status, 'merged');
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
      const record = await f.record(started.graphId); assert.ok(record);
      const [a, b] = record.tasks; assert.ok(a); assert.ok(b); assert.ok(a.worktree); assert.ok(b.worktree);
      assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.worktree.branch, b.worktree.branch);
      assert.equal(f.git('rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: a.cwd, encoding: 'utf8' }).trim());
      assert.equal(logParams(f.log('first').find(row => row.method === 'session/new')).cwd, a.cwd);
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
  // The fake agent logs the tool before the bridge has recorded its update, so wait for the run record itself.
  const running = await until(() => g.record(run.graphId), record => required(record.tasks[0]).progress?.some(row => row.title === 'Read notes' && row.status === 'in_progress'));
  assert.ok(required(running.tasks[0]).progress?.some(row => row.text?.includes('Thinking about it.')), 'live text is available before completion');
  assert.ok(required(required(running.tasks[0]).progress).some(row => row.title === 'Read notes' && row.status === 'in_progress'));
  const accepted = await g.runs.steer(run.graphId, 'live', { id: 'message-1', text: 'Include planted steering evidence.' });
  assert.equal(accepted.message.status, 'pending');
  await pause(80); assert.equal(g.log('live').some(row => row.method === '_session/steering'), false, 'a foreground tool is never interrupted');
  fs.writeFileSync(release, 'release');
  await until(() => g.record(run.graphId), record => required(record.tasks[0]).messages?.[0]?.status === 'delivered');
  const duplicate = await g.runs.steer(run.graphId, 'live', { id: 'message-1', text: 'Include planted steering evidence.' });
  assert.equal(duplicate.message.status, 'delivered');
  assert.equal(g.log('live').filter(row => row.method === '_session/steering').length, 1, 'retries do not deliver twice');
  fs.writeFileSync(finish, 'finish');
  const completed = await g.finished(run.graphId); assert.match(required(required(completed.tasks[0]).result).summary, /planted steering evidence/);
  await assert.rejects(g.runs.steer(run.graphId, 'live', { text: 'Too late' }), /not running/i);
  const restored = createWorkflowRuns({ stateDir: path.join(g.home, 'state') });
  const saved = (await restored.list())[0];
  assert.ok(saved); assert.ok(required(saved.tasks[0]));
  assert.deepEqual(required(saved.tasks[0]).progress, required(completed.tasks[0]).progress);
  assert.deepEqual(required(saved.tasks[0]).messages, required(completed.tasks[0]).messages);
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
    assert.equal(required(result.review).status, 'ready');
    const changes = required(required(result.tasks[0]).result);
    assert.ok(changes.diff); assert.ok(changes.candidateCommit); assert.ok(changes.commits);
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
      const merged = await restored.merge(started.graphId); assert.equal(required(merged.review).status, 'merged');
      assert.deepEqual(leftovers(f, started.graphId), NOTHING, 'a merged run leaves no worktree, branch or folder');
      assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'planted review evidence\n');
      const head = f.git('rev-parse', 'HEAD'); await restored.merge(started.graphId); assert.equal(f.git('rev-parse', 'HEAD'), head, 'merge retries are idempotent');
    }
  }
});


// Masih, 29 Oct: "so leftovers don't exist". A run's worktrees and branches end when its work has reached the project.
test('a run whose work reached the project, or that had none, leaves no worktree, branch or folder', { timeout: 20000 }, async t => {
  const f = fixture(t, { env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/result', text: 'merged evidence\n' }) } } });
  const empty = await f.finished((await f.start([task('reader')], { isolation: 'worktree' })).graphId);
  assert.equal(empty.status, 'succeeded', empty.error ?? undefined); assert.equal(required(empty.review).status, 'empty');
  assert.ok(required(empty.worktrees).length, 'the run had a worktree to free');
  assert.deepEqual(leftovers(f, empty.id), NOTHING, 'an empty run leaves nothing');
  const merged = await f.finished((await f.start([task('writer', { writeScopes: ['src'] })], { isolation: 'worktree', autoMerge: true })).graphId);
  assert.equal(merged.status, 'succeeded', merged.error ?? undefined); assert.equal(required(merged.review).status, 'merged');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'src/result'), 'utf8'), 'merged evidence\n');
  assert.equal(required(merged.worktrees).length, 2, 'a task worktree and the integration worktree');
  assert.deepEqual(leftovers(f, merged.id), NOTHING, 'a merged run leaves nothing');
});

test('failed and cancelled runs keep their worktrees until they leave History; only their own are freed, and a failed removal retries', { timeout: 30000 }, async t => {
  const f = fixture(t), elpis = `${f.cwd}-elpis`, other = randomUUID(), otherPath = path.join(elpis, 'workflows', other, 'x-r1');
  const failed = await f.finished((await f.start([task('broken', { writeScopes: ['src'], instruction: '[crash]' })], { isolation: 'worktree', rootThreadId: ROOT })).graphId);
  assert.equal(failed.status, 'failed');
  const waiting = await f.start([task('waiter', { writeScopes: ['src'], instruction: '[hang]' })], { isolation: 'worktree', rootThreadId: ROOT });
  await until(() => f.log('waiter'), log => log.some(row => row.method === 'session/prompt'));
  f.runs.cancel(ROOT); const cancelled = await f.finished(waiting.graphId); assert.equal(cancelled.status, 'cancelled');
  for (const run of [failed, cancelled]) {
    assert.equal(required(run.worktrees).length, 1);
    const kept = leftovers(f, run.id);
    assert.ok(kept.folder && fs.existsSync(required(required(run.worktrees)[0]).path), `a ${run.status} run keeps its worktree, so it can resume`);
    assert.deepEqual(kept.branches, [required(required(run.worktrees)[0]).branch]); assert.equal(required(kept.worktrees).length, 1);
  }
  // Another run's worktree, and branches that only look like this run's, are not this run's to free. A record that
  // lists paths outside its own folder cannot reach them either.
  f.git('worktree', 'add', '-q', '-b', `elpis/${other}/x`, otherPath);
  for (const branch of ['elpis-other', `elpis/${failed.id}-copy/x`]) f.git('branch', branch);
  const file = path.join(f.runnerOptions.stateDir, `${failed.id}.json`), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.worktrees.push({ path: otherPath, branch: `elpis/${other}/x` }, { path: f.cwd, branch: 'elpis-other' }); fs.writeFileSync(file, JSON.stringify(saved));
  f.git('worktree', 'lock', required(required(cancelled.worktrees)[0]).path);
  const { client } = desktopClient(f); await client.initialize(); t.after(() => client.close());
  // A removal that Git refuses still removes the run from History, and is recorded.
  assert.deepEqual(await client.removeWorkflowHistory(cancelled.id, {}), { removed: cancelled.id, canUndo: true });
  assert.ok(fs.existsSync(required(required(cancelled.worktrees)[0]).path));
  assert.match((await client.workflowRun(cancelled.id)).run.cleanup?.error ?? '', /locked/);
  assert.ok(fs.existsSync(required(required(failed.worktrees)[0]).path), 'removing one run frees nothing of another');
  f.git('worktree', 'unlock', required(required(cancelled.worktrees)[0]).path);
  await client.removeWorkflowHistory(failed.id, {});
  for (const run of [failed, cancelled]) assert.deepEqual({ ...leftovers(f, run.id), elpis: false }, NOTHING, `the removed ${run.status} run is freed, on retry too`);
  assert.ok(fs.existsSync(path.join(otherPath, 'src/seed')), 'another run keeps its worktree');
  assert.ok(fs.existsSync(path.join(f.cwd, 'src/seed')));
  for (const branch of [`elpis/${other}/x`, 'elpis-other', `elpis/${failed.id}-copy/x`]) assert.equal(f.git('branch', '--list', branch).trim().replace(/^\+ /, ''), branch);
  // Undo brings back the record only; its resume says plainly why it cannot continue.
  assert.equal((await client.undoWorkflowHistory({})).restored, failed.id);
  assert.ok((await client.workflowHistory()).data.some(run => run.id === failed.id));
  await assert.rejects(client.resumeWorkflow(failed.id, {}), /worktrees were removed.*cannot resume/i);
});

test('Default workflow nodes skip an exhausted subscription and record their actual healthy route', { timeout: 20000 }, async t => {
  const routes = [{ model: 'claude/opus', provider: 'claude', exhausted: true, reason: 'Weekly usage limit reached' }, { model: 'm-fast', provider: 'openai', exhausted: false }];
  const f = fixture(t, { runner: { modelRoutes: async () => routes } });
  const run = await f.runs.start({ rootThreadId: 'root', name: 'Quota routing', tasks: [task('default-node')] }, { cwd: f.cwd, model: 'claude/opus', modelProvider: 'claude' });
  const completed = await f.finished(run.graphId);
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  const routing = required(required(completed.tasks[0]).routing);
  assert.deepEqual(routing.requested, { model: 'claude/opus', provider: 'claude' });
  assert.deepEqual(routing.actual, { model: 'm-fast', provider: 'openai' });
  assert.equal(f.log('default-node').some(row => row.method === 'session/set_config_option' && logParams(row).value === 'opus'), false, 'known exhausted Claude never receives a model turn');
  assert.match(required(required(routing.attempts[0]).reason), /Weekly/);
});

test('resume preserves successful nodes and the same run while retrying a failed dependent', { timeout: 20000 }, async t => {
  const offline = path.join(TEST_ROOT, `workflow-offline-${process.pid}-${Date.now()}`);
  fs.writeFileSync(offline, 'offline'); t.after(() => { if (fs.existsSync(offline)) execFileSync('gio', ['trash', offline]); });
  const f = fixture(t, { env: { second: { FAKE_ACP_OFFLINE: offline } } });
  const run = await f.start([task('first'), task('second', { dependsOn: ['first'] })]);
  const failed = await f.finished(run.graphId); assert.equal(failed.status, 'failed');
  const original = required(failed.tasks[0]).result, before = f.log('first').filter(row => row.method === 'session/prompt').length;
  execFileSync('gio', ['trash', offline]);
  const resumed = await f.runs.resume(run.graphId, { cwd: f.cwd, model: 'm-fast', modelProvider: 'openai' }, {});
  assert.equal(resumed.graphId, run.graphId, 'recovery keeps the original workflow');
  const completed = await f.finished(run.graphId);
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  assert.deepEqual(required(completed.tasks[0]).result, original, 'successful evidence stays byte-for-byte');
  assert.equal(f.log('first').filter(row => row.method === 'session/prompt').length, before, 'the successful node is not replayed');
  assert.equal(f.log('second').filter(row => row.method === 'session/prompt').length, 2);
});


test('subscription recovery routes exclude API billing, expired limits and managed-provider escapes', () => {
  const models = ['m-fast', 'claude/opus', 'agy/gemini-4-argon-high'].map(model => ({ model }));
  const providers = { openai: { auth: { state: 'signedIn', method: 'API key' }, usage: [] }, claude: { state: 'connected', usage: [{ secondary: { usedPercent: 100, resetsAt: Date.now() / 1000 - 60 } }] }, gemini: { state: 'connected', usage: [] }, openrouter: [{ keySet: true }] };
  const routes = workflowModelRoutes(models, providers, {});
  assert.deepEqual(routes.map(route => route.provider), ['claude', 'agy'], 'a stored API key never authorizes automatic paid fallback');
  assert.ok(routes[0]);
  assert.equal(routes[0].exhausted, false, 'an expired usage window does not block a fresh allowance');
  assert.deepEqual(workflowModelRoutes(models, providers, { modelProvider: 'claude' }).map(route => route.provider), ['claude'], 'managed connection restrictions apply before routing');
  assert.deepEqual(workflowModelRoutes(models, { ...providers, claude: { state: 'notConnected', signedOut: true }, gemini: { state: 'notConnected' } }, {}), [], 'signed-out subscriptions are unavailable');
});

for (const [error, kind, recovers] of [
  ['Weekly usage limit reached', 'usage_limit_reached', true],
  ['Claude (ACP) error: You have hit your weekly limit.', 'provider_error', true],
  ['Weekly report failed because the file is missing', 'provider_error', false],
  ['Please review the weekly limit documentation', 'provider_error', false],
] as const) test(`quota recovery classifies ${error} without replaying unrelated failures`, { timeout: 20000 }, async t => {
  const preservesPartialWork = error === 'Claude (ACP) error: You have hit your weekly limit.';
  const f: ReturnType<typeof fixture> = fixture(t, { runner: {
    modelRoutes: async () => [{ model: 'claude/opus', provider: 'claude' }, { model: 'm-fast', provider: 'openai' }],
    nodeSpec: node => ({ name: node.name, command: process.execPath, args: [FAKE], model: node.model.replace(/^(claude|agy)\//, ''), env: {
      FAKE_ACP_NAME: `${node.provider}-${node.name}`, FAKE_ACP_MODELS: 'opus,m-fast', FAKE_ACP_LOG: path.join(f.home, `${node.name}.jsonl`),
      ...(node.provider === 'claude' ? { ...(preservesPartialWork ? {
        FAKE_ACP_WRITE: JSON.stringify({ file: 'src/quota-partial', text: 'work from the exhausted subscription' }),
        FAKE_ACP_PROMPT_ERROR_AFTER_WRITE: error,
      } : { FAKE_ACP_PROMPT_ERROR: error }), FAKE_ACP_ERROR_KIND: kind } : preservesPartialWork ? {
        FAKE_ACP_EXPECT: JSON.stringify({ file: 'src/quota-partial', text: 'work from the exhausted subscription' }),
      } : {}),
    } }),
  } });
  const started = await f.start([task('limited', { model: 'claude/opus', provider: 'claude' })]);
  const completed = await f.finished(started.graphId), node = required(completed.tasks[0]);
  const routing = required(node.routing);
  assert.equal(completed.status, recovers ? 'succeeded' : 'failed', completed.error ?? undefined);
  assert.deepEqual(routing.attempts.map(attempt => [attempt.provider, attempt.status]), recovers ? [['claude', 'failed'], ['openai', 'succeeded']] : [['claude', 'failed']]);
  assert.deepEqual(routing.actual, recovers ? { model: 'm-fast', provider: 'openai' } : { model: 'claude/opus', provider: 'claude' });
  assert.ok(required(required(routing.attempts[0]).reason).includes(error));
  assert.equal(f.log('limited').filter(row => row.method === 'session/prompt').length, recovers ? 2 : 1, 'only quota failures reach another subscription');
  if (preservesPartialWork) assert.match(required(node.result).summary, /Read planted result: work from the exhausted subscription/, 'the fallback continues in the same workspace with the first subscription\'s work');
  if (recovers) assert.equal(completed.mother, undefined, 'successful quota recovery does not create an unnecessary supervisor turn');
});

test('Mother agent actually steers a running sibling after a node fails without blindly replaying the failed operation', { timeout: 20000 }, async t => {
  const env: Record<string, NodeJS.ProcessEnv> = {}, f = fixture(t, { env });
  const offline = path.join(f.home, 'offline'), release = path.join(f.home, 'tool-release'), finish = path.join(f.home, 'finish'); fs.writeFileSync(offline, 'offline');
  env.bad = { FAKE_ACP_OFFLINE: offline };
  env.live = { FAKE_ACP_TOOL_RELEASE: release, FAKE_ACP_HOLD_TOOL: '1', FAKE_ACP_RELEASE: finish, FAKE_ACP_HOLD_TURN: '1' };
  env['Mother agent'] = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'steer', taskId: 'live', message: 'Include MOTHER_GUIDANCE_2710 in your final evidence.', reason: 'The independent sibling can finish while the unavailable node waits for manual recovery.' }) };
  const started = await f.start([task('seed'), task('live', { instruction: 'Continue the independent work.' }), task('bad', { dependsOn: ['seed'] })]);
  await until(() => f.log('Mother agent'), log => log.some(row => row.method === 'session/prompt'));
  assert.equal(f.log('live').some(row => row.method === '_session/steering'), false, 'Mother agent waits for a foreground tool before steering');
  fs.writeFileSync(release, 'done');
  await until(() => f.record(started.graphId), record => record.mother?.decisions?.some(decision => decision.decision === 'steer' && decision.delivery === 'currentTurn'));
  fs.writeFileSync(finish, 'done');
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, 'failed', 'the genuinely failed node remains visible for recovery');
  assert.match(required(required(completed.tasks.find(node => node.id === 'live')).result).summary, /MOTHER_GUIDANCE_2710/);
  const decision = required(required(completed.mother).decisions.find(decision => decision.decision === 'steer'));
  assert.equal(decision.taskId, 'live'); assert.equal(decision.delivery, 'currentTurn');
  assert.equal(f.log('Mother agent').filter(row => row.method === 'session/prompt').length, 1, 'supervision is one bounded actual ACP decision');
  assert.equal(f.log('bad').filter(row => row.method === 'session/prompt').length, 1, 'a generic provider failure never blindly replays the operation');
});

test('isolated workflow recovery keeps successful candidate commits and reuses the failed workspace', { timeout: 20000 }, async t => {
  const env: Record<string, NodeJS.ProcessEnv> = {}, f = fixture(t, { env }), offline = path.join(f.home, 'offline'); fs.writeFileSync(offline, 'offline');
  env.writer = { FAKE_ACP_WRITE: JSON.stringify({ file: 'src/preserved', text: 'preserved candidate evidence' }) };
  env.check = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed preserved candidate evidence' }) };
  env.second = { FAKE_ACP_OFFLINE: offline };
  const started = await f.start([task('writer', { kind: 'implement', writeScopes: ['src'] }), task('check', { kind: 'verify', dependsOn: ['writer'] }), task('second', { dependsOn: ['check'] })], { isolation: 'worktree' });
  const failed = await f.finished(started.graphId); assert.equal(failed.status, 'failed');
  const candidate = required(required(failed.tasks[0]).result).candidateCommit, workspace = required(failed.tasks.find(node => node.id === 'second')).cwd;
  const calls = f.log('writer').filter(row => row.method === 'session/prompt').length;
  execFileSync('gio', ['trash', offline]);
  const resumed = await f.runs.resume(started.graphId, { cwd: f.cwd, model: 'm-fast', modelProvider: 'openai' });
  assert.equal(resumed.graphId, started.graphId);
  const completed = await f.finished(started.graphId); assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  assert.equal(required(required(completed.tasks[0]).result).candidateCommit, candidate);
  assert.equal(required(completed.tasks.find(node => node.id === 'second')).cwd, workspace, 'the failed node continues in its existing worktree');
  assert.equal(f.log('writer').filter(row => row.method === 'session/prompt').length, calls, 'successful writers are never replayed');
  assert.equal(fs.readFileSync(path.join(required(required(completed.review).path), 'src/preserved'), 'utf8'), 'preserved candidate evidence');
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


for (const failure of ['failed verification', 'invalid verification', 'corrected verification', 'out-of-scope candidate']) test(`Mother agent supervises ${failure} with one visible corrective decision`, { timeout: 20000 }, async t => {
  const env: Record<string, NodeJS.ProcessEnv> = {}, f = fixture(t, { env });
  env.evidence = failure === 'out-of-scope candidate'
    ? { FAKE_ACP_WRITE: JSON.stringify({ file: 'outside-report', text: 'Preserve this rejected candidate' }) }
    : { FAKE_ACP_ANSWER: failure === 'failed verification' ? JSON.stringify({ passed: false, summary: 'Required evidence is missing' }) : 'No structured verification evidence' };
  if (failure === 'corrected verification') {
    let attempts = 0;
    Object.defineProperty(env, 'evidence', { get: () => ({ FAKE_ACP_ANSWER: JSON.stringify({ passed: ++attempts > 1, summary: 'Observed the requested evidence after focused correction' }) }) });
  }
  env['Mother agent'] = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'retry', taskId: 'evidence', instruction: 'Inspect the failed evidence and correct only the existing scope.', reason: 'The retained result needs one focused correction.' }) };
  // Since 1 Nov a new file outside the folders is moved in by Elpis itself; changing an existing one still needs the Mother.
  if (failure === 'out-of-scope candidate') { fs.writeFileSync(path.join(f.cwd, 'outside-report'), 'base'); f.git('add', 'outside-report'); f.git('commit', '-qm', 'existing outside file'); }
  const started = await f.start([task('evidence', { kind: failure === 'out-of-scope candidate' ? 'explore' : 'verify', writeScopes: failure === 'out-of-scope candidate' ? ['src'] : [] })], failure === 'out-of-scope candidate' ? { isolation: 'worktree' } : {});
  const completed = await f.finished(started.graphId);
  assert.equal(completed.status, failure === 'corrected verification' ? 'succeeded' : 'failed');
  assert.equal(completed.mother?.decisions.length, 1, 'Mother agent makes a single bounded decision even if the correction also fails');
  assert.equal(required(required(completed.mother).decisions[0]).decision, 'retry');
  assert.equal(f.log('Mother agent').filter(row => row.method === 'session/prompt').length, 1);
  assert.equal(f.log('evidence').filter(row => row.method === 'session/prompt').length, 2, 'the correction executes exactly once');
  if (failure === 'corrected verification') {
    assert.equal(required(completed.tasks[0]).failureReason, null, 'a corrected task cannot retain a current failure');
    assert.match(required(required(completed.tasks[0]).result).summary, /Observed the requested evidence/);
    assert.match(logPrompt(f.log('evidence').filter(row => row.method === 'session/prompt')[1]), /Mother agent's corrective guidance/);
  } else {
    assert.match(required(required(completed.tasks[0]).failureReason), failure === 'out-of-scope candidate' ? /outside its write scopes/ : /Check failed/);
    assert.equal(required(completed.tasks[0]).result, null);
  }
  if (failure === 'out-of-scope candidate') {
    assert.equal(fs.readFileSync(path.join(required(required(completed.tasks[0]).cwd), 'outside-report'), 'utf8'), 'Preserve this rejected candidate');
    assert.equal(fs.readFileSync(path.join(f.cwd, 'outside-report'), 'utf8'), 'base', 'rejected work never reaches the source checkout');
  }
});

for (const activeMember of ['nested', 'next-stage', 'unrelated']) test(`recovery checks paginated ${activeMember} work before starting an agent`, async t => {
  const cleanup: { run?: ReturnType<typeof createWorkflowRuns> } = {};
  t.after(async () => { const active = cleanup.run; if (!active) return; active.close(); await until(() => active.list(), list => list.every(record => record.status !== 'running')); });
  const f = fixture(t), id = randomUUID(), rootThreadId = randomUUID(), childId = randomUUID(), nextId = randomUUID();
  const retained = { id, rootThreadId, status: 'failed', round: 1, projectCwd: f.cwd, tasks: [task('evidence', { assignedThreadId: childId, status: 'failed' })], next: { threadId: randomUUID(), tasks: [task('next', { assignedThreadId: nextId, status: 'failed' })] } };
  const file = path.join(f.home, 'state', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, 'utf8'), pages: Parameters<NonNullable<WorkflowOptions['listThreadDescendants']>>[0][] = [];
  const restored = createWorkflowRuns({ ...f.runnerOptions,
    observeThread: async threadId => ({ id: threadId, status: { type: threadId === 'foreign' || activeMember === 'next-stage' && threadId === nextId || activeMember === 'nested' && threadId === 'grandchild' ? 'active' : 'idle' } }),
    listThreadDescendants: async options => {
      pages.push(options);
      return options.cursor ? { data: [{ id: 'grandchild', source: { subAgent: { thread_spawn: { parent_thread_id: childId } } }, status: { type: activeMember === 'nested' ? 'active' : 'idle' } }, { id: 'foreign', parentThreadId: rootThreadId, status: { type: 'active' } }], nextCursor: null }
        : { data: [{ id: childId, parentThreadId: rootThreadId, status: { type: 'idle' } }, { id: nextId, parentThreadId: retained.next.threadId, status: { type: 'idle' } }], nextCursor: 'second' };
    },
  });
  cleanup.run = restored;
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


// 28 Oct, Masih: no check-ins. Mother used to look in on a running step after its tools and long reports, an Opus call
// on the person's Claude quota each time; she now speaks only when a step fails.
const routes = async () => [
  { model: 'm-fast', provider: 'openai', efforts: ['low', 'high'], defaultEffort: 'high' },
  { model: 'claude/opus', provider: 'claude', efforts: ['low'] },
];
test('a run whose steps succeed never asks Mother agent, even after their tools and long reports', { timeout: 20000 }, async t => {
  const env: Record<string, NodeJS.ProcessEnv> = {}, f = fixture(t, { env, runner: { modelRoutes: routes } });
  env.live = { FAKE_ACP_ANSWER: 'A long report. '.repeat(40) };
  env['Mother agent'] = { FAKE_ACP_ANSWER: JSON.stringify({ action: 'continue', reason: 'should not be asked' }) };
  const completed = await f.finished((await f.start([task('live')])).graphId);
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  assert.equal(f.log('Mother agent').filter(row => row.method === 'session/prompt').length, 0, 'Mother agent was never asked');
  assert.equal(completed.mother?.decisions?.length ?? 0, 0);
});
