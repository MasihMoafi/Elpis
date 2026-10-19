import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from './client.mjs';
import { workflowWorktrees } from './workflow-worktrees.mjs';

const ROOT = '00000000-0000-0000-0000-000000000001';
const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (id, dependsOn = [], instruction = 'Seed workflow-acp-739') => ({ id, title: id, instruction, kind: 'explore', dependsOn, writeScopes: [], acceptanceCriteria: ['Return evidence'] });
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache/elpis-tests/workflow-acp-'));
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  const root = { id: ROOT, cwd: dir, source: 'cli', model: 'm-fast', modelProvider: 'openai', status: { type: 'idle' } };
  socket.send = raw => {
    const row = JSON.parse(raw); socket.sent.push(row); if (!row.id) return;
    const result = row.method === 'model/list' ? { data: [{ id: 'm-fast', model: 'm-fast' }] }
      : row.method === 'thread/read' || row.method === 'thread/resume' ? { thread: root }
      : row.method === 'workGraph/list' ? { data: [] }
      : row.method.startsWith('workGraph/run') ? { graphId: 'native', threadId: ROOT } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: row.id, result })));
  };
  const log = id => {
    const p = path.join(dir, `${id}.jsonl`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  const client = new DesktopClient(socket, { workflowOptions: { stateDir: path.join(dir, 'state'), nodeSpec: (node, env) => ({ name: node.name, instructions: node.prompt, elpis: true, command: process.execPath, args: [FAKE], env: { FAKE_ACP_NAME: node.name, FAKE_ACP_MODELS: 'm-fast', FAKE_ACP_LOG: path.join(dir, `${node.name}.jsonl`), ...(node.prompt.includes('Return only JSON:') ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: !node.prompt.includes('[fail-check]'), summary: 'Observed the planted evidence' }) } : {}), ...(env.workflowFake?.[node.name] ?? {}) }, model: node.model }), ...overrides } });
  t.after(() => { client.close(); execFileSync('gio', ['trash', dir]); });
  const run = (tasks, extra = {}) => client.runWorkflow({ rootThreadId: ROOT, name: 'ACP team', tasks, maxConcurrency: 2, ...extra });
  const finished = async id => {
    for (let n = 0; n < 500; n++) {
      const g = (await client.workflows(ROOT)).data.find(g => g.id === id);
      if (g && g.status !== 'running') return g;
      await pause(20);
    }
    throw Error('workflow did not finish');
  };
  return { client, socket, dir, root, run, log, finished, fakeEnv: overrides.env };
}

test('Workflows uses real ACP and hands only completed dependency answers to the next agent', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('a'), task('b', ['a'], 'Use the planted answer')]);
  assert.equal(f.socket.sent.some(row => row.method.startsWith('workGraph/run')), false, 'native execution is disabled');
  const g = await f.finished(r.graphId); assert.equal(g.status, 'succeeded');
  const prompt = f.log('b').find(row => row.method === 'session/prompt').params.prompt[0].text;
  assert.match(prompt, /a\(m-fast\) answered: Seed workflow-acp-739/);
  assert.equal(f.log('a').filter(row => row.method === 'session/prompt').length, 1);
  assert.ok(g.tasks.every(row => row.assignedThreadId && row.result.summary));
});
test('failure blocks dependent ACP nodes; an independent node can finish', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('a', [], '[crash]'), task('b', ['a']), task('c')]);
  const g = await f.finished(r.graphId); assert.equal(g.status, 'failed');
  assert.equal(g.tasks.find(n => n.id === 'b').status, 'blocked'); assert.equal(f.log('b').length, 0);
  assert.equal(g.tasks.find(n => n.id === 'c').status, 'succeeded');
});
test('recursive feedback runs exactly the explicit number of rounds, with previous round answers', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const tasks = [{ ...task('a'), feedbackFrom: ['b'] }, task('b', ['a'], 'Continue')];
  const r = await f.run(tasks, { roundLimit: 2 }); const g = await f.finished(r.graphId);
  assert.equal(g.status, 'succeeded'); assert.equal(g.round, 2);
  const prompts = f.log('a').filter(row => row.method === 'session/prompt'); assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0].params.prompt[0].text, /b\(m-fast\)/);
  assert.match(prompts[1].params.prompt[0].text, /b\(m-fast\) answered/);
});
test('cycles, missing dependencies, duplicate IDs and unbounded feedback fail before spawning', async t => {
  const f = fixture(t); await f.client.initialize();
  for (const tasks of [[task('a', ['b']), task('b', ['a'])], [task('a', ['missing'])], [task('a'), task('a')], [{ ...task('a'), feedbackFrom: ['a'] }]]) await assert.rejects(f.run(tasks), /loop|depend|unique|round limit/i);
  assert.equal(f.log('a').length, 0);
});
test('a root cannot start two runs; interrupt cancels ACP and never starts a waiting dependent', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('a', [], '[hang]'), task('b', ['a'])]);
  await assert.rejects(f.run([task('c')]), /already running/);
  for (let n = 0; n < 200 && !f.log('a').some(row => row.method === 'session/prompt'); n++) await pause(20);
  await f.client.interrupt(ROOT, {});
  const g = await f.finished(r.graphId); assert.equal(g.status, 'cancelled');
  assert.ok(f.log('a').some(row => row.method === 'session/cancel')); assert.equal(f.log('b').length, 0);
});

