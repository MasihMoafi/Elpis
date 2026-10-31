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
const { Provider, message, call } = require('./lib/mock-provider.js');
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, label) => { const until = Date.now() + 30000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
const search = { type: 'tool_search_call', call_id: 'search_1', execution: 'client', arguments: { query: 'delegate a task to a helper agent' } };
const mcpCatalogSearch = label => ({ type: 'tool_search_call', call_id: 'search_mcp_' + label, execution: 'client',
  arguments: { query: 'generation_alpha generation_beta Offline MCP reload fixture' } });
// The tools a request offers: its own, and those its last tool search exposed.
const offered = body => [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'tool_search_output').flatMap(i => i.tools || [])]
  .flatMap(t => t.type === 'namespace' ? (t.tools || []).map(c => ({ ...c, namespace: t.name })) : [t]);
const delegateTool = body => offered(body).find(t => t.name === 'delegate' && /elpis.agents/.test(t.namespace ?? '') || /elpis.agents__delegate$/.test(t.name ?? '')) ?? null;
const mcpCatalog = body => offered(body).filter(tool => {
  const serialized = JSON.stringify(tool);
  return serialized.includes('generation_alpha') || serialized.includes('generation_beta');
}).map(tool => ({
  name: tool.name ?? null,
  namespace: tool.namespace ?? null,
  type: tool.type ?? null,
  description: tool.description ?? null,
}));
const mcpCatalogServers = catalog => ['alpha', 'beta'].filter(server =>
  catalog.some(tool => JSON.stringify(tool).includes('generation_' + server)));
