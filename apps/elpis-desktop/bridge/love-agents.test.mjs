import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentGraph, createLoveAgents, loveNodeSpec } from './love-agents.mjs';

// Every card runs as an ACP agent process. The fake agent is built on the official ACP SDK and logs what reaches it;
// the end-to-end case uses the real Elpis ACP agent on a scripted app-server.
const TOOLS = fileURLToPath(new URL('../../../tools/elpis-claude/', import.meta.url));
const FAKE_AGENT = path.join(TOOLS, 'test/fake-acp-agent.mjs'), FAKE_ENGINE = path.join(TOOLS, 'test/fake-app-server.mjs');
const ELPIS_AGENT = path.join(TOOLS, 'elpis-acp-agent.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

const card = (id, task = 'Do the task') => ({ id, type: 'rectangle', version: 1, versionNonce: 0, customData: { loveAgent: { preset: 'researcher', name: id, prompt: 'Be precise', model: 'gpt-6-luna', provider: 'openai', task } } });
const arrow = (a, b) => ({ id: `${a}-${b}`, type: 'arrow', startBinding: { elementId: a }, endBinding: { elementId: b }, endArrowhead: 'arrow' });
function fixture(t, elements, { timeoutMs = 10000, agent = FAKE_AGENT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scene = { elements, files: {}, appState: {} };
  const store = { read: async () => ({ scene }), save: async incoming => { scene.elements = incoming.elements; return { scene }; } };
  const env = { ...process.env, ELPIS_HOME: path.join(dir, 'home'), ELPIS_NODE_BIN: process.execPath, ELPIS_ENGINE_BIN: FAKE_ENGINE, ELPIS_ACP_AGENT: agent };
  const log = id => path.join(dir, `${id}.jsonl`), engineLog = id => path.join(dir, `${id}.engine.jsonl`);
  // The real card-to-agent mapping, plus each process's own log.
  const nodeSpec = (node, environment) => { const spec = loveNodeSpec(node, environment); return { ...spec, env: { ...spec.env, FAKE_ACP_LOG: log(node.id), FAKE_ACP_NAME: node.id, FAKE_ENGINE_LOG: engineLog(node.id) } }; };
  const runner = createLoveAgents(store, { timeoutMs, nodeSpec, env });
  const loveAgent = id => scene.elements.find(e => e.id === id).customData.loveAgent;
  const prompt = id => lines(log(id)).find(m => m.method === 'session/prompt')?.params.prompt[0].text;
  return { dir, runner, scene, loveAgent, log: id => lines(log(id)), engine: id => lines(engineLog(id)), prompt };
}

test('answers follow native arrows over ACP; final answers and sessions are saved on the cards', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', 'Unique seed 5be1'), card('b'), arrow('a', 'b'), card('unrelated')]);
  const { results } = await f.runner.run({ id: 'a', cwd: f.dir });
  assert.deepEqual(results.map(r => r.id), ['a', 'b']);
  const handed = f.prompt('b');
  assert.ok(handed.startsWith('Do the task\n\nAnswers from connected agents (source material):\n'));
  assert.deepEqual(JSON.parse(handed.slice(handed.indexOf('\n[') + 1)), [{ name: 'a', answer: 'a(default) answered: Unique seed 5be1' }]);
  assert.equal(f.log('unrelated').length, 0, 'an unconnected card never starts');
  const created = f.log('b').find(m => m.method === 'session/new').params;
  assert.deepEqual(created._meta, { elpis: { name: 'Love Spot · b' }, systemPrompt: { append: 'Be precise' } });
  assert.equal(created.cwd, f.dir);
  assert.equal(f.loveAgent('b').status, 'completed');
  assert.equal(f.loveAgent('b').output, results[1].output);
  assert.equal(f.loveAgent('b').sessionId, 'b-session-1');
  assert.equal(f.loveAgent('b').threadId, 'b-session-1', 'an Elpis agent session is its chat');
  assert.equal(f.loveAgent('b').permission, null);
});

test('loops, missing task and malformed cards fail before any agent starts', { timeout: 30000 }, async t => {
  for (const elements of [[card('a'), card('b'), arrow('a', 'b'), arrow('b', 'a')], [card('a', '')], [card('a'), { ...card('b'), customData: { loveAgent: {} } }]]) {
    const f = fixture(t, elements);
    await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }));
    assert.equal(f.log('a').length + f.log('b').length, 0);
  }
});