test('failed verification cannot release a downstream writer', { timeout: 20000 }, async t => {
  const f = fixture(t, { env: { workflowFake: { check: { FAKE_ACP_ANSWER: JSON.stringify({ passed: false, summary: 'The planted criterion failed' }) } } } }); await f.client.initialize(); fs.mkdirSync(path.join(f.dir, 'src'));
  const a = { ...task('writer'), kind: 'implement', writeScopes: ['src'] };
  const check = { ...task('check', ['writer'], '[fail-check]'), kind: 'verify' };
  const r = await f.run([a, check, task('next', ['check'])]);
  const g = await f.finished(r.graphId); assert.equal(g.status, 'failed');
  assert.equal(g.tasks.find(t => t.id === 'check').status, 'failed'); assert.equal(f.log('next').length, 0);
});
test('ACP permissions use the existing approval panel and the offered decision reaches the agent', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('a', [], '[permission]')]);
  for (let n = 0; n < 300 && !f.client.pendingApprovals.length; n++) await pause(20);
  const question = f.client.pendingApprovals[0]; assert.ok(question);
  assert.throws(() => f.client.answerApproval(question.id, { decision: 'acceptForSession' }), /not offered/);
  f.client.answerApproval(question.id, { decision: 'accept' });
  const g = await f.finished(r.graphId); assert.equal(g.status, 'succeeded');
  assert.match(g.tasks[0].result.summary, /permission: allow_once/); assert.equal(f.client.pendingApprovals.length, 0);
});
test('time limit cancels the process and blocks dependents', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('a', [], '[hang]'), task('b', ['a'])], { maxRuntimeSeconds: 1 });
  const g = await f.finished(r.graphId); assert.equal(g.status, 'failed'); assert.match(g.error, /timed out/);
  assert.equal(f.log('b').length, 0);
});
test('isolated ACP writes reach their verifier, then the source; scope escape or a changed source prevents integration', { timeout: 30000 }, async t => {
  for (const mode of ['success', 'scope', 'dirty']) {
    const f = fixture(t, { env: { workflowFake: {} } }); await f.client.initialize();
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: f.dir, encoding: 'utf8' }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(f.dir, '.gitignore'), 'state/\n*.jsonl\n'); fs.mkdirSync(path.join(f.dir, 'src')); fs.writeFileSync(path.join(f.dir, 'src', 'seed'), 'base'); git('add', '.gitignore', 'src/seed'); git('commit', '-qm', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    // The fake ACP command writes relative to its session's actual isolated cwd.
    const a = { ...task('writer'), kind: 'implement', writeScopes: ['src'] };
    const check = { ...task('check', ['writer']), kind: 'verify' };
    // Recreate only the injected fake environment, without replacing runAcpNode.
    f.fakeEnv.workflowFake.writer = { FAKE_ACP_WRITE: JSON.stringify({ file: mode === 'scope' ? 'outside.txt' : 'src/result', text: 'workflow planted result' }) };
    f.fakeEnv.workflowFake.check = { FAKE_ACP_EXPECT: JSON.stringify({ file: 'src/result', text: 'workflow planted result' }) };
    if (mode === 'dirty') fs.writeFileSync(path.join(f.dir, 'src', 'seed'), 'user edit');
    const r = await f.run([a, check], { isolation: 'worktree' }); const g = await f.finished(r.graphId);
    if (mode === 'success') {
      assert.equal(g.status, 'succeeded', g.error); assert.equal(fs.readFileSync(path.join(f.dir, 'src/result'), 'utf8'), 'workflow planted result');
      assert.notEqual(git('rev-parse', 'HEAD'), baseline);
      assert.equal(f.log('check').find(row => row.method === 'session/new').params.cwd.includes('-elpis/workflows/'), true);
    } else {
      assert.equal(g.status, 'failed'); assert.equal(git('rev-parse', 'HEAD'), baseline); assert.equal(fs.existsSync(path.join(f.dir, 'src/result')), false);
      if (mode === 'dirty') assert.equal(fs.readFileSync(path.join(f.dir, 'src/seed'), 'utf8'), 'user edit');
    }
    const worktreeHome = path.join(path.dirname(f.dir), `${path.basename(f.dir)}-elpis`);
    if (fs.existsSync(worktreeHome)) t.after(() => execFileSync('gio', ['trash', worktreeHome]));
  }
});

