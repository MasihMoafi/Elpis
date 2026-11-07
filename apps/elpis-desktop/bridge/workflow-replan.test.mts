// The Mother re-plans mid-run (1 Nov, Masih approved "1) yes"; "add" takes a list, confirmed the same day): when a child
// succeeds she is asked once, with the finished children's summaries and files and the remaining plan, and answers
// continue, add, cancel or steer. Stand-in ACP agents (tools/elpis-claude/test/fake-acp-agent.mts), no model calls.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowRuns, REPLAN_LIMIT } from './workflow-acp.mts';
import { workflowDefaults, MOTHER_ROUTE, MOTHER_FALLBACK } from './workflow-models.mts';
import type { WorkflowOptions, WorkflowParams } from './workflow-acp/types.mts';

type NodeSpec = NonNullable<WorkflowOptions['nodeSpec']>;
type NodeInput = Parameters<NodeSpec>[0];
type FixtureOptions = {
  held?: string[];
  mother?: (string | Record<string, unknown>)[];
  motherEnv?: (node: NodeInput) => NodeJS.ProcessEnv;
  runner?: Partial<WorkflowOptions>;
};
type StartOptions = Omit<Partial<WorkflowParams>, 'replan'> & { replan?: boolean | undefined };

function required<T>(value: T | null | undefined): T { assert.ok(value); return value; }

const TEST_ROOT = path.join(os.homedir(), '.cache/elpis-tests'); fs.mkdirSync(TEST_ROOT, { recursive: true });
const FAKE = fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mts', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MOTHER = 'Mother agent';
const task = (id: string, extra: Partial<WorkflowParams['tasks'][number]> = {}): WorkflowParams['tasks'][number] => ({ id, title: id, kind: 'explore', instruction: `Work on ${id}`, dependsOn: [], writeScopes: [], acceptanceCriteria: ['Observed evidence'], ...extra });
const continueAnswer = { decision: 'continue', why: 'The plan still covers the goal' };

async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, what = 'condition'): Promise<T> {
  for (let n = 0; n < 500; n++) { const value = await read(); if (check(value)) return value; await pause(20); }
  assert.fail(`Workflow ${what} did not settle`);
}

/** `held`: children that wait for `release(name)`. `mother`: her answers in order (then "continue"). */
function fixture(t: TestContext, { held = [], mother = [], motherEnv = () => ({}), runner = {} }: FixtureOptions = {}) {
  const home = fs.mkdtempSync(path.join(TEST_ROOT, 'replan-test-'));
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const answers = [...mother], specs: { name: string; model: string; provider: string; spec: ReturnType<NodeSpec> }[] = [];
  const nodeSpec: NodeSpec = node => {
    const isMother = node.name === MOTHER;
    const env = { FAKE_ACP_NAME: node.name, FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
      ...(isMother ? { FAKE_ACP_ANSWER: (() => { const next = answers.length ? answers.shift() : continueAnswer; return typeof next === 'string' ? next : JSON.stringify(next); })(), ...motherEnv(node) }
        : node.prompt.includes('Return only JSON: {"passed"') ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: 'Observed the work' }) } : {}),
      ...(held.includes(node.name) ? { FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_RELEASE: path.join(home, `release-${node.name}`) } : {}) };
    const spec: ReturnType<NodeSpec> = { name: node.name, instructions: node.prompt, elpis: true, command: process.execPath, args: [FAKE], env };
    specs.push({ name: node.name, model: node.model, provider: node.provider, spec });
    return spec;
  };
  const runs = createWorkflowRuns({ stateDir: path.join(home, 'state'), timeoutMs: 10000, nodeSpec, ...runner });
  t.after(async () => { runs.close(); await until(() => runs.list(), list => list.every(record => record.status !== 'running'), 'shutdown'); execFileSync('gio', ['trash', home]); });
  const start = (tasks: WorkflowParams['tasks'], extra: StartOptions = {}) => runs.start({ rootThreadId: 'root', name: 'Team', goal: 'Cover every section', tasks, maxConcurrency: 4, replan: true, ...extra } as WorkflowParams, { cwd, model: 'm-fast', modelProvider: 'openai' });
  const record = async (id: string) => { const item = (await runs.list()).find(item => item.id === id); assert.ok(item); return item; };
  const finished = (id: string) => until(() => record(id), item => item.status !== 'running', 'run');
  const decisions = async (id: string, count: number) => until(() => record(id), item => (item.mother?.decisions?.length ?? 0) >= count, `${count} Mother decisions`);
  const release = (name: string) => fs.writeFileSync(path.join(home, `release-${name}`), '');
  const prompts = (name: string): string[] => { const file = path.join(home, `${name}.jsonl`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params: { prompt: { text: string }[] } }).filter(row => row.method === 'session/prompt').map(row => { const part = row.params.prompt[0]; assert.ok(part); return part.text; }) : []; };
  return { home, cwd, start, record, finished, decisions, release, prompts, specs };
}