const mcpInheritanceOnly = process.argv[2] === '--mcp-inheritance';
async function main() {
  const binary = mcpInheritanceOnly ? process.argv[3] : process.argv[2];
  const bridgePath = (mcpInheritanceOnly ? process.argv[4] : process.argv[3]) ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const provider = new Provider(); await provider.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-engine-delegate-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), store = path.join(root, 'sessions.json');
  for (const p of [home, cwd]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nthread_unload_delay_secs=1\n[features]\nmulti_agent=true\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  if (mcpInheritanceOnly) {
    const fixture = path.resolve(__dirname, 'mcp-reset-runtime.test.cjs');
    const mcpLog = path.join(root, 'mcp.jsonl');
    const serverConfig = name => [
      '[mcp_servers.' + name + ']',
      'command = ' + JSON.stringify(process.execPath),
      'args = [' + JSON.stringify(fixture) + ', "--mcp-fixture"]',
      '[mcp_servers.' + name + '.env]',
      'MCP_RESET_LOG = ' + JSON.stringify(mcpLog),
      'MCP_RESET_GENERATION = ' + JSON.stringify(name),
      '',
    ].join('\n');
    fs.appendFileSync(path.join(home, 'config.toml'), '\n' + serverConfig('alpha') + serverConfig('beta'));
  }
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
  const verifyMcpInheritance = async () => {
    const cases = [
      { label: 'default', expected: ['alpha', 'beta'] },
      { label: 'empty', selection: [], expected: [] },
      { label: 'alpha', selection: ['alpha'], expected: ['alpha'] },
    ];
    const results = [];
    for (const testCase of cases) {
      const params = { cwd, model: 'gpt-5.5', approvalPolicy: 'never', permissions: ':danger-full-access' };
      if (Object.hasOwn(testCase, 'selection')) params.mcpServerSelection = testCase.selection;
      const thread = (await req('thread/start', params)).thread;
      const expectedSelection = Object.hasOwn(testCase, 'selection') ? testCase.selection : null;
      assert.deepEqual(thread.mcpServerSelection, expectedSelection, testCase.label + ': parent selection snapshot');

      let parentCatalog;
      let childCatalog;
      const childMarker = 'ENGINE_MCP_INHERITANCE_CHILD_' + testCase.label;
      provider.actions.push(mcpCatalogSearch('parent_' + testCase.label));
      provider.actions.push(body => {
        parentCatalog = mcpCatalog(body);
        return search;
      });
      provider.actions.push(body => {
        const found = delegateTool(body);
        assert(found, testCase.label + ': parent could not discover the delegate tool');
        provider.actions.push(mcpCatalogSearch('child_' + testCase.label));
        provider.actions.push(childBody => {
          childCatalog = mcpCatalog(childBody);
          assert(JSON.stringify(childBody).includes(childMarker), testCase.label + ': captured a non-child model request');
          return message('Child MCP catalog observed.');
        });
        provider.actions.push(() => message('Parent turn completed.'));
        return call('delegate_' + testCase.label, found.name, {
          task: childMarker + ': inspect the available MCP tools, then finish.',
          model: 'gpt-5.5', provider: 'fixture', allow_writes: false,
        });
      });

      const eventStart = seen.length;
      const { turn } = await req('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'Delegate child catalog case ' + testCase.label + '.', text_elements: [] }],
      });
      await wait(() => seen.slice(eventStart).some(event =>
        event.method === 'turn/completed' && event.params.threadId === thread.id && event.params.turn.id === turn.id),
      'MCP inheritance case ' + testCase.label);
      assert(parentCatalog, testCase.label + ': no parent model request observed');
      assert(childCatalog, testCase.label + ': no delegated child model request observed');
      console.log('MCP catalog ' + JSON.stringify({
        case: testCase.label,
        parent: mcpCatalogServers(parentCatalog),
        child: mcpCatalogServers(childCatalog),
        expected: testCase.expected,
      }));
      assert.deepEqual(mcpCatalogServers(parentCatalog), testCase.expected, testCase.label + ': parent model-visible MCP catalog');
      assert.deepEqual(mcpCatalogServers(childCatalog), testCase.expected, testCase.label + ': delegated child model-visible MCP catalog');
      results.push({
        selection: Object.hasOwn(testCase, 'selection') ? testCase.selection : 'omitted',
        parentSelectionSnapshot: thread.mcpServerSelection,
        parentCatalog,
        childCatalog,
      });
    }

    const runtimeSource = fs.readFileSync(path.join(path.dirname(binary), 'runtime-source.txt'), 'utf8').trim();
    const evidence = { runtimeSource, cases: results };
    const evidencePath = process.env.ELPIS_MCP_INHERITANCE_EVIDENCE || path.join(root, 'mcp-inheritance-evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log('PASS delegated child MCP catalog inheritance ' + JSON.stringify(evidence));
  };
  // A client (the TUI or the app); a new one replaces the last as `ws`.
  async function connect() {
    const client = ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise((res, rej) => { client.once('open', res); client.once('error', rej); });
    client.on('message', data => {
      const m = JSON.parse(String(data)); seen.push(m);
      if (m.method && m.id !== undefined) client.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } }));
      else if (!m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    await req('initialize', { clientInfo: { name: 'codex-tui', version: '1' }, capabilities: { experimentalApi: true } }); client.send(JSON.stringify({ method: 'initialized' }));
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    await connect();

    if (mcpInheritanceOnly) {
      await verifyMcpInheritance();
      return;
    }

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

    // The app closes while a helper the chat started still works; the chat is idle, so the engine would unload it
    // (and the delegate server in its session) a second after its last client leaves.
    const isHelper = body => body.input.some(i => i.role === 'user' && JSON.stringify(i.content).includes('ENGINE_RESTART_FIXTURE'));
    const route = body => isHelper(body) ? { hang: true } : message('Chat done.');
    const background = await chatTurn(tool => {
      provider.actions.push(route, route);
      return { type: 'function_call', call_id: 'delegate_2', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_RESTART_FIXTURE: reply done.', model: 'gpt-5.5', provider: 'fixture', allow_writes: false, wait: false }) };
    });
    await wait(() => provider.hanging.size === 1, 'the helper is mid-turn');
    const helperId = Object.entries(JSON.parse(fs.readFileSync(store, 'utf8'))._delegations).find(([, d]) => d.parentThreadId === background.chat)?.[0];
    ws.terminate(); await pause(5000);
    assert.equal(provider.hanging.size, 1, 'the helper still works after the app closed');
    await connect();
    const [held] = provider.hanging; provider.hanging.delete(held);
    const item = message('Helper done.');
    held.writeHead(200, { 'content-type': 'text/event-stream' });
    held.end([{ type: 'response.created', response: { id: 'r_restart' } }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r_restart', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    let last;
    for (const until = Date.now() + 30000; last !== 'completed' && Date.now() < until; await pause(300))
      last = (await req('thread/read', { threadId: helperId, includeTurns: true }).catch(() => null))?.thread?.turns?.at(-1)?.status;
    assert.equal(last, 'completed', 'the helper finishes');
    console.log('PASS after the app closes and reopens, a running helper keeps working and finishes');

    // Stop on a helper (from the app or TUI) also ends the command it left running in the background.
    const started = path.join(cwd, 'stop-started'), wrote = path.join(cwd, 'stop-wrote');
    const stopping = body => body.input.some(i => i.role === 'user' && JSON.stringify(i.content).includes('ENGINE_STOP_FIXTURE'));
    let helperRequests = 0;
    const stopRoute = body => !stopping(body) ? message('Chat done.') : ++helperRequests === 1
      ? call('stop_cmd', 'exec_command', { cmd: `printf s > '${started}'; sleep 3; printf x > '${wrote}'`, yield_time_ms: 250 }) : { hang: true };
    const stopChat = await chatTurn(tool => {
      provider.actions.push(stopRoute, stopRoute, stopRoute);
      return { type: 'function_call', call_id: 'delegate_3', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_STOP_FIXTURE: run the command.', model: 'gpt-5.5', provider: 'fixture', allow_writes: true, wait: false }) };
    });
    await wait(() => provider.hanging.size === 1, 'the helper waits while its command runs');
    assert.ok(fs.existsSync(started), 'the helper started its command');
    const stopId = Object.entries(JSON.parse(fs.readFileSync(store, 'utf8'))._delegations).find(([, d]) => d.parentThreadId === stopChat.chat)?.[0];
    const running = (await req('thread/turns/list', { threadId: stopId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.[0];
    assert.equal(running?.status, 'inProgress', 'the client sees the helper\u2019s running turn');
    await req('turn/interrupt', { threadId: stopId, turnId: running.id });
    await pause(4500);
    assert.equal(fs.existsSync(wrote), false, 'Stop ended the command the helper left running');
    console.log('PASS Stop on a helper ends its turn and the command it left running');

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
