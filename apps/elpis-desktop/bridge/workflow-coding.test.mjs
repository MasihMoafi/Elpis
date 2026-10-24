import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowRuns } from './workflow-acp.mjs';

const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (id, extra = {}) => ({ id, title: id, kind: 'explore', instruction: 'Tiny evidence', dependsOn: [], writeScopes: [], acceptanceCriteria: ['Observed evidence'], ...extra });
async function until(read, check) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (check(value)) return value; await pause(20); }
  assert.fail('Workflow condition did not settle');
}
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.cache/elpis-briefs/cc/wfrun-test-'));
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@elpis.local', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/seed'), 'base'); git('add', 'src/seed'); git('commit', '-qm', 'base');
  const log = id => { const file = path.join(home, `${id}.jsonl`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
  const runs = createWorkflowRuns({ stateDir: path.join(home, 'state'), timeoutMs: 10000,
    nodeSpec: node => ({ name: node.name, command: process.execPath, args: [FAKE], model: node.model,
      env: { FAKE_ACP_NAME: `${node.provider ?? 'default'}-${node.name}`, FAKE_ACP_MODELS: 'm-fast,m-slow', FAKE_ACP_EFFORTS: 'low,high', FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
        ...(options.env?.[node.name] ?? {}) } }), ...options.runner });
  t.after(async () => { runs.close(); await until(() => runs.list(), list => list.every(record => record.status !== 'running')); execFileSync('gio', ['trash', home]); });
  const start = (tasks, extra = {}) => runs.start({ rootThreadId: 'root', name: 'Coding team', tasks, maxConcurrency: 2, ...extra }, { cwd, model: 'm-fast', modelProvider: 'openai' });
  const record = async id => (await runs.list()).find(record => record.id === id);
  const finished = id => until(() => record(id), record => record.status !== 'running');
  return { home, cwd, git, log, runs, start, record, finished };
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