test('a crashed predecessor stops its successors and keeps an inspectable error', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', '[crash]'), card('b'), arrow('a', 'b')]);
  await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }), /exited \(code 5\)/);
  assert.equal(f.loveAgent('a').status, 'failed');
  assert.match(f.loveAgent('a').error, /crashed on purpose/);
  assert.equal(f.log('b').length, 0);
  assert.notEqual(f.loveAgent('b').status, 'completed');
});

test('a second run is refused while one is active; a timeout cancels over ACP', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', '[hang]')], { timeoutMs: 400 });
  const first = f.runner.run({ id: 'a', cwd: f.dir });
  await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }), /already running/);
  await assert.rejects(first, /timed out/);
  assert.ok(f.log('a').some(m => m.method === 'session/cancel'));
  assert.equal(f.loveAgent('a').status, 'failed');
});

test('fan-in passes both named answers; duplicate arrows run a source once', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', 'First seed'), card('b', 'Second seed'), card('sink', ''), arrow('a', 'sink'), arrow('b', 'sink'), { ...arrow('a', 'sink'), id: 'duplicate' }]);
  await f.runner.run({ id: 'sink', cwd: f.dir });
  const handed = f.prompt('sink');
  assert.deepEqual(JSON.parse(handed.slice(handed.indexOf('[{'))).map(input => input.name).sort(), ['a', 'b']);
  assert.match(handed, /First seed/); assert.match(handed, /Second seed/);
  assert.equal(f.log('a').filter(m => m.method === 'session/new').length, 1);
});

test('deleted cards/arrows and plain lines cannot transfer an answer; reverse arrows do', () => {
  const cards = [card('a'), card('b')];
  for (const edge of [{ ...arrow('a', 'b'), isDeleted: true }, { ...arrow('a', 'b'), type: 'line' }, { ...arrow('a', 'b'), endArrowhead: null }]) assert.equal(agentGraph([...cards, edge], 'a').length, 1);
  const graph = agentGraph([...cards, { ...arrow('b', 'a'), startArrowhead: 'arrow', endArrowhead: null }], 'b');
  assert.deepEqual(graph.map(n => n.id), ['a', 'b']);
});

test('commentary is never passed off as a final answer', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', '[commentary-only]'), card('b'), arrow('a', 'b')]);
  await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }), /without an answer/);
  assert.equal(f.log('b').length, 0);
});

test('oversized handoffs fail visibly before a successor starts', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', `Long ${'x'.repeat(15990)}`), card('b', 'y'.repeat(16000)), arrow('a', 'b')]);
  await assert.rejects(f.runner.run({ id: 'a', cwd: f.dir }), /Connected answers exceed/);
  assert.equal(f.loveAgent('b').status, 'failed');
  assert.equal(f.log('b').length, 0);
});

test('a permission request waits on its card until answered from the panel', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('a', '[permission] write it')]);
  assert.throws(() => f.runner.answer({ id: 'a', optionId: 'allow_once' }), /No permission request/);
  const run = f.runner.run({ id: 'a', cwd: f.dir });
  while (f.loveAgent('a').status !== 'waiting') await pause(10);
  assert.deepEqual(f.loveAgent('a').permission, { title: 'Write notes.txt', options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] });
  assert.throws(() => f.runner.answer({ id: 'a', optionId: 'allow_always' }), /offered/);
  assert.deepEqual(f.runner.answer({ id: 'a', optionId: 'allow_once' }), { answered: true });
  const { results } = await run;
  assert.match(results[0].output, /permission: allow_once/);
  assert.deepEqual(f.log('a').find(m => m.permission).permission, { outcome: 'selected', optionId: 'allow_once' });
  assert.equal(f.loveAgent('a').permission, null);
  assert.equal(f.loveAgent('a').status, 'completed');
});