test('a child that succeeds brings one Mother call with its summary and file; "continue" leaves the plan alone', { timeout: 30000 }, async t => {
  const f = fixture(t, { held: ['b'] });
  const { graphId } = await f.start([task('a'), task('b')]);
  const after = await f.decisions(graphId, 1);
  assert.ok(after.mother);
  assert.equal(f.prompts(MOTHER).length, 1, 'one Mother call for one success');
  const asked = f.prompts(MOTHER)[0], a = after.tasks.find(item => item.id === 'a');
  assert.ok(asked); assert.ok(a?.result);
  assert.match(asked, /Just finished: a\./);
  assert.ok(a.result.file && asked.includes(a.result.file), 'she gets the file with the whole answer');
  assert.equal(fs.readFileSync(a.result.file, 'utf8'), a.result.summary, 'the file holds the whole answer');
  assert.match(asked, /"id":"b","title":"b","kind":"explore","status":"running"/, 'she sees the remaining plan');
  assert.deepEqual(after.mother.decisions.map(item => [item.kind, item.decision, item.summary]), [['replan', 'continue', 'Continued — The plan still covers the goal']]);
  f.release('b');
  const done = await f.finished(graphId);
  assert.ok(done.log);
  assert.equal(done.status, 'succeeded');
  assert.equal(f.prompts(MOTHER).length, 1, 'the last child ends the run without asking her: nothing was left to run');
  assert.deepEqual(done.tasks.map(item => item.id), ['a', 'b']);
  assert.ok(done.log.some(line => line.text === 'Mother agent · Continued — The plan still covers the goal'), 'the decision is a line in the run history');
});

test('one "add" decision adds three agents together, each with its own wiring and check, and they use earlier output', { timeout: 30000 }, async t => {
  const add = { decision: 'add', why: 'section 4 was missed', agents: [
    { key: 'fact-4', title: 'Fact-checker 4', prompt: 'Check section 4', folders: [], doneWhen: ['Section 4 is checked'], waitsFor: ['a'] },
    { key: 'editor', title: 'Editor', prompt: 'Edit after the checker', folders: [], doneWhen: [], waitsFor: ['fact-4'] },
    { key: 'index', title: 'Index', prompt: 'Build the index', folders: [], doneWhen: [], waitsFor: [] },
  ] };
  const f = fixture(t, { held: ['b'], mother: [add] });
  const { graphId } = await f.start([task('a'), task('b')]);
  const after = await f.decisions(graphId, 1);
  assert.ok(after.mother);
  assert.equal(required(after.mother.decisions[0]).summary, 'Added: Fact-checker 4, Editor, Index — section 4 was missed');
  assert.equal(after.mother.replans, 1, 'one decision counts once against the cap');
  const wiring = Object.fromEntries(after.tasks.filter(item => item.addedBy === 'mother').map(item => [item.id, [item.kind, item.dependsOn, item.writeScopes]]));
  assert.deepEqual(wiring, {
    'fact-4': ['implement', ['a'], ['agents/fact-checker-4']], 'fact-4-check': ['verify', ['fact-4'], ['agents/fact-checker-4/check']],
    editor: ['implement', ['fact-4', 'fact-4-check'], ['agents/editor']], 'editor-check': ['verify', ['editor'], ['agents/editor/check']],
    index: ['implement', [], ['agents/index']], 'index-check': ['verify', ['index'], ['agents/index/check']],
  });
  f.release('b');
  const done = await f.finished(graphId);
  assert.equal(done.status, 'succeeded', done.error ?? undefined);
  assert.ok(done.tasks.filter(item => item.addedBy === 'mother').every(item => item.status === 'succeeded'), 'every added agent ran');
  const fact = f.prompts('Fact-checker 4')[0], a = done.tasks.find(item => item.id === 'a');
  assert.ok(fact); assert.ok(a?.result);
  assert.match(fact, /Check section 4/);
  assert.ok(fact.includes(JSON.stringify({ name: 'a', answer: a.result.summary, file: a.result.file })), 'the added agent got a’s summary and its file');
  assert.ok(required(f.prompts('Editor')[0]).includes('"name":"Fact-checker 4"'), 'an added agent builds on another added agent');
});

