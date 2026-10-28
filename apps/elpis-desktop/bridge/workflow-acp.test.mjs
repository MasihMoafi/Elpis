import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { workflowWorktrees } from './workflow-worktrees.mjs';
import { loveNodeSpec } from './love-agents.mjs';

const ROOT = '00000000-0000-0000-0000-000000000001';
const FATHER = '00000000-0000-0000-0000-00000000000f';
const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = (id, dependsOn = [], instruction = 'Seed workflow-acp-739') => ({ id, title: id, instruction, kind: 'explore', dependsOn, writeScopes: [], acceptanceCriteria: ['Return evidence'] });
function fixture(t, overrides = {}, clientOptions = {}) {
  const tempRoot = createTestTempDir(path.join(os.homedir(), '.cache/elpis-tests/workflow-acp-'));
  const dir = path.join(tempRoot, 'project'); fs.mkdirSync(dir);
  const socket = new EventEmitter(); socket.sent = []; socket.close = () => {};
  const root = { id: ROOT, cwd: dir, source: 'cli', model: 'm-fast', modelProvider: 'openai', status: { type: 'idle' } };
  // Chats the bridge starts (the Father's) are kept, so reading one returns it.
  const threads = new Map([[ROOT, root]]);
  socket.send = raw => {
    const row = JSON.parse(raw); socket.sent.push(row); if (!row.id) return;
    const result = row.method === 'model/list' ? { data: [{ id: 'm-fast', model: 'm-fast' }, { id: 'claude/opus', model: 'claude/opus' }] }
      : row.method === 'thread/list' ? { data: [root], nextCursor: null }
      : row.method === 'thread/read' || row.method === 'thread/resume' ? { thread: threads.get(row.params.threadId) ?? root }
      : row.method === 'thread/start' ? (() => { const made = { ...root, id: FATHER, cwd: row.params.cwd ?? dir }; threads.set(FATHER, made); return { thread: made }; })()
      : row.method === 'turn/start' && socket.refuseTurns > 0 && socket.refuseTurns-- ? { __error: 'busy' }
      : row.method === 'turn/start' ? { turn: { id: `turn-${socket.sent.length}`, status: 'inProgress', items: [] } }
      : row.method === 'workGraph/list' ? { data: [] }
      : row.method.startsWith('workGraph/run') ? { graphId: 'native', threadId: ROOT } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify(result?.__error ? { id: row.id, error: { code: -32000, message: result.__error } } : { id: row.id, result })));
  };
  const log = id => {
    const p = path.join(dir, `${id}.jsonl`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  const client = new DesktopClient(socket, { home: overrides.env?.ELPIS_HOME ?? path.join(dir, 'profile'), rewindHome: path.join(dir, 'rewind'), reportRetryMs: 20, workflowOptions: { stateDir: path.join(dir, 'state'), nodeSpec: (node, env) => ({ name: node.name, instructions: node.prompt, elpis: true, command: process.execPath, args: [FAKE], env: { FAKE_ACP_NAME: node.name, FAKE_ACP_MODELS: node.name === 'Mother' ? 'opus' : 'm-fast', FAKE_ACP_LOG: path.join(dir, `${node.name}.jsonl`), ...(node.prompt.includes('Return only JSON:') ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: !node.prompt.includes('[fail-check]'), summary: 'Observed the planted evidence' }) } : {}), ...(env.workflowFake?.[node.name] ?? {}) }, model: node.name === 'Mother' ? 'opus' : node.model }), ...overrides }, ...clientOptions });
  t.after(() => { client.close(); removeTestTempDir(tempRoot); });
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

