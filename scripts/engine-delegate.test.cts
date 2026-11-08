'use strict';
// A37 (20 Oct): an engine chat delegates like a Claude one. The real bridge gives an engine chat the elpis-agents
// delegate tool while the Subagents switch is on; the helper it starts is recorded under that chat, which the delegate
// server learns from the engine's `_meta.threadId`. With the switch off the tool is not offered. The engine defers MCP
// tools behind tool search, so the scripted model searches for it first, as a real one does.
// Usage: node scripts/engine-delegate.test.cts /absolute/engine [absolute/bridge]
import type { ServerResponse } from 'node:http';
import type { ProviderApi } from './lib/mock-provider.cts';

type Socket = { once(event: 'open', listener: () => void): void; once(event: 'error', listener: (error: Error) => void): void; on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; terminate(): void };
type Tool = { type?: string; name?: string; namespace?: string | undefined; tools?: Tool[] };
type ModelInput = { type?: string; role?: string; content?: unknown; tools?: Tool[] };
type ModelBody = { tools?: Tool[]; input?: ModelInput[] };
type Action = { type?: string; [key: string]: unknown };
type WireMessage = { id?: number; method?: string; result?: unknown; error?: { message: string }; params: { threadId: string; turn: { id: string } } };
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ThreadResult = { thread: { id: string } };
type TurnResult = { turn: { id: string } };
type ThreadRead = { thread?: { turns?: { status: string }[] } };
type TurnList = { data?: { id: string; status: string }[] };
type Delegation = { parentThreadId: string };
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const WebSocket: new (address: string) => Socket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message, call }: ProviderApi = require('./lib/mock-provider.cts');
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const wait = async (f: () => boolean, label: string) => { const until = Date.now() + 30000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
const search = { type: 'tool_search_call', call_id: 'search_1', execution: 'client', arguments: { query: 'delegate a task to a helper agent' } };
// The tools a request offers: its own, and those its last tool search exposed.
const offered = (body: ModelBody) => [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'tool_search_output').flatMap(i => i.tools || [])]
  .flatMap(t => t.type === 'namespace' ? (t.tools || []).map(c => ({ ...c, namespace: t.name })) : [t]);