test('"cancel" stops a pending agent and its check; the run still succeeds without it', { timeout: 30000 }, async t => {
  const f = fixture(t, { held: ['b'], mother: [{ decision: 'cancel', why: 'a already covered it', taskIds: ['c'] }] });
  const { graphId } = await f.start([task('a'), task('b'), task('c', { kind: 'implement', dependsOn: ['b'], writeScopes: ['c'] }), task('c-check', { kind: 'verify', dependsOn: ['c'] }), task('d', { dependsOn: ['c'] })]);
  const after = await f.decisions(graphId, 1);
  assert.ok(after.mother);
  assert.deepEqual(after.tasks.filter(item => item.status === 'cancelled').map(item => [item.id, item.cancelledBy]), [['c', 'mother'], ['c-check', 'mother']]);
  assert.equal(required(after.mother.decisions[0]).summary, 'Cancelled: c — a already covered it');
  f.release('b');
  const done = await f.finished(graphId);
  assert.equal(done.status, 'succeeded', done.error ?? undefined);
  assert.deepEqual(done.tasks.map(item => [item.id, item.status]), [['a', 'succeeded'], ['b', 'succeeded'], ['c', 'cancelled'], ['c-check', 'cancelled'], ['d', 'succeeded']]);
  assert.equal(f.prompts('c').length, 0, 'the cancelled agent never started');
});

test('"steer" reaches a running agent, and its answer shows the guidance', { timeout: 30000 }, async t => {
  const f = fixture(t, { held: ['b'], mother: [{ decision: 'steer', why: 'b must cite sources', taskId: 'b', message: 'Cite a source for every claim.' }] });
  const { graphId } = await f.start([task('a'), task('b')]);
  const after = await f.decisions(graphId, 1);
  assert.ok(after.mother);
  assert.equal(required(after.mother.decisions[0]).summary, 'Steered: b — b must cite sources');
  assert.deepEqual(required(required(after.tasks.find(item => item.id === 'b')).messages).map(item => [item.source, item.text]), [['mother', 'Cite a source for every claim.']]);
  f.release('b');
  const done = await f.finished(graphId);
  assert.match(required(required(done.tasks.find(item => item.id === 'b')).result).summary, /Cite a source for every claim\./);
});

test(`at most ${REPLAN_LIMIT} Mother decisions a run`, { timeout: 60000 }, async t => {
  const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const f = fixture(t, { held: names });
  const { graphId } = await f.start(names.map(name => task(name)), { maxConcurrency: 1 });
  for (const [index, name] of names.entries()) {
    await until(() => f.record(graphId), item => required(item.tasks.find(row => row.id === name)).status === 'running', `${name} running`);
    f.release(name);
    // Each success up to the cap brings her decision before the next child is let go.
    if (index < REPLAN_LIMIT) await f.decisions(graphId, index + 1);
  }
  const done = await f.finished(graphId);
  assert.ok(done.mother); assert.ok(done.log);
  assert.equal(done.status, 'succeeded');
  assert.equal(f.prompts(MOTHER).length, REPLAN_LIMIT);
  assert.equal(done.mother.replans, REPLAN_LIMIT);
  assert.equal(done.mother.decisions.length, REPLAN_LIMIT);
  assert.equal(done.log.filter(line => /reached her 5 re-plans/.test(line.text)).length, 1);
});

