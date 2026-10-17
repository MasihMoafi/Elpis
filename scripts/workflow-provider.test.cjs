'use strict';
// Real shared bridge and native scheduler; inference stays on the local fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message, call } = require('./lib/mock-provider.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), 'Usage: node scripts/workflow-provider.test.cjs /absolute/native-binary');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-workflow-provider-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const provider = new Provider(); await provider.start();
  provider.actions.shift = () => request => {
    const input = JSON.stringify(request);
    const graphId = input.match(/Graph ID: ([^\\\s]+)/)?.[1];
    const taskId = input.match(/Task ID: ([^\\\s]+)/)?.[1];
    assert(graphId && taskId, 'Only a native workflow worker may request inference');
    if (input.includes('WORKFLOW_PROVIDER_EVIDENCE_7321')) return message('Worker complete');
    return call(`report-${taskId}`, 'report_agent_work_task', {
      graph_id: graphId, task_id: taskId, outcome: 'succeeded', summary: 'Native worker complete',
      changed_files: [], checks: ['Read assigned fixture prompt'], evidence: ['WORKFLOW_PROVIDER_EVIDENCE_7321'],
      risks: [], edge_cases_considered: ['Subscription routes are blocked before scheduling'],
      open_questions: [], what_i_did_not_check: ['Paid provider inference'],
    });
  };
  const model = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../codex-rs/models-manager/models.json'), 'utf8')).models.find(item => item.slug === 'gpt-5.5');
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ models: [model] }));
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\ncode_mode=false\nmulti_agent=true\nenable_fanout=true\nsqlite=true\n[memories]\ngenerate_memories=false\nuse_memories=false\n[model_providers.fixture]\nname="Local workflow fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  const agy = path.join(root, 'agy'); fs.writeFileSync(agy, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const socket = path.join(root, 'bridge.sock'), store = path.join(home, 'sessions.json');
  const env = { ...process.env, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, ELPIS_ENGINE_BIN: binary,
    ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socket, ACP_BRIDGE_STORE: store, AGY_BIN: agy,
    ACP_BRIDGE_LOG: path.join(root, 'bridge.log'), CLAUDE_CODE_OAUTH_TOKEN: '', NO_PROXY: 'localhost,127.0.0.1,::1' };
  delete env.ELPIS_NO_AGY;
  const bridge = spawn(process.execPath, [path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', data => { errors += data; });
  const clients = [];
  async function client() {
    const ws = new WebSocket('ws+unix://' + socket + ':/'), pending = new Map(); let sequence = 0;
    clients.push(ws);
    ws.on('message', raw => { const value = JSON.parse(raw); const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve(value); } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${errors}`)); }, 20000);
      pending.set(id, answer => { clearTimeout(timer); resolve(answer); }); ws.send(JSON.stringify({ id, method, params }));
    });
    assert((await request('initialize', { clientInfo: { name: 'workflow-provider-fixture', version: '1' }, capabilities: { experimentalApi: true } })).result);
    return request;
  }
  async function waitFor(check, label) {
    const until = Date.now() + 20000;
    while (Date.now() < until) { const result = await check(); if (result) return result; if (provider.error) throw provider.error; await pause(40); }
    throw new Error(`${label} timed out; evidence ${root}; ${errors}`);
  }
  const graph = id => ({ rootThreadId: id, name: 'Provider routing fixture', tasks: [{ id: 'inspect', kind: 'explore', title: 'Inspect fixture', instruction: 'Read this local fixture prompt and report your result with report_agent_work_task. Do not run commands or delegate.', acceptanceCriteria: ['Report fixture evidence'], writeScopes: [] }], maxConcurrency: 1, maxRuntimeSeconds: 30 });
  try {
    await waitFor(() => fs.existsSync(socket), 'Bridge startup');
    const rpc = await client();
    const native = await rpc('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture' });
    assert(native.result?.thread?.id, JSON.stringify(native));
    const started = await rpc('workGraph/run', graph(native.result.thread.id));
    assert(started.result?.graphId, JSON.stringify(started));
    await waitFor(async () => (await rpc('workGraph/list', { rootThreadId: native.result.thread.id })).result?.data.some(item => item.id === started.result.graphId && item.status === 'succeeded'), 'Native workflow completion');
    assert(provider.requests.length > 0); assert(provider.requests.every(item => item.body.model === 'gpt-5.5'));
    console.log('PASS native custom-provider workflow runs on its configured model');
    async function rejected(request, id, label) {
      const before = provider.requests.length;
      const graphsBefore = (await request('workGraph/list', { rootThreadId: id })).result.data.length;
      for (const method of ['workGraph/run', 'workGraph/runWithProviders']) {
        const params = graph(id);
        if (method === 'workGraph/runWithProviders') params.tasks[0] = { ...params.tasks[0], provider: 'fixture', model: 'gpt-5.5' };
        const answer = await request(method, params);
        assert(answer.error?.message?.includes('subscription'), `${label} ${method} silently scheduled on the native carrier: ${JSON.stringify(answer)}`);
      }
      assert.equal((await request('workGraph/list', { rootThreadId: id })).result.data.length, graphsBefore, 'Rejected graph must not persist');
      await pause(100); assert.equal(provider.requests.length, before, 'Rejected graph must not start a native worker');
      console.log(`PASS ${label} rejects before graph persistence or worker inference`);
    }
    for (const model of ['claude/haiku', 'agy/gemini-3.8-flash-medium']) {
      const started = await rpc('thread/start', { cwd, model });
      assert.equal(started.result?.model, model, JSON.stringify(started));
      await rejected(rpc, started.result.thread.id, model);
    }
    const savedId = native.result.thread.id;
    const data = JSON.parse(fs.readFileSync(store, 'utf8')); data[savedId] = { model: 'claude/haiku', turns: [] }; fs.writeFileSync(store, JSON.stringify(data));
    const resumed = await client();
    await rejected(resumed, savedId, 'Saved Claude subscription on a new connection');
    const answer = await resumed('thread/resume', { threadId: savedId });
    assert.equal(answer.result?.model, 'claude/haiku', JSON.stringify(answer));
    await rejected(resumed, savedId, 'Resumed Claude subscription');
    console.log(`Evidence: ${root}`);
  } finally {
    fs.writeFileSync(path.join(root, 'provider-requests.json'), JSON.stringify(provider.requests, null, 2));
    for (const ws of clients) ws.close();
    bridge.kill('SIGTERM'); await pause(100); provider.close();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
