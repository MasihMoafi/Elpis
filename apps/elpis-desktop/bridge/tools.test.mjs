import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { childEnv, createTools, runCli } from './tools.mjs';

function call(tools, method, pathname, { body, type = 'application/json' } = {}) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Object.assign(Readable.from(raw), { method, headers: { 'content-type': type } });
  const url = new URL(pathname, 'http://127.0.0.1');
  let sent;
  return tools(request, {}, url, (_response, status, value) => { sent = { status, value }; }).then(() => sent);
}

function fakeCli() {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'rag' && args[0] === 'capabilities') return JSON.stringify({ stages: [
      { stage: 'lexical', provider: 'tantivy', model: 'BM25', location: 'local' },
      { stage: 'embedding', provider: 'ollama', model: 'bge-m3', location: 'local', required_credential: null },
      { stage: 'generation', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', location: 'api', required_credential: 'openrouter_key', secret: 'sk-never' }] });
    if (command === 'rag' && args[0] === 'doctor') return JSON.stringify({ detected: { api_keys: ['openrouter'], ollama: { running: true, url: 'http://localhost:11434' } }, codex: { authenticated: true } });
    if (command === 'rag' && args[0] === 'config') return 'ok\n';
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return { calls, tools: createTools({ run }) };
}

test('RAG settings expose only provider, model, location and key presence', async () => {
  const { tools } = fakeCli();
  const { status, value } = await call(tools, 'GET', '/api/tools/rag');
  assert.equal(status, 200);
  assert.deepEqual(value.stages.map(stage => stage.stage), ['embedding', 'generation']);
  assert.deepEqual(value.stages[1], { stage: 'generation', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', location: 'api', credential: 'openrouter_key' });
  assert.deepEqual(value.keys, { openrouter: true });
  assert.equal(JSON.stringify(value).includes('sk-never'), false);
});

test('RAG commands receive configured MCP credentials internally and redact them from output', async () => {
  const calls = [];
  const tools = createTools({ environment: async () => ({ OPENROUTER_API_KEY: 'fixture-secret-environment' }), run: async (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === 'capabilities' ? JSON.stringify({ stages: [] }) : args[0] === 'doctor' ? JSON.stringify({ detected: { api_keys: ['openrouter'] } }) : 'ok';
  } });
  const saved = await call(tools, 'POST', '/api/tools/rag', { body: { stage: 'generation', model: 'openai/gpt-5-mini' } });
  assert.equal(calls.length, 3);
  assert(calls.every(call => call.options.env.OPENROUTER_API_KEY === 'fixture-secret-environment'));
  assert(!JSON.stringify(saved).includes('fixture-secret-environment'));
});

test('CLI failure cannot become success through stdout or reveal credentials through stderr', async () => {
  await assert.rejects(runCli(process.execPath, ['-e', "process.stdout.write('partial output');process.stderr.write('fixture-secret-stderr');process.exit(1)"]), error => error.status === 502 && !error.message.includes('fixture-secret-stderr'));
});

test('answer model and reranker changes go through `rag config`; embeddings and junk are refused', async () => {
  const { tools, calls } = fakeCli();
  await call(tools, 'POST', '/api/tools/rag', { body: { stage: 'generation', model: 'openai/gpt-5-mini' } });
  await call(tools, 'POST', '/api/tools/rag', { body: { stage: 'reranking', model: 'fastembed' } });
  assert.deepEqual(calls.filter(c => c[1] === 'config'), [['rag', 'config', 'answer', 'openai/gpt-5-mini'], ['rag', 'config', 'reranker', 'fastembed']]);
  await assert.rejects(call(tools, 'POST', '/api/tools/rag', { body: { stage: 'embedding', model: 'bge-m3' } }), /rag setup/);
  await assert.rejects(call(tools, 'POST', '/api/tools/rag', { body: { stage: 'generation', model: '$(id)' } }), /OpenRouter answer model/);
  await assert.rejects(call(tools, 'POST', '/api/tools/rag', { body: { stage: 'reranking', model: '--help' } }), /reranker/);
  assert.equal(calls.filter(c => c[1] === 'config').length, 2, 'refused changes run nothing');
});

test('removed dictation and search routes are gone', async () => {
  const { tools } = fakeCli();
  for (const path of ['/api/tools/whispertype', '/api/tools/rag/search', '/api/tools/whispertype/session'])
    await assert.rejects(call(tools, 'POST', path, { body: {} }), /Unknown tool operation/);
});

test('child processes follow the system proxy but never proxy loopback', () => {
  const proxied = childEnv({ PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:10808', NO_PROXY: 'example.internal' });
  assert.equal(proxied.NODE_USE_ENV_PROXY, '1');
  for (const key of ['NO_PROXY', 'no_proxy']) assert.deepEqual(proxied[key].split(','), ['example.internal', 'localhost', '127.0.0.1', '::1']);
  const direct = childEnv({ PATH: '/usr/bin' });
  assert.equal(direct.NODE_USE_ENV_PROXY, undefined, 'no proxy configured: nothing is forced');
  assert.equal(direct.NO_PROXY, undefined);
});