test('an invalid answer is ignored and logged: not JSON, cancelling a running agent, an add the plan checks refuse', { timeout: 40000 }, async t => {
  const f = fixture(t, { held: ['b', 'c', 'd'], mother: ['I think we are fine.',
    { decision: 'cancel', why: 'stop d', taskIds: ['d'] },
    { decision: 'add', why: 'more', agents: [{ key: 'x', title: 'X', prompt: 'Write elsewhere', folders: ['secret'], doneWhen: [], waitsFor: [] }] }] });
  const { graphId } = await f.start([task('a'), task('b'), task('c'), task('d')]);
  await f.decisions(graphId, 1); f.release('b');
  await f.decisions(graphId, 2); f.release('c');
  await f.decisions(graphId, 3);
  const before = await f.record(graphId);
  f.release('d');
  const done = await f.finished(graphId);
  assert.ok(done.log);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.tasks.map(item => [item.id, item.status]), [['a', 'succeeded'], ['b', 'succeeded'], ['c', 'succeeded'], ['d', 'succeeded']], 'nothing was added or cancelled');
  assert.ok(before); assert.ok(before.mother);
  const invalid = before.mother.decisions.map(item => [item.decision, item.summary]);
  assert.deepEqual(invalid, [['invalid', 'Ignored her answer — her answer was not JSON'], ['invalid', 'Ignored her answer — cancel names only pending agents'],
    ['invalid', 'Ignored her answer — Agent "x" uses the folder "secret", which is not in the project\'s folder list']]);
  assert.ok(done.log.some(line => line.text.startsWith('Mother agent · Ignored her answer')), 'logged in the run history');
});

test('with the switch off, or absent on an older run, she is never asked', { timeout: 30000 }, async t => {
  const f = fixture(t);
  for (const extra of [{ replan: false }, { replan: undefined }]) {
    const { graphId } = await f.start([task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['a'] })], extra);
    const done = await f.finished(graphId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.mother, undefined);
  }
  assert.equal(f.prompts(MOTHER).length, 0);
});

// Catalogues as the engine listed them on 1 Nov (`agy models`; `elpis-next -c model_provider=anthropic-credits debug models`).
const AGY = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-medium'].map(id => ({ model: `agy/${id}` }));
const CLAUDE = ['claude/haiku', 'claude/sonnet', 'claude/opus'].map(model => ({ model }));

test('defaults: Gemini Flash for children (a smaller one if listed, never Argon), Opus on the Claude subscription for the Mother', () => {
  assert.deepEqual(workflowDefaults([{ model: 'gpt-6.1-sol' }, ...AGY, ...CLAUDE]), { child: { model: 'agy/gemini-3.8-flash-medium', provider: 'agy' }, mother: MOTHER_ROUTE, motherFallback: MOTHER_FALLBACK });
  assert.equal(required(workflowDefaults([...AGY, { model: 'agy/gemini-3.9-flash-lite-medium' }]).child).model, 'agy/gemini-3.9-flash-lite-medium', 'a smaller Gemini wins');
  assert.deepEqual(workflowDefaults([...AGY.filter(item => /argon/.test(item.model)), { model: 'claude/sonnet' }]), { child: null, mother: MOTHER_FALLBACK, motherFallback: null }, 'Argon is never a default');
});

test('a run uses the defaults, an agent he set keeps its model, and the Mother falls back to Sonnet low', { timeout: 30000 }, async t => {
  const f = fixture(t, { held: ['b'], runner: { modelDefaults: async () => workflowDefaults([...AGY, ...CLAUDE]) },
    // Opus fails (not a quota error): she continues once on Sonnet at low.
    motherEnv: node => node.model === 'claude/opus' ? { FAKE_ACP_PROMPT_ERROR: 'Overloaded', FAKE_ACP_ERROR_KIND: 'server_error' } : {} });
  const { graphId } = await f.start([task('a'), task('b', { model: 'm-slow' })]);
  await f.decisions(graphId, 1);
  f.release('b');
  const done = await f.finished(graphId);
  assert.equal(done.status, 'succeeded', done.error ?? undefined);
  const ran = (name: string) => f.specs.filter(item => item.name === name).map(item => [item.model, item.provider]);
  assert.deepEqual(ran('a'), [['agy/gemini-3.8-flash-medium', 'agy']], 'an agent without a model runs on Gemini Flash');
  assert.deepEqual(ran('b'), [['m-slow', 'openai']], 'the model he set wins');
  assert.deepEqual(ran(MOTHER), [['claude/opus', 'claude'], ['claude/sonnet', 'claude']]);
  assert.deepEqual(f.specs.filter(item => item.name === MOTHER).map(item => item.spec.reasoningEffort), ['medium', 'low']);
  assert.equal(required(required(done.mother).decisions[0]).decision, 'continue');
});