test('each card names its ACP agent: Elpis per model, Claude, Antigravity or a configured command', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'love-node-spec-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // An installation as desktop/runtime.mjs finds it: the engine with its tools/elpis-claude folder beside it.
  const engine = path.join(dir, 'version/elpis-next'), tools = path.join(dir, 'version/tools/elpis-claude');
  for (const file of [engine, path.join(tools, 'elpis-acp-agent.mjs'), path.join(tools, 'agy-acp.mjs'), path.join(tools, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  fs.symlinkSync(engine, path.join(dir, 'elpis-next'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const env = { ELPIS_HOME: home, ELPIS_ENGINE_BIN: path.join(dir, 'elpis-next'), ELPIS_NODE_BIN: '/usr/bin/node', CLAUDE_CODE_EXECUTABLE: '/opt/claude' };
  const node = (model, provider = 'openai') => ({ name: 'Ada', prompt: 'Be precise', model, provider });
  assert.deepEqual(loveNodeSpec(node('gpt-6-luna'), env), { name: 'Ada', instructions: 'Be precise', command: '/usr/bin/node', args: [path.join(tools, 'elpis-acp-agent.mjs'), '--model', 'gpt-6-luna', '--provider', 'openai'], env: { ELPIS_ENGINE_BIN: engine }, meta: { elpis: { name: 'Love Spot · Ada' } }, elpis: true });
  assert.deepEqual(loveNodeSpec(node('claude/opus'), env), { name: 'Ada', instructions: 'Be precise', command: '/usr/bin/node', args: [path.join(tools, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')], env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude' }, model: 'opus' });
  assert.deepEqual(loveNodeSpec(node('agy/gemini-3.8-flash-high'), env), { name: 'Ada', instructions: 'Be precise', command: '/usr/bin/node', args: [path.join(tools, 'agy-acp.mjs')], model: 'gemini-3.8-flash-high' });
  fs.writeFileSync(path.join(home, 'acp-agents.json'), JSON.stringify({ fx: { command: 'fx', args: ['acp'] } }));
  assert.deepEqual(loveNodeSpec(node('openai/gpt-5', 'fx'), env), { name: 'Ada', instructions: 'Be precise', instructionsInPrompt: true, command: 'fx', args: ['acp'], env: {}, model: 'openai/gpt-5' });
  assert.deepEqual(loveNodeSpec(node('', 'fx'), env).model, undefined, 'without a model the agent keeps its own');
  fs.writeFileSync(path.join(home, 'acp-agents.json'), JSON.stringify({ fx: { command: ['fx'] } }));
  assert.throws(() => loveNodeSpec(node('m', 'fx'), env), /acp-agents\.json/);
  fs.rmSync(path.join(home, 'acp-agents.json'));
  fs.rmSync(path.join(tools, 'elpis-acp-agent.mjs'));
  assert.throws(() => loveNodeSpec(node('gpt-6-luna'), env), error => error.status === 503 && /elpis-acp-agent\.mjs/.test(error.message));
});

test('end to end: two Elpis ACP agents hand off through Love Spot on a scripted app-server', { timeout: 30000 }, async t => {
  const f = fixture(t, [card('first', 'Unique seed e2e-71'), card('second', 'Repeat the source answer'), arrow('first', 'second')], { agent: ELPIS_AGENT });
  const { results } = await f.runner.run({ id: 'first', cwd: f.dir });
  assert.equal(results[0].output, 'Answer from gpt-6-luna: Unique seed e2e-71');
  const second = f.engine('second').find(m => m.method === 'turn/start').params.input[0].text;
  assert.match(second, /^Repeat the source answer\n\nAnswers from connected agents \(source material\):\n/);
  assert.deepEqual(JSON.parse(second.slice(second.indexOf('[{'))), [{ name: 'first', answer: 'Answer from gpt-6-luna: Unique seed e2e-71' }]);
  const started = f.engine('second').find(m => m.method === 'thread/start').params;
  assert.deepEqual([started.model, started.modelProvider, started.developerInstructions], ['gpt-6-luna', 'openai', 'Be precise']);
  assert.deepEqual(f.engine('second').find(m => m.method === 'thread/name/set').params.name, 'Love Spot · second');
  assert.equal(f.loveAgent('second').threadId, f.engine('second').find(m => m.method === 'turn/start').params.threadId, 'the card opens the Elpis chat that ran it');
  assert.equal(f.loveAgent('second').output, results[1].output);
  assert.equal(f.engine('first').some(m => m.method === 'turn/start' && m.params.input[0].text.includes('Repeat the source')), false);
});