const delegateTool = (body: ModelBody) => offered(body).find(t => t.name === 'delegate' && /elpis.agents/.test(t.namespace ?? '') || /elpis.agents__delegate$/.test(t.name ?? '')) ?? null;
async function main() {
  const binary = process.argv[2] as string, bridgePath = process.argv[3] ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs');
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const provider = new Provider(); await provider.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-engine-delegate-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), store = path.join(root, 'sessions.json');
  for (const p of [home, cwd]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nthread_unload_delay_secs=1\n[features]\nmulti_agent=true\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const sock = path.join(root, 'bridge.sock');
  const bridge = spawn(process.execPath, [bridgePath], { cwd, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home, ELPIS_ENGINE_BIN: binary,
    ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: sock, ELPIS_NO_AGY: '1', ACP_BRIDGE_LOG: path.join(root, 'bridge.log'), ACP_BRIDGE_STORE: store,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', d => { errors += d; });
  const seen: WireMessage[] = [], pending = new Map<number | undefined, Waiter>(); let next = 1, ws: Socket | undefined;
  const req = <T,>(method: string, params: unknown = {}) => new Promise<T>((resolve, reject) => {
    const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}: ${errors}`)); }, 30000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer }); (ws as Socket).send(JSON.stringify({ id, method, params }));
  });
  // One engine chat's turn: the model searches its tools, then `reply` answers with the delegate tool found (or null).
  async function chatTurn(reply: (tool: Tool | null) => Action) {
    const { thread } = await req<ThreadResult>('thread/start', { cwd, model: 'gpt-5.5', approvalPolicy: 'never', permissions: ':danger-full-access' });
    let found: Tool | null = null, names: string[] = [];
    provider.actions.push(search, body => { found = delegateTool(body as ModelBody); names = offered(body as ModelBody).map(t => `${t.namespace ?? ''}${t.name ?? t.type}`); return reply(found); });
    const { turn } = await req<TurnResult>('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Delegate one helper.', text_elements: [] }] });
    await wait(() => seen.some(m => m.method === 'turn/completed' && m.params.threadId === thread.id && m.params.turn.id === turn.id), 'chat turn completes');
    return { chat: thread.id, found, names };
  }
  // A client (the TUI or the app); a new one replaces the last as `ws`.
  async function connect() {
    const client = ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise<void>((res, rej) => { client.once('open', res); client.once('error', rej); });
    client.on('message', data => {
      const m: WireMessage = JSON.parse(String(data)); seen.push(m);
      if (m.method && m.id !== undefined) client.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } }));
      else if (!m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    await req('initialize', { clientInfo: { name: 'codex-tui', version: '1' }, capabilities: { experimentalApi: true } }); client.send(JSON.stringify({ method: 'initialized' }));
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    await connect();

    const on = await chatTurn(tool => {
      if (!tool) return message('No delegate tool.');
      provider.actions.push(message('Helper done.'), message('Chat done.'));
      return { type: 'function_call', call_id: 'delegate_1', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_DELEGATE_FIXTURE: reply done.', model: 'gpt-5.5', provider: 'fixture', allow_writes: false }) };
    });
    assert.ok(on.found, `an engine chat is offered the delegate tool while Subagents is on; offered: ${on.names.join(', ')}`);
    assert.ok(provider.requests.some(r => JSON.stringify(r.body.input).includes('ENGINE_DELEGATE_FIXTURE')), 'the helper ran its task');
    const delegations: Record<string, Delegation> = JSON.parse(fs.readFileSync(store, 'utf8'))._delegations ?? {};
    assert.ok(Object.values(delegations).some(d => d.parentThreadId === on.chat), `the helper is recorded under the engine chat: ${JSON.stringify(delegations)}`);
    console.log('PASS an engine chat delegates a helper, recorded under that chat');

    // The app closes while a helper the chat started still works; the chat is idle, so the engine would unload it
    // (and the delegate server in its session) a second after its last client leaves.
    const isHelper = (body: Record<string, unknown>) => (body.input as ModelInput[]).some(i => i.role === 'user' && JSON.stringify(i.content).includes('ENGINE_RESTART_FIXTURE'));
    const route = (body: Record<string, unknown>) => isHelper(body) ? { hang: true } : message('Chat done.');
    const background = await chatTurn(tool => {
      provider.actions.push(route, route);
      return { type: 'function_call', call_id: 'delegate_2', name: (tool as Tool).name, ...((tool as Tool).namespace && { namespace: (tool as Tool).namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_RESTART_FIXTURE: reply done.', model: 'gpt-5.5', provider: 'fixture', allow_writes: false, wait: false }) };
    });
    await wait(() => provider.hanging.size === 1, 'the helper is mid-turn');
    const helperId = Object.entries(JSON.parse(fs.readFileSync(store, 'utf8'))._delegations as Record<string, Delegation>).find(([, d]) => d.parentThreadId === background.chat)?.[0];
    (ws as Socket).terminate(); await pause(5000);
    assert.equal(provider.hanging.size, 1, 'the helper still works after the app closed');
    await connect();
    const [heldResponse] = provider.hanging; const held = heldResponse as ServerResponse; provider.hanging.delete(held);
    const item = message('Helper done.');
    held.writeHead(200, { 'content-type': 'text/event-stream' });
    held.end([{ type: 'response.created', response: { id: 'r_restart' } }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r_restart', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    let last: string | undefined;
    for (const until = Date.now() + 30000; last !== 'completed' && Date.now() < until; await pause(300))
      last = (await req<ThreadRead>('thread/read', { threadId: helperId, includeTurns: true }).catch(() => null))?.thread?.turns?.at(-1)?.status;
    assert.equal(last, 'completed', 'the helper finishes');
    console.log('PASS after the app closes and reopens, a running helper keeps working and finishes');

    // Stop on a helper (from the app or TUI) also ends the command it left running in the background.
    const started = path.join(cwd, 'stop-started'), wrote = path.join(cwd, 'stop-wrote');
    const stopping = (body: Record<string, unknown>) => (body.input as ModelInput[]).some(i => i.role === 'user' && JSON.stringify(i.content).includes('ENGINE_STOP_FIXTURE'));
    let helperRequests = 0;
    const stopRoute = (body: Record<string, unknown>) => !stopping(body) ? message('Chat done.') : ++helperRequests === 1
      ? call('stop_cmd', 'exec_command', { cmd: `printf s > '${started}'; sleep 3; printf x > '${wrote}'`, yield_time_ms: 250 }) : { hang: true };
    const stopChat = await chatTurn(tool => {
      provider.actions.push(stopRoute, stopRoute, stopRoute);
      return { type: 'function_call', call_id: 'delegate_3', name: (tool as Tool).name, ...((tool as Tool).namespace && { namespace: (tool as Tool).namespace }),
        arguments: JSON.stringify({ task: 'ENGINE_STOP_FIXTURE: run the command.', model: 'gpt-5.5', provider: 'fixture', allow_writes: true, wait: false }) };
    });
    await wait(() => provider.hanging.size === 1, 'the helper waits while its command runs');
    assert.ok(fs.existsSync(started), 'the helper started its command');
    const stopId = Object.entries(JSON.parse(fs.readFileSync(store, 'utf8'))._delegations as Record<string, Delegation>).find(([, d]) => d.parentThreadId === stopChat.chat)?.[0];
    const running = (await req<TurnList>('thread/turns/list', { threadId: stopId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.[0];
    assert.equal(running?.status, 'inProgress', 'the client sees the helper\u2019s running turn');
    await req('turn/interrupt', { threadId: stopId, turnId: (running as { id: string }).id });
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
    await Promise.race([new Promise<void>(r => bridge.once('exit', () => r())), pause(5000).then(() => bridge.kill('SIGKILL'))]);
    provider.close(); fs.writeFileSync(path.join(root, 'stderr.log'), errors); console.log(`Evidence ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