test('an explicit desktop profile reaches the actual workflow agent despite an ambient profile', async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), 'workflow-profile-'));
  t.after(() => removeTestTempDir(home));
  const endpoints = ['ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELPIS_BRIDGE_URL'];
  const ambient = Object.fromEntries(endpoints.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(ambient)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of endpoints) process.env[key] = path.join(home, 'foreign-profile.sock');
  const expected = { ELPIS_HOME: home, ...Object.fromEntries(endpoints.map(key => [key, null])) };
  const f = fixture(t, { env: { ELPIS_HOME: path.join(home, 'ambient'), ELPIS_NODE_BIN: process.execPath, ELPIS_ENGINE_BIN: fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-app-server.mjs', import.meta.url)), ELPIS_ACP_AGENT: FAKE }, nodeSpec: (node, env) => {
    const spec = loveNodeSpec(node, env);
    return { ...spec, env: { ...spec.env, FAKE_ACP_EXPECT_ENV: spec.env.FAKE_ACP_EXPECT_ENV ?? JSON.stringify(expected) } };
  } }, { home });
  await f.client.initialize();
  const started = await f.run([task('profile')]);
  assert.equal((await f.finished(started.graphId)).status, 'succeeded', 'the spawned agent itself refuses a different home or any ambient endpoint');
  const explicit = { ...expected, ELPIS_HOME: path.join(home, 'node-profile'), ELPIS_APP_BRIDGE_SOCKET: path.join(home, 'node.sock') };
  fs.writeFileSync(path.join(home, 'acp-agents.json'), JSON.stringify({ external: { command: process.execPath, args: [FAKE], env: { ELPIS_HOME: explicit.ELPIS_HOME, ELPIS_APP_BRIDGE_SOCKET: explicit.ELPIS_APP_BRIDGE_SOCKET, FAKE_ACP_MODELS: 'm-fast', FAKE_ACP_EXPECT_ENV: JSON.stringify(explicit) } } }));
  f.root.modelProvider = 'external';
  assert.equal((await f.finished((await f.run([task('explicit-node')])).graphId)).status, 'succeeded', 'explicit per-node environment overrides remain authoritative');
});

test('Restart waits through local workflow admission and final persistence while engine threads stay idle', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const app = await startDesktopServer({ client: f.client, elpisHome: f.dir, trashFile: path.join(f.dir, 'trash.json'),
    loveSpot: { directory: path.join(f.dir, 'drawing'), screenshots: path.join(f.dir, 'screenshots') } });
  const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const admission = gate(), admitting = gate(), finish = gate(), finishing = gate();
  const send = f.socket.send, rename = fs.promises.rename;
  let holdRead = true, run;
  f.socket.send = raw => {
    if (JSON.parse(raw).method === 'thread/read' && holdRead) {
      admitting.resolve(); void admission.promise.then(() => send(raw));
    } else send(raw);
  };
  fs.promises.rename = async (from, to) => {
    if (to.startsWith(path.join(f.dir, 'state') + path.sep) && JSON.parse(await fs.promises.readFile(from, 'utf8')).status === 'succeeded') {
      finishing.resolve(); await finish.promise;
    }
    return rename(from, to);
  };
  try {
    assert.equal(await app.canRestart(), true);
    run = f.run([task('restart-evidence')]);
    await admitting.promise;
    assert.equal(await app.canRestart(), false, 'workflow admission has not reached its active runner yet');
    holdRead = false; admission.resolve(); await run;
    assert.equal(await app.canRestart(), false, 'local ACP execution is running despite an idle native thread');
    await finishing.promise;
    assert.equal(await app.canRestart(), false, 'the last durable workflow result is still pending');
    finish.resolve();
    assert.equal((await f.finished((await run).graphId)).status, 'succeeded');
    assert.equal(f.root.status.type, 'idle');
    assert.equal(await app.canRestart(), true);
  } finally {
    holdRead = false; admission.resolve(); finish.resolve(); fs.promises.rename = rename;
    try { const started = await run?.catch(() => null); if (started) await f.finished(started.graphId); }
    finally { await app.close(); }
  }
});

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
test('workflow history lists persisted teams without a selected conversation', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  assert.deepEqual((await f.client.workflowHistory()).data, [], 'An empty history does not invent workflows');
  const started = await f.run([task('saved-team')]);
  const completed = await f.finished(started.graphId);
  const history = (await f.client.workflowHistory()).data;
  const record = history.find(row => row.id === completed.id);
  assert.equal(record.rootThreadId, ROOT);
  assert.equal(record.name, 'ACP team');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.tasks[0].id, 'saved-team');
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
// 28 Oct, Masih: the OCR run "shouldn't take this long" and must finish with no further input. Its check found a dropped
// clause and the run stopped, because Mother may only retry the failed node, the check itself. A failed check now sends
// its step back once with the check's findings, and the step is checked again.
test('a failed check sends its step back once with the findings, then checks again and the run goes on', { timeout: 20000 }, async t => {
  const env = { workflowFake: {} }, f = fixture(t, { env }); fs.mkdirSync(path.join(f.dir, 'src')); const out = path.join(f.dir, 'src', 'out.txt');
  Object.assign(env.workflowFake, { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: out, text: 'fixed', when: 'Your check found a problem' }) }, check: { FAKE_ACP_EXPECT: JSON.stringify({ file: out, text: 'fixed' }) } });
  await f.client.initialize();
  const r = await f.run([{ ...task('writer'), kind: 'implement', writeScopes: ['src'] }, { ...task('check', ['writer']), kind: 'verify' }, task('next', ['check'])]);
  const g = await f.finished(r.graphId); assert.equal(g.status, 'succeeded', g.error);
  const prompts = f.log('writer').filter(entry => entry.method === 'session/prompt').map(entry => JSON.stringify(entry.params));
  assert.equal(prompts.length, 2, 'the step ran once more');
  assert.match(prompts[1], /The planted result did not arrive/, 'with its check\u2019s findings');
  assert.ok(f.log('next').length > 0, 'and the run went on');
});

