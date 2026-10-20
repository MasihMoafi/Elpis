'use strict';
// A37 (20 Oct): an engine chat delegates like a Claude one. The real bridge gives an engine chat the elpis-agents
// delegate tool while the Subagents switch is on; the helper it starts is recorded under that chat, which the delegate
// server learns from the engine's `_meta.threadId`. With the switch off the tool is not offered. The engine defers MCP
// tools behind tool search, so the scripted model searches for it first, as a real one does.
// Usage: node scripts/engine-delegate.test.cjs /absolute/engine [absolute/bridge]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message } = require('./lib/mock-provider.js');
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, label) => { const until = Date.now() + 30000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
const search = { type: 'tool_search_call', call_id: 'search_1', execution: 'client', arguments: { query: 'delegate a task to a helper agent' } };
// The tools a request offers: its own, and those its last tool search exposed.
const offered = body => [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'tool_search_output').flatMap(i => i.tools || [])]
  .flatMap(t => t.type === 'namespace' ? (t.tools || []).map(c => ({ ...c, namespace: t.name })) : [t]);
const delegateTool = body => offered(body).find(t => t.name === 'delegate' && /elpis.agents/.test(t.namespace ?? '') || /elpis.agents__delegate$/.test(t.name ?? '')) ?? null;
async function main() {
  const binary = process.argv[2], bridgePath = process.argv[3] ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const provider = new Provider(); await provider.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-engine-delegate-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), store = path.join(root, 'sessions.json');
  for (const p of [home, cwd]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\n[features]\nmulti_agent=true\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const sock = path.join(root, 'bridge.sock');
  const bridge = spawn(process.execPath, [bridgePath], { cwd, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home, ELPIS_ENGINE_BIN: binary,
    ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: sock, ELPIS_NO_AGY: '1', ACP_BRIDGE_LOG: path.join(root, 'bridge.log'), ACP_BRIDGE_STORE: store,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', d => { errors += d; });
  const seen = [], pending = new Map(); let next = 1, ws;
  const req = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}: ${errors}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  // One engine chat's turn: the model searches its tools, then `reply` answers with the delegate tool found (or null).
  async function chatTurn(reply) {
    const { thread } = await req('thread/start', { cwd, model: 'gpt-5.5', approvalPolicy: 'never', permissions: ':danger-full-access' });
    let found = null, names = [];
    provider.actions.push(search, body => { found = delegateTool(body); names = offered(body).map(t => `${t.namespace ?? ''}${t.name ?? t.type}`); return reply(found); });
    const { turn } = await req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Delegate one helper.', text_elements: [] }] });
    await wait(() => seen.some(m => m.method === 'turn/completed' && m.params.threadId === thread.id && m.params.turn.id === turn.id), 'chat turn completes');
    return { chat: thread.id, found, names };
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', data => {
      const m = JSON.parse(String(data)); seen.push(m);
      if (m.method && m.id !== undefined) ws.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } }));
      else if (!m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    await req('initialize', { clientInfo: { name: 'codex-tui', version: '1' }, capabilities: { experimentalApi: true } }); ws.send(JSON.stringify({ method: 'initialized' }));

    const on = await chatTurn(tool => {
      if (!tool) return message('No delegate tool.');
      provider.actions.push(message('Helper done.'), message('Chat done.'));
      return { type: 'function_call', call_id: 'delegate_1', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_DELEGATE_FIXTURE: reply done.', model: 'gpt-5.5', provider: 'fixture', allow_writes: false }) };
    });
    assert.ok(on.found, `an engine chat is offered the delegate tool while Subagents is on; offered: ${on.names.join(', ')}`);
    assert.ok(provider.requests.some(r => JSON.stringify(r.body.input).includes('ENGINE_DELEGATE_FIXTURE')), 'the helper ran its task');
    const delegations = JSON.parse(fs.readFileSync(store, 'utf8'))._delegations ?? {};
    assert.ok(Object.values(delegations).some(d => d.parentThreadId === on.chat), `the helper is recorded under the engine chat: ${JSON.stringify(delegations)}`);
    console.log('PASS an engine chat delegates a helper, recorded under that chat');

    await req('config/batchWrite', { edits: [{ keyPath: 'features.multi_agent', value: false, mergeStrategy: 'replace' }] });
    const off = await chatTurn(() => message('Done.'));
    assert.equal(off.found, null, 'with Subagents off the engine chat is not offered the delegate tool');
    console.log('PASS with Subagents off an engine chat has no delegate tool');
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    ws?.terminate(); bridge.kill('SIGTERM');
    await Promise.race([new Promise(r => bridge.once('exit', r)), pause(5000).then(() => bridge.kill('SIGKILL'))]);
    provider.close(); fs.writeFileSync(path.join(root, 'stderr.log'), errors); console.log(`Evidence ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