test('the concurrency cap and overlapping writer scopes hold before another process starts', { timeout: 20000 }, async t => {
  for (const shared of [true, false]) {
    const f = fixture(t); await f.client.initialize();
    fs.mkdirSync(path.join(f.dir, 'one')); fs.mkdirSync(path.join(f.dir, 'two'));
    const tasks = ['a', 'b', 'c'].flatMap((id, i) => [{ ...task(id, [], '[hang]'), kind: 'implement', writeScopes: [shared || i === 0 ? 'one' : 'two'] }, { ...task(`${id}-check`, [id]), kind: 'verify' }]);
    const r = await f.run(tasks);
    for (let n = 0; n < 200 && !f.log('a').some(row => row.method === 'session/prompt'); n++) await pause(20);
    if (!shared) for (let n = 0; n < 500 && !f.log('b').some(row => row.method === 'session/prompt'); n++) await pause(20);
    await pause(250);
    assert.equal(f.log('b').some(row => row.method === 'session/prompt'), !shared);
    assert.equal(f.log('c').length, 0, 'third task cannot exceed the cap');
    await f.client.interrupt(ROOT, {}); assert.equal((await f.finished(r.graphId)).status, 'cancelled');
    assert.equal(f.log('b').some(row => row.method === 'session/prompt'), !shared, 'overlapping work stays blocked through cancellation');
    assert.equal(f.log('c').length, 0, 'queued work never starts during cancellation');
  }
});

test('isolation rejects staged changes outside scope even when the working file was restored', async t => {
  const f = fixture(t);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.dir, 'init', '-q'); fs.mkdirSync(path.join(f.dir, 'src')); fs.writeFileSync(path.join(f.dir, 'outside'), 'original');
  fs.writeFileSync(path.join(f.dir, 'src/seed'), 'seed'); git(f.dir, 'add', 'outside', 'src/seed'); git(f.dir, 'commit', '-qm', 'baseline');
  const isolation = await workflowWorktrees(f.dir, 'staged-scope-eval');
  const writer = { ...task('writer'), kind: 'implement', writeScopes: ['src'] };
  const cwd = await isolation.prepare(writer, 1);
  t.after(() => execFileSync('gio', ['trash', `${f.dir}-elpis`]));
  fs.writeFileSync(path.join(cwd, 'outside'), 'unwanted staged edit'); git(cwd, 'add', 'outside');
  fs.writeFileSync(path.join(cwd, 'outside'), 'original');
  await assert.rejects(isolation.complete(writer, 1), /outside its write scopes: outside/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'outside'), 'utf8'), 'original');
});