test('every agent writes: a check gets its own folder, and folders the run names are created inside the project only', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const outside = fs.mkdtempSync(path.join(path.dirname(f.dir), 'outside-')); fs.symlinkSync(outside, path.join(f.dir, 'link'));
  await assert.rejects(f.run([{ ...task('escape'), kind: 'implement', writeScopes: ['link/agents/escape'] }, { ...task('escape-check', ['escape']), kind: 'verify' }]), /project folder/i);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing is created through a link out of the project');
  const writer = { ...task('writer'), kind: 'implement', writeScopes: ['agents/writer'] };
  const check = { ...task('check', ['writer']), kind: 'verify', writeScopes: ['agents/writer/check'] };
  const g = await f.finished((await f.run([writer, check])).graphId);
  assert.equal(g.status, 'succeeded', g.error);
  assert.ok(fs.statSync(path.join(f.dir, 'agents/writer/check')).isDirectory());
  const opened = f.log('check').find(row => row.method === 'session/new').params._meta.elpis.workflow;
  assert.deepEqual([opened.kind, opened.writeScopes], ['verify', ['agents/writer/check']]);
});

test('A30: an empty project runs real ACP processes; every writer and check creates its own report, including a whole-project writer', { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf1-reports-'));
  const env = { workflowFake: {} };
  const f = fixture(t, { stateDir: path.join(home, 'workflow-state'), env });
  await f.client.initialize();
  assert.deepEqual(fs.readdirSync(f.dir), [], 'the run starts in a project with no files or subfolders');
  const tasks = [], reports = new Map();
  for (const [index, id] of ['first', 'middle', 'last'].entries()) {
    const folder = `agents/${id}`, ownReport = `${folder}/report.md`, checkReport = `${folder}/check/report.md`;
    const content = `# ${id}\n## Result\nPlanted evidence A30-${index}.\n## Evidence\nACP wrote this file.\n## Files\n${ownReport}\n## Open\nNone.\n`;
    const verdict = `# Check ${id}\n## Verdict\nPassed: read A30-${index}.\n## Evidence\nRead ${ownReport}.\n## Files\n${checkReport}\n## Open\nNone.\n`;
    const dependencies = index ? ['first', 'first-check', ...(index > 1 ? ['middle', 'middle-check'] : [])] : [];
    tasks.push({ ...task(id, dependencies, `Write ${ownReport}`), kind: 'implement', writeScopes: [...(id === 'last' ? ['.'] : []), folder] },
      { ...task(`${id}-check`, [id], `Check ${ownReport} and write ${checkReport}`), kind: 'verify', writeScopes: [`${folder}/check`] });
    env.workflowFake[id] = { HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'), FAKE_ACP_WRITE: JSON.stringify({ file: path.join(f.dir, ownReport), text: content }) };
    env.workflowFake[`${id}-check`] = { HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'), FAKE_ACP_WRITE: JSON.stringify({ file: path.join(f.dir, checkReport), text: verdict }), FAKE_ACP_EXPECT: JSON.stringify({ file: path.join(f.dir, ownReport), text: content }) };
    reports.set(ownReport, content); reports.set(checkReport, verdict);
  }
  const started = await f.run(tasks);
  for (const task of tasks) assert.ok(fs.statSync(path.join(f.dir, task.writeScopes.at(-1))).isDirectory(), `${task.id}'s folder exists as soon as the run starts`);
  const result = await f.finished(started.graphId);
  assert.equal(result.status, 'succeeded', result.error);
  for (const [report, content] of reports) assert.equal(fs.readFileSync(path.join(f.dir, report), 'utf8'), content, `real report written: ${report}`);
  for (const task of tasks) {
    const session = f.log(task.id).find(row => row.method === 'session/new');
    assert.ok(session, `${task.id} started its own ACP session`);
    assert.deepEqual(session.params._meta.elpis.workflow.writeScopes, task.writeScopes);
    assert.doesNotMatch(session.params._meta.systemPrompt.append, /read.only/i);
    assert.ok(fs.statSync(path.join(f.dir, task.writeScopes.at(-1))).isDirectory());
    assert.match(result.tasks.find(item => item.id === task.id).result.summary, task.kind === 'verify' ? /Read planted result/ : /answered/);
  }
  assert.equal(new Set(tasks.map(task => task.writeScopes.at(-1))).size, tasks.length);
  assert.equal(f.socket.sent.some(row => row.method.startsWith('workGraph/run')), false, 'the ACP scheduler, not native work graphs, ran');
  t.diagnostic('Six ACP child sessions wrote and read all six report.md files; a writer had scope ".". No model or credentials used.');
});
// A41: stages belong to the bridge, not to the Workflows screen, so a run goes on when that screen is closed.
const staged = async (f, id) => { let graph; for (let n = 0; n < 400; n++) { graph = (await f.client.workflows(ROOT)).data.find(item => item.id === id); if (graph?.next && ['cancelled', 'failed'].includes(graph.next.status) || graph?.next?.reported || graph?.next?.error) return graph; await pause(25); } throw Error(`the next stage did not settle: ${JSON.stringify(graph?.next)}`); };
const fatherPart = { name: 'Father · Team', thread: { name: 'Father · Team', instructions: 'You are the Father.' }, tasks: [task('f')] };
test('the Father part starts from the bridge after the Mother part, in his own chat, and his report reaches hers', { timeout: 30000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('m')], { next: fatherPart });
  assert.equal((await f.finished(r.graphId)).status, 'succeeded');
  const graph = await staged(f, r.graphId);
  assert.deepEqual([graph.next.threadId, graph.next.status, graph.next.reported], [FATHER, 'succeeded', true]);
  assert.equal(f.log('f').filter(row => row.method === 'session/prompt').length, 1, "the Father's agent ran");
  assert.match(f.socket.sent.find(row => row.method === 'thread/start').params.developerInstructions, /You are the Father\./);
  const report = f.socket.sent.find(row => row.method === 'turn/start' && row.params.threadId === ROOT);
  assert.match(JSON.stringify(report.params.input), /Report from the Father[\s\S]*Status: succeeded/);
});
test("a refused Father report is tried again, and its reason is kept when it never goes through", { timeout: 30000 }, async t => {
  for (const [refusals, reported] of [[2, true], [9, false]]) {
    const f = fixture(t); await f.client.initialize(); f.socket.refuseTurns = refusals;
    const r = await f.run([task('m')], { next: fatherPart });
    const graph = await staged(f, r.graphId);
    if (!reported) for (let n = 0; n < 200 && !graph.next.error; n++) Object.assign(graph, (await f.client.workflows(ROOT)).data.find(item => item.id === r.graphId)), await pause(25);
    assert.equal(!!graph.next.reported, reported);
    if (!reported) assert.match(graph.next.error, /^Father report not delivered: busy/);
    assert.equal(f.socket.sent.filter(row => row.method === 'turn/start' && row.params.threadId === ROOT).length, reported ? 3 : 4);
  }
});
test('a Mother part that fails never starts the Father', { timeout: 30000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const r = await f.run([task('m', [], '[crash]')], { next: fatherPart });
  assert.equal((await f.finished(r.graphId)).status, 'failed');
  assert.equal((await staged(f, r.graphId)).next.status, 'cancelled');
  assert.equal(f.socket.sent.some(row => row.method === 'thread/start'), false);
  assert.equal(f.log('f').length, 0);
});
test('workflow ACP permissions are allowed and recorded on the node without reaching the approval UI', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.client.initialize();
  const questions = [];
  f.client.on('event', event => {
    if (event.type !== 'approval') return;
    questions.push(event.data);
    // Let the old implementation finish so its UI leak fails explicitly, without a timeout.
    f.client.answerApproval(event.data.id, { decision: 'accept' });
  });
  const r = await f.run([task('a', [], '[permission]')]);
  const g = await f.finished(r.graphId); assert.equal(g.status, 'succeeded');
  assert.match(g.tasks[0].result.summary, /permission: allow_once/); assert.equal(f.client.pendingApprovals.length, 0);
  assert.deepEqual(questions, [], 'no permission question is emitted to the person');
  assert.equal(g.tasks[0].permissions[0].optionId, 'allow_once');
  assert.match(g.tasks[0].progress.find(entry => entry.text?.includes('automatically')).text, /Write notes.txt/);
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
      assert.equal(fs.existsSync(path.join(f.dir, 'src/result')), false, 'the candidate waits for Mother');
      await f.client.mergeWorkflow(r.graphId, {});
      assert.equal(g.status, 'succeeded', g.error); assert.equal(fs.readFileSync(path.join(f.dir, 'src/result'), 'utf8'), 'workflow planted result');
      assert.notEqual(git('rev-parse', 'HEAD'), baseline);
      assert.equal(f.log('check').find(row => row.method === 'session/new').params.cwd.includes('-elpis/workflows/'), true);
    } else {
      if (mode === 'dirty') { assert.equal(g.status, 'succeeded'); await assert.rejects(f.client.mergeWorkflow(r.graphId, {}), /project changed/); }
      else assert.equal(g.status, 'failed');
      assert.equal(git('rev-parse', 'HEAD'), baseline); assert.equal(fs.existsSync(path.join(f.dir, 'src/result')), false);
      if (mode === 'dirty') assert.equal(fs.readFileSync(path.join(f.dir, 'src/seed'), 'utf8'), 'user edit');
    }
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
  fs.writeFileSync(path.join(cwd, 'outside'), 'unwanted staged edit'); git(cwd, 'add', 'outside');
  fs.writeFileSync(path.join(cwd, 'outside'), 'original');
  await assert.rejects(isolation.complete(writer, 1), /outside its write scopes: outside/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'outside'), 'utf8'), 'original');
});
