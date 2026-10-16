import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { DesktopClient, existingSocket } from './client.mjs';
import { startDesktopServer } from './server.mjs';

const ROOT = '00000000-0000-0000-0000-000000000001';
const CHILD = '00000000-0000-0000-0000-000000000002';
const CREATED = '00000000-0000-0000-0000-000000000003';
const MODEL = 'test-model';
const FORK = '00000000-0000-0000-0000-000000000007';
function fixture({ prunerSupported = false, omitWorkflowParentInList = false, replacementPages } = {}) {
  const workflowRecords = [];
  let pruner = {model:"optimizer-original",provider:"openai",version:"pruner-v1",providers:[{id:"openai",displayName:"OpenAI"}],systemPrompt:"PRIVATE CONFIG SECRET"};
  const configRead = { config: {
    model: MODEL, model_provider: 'openai', background_model: 'cheap-model', background_provider: 'local',
    features: { automatic_context_pruning: true }, memories: { use_memories: true, generate_memories: false },
    model_providers: { local: { name: 'Local provider', base_url: 'http://127.0.0.1:1234/v1?key=PRIVATE CONFIG SECRET', http_headers: { Authorization: 'PRIVATE CONFIG SECRET' } },
      openrouter: { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', env_key: 'APP_TEST_OPENROUTER_KEY' } },
    mcp_servers: { rag: { command: '/usr/bin/python', args: ['--token', 'PRIVATE CONFIG SECRET'], env: { OPENROUTER_API_KEY: 'PRIVATE CONFIG SECRET', RAG_MCP_BACKEND: 'lancedb' } },
      whispertype: { command: 'python', env_vars: ['APP_TEST_COMPANY_KEY'], env: { WHISPERTYPE_BACKEND: 'local', WHISPERTYPE_CLOUD_MODEL: 'openai/gpt-4o-mini-transcribe' } },
      remote: { url: 'https://mcp.example/path?token=PRIVATE CONFIG SECRET', bearer_token_env_var: 'APP_TEST_BEARER', enabled: false } },
    api_key: 'PRIVATE CONFIG SECRET',
  }, layers: [{ name: { type: 'user', file: '/private/config.toml' }, version: 'user-version', config: { secret: 'PRIVATE CONFIG SECRET' } }] };
  const requirementsRead = { requirements: null };
  const hooksList = { data: [{ cwd: '/work', warnings: ['hooks.json: unknown field ignored'], errors: [], hooks: [
    { key: 'user:/private/hooks.json:pre_tool_use:0:0', eventName: 'preToolUse', handlerType: 'command', command: 'rtk hook claude', async: false, matcher: '^Bash$', timeoutSec: 5, statusMessage: 'compressing shell output', sourcePath: '/home/person/.elpis-next/hooks.json', source: 'user', pluginId: null, displayOrder: 0, enabled: true, isManaged: false, currentHash: 'sha256:current', trustStatus: 'untrusted' },
    { key: 'managed:/etc/requirements.toml:stop:0:0', eventName: 'stop', handlerType: 'command', command: 'audit', matcher: null, timeoutSec: 30, statusMessage: null, sourcePath: '/etc/requirements.toml', source: 'system', pluginId: null, displayOrder: 1, enabled: true, isManaged: true, currentHash: 'sha256:managed', trustStatus: 'managed' },
  ] }] };
  const threads = new Map([
    [ROOT, { id: ROOT, name: 'Existing root', source: 'cli', status: { type: 'idle' } }],
    [CHILD, { id: CHILD, name: null, preview: '', agentNickname: 'Sagan', model: MODEL, modelProvider: 'openai', parentThreadId: ROOT, canAcceptDirectInput: false, source: { subAgent: { thread_spawn: { parent_thread_id: ROOT, agent_path: '/root/failure_reporting' } } }, status: { type: 'active' } }],
  ]);
  const socket = new EventEmitter(); socket.sent = []; socket.closed = false;
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { userAgent: 'protocol-test' }; break;
      case 'config/read': result = configRead; break;
      case 'configRequirements/read': result = requirementsRead; break;
      case 'pruner/read': if (prunerSupported) {result=pruner;break;} queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: {code: -32601, message: 'Unknown method'} }))); return;
      case 'pruner/write': pruner={...pruner,model:request.params.model,provider:request.params.provider,version:'pruner-v2'};result=pruner;break;
      case 'config/batchWrite': result = {status:'ok'}; break;
      case 'hooks/list': result = hooksList; break;
      case 'memory/reset': result = {}; break;
      // Like native stored rows, listed threads do not report forkedFromId; thread/read does.
      case 'thread/list': result = { data: [...threads.values()].filter(thread => !!thread.archived === !!request.params.archived).filter(thread => !request.params.ancestorThreadId || thread.parentThreadId === request.params.ancestorThreadId).map(thread => ({ ...thread, forkedFromId: null, ...(omitWorkflowParentInList && thread.source?.subAgent?.other?.startsWith('work_graph:') ? {parentThreadId:null} : {}) })), nextCursor: null }; break;
      case 'thread/read': result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      case 'thread/resume': result = { thread: structuredClone(threads.get(request.params.threadId)), model: threads.get(request.params.threadId).model ?? MODEL, collaborationMode: threads.get(request.params.threadId).collaborationMode, initialTurnsPage: { data: [] } }; break;
      case 'thread/turns/list': result = { data: threads.get(request.params.threadId).status?.type === 'active' ? [{ id: 'running-turn', status: 'inProgress' }] : [] }; break;
      case 'thread/fork': { const thread = { id: FORK, forkedFromId: request.params.threadId, source: 'appServer', canAcceptDirectInput: true, model: request.params.model, modelProvider: request.params.modelProvider, status: { type: 'idle' } }; threads.set(FORK, thread); result = { thread }; break; }
      case 'thread/name/set': threads.get(request.params.threadId).name = request.params.name; result = {}; break;
      case 'thread/archive': threads.get(request.params.threadId).archived = true; result = {}; break;
      case 'thread/unarchive': delete threads.get(request.params.threadId).archived; result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      case 'thread/revert': result = { thread: { ...structuredClone(threads.get(request.params.threadId)), turns: [] } }; break;
      case 'thread/delete': if (request.params.threadId === ROOT && threads.has(FORK)) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: `cannot delete thread ${CHILD}: forked history still references it` } }))); return; } threads.delete(request.params.threadId); if (request.params.threadId === ROOT) threads.delete(CHILD); result = {}; break;
      case 'account/read': result = { account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: true }; break;
      case 'account/rateLimits/read': result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 } }, rateLimitsByLimitId: {
        codex: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 }, secondary: null, credits: { balance: 'PRIVATE CONFIG SECRET' } },
        claude: { limitId: 'claude', limitName: 'Claude', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 3 } },
        'antigravity-pro': { limitId: 'antigravity-pro', limitName: 'Gemini Pro', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 4 } } } }; break;
      case 'config/mcpServer/reload': result = {}; break;
      case 'thread/items/list': result = request.params.turnId
        ? replacementPages?.[request.params.cursor ?? 'start'] ?? { data: [{ turnId: request.params.turnId, item: { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Original prompt', textElements: [] }] } }], nextCursor: null }
        : { data: [{ turnId: 't1', item: { type: 'agentMessage', id: 'item1', text: 'Actual fixture transcript' }, startedAtMs: 1 }], nextCursor: null }; break;
      case 'model/list': result = { data: [{ id: MODEL, model: MODEL, displayName: 'Test model' }, { id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)' }], nextCursor: null }; break;
      case 'thread/start': {
        const thread = { id: CREATED, source: 'cli', canAcceptDirectInput: true, status: { type: 'idle' } };
        threads.set(CREATED, thread); result = { thread }; break;
      }
      case 'turn/start': threads.get(request.params.threadId).status = { type: 'active' }; result = { turn: { id: 'new-turn', status: 'inProgress', items: [] } }; break;
      case 'turn/steer': result = { turnId: request.params.expectedTurnId }; break;
      case 'turn/interrupt': threads.get(request.params.threadId).status = { type: 'idle' }; result = {}; break;
      case 'workGraph/list': result = {data:workflowRecords.filter(graph => graph.rootThreadId === request.params.rootThreadId)}; break;
      case 'workGraph/runWithProviders':
      case 'workGraph/run': result = {graphId:'graph-1',threadId:request.params.rootThreadId,turnId:'workflow-turn'}; break;
      default: throw new Error(`Unexpected protocol method ${request.method}`);
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  socket.close = () => { socket.closed = true; socket.emit('close'); };
  const client = new DesktopClient(socket);
  return { socket, client, threads, configRead, requirementsRead, workflowRecords, hooksList };
}

test('configured connection models use only that endpoint and never authorize the same ID on the main route', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  configRead.config.model_providers.local = { name: 'gpt-oss', base_url: 'http://127.0.0.1:1234/v1', experimental_bearer_token: 'LOCAL CATALOG KEY' };
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.get('authorization') });
    return new Response(JSON.stringify({ data: [{ id: 'unique-local-book-model', name: 'Book model' }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const local = await client.models({ provider: 'local' });
    assert.deepEqual(local.data.map(model => model.model), ['unique-local-book-model']);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:1234/v1/models', authorization: 'Bearer LOCAL CATALOG KEY' }]);
    assert.doesNotMatch(JSON.stringify(local), /LOCAL CATALOG KEY|Authorization|base_url/);
    await client.createThread({ provider: 'local', model: local.data[0].model });
    const sent = socket.sent.findLast(message => message.method === 'thread/start');
    assert.equal(sent.params.modelProvider, 'local'); assert.equal(sent.params.model, 'unique-local-book-model');
    await assert.rejects(client.createThread({ model: 'unique-local-book-model' }), /current Elpis model list/);
    await assert.rejects(client.models({ provider: 'missing' }), /saved API address/);
    requirementsRead.requirements = { modelProvider: 'openai' };
    await assert.rejects(client.models({ provider: 'local' }), /restricted/);
    assert.equal(calls.length, 1, 'missing and restricted connections must not make an endpoint request');
  } finally { globalThis.fetch = original; client.close(); }
});

test('saved-conversation search passes its term and cursor to the native list before decoration', async () => {
  const { client, socket } = fixture(); await client.initialize();
  try {
    await client.listThreads({ searchTerm: 'Augustus', cursor: 'saved-page', limit: 25 });
    const params = socket.sent.findLast(message => message.method === 'thread/list').params;
    assert.equal(params.searchTerm, 'Augustus'); assert.equal(params.cursor, 'saved-page'); assert.equal(params.limit, 25);
    const count = socket.sent.filter(message => message.method === 'thread/list').length;
    await assert.rejects(client.listThreads({ searchTerm: ' ' }), /conversation search/);
    assert.equal(socket.sent.filter(message => message.method === 'thread/list').length, count);
  } finally { client.close(); }
});

test('existing chats are written directly after a native rejoin; parent-owned agents continue in a fork', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  const listed = await client.listThreads();
  assert.equal(listed.data.length, 2);
  assert.deepEqual(listed.data.map(thread => [thread.desktopAccess.writable, thread.desktopAccess.mode]), [[true, 'direct'], [true, 'continue']]);
  assert.ok(socket.sent.find(row => row.method === 'thread/list').params.sourceKinds.includes('subAgentThreadSpawn'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/resume').map(row => row.params.threadId), [CHILD], 'working agents are followed live');
  const child = await client.readThread(CHILD);
  assert.equal(child.data[0].item.text, 'Actual fixture transcript');
  await client.send(ROOT, { text: 'Continue the root' });
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/resume').map(row => row.params), [
    { threadId: CHILD, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } },
    { threadId: ROOT, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } }]);
  assert.deepEqual(socket.sent.filter(row => row.method === 'turn/start').map(row => row.params.threadId), [ROOT]);
  // Elpis refuses direct turns for a multi-agent v2 agent, so its history continues in a fork with its model.
  threads.get(CHILD).status = { type: 'idle' };
  await assert.rejects(client.send(CHILD, { text: 'Follow up' }), /continued conversation name/);
  const continued = await client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' });
  assert.equal(continued.thread.id, FORK); assert.equal(continued.continuedFrom, CHILD); assert.equal(continued.thread.name, 'Failure reporting (continued)');
  assert.deepEqual(socket.sent.find(row => row.method === 'thread/fork').params, { threadId: CHILD, model: MODEL, modelProvider: 'openai' });
  assert.deepEqual(socket.sent.filter(row => row.method === 'turn/start').map(row => row.params.threadId), [ROOT, FORK], 'never a direct turn on the agent');
  client.close();
});

test('a continued-agent conversation survives a failed name or first send, and an explicit retry reuses it', async t => {
  for (const method of ['thread/name/set', 'turn/start']) await t.test(method, async () => {
    const { client, socket, threads } = fixture();
    try {
      await client.initialize(); threads.get(CHILD).status = { type: 'idle' };
      const send = socket.send; let reject = true;
      socket.send = raw => {
        const request = JSON.parse(raw);
        if (reject && request.method === method && request.params?.threadId === FORK) {
          reject = false; socket.sent.push(request);
          queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'Fixture continuation write rejected' } })));
        } else send(raw);
      };
      const result = await client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' });
      assert.equal(result.thread.id, FORK); assert.equal(result.continuedFrom, CHILD);
      assert.equal(result.thread.desktopAccess.mode, 'direct'); assert.equal(result.turn, undefined);
      assert.match(result.sendError, /Fixture continuation write rejected/);
      assert.equal(result.thread.name, method === 'thread/name/set' ? undefined : 'Failure reporting (continued)');
      assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, method === 'thread/name/set' ? 0 : 1,
        'a naming failure does not send, and a send failure is not automatically retried');
      const retried = await client.send(result.thread.id, { text: 'Follow up' });
      assert.equal(retried.turn.id, 'new-turn');
      assert.equal(socket.sent.filter(row => row.method === 'thread/fork').length, 1, 'retry stays in the acknowledged conversation');
      assert.equal(socket.sent.filter(row => row.method === 'turn/start').at(-1).params.threadId, FORK);
    } finally { client.close(); }
  });
});

test('an unknown continued-agent send outcome preserves its fork without replaying the write', async () => {
  const { client, socket, threads } = fixture();
  try {
    await client.initialize(); client.timeoutMs = 20; threads.get(CHILD).status = { type: 'idle' };
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === 'turn/start') socket.sent.push(request); // Native outcome is deliberately unknown.
      else send(raw);
    };
    const result = await client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' });
    assert.equal(result.thread.id, FORK); assert.equal(result.continuedFrom, CHILD); assert.equal(result.turn, undefined);
    assert.match(result.sendError, /outcome is unknown/);
    assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 1);
    assert.equal(socket.sent.filter(row => row.method === 'thread/fork').length, 1);
  } finally { client.close(); }
});

test('a failed continuation fork does not report an acknowledged conversation or send a message', async () => {
  const { client, socket, threads } = fixture();
  try {
    await client.initialize(); threads.get(CHILD).status = { type: 'idle' };
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === 'thread/fork') {
        socket.sent.push(request);
        queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'Fixture fork rejected' } })));
      } else send(raw);
    };
    await assert.rejects(client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' }), /Fixture fork rejected/);
    assert.equal(socket.sent.filter(row => ['thread/name/set', 'turn/start'].includes(row.method)).length, 0);
  } finally { client.close(); }
});

test('new roots send, steer and interrupt through typed protocol without overriding permissions', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.models();
  await assert.rejects(client.createThread({ model: 'invented' }), /model list/);
  await assert.rejects(client.createThread({ approvalPolicy: 'never' }), /Unsupported/);
  const created = await client.createThread({ model: MODEL });
  assert.equal(created.thread.desktopAccess.writable, true);
  const first = client.send(CREATED, { text: 'Do the task', model: MODEL });
  await assert.rejects(client.send(CREATED, { text: 'Race' }), /pending/);
  assert.equal((await first).turn.id, 'new-turn');
  await assert.rejects(client.send(CREATED, { text: 'Do not silently steer' }), /Use Steer/);
  assert.equal((await client.steer(CREATED, { text: 'Clarify', expectedTurnId: 'new-turn' })).turnId, 'new-turn');
  await client.interrupt(CREATED, { turnId: 'new-turn' });
  const request = socket.sent.find(row => row.method === 'turn/start');
  assert.deepEqual(request.params, { threadId: CREATED, input: [{ type: 'text', text: 'Do the task', text_elements: [] }], model: MODEL });
  assert.equal(socket.sent.some(row => row.method === 'thread/resume'), false);
  client.close(); assert.equal(socket.closed, true);
});

test('approvals are only forwarded for owned roots and only accept exact offered decisions, including amendments', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.createThread({});
  const events = []; client.on('event', event => events.push(event));
  const always = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'diff'] } };
  const approval = threadId => ({ id: 'approval-native', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn1', command: 'echo hello', availableDecisions: ['accept', always, 'decline'] } });
  socket.emit('message', JSON.stringify(approval(ROOT))); assert.equal(events.length, 0);
  socket.emit('message', JSON.stringify(approval(CREATED)));
  const visible = events[0].data; assert.equal(visible.wireId, undefined);
  assert.throws(() => client.answerApproval(visible.id, { decision: 'rm -rf' }), /Unsupported/);
  assert.throws(() => client.answerApproval(visible.id, { decision: 'acceptForSession' }), /not offered/);
  assert.throws(() => client.answerApproval(visible.id, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } } }), /not offered/);
  client.answerApproval(visible.id, { decision: always });
  assert.deepEqual(socket.sent.at(-1), { id: 'approval-native', result: { decision: always } });
  assert.throws(() => client.answerApproval(visible.id, { decision: 'accept' }), /no longer pending/);
  socket.emit('message', JSON.stringify({ id: 'permissions', method: 'item/permissions/requestApproval', params: { threadId: CREATED } }));
  assert.equal(socket.sent.at(-1).error.code, -32601);
  client.close();
});

test('worker approvals follow recorded ancestry and name the requester; resolved requests cannot reappear', async () => {
  const {client,socket,threads}=fixture(); await client.initialize(); await client.resume(ROOT,{});
  const grandchild='00000000-0000-0000-0000-000000000005';
  threads.set(grandchild,{id:grandchild,name:'Review worker',parentThreadId:CHILD,source:{subAgent:{other:'work_graph:fixture:review'}},status:{type:'active'}});
  const events=[];client.on('event',event=>events.push(event));
  const request=(id,wire)=>socket.emit('message',JSON.stringify({id:wire,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:'worker-turn',command:'inspect evidence',availableDecisions:['accept','decline']}}));
  request(grandchild,'worker-approval');
  await new Promise(resolve=>setImmediate(resolve));
  const approval=events.find(event=>event.type==='approval')?.data;
  assert.ok(approval,'owned-root descendant request must be visible');
  assert.equal(approval.ownerThreadId,ROOT);assert.equal(approval.thread.name,'Review worker');
  assert.equal(approval.params.threadId,grandchild);
  client.answerApproval(approval.id,{decision:'accept'});
  assert.deepEqual(socket.sent.at(-1),{id:'worker-approval',result:{decision:'accept'}});
  const unrelated='00000000-0000-0000-0000-000000000006';threads.set(unrelated,{id:unrelated,name:'Unrelated root',status:{type:'active'}});
  request(unrelated,'unrelated-approval');
  request(CHILD,'already-resolved');
  socket.emit('message',JSON.stringify({method:'serverRequest/resolved',params:{threadId:CHILD,requestId:'already-resolved'}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.filter(event=>event.type==='approval').length,1);
  assert.equal(client.pendingApprovals.length,0);
  request(ROOT,'root-resolved-elsewhere');
  const last=events.filter(event=>event.type==='approval').at(-1).data;
  socket.emit('message',JSON.stringify({method:'serverRequest/resolved',params:{threadId:ROOT,requestId:'root-resolved-elsewhere'}}));
  assert.ok(events.some(event=>event.type==='approvalResolved'&&event.data.id===last.id));
  assert.equal(client.pendingApprovals.length,0);
  client.close();
});

test('HTTP requires capability/cookie, strict origin/host, allowlisted routes and contained assets', async t => {
  const { client, socket } = fixture(); await client.initialize();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-desktop-test-'));
  const out = path.join(temp, 'out'); await fs.mkdir(out); await fs.writeFile(path.join(out, 'index.html'), '<h1>Elpis</h1>');
  await fs.writeFile(path.join(temp, 'secret.txt'), 'PLANTED PRIVATE FILE');
  await fs.symlink(path.join(temp, 'secret.txt'), path.join(out, 'leak.txt'));
  const app = await startDesktopServer({ client, staticDir: out }); t.after(() => app.close());
  const url = new URL(app.url); const origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = (pathname, data, headers = {}) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(origin + '/')).status, 200);
  assert.equal((await fetch(origin + '/api/threads')).status, 401);
  assert.equal((await post('/api/session', { token: 'wrong' })).status, 403);
  assert.equal((await post('/api/session', { token }, { Origin: 'https://evil.example' })).status, 403);
  const auth = await post('/api/session', { token }); assert.equal(auth.status, 200);
  assert.match(auth.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = pathname => fetch(origin + pathname, { headers: { Cookie: cookie } });
  const result = await (await get('/api/threads')).json(); assert.equal(result.data.length, 2);
  const child = await (await get(`/api/threads/${CHILD}`)).json(); assert.equal(child.thread.id, CHILD);
  const settings = await (await get('/api/settings')).json(); assert.equal(settings.smartPrune.enabled, true);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE CONFIG SECRET|private\/config/);
  const context = await (await get(`/api/threads/${ROOT}/context`)).json(); assert.equal(context.tokenUsage, null);
  assert.equal((await post('/api/settings', { background_model: 'changed' }, { Cookie: cookie })).status, 400);
  assert.equal((await post(`/api/threads/${ROOT}/context`, {}, { Cookie: cookie })).status, 405);
  assert.equal((await get('/api/threads?archived=yes')).status, 400);
  assert.equal((await get('/api/threads?archived=true')).status, 200);
  assert.equal((await get('/api/threads?archived=false')).status, 200);
  assert.equal((await post(`/api/threads/${ROOT}/rename`, { name: 'Renamed over HTTP' }, { Cookie: cookie })).status, 200);
  assert.equal((await post(`/api/threads/${ROOT}/turns`, { text: 'written directly' }, { Cookie: cookie })).status, 200);
  for (const route of ['/api/mcp', '/api/providers']) assert.doesNotMatch(await (await get(route)).text(), /PRIVATE CONFIG SECRET|token=/);
  assert.equal((await post('/api/rpc', { method: 'command/exec' }, { Cookie: cookie })).status, 404);
  assert.equal((await get('/api/threads?limit=10000')).status, 400);
  // Node fetch rewrites Host; raw HTTP verifies the server's actual Host guard.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/threads', { agent: new http.Agent(), headers: { Cookie: cookie, Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post('/api/threads', {}, { Cookie: cookie, Origin: 'null' })).status, 403);
  assert.equal((await get('/leak.txt')).status, 403);
  assert.equal(socket.sent.some(row => row.method === 'command/exec'), false);
});

test('workflow workers keep recorded task names and lineage when native list omits their parent', async () => {
  const {client,socket,threads,workflowRecords}=fixture({omitWorkflowParentInList:true}); await client.initialize();
  const graphId='10000000-0000-0000-0000-000000000001';
  threads.set(CHILD,{id:CHILD,name:null,parentThreadId:ROOT,status:{type:'idle'},source:{subAgent:{other:`work_graph:${graphId}:inspect`}}});
  workflowRecords.push({id:graphId,rootThreadId:ROOT,tasks:[{id:'inspect',title:'Inspect actual project',assignedThreadId:CHILD}]});
  const worker=(await client.listThreads()).data.find(thread=>thread.id===CHILD);
  assert.equal(worker.workflowTaskTitle,'Inspect actual project');
  assert.equal(worker.parentThreadId,ROOT,'list must preserve the native read and recorded graph lineage');
  assert.deepEqual(socket.sent.filter(row=>row.method==='thread/read').map(row=>row.params.threadId),[CHILD]);
  const again=(await client.listThreads()).data.find(thread=>thread.id===CHILD);
  assert.equal(again.parentThreadId,ROOT);
  assert.equal(socket.sent.filter(row=>row.method==='thread/read').length,1,'verified workflow metadata is reused');
  threads.get(CHILD).source={subAgent:{other:`work_graph:${graphId}:different-task`}};
  const unrelated=(await client.listThreads()).data.find(thread=>thread.id===CHILD);
  assert.equal(unrelated.workflowTaskTitle,undefined);
  assert.equal(unrelated.parentThreadId,null,'unrecorded task cannot inherit cached lineage');
  client.close();
});

test('manual workflows require an idle root and forward the reviewed graph without a model turn', async () => {
  const {client,socket,threads}=fixture(); await client.initialize();
  const task={id:'inspect',title:'Inspect',instruction:'Read the evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Report evidence']};
  const draft={rootThreadId:ROOT,name:'Reviewed workflow',maxConcurrency:2,tasks:[task]};
  assert.deepEqual(await client.workflows(ROOT),{data:[]});
  await assert.rejects(client.runWorkflow({...draft,rootThreadId:CHILD}),/root conversation/);
  threads.get(ROOT).status={type:'active'};
  await assert.rejects(client.runWorkflow(draft),/Wait for/);
  threads.get(ROOT).status={type:'idle'};
  await assert.rejects(client.runWorkflow({...draft,approvalPolicy:'never'}),/Unsupported/);
  await assert.rejects(client.runWorkflow({...draft,tasks:[{...task,model:'claude/opus'}]}),/native model/);
  assert.equal(socket.sent.some(row=>row.method==='workGraph/run'),false);
  assert.equal((await client.runWorkflow(draft)).graphId,'graph-1');
  assert.deepEqual(socket.sent.find(row=>row.method==='workGraph/run').params,draft);
  assert.equal(socket.sent.some(row=>row.method==='turn/start'),false);
  assert.equal(socket.sent.filter(row=>row.method==='workGraph/run').length,1);
  client.close();
});

test('browser rag command reaches actual native turn input without changing plain text', async () => {
  for (const input of ['/rag', '/rag show', '/ragged show', 'rag show']) {
    const { client, socket } = fixture(); await client.initialize();
    await client.send(ROOT, { text: input });
    const submitted = socket.sent.findLast(row => row.method === 'turn/start').params.input[0].text;
    if (input === '/rag' || input === '/rag show') {
      assert(submitted.includes('rag config show'));
      assert(submitted.includes('configured RAG MCP server'));
      assert(submitted.endsWith(input === '/rag' ? 'RAG request: ' : 'RAG request: show'));
    } else assert.equal(submitted, input);
    client.close();
  }
});

test('provider settings redact stored keys and apply private versioned native configuration', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  requirementsRead.requirements = { modelProvider: null };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-provider-settings-'));
  const configPath = path.join(root, 'config.toml');
  await fs.writeFile(configPath, 'fixture', { mode: 0o644 });
  configRead.layers[0].name.file = configPath;
  configRead.config.model_providers.saved = { name: 'Stored OpenRouter', base_url: 'https://openrouter.ai/api/v1', experimental_bearer_token: 'provider-fixture-secret' };
  const snapshot = await client.providerSettings();
  assert.equal(snapshot.application.scope, 'newConversations');
  assert(snapshot.application.credentialClearMessage.includes('does not revoke authentication in existing conversations'));
  const saved = snapshot.providers.find(provider => provider.id === 'saved');
  assert.deepEqual(saved.auth, { source: 'stored', keySet: true, envKey: null, acceptsKey: false });
  assert(!JSON.stringify(snapshot).includes('provider-fixture-secret'));
  assert.equal((await client.providers()).openrouter.find(provider => provider.id === 'saved').keySet, true);
  const input = { version: 'user-version', id: 'saved', name: 'Updated OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', credential: { action: 'replace', value: 'provider-fixture-replacement' } };
  const updated = await client.saveProvider(input);
  assert(!JSON.stringify(updated).includes('provider-fixture-replacement'));
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  const write = socket.sent.findLast(row => row.method === 'config/batchWrite');
  assert.equal(write.params.expectedVersion, 'user-version');
  assert(write.params.edits.some(edit => edit.keyPath === 'model_providers.saved.experimental_bearer_token' && edit.value === 'provider-fixture-replacement'));
  assert(write.params.edits.some(edit => edit.keyPath === 'model_providers.saved.env_key' && edit.value === null));
  for (const value of ['', '********', '••••••••']) {
    await client.saveProvider({ ...input, credential: { action: 'replace', value } });
    assert(!socket.sent.findLast(row => row.method === 'config/batchWrite').params.edits.some(edit => /bearer_token|env_key/.test(edit.keyPath)));
  }
  await client.saveProvider({ ...input, credential: { action: 'clear' } });
  assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params.edits.slice(-2).map(edit => edit.value), [null, null]);
  client.close();
});

test('custom API models are validated under the selected native provider for creation and follow-up', async () => {
  const { client, socket, configRead, threads } = fixture(); await client.initialize(); await client.models();
  delete configRead.config.model_providers.local.http_headers;
  for (const model of ['claude/opus', 'agy/gemini-pro', 'bad model;']) await assert.rejects(client.createThread({ provider: 'local', model }), /Subscription model|model ID/);
  await assert.rejects(client.createThread({ provider: 'unknown', model: 'fixture/custom-model' }), /configured provider/);
  await assert.rejects(client.createThread({ model: 'fixture/custom-model' }), /current Elpis model list/);
  assert.equal(socket.sent.filter(row => row.method === 'thread/start').length, 0);
  await client.createThread({ provider: 'local', model: 'fixture/custom-model' });
  assert.deepEqual(socket.sent.findLast(row => row.method === 'thread/start').params, { model: 'fixture/custom-model', modelProvider: 'local' });
  // Reflect the native thread/read route rather than trusting the renderer's selection.
  threads.get(CREATED).modelProvider = 'local'; threads.get(CREATED).model = 'fixture/custom-model';
  await client.send(CREATED, { text: 'follow-up', model: 'fixture/custom-model' });
  assert.equal(socket.sent.findLast(row => row.method === 'turn/start').params.model, 'fixture/custom-model');
  await client.steer(CREATED, { text: 'steer same route', expectedTurnId: 'new-turn' });
  assert.equal(socket.sent.findLast(row => row.method === 'turn/steer').params.threadId, CREATED);
  await assert.rejects(client.send(ROOT, { text: 'default provider stays catalog bound', model: 'fixture/custom-model' }), /current Elpis model list/);
  client.close();
});

test('provider setup rejects unsafe endpoints, policy, stale versions and alternate auth sources before mutation', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  requirementsRead.requirements = { modelProvider: null };
  const input = { version: 'user-version', id: 'custom', name: 'Custom', baseUrl: 'http://localhost:1234/v1', credential: { action: 'preserve' } };
  for (const baseUrl of ['http://example.com/v1', 'https://key@example.com/v1', 'https://example.com/v1?key=secret', 'file:///private', 'http://0.0.0.0:1234/v1']) await assert.rejects(client.saveProvider({ ...input, baseUrl }), /HTTPS/);
  await assert.rejects(client.saveProvider({ ...input, version: 'stale' }), error => error.status === 409);
  await assert.rejects(client.saveProvider({ ...input, id: 'openai' }), /custom provider ID/);
  configRead.config.model_providers.custom = { name: 'Command auth', base_url: input.baseUrl, auth: { command: '/bin/true' } };
  await assert.rejects(client.saveProvider(input), error => error.status === 403);
  delete configRead.config.model_providers.custom;
  requirementsRead.requirements.modelProvider = 'openai';
  await assert.rejects(client.saveProvider(input), error => error.status === 403);
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 0);
  client.close();
});

test('MCP credentials preserve blanks and masks and never return secrets', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-mcp-credential-'));
  const configPath = path.join(root, 'config.toml');
  await fs.writeFile(configPath, 'fixture config', { mode: 0o644 });
  configRead.layers[0].name.file = configPath;
  assert.equal((await client.mcp()).configPath, configPath);
  const saved = await client.saveMcp({ version: 'user-version', action: 'credentials', name: 'whispertype', env: { OPENROUTER_API_KEY_COMPANY: 'new-fixture-key' } });
  assert(!JSON.stringify(saved).includes('new-fixture-key'));
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(socket.sent.findLast(m => m.method === 'config/batchWrite').params.edits, [{ keyPath: 'mcp_servers.whispertype.env.OPENROUTER_API_KEY_COMPANY', value: 'new-fixture-key', mergeStrategy: 'replace' }]);
  const count = socket.sent.filter(m => m.method === 'config/batchWrite').length;
  for (const value of ['', '********', '••••••••']) await client.saveMcp({ version: 'user-version', action: 'credentials', name: 'whispertype', env: { OPENROUTER_API_KEY_COMPANY: value } });
  assert.equal(socket.sent.filter(m => m.method === 'config/batchWrite').length, count);
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'credentials', name: 'missing', env: { OPENROUTER_API_KEY: 'key' } }), /Unknown MCP/);
  for (const name of ['LD_PRELOAD', 'API.KEY']) await assert.rejects(client.saveMcp({ version: 'user-version', action: 'credentials', name: 'rag', env: { [name]: 'bad' } }), /credential/);
  client.close();
});

test('MCP credential writes reject unsafe files before any native write', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-mcp-unsafe-'));
  const target = path.join(root, 'config.toml');
  await fs.writeFile(target, 'fixture', { mode: 0o644 });
  const link = path.join(root, 'link.toml'); await fs.symlink(target, link);
  for (const file of [link, root, path.join(root, 'missing.toml')]) {
    configRead.layers[0].name.file = file;
    await assert.rejects(client.saveMcp({ version: 'user-version', action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: 'fixture-key' } }), error => error.status === 403);
  }
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 0);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  configRead.layers[0].name.file = target;
  await client.saveMcp({ version: 'user-version', action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: '' } });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644, 'a blank key must not change config or permissions');
  client.close();
});

test('MCP credential errors never echo submitted keys', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-mcp-credential-error-'));
  const configPath = path.join(root, 'config.toml');
  await fs.writeFile(configPath, 'fixture config', { mode: 0o600 });
  configRead.layers[0].name.file = configPath;
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'config/batchWrite') return send(raw);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32603, message: 'Rejected secret-fixture-leak' } })));
  };
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'credentials', name: 'rag', env: { OPENROUTER_API_KEY: 'secret-fixture-leak' } }), error => !error.message.includes('secret-fixture-leak') && error.status === 502);
  client.close();
});

test('socket discovery rejects ordinary files and relative paths without launching anything', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-desktop-socket-test-'));
  const file = path.join(temp, 'not-a-socket'); await fs.writeFile(file, '');
  assert.throws(() => existingSocket(file), /private.*owned/);
  assert.throws(() => existingSocket('relative.sock'), /absolute/);
  assert.throws(() => existingSocket(path.join(temp, 'missing')), /No running Elpis bridge/);
});

test('opening a chat rejoins it without overrides, reports its running turn, and subscribes agents too', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const opened = await client.resume(ROOT, {});
  assert.equal(opened.thread.desktopAccess.writable, true); assert.equal(opened.activeTurnId, null);
  assert.deepEqual(socket.sent.find(message => message.method === 'thread/resume').params,
    { threadId: ROOT, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } });
  const again = await client.resume(ROOT, {});
  assert.equal(again.thread.id, ROOT);
  assert.equal(socket.sent.filter(message => message.method === 'thread/resume').length, 1, 'an owned chat is not resumed twice');
  const agent = await client.resume(CHILD, {});
  assert.equal(agent.thread.desktopAccess.mode, 'continue');
  await assert.rejects(client.resume(ROOT, { model: 'override' }), /Unsupported/);
  assert.deepEqual(await client.interrupt(CHILD, {}), {});
  assert.deepEqual(socket.sent.find(message => message.method === 'turn/interrupt').params, { threadId: CHILD, turnId: 'running-turn' }, 'stop finds the running turn');
  client.close();
});

test('rename, archive, unarchive and edit-and-resend reach native thread methods; agents are never reverted', async () => {
  const { client, socket, threads } = fixture(); await client.initialize(); await client.listThreads();
  assert.equal((await client.renameThread(ROOT, { name: '  Parser fix  ' })).thread.name, 'Parser fix');
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/name/set').at(-1).params, { threadId: ROOT, name: 'Parser fix' });
  await assert.rejects(client.renameThread(ROOT, { name: '   ' }), /Invalid name|Enter a name/);
  assert.deepEqual(await client.archiveThread(ROOT, {}), { archived: true });
  assert.equal((await client.listThreads()).data.some(thread => thread.id === ROOT), false, 'archived chats leave the list');
  assert.deepEqual((await client.listThreads({ archived: true })).data.map(thread => thread.id), [ROOT]);
  assert.equal(socket.sent.filter(row => row.method === 'thread/list').at(-1).params.archived, true);
  assert.equal((await client.unarchiveThread(ROOT, {})).thread.id, ROOT);
  assert.equal((await client.listThreads()).data.some(thread => thread.id === ROOT), true, 'unarchived chats return');
  await client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' });
  assert.deepEqual(socket.sent.filter(row => ['thread/revert', 'turn/start'].includes(row.method)).map(row => row.method), ['thread/revert', 'turn/start']);
  assert.deepEqual(socket.sent.find(row => row.method === 'thread/revert').params, { threadId: ROOT, beforeTurnId: 'turn-1' });
  assert.match(JSON.stringify(socket.sent.filter(row => row.method === 'turn/start').at(-1).params.input), /Edited prompt/);
  threads.get(CHILD).status = { type: 'idle' };
  await assert.rejects(client.revert(CHILD, { beforeTurnId: 'turn-1', text: 'Replace' }), /only from its parent/);
  assert.equal(socket.sent.filter(row => row.method === 'thread/revert').length, 1, 'an agent owned by its parent is never reverted');
  client.close();
});

test('replacement checks every native page of the selected turn before reverting', async () => {
  const prompt = { turnId: 'turn-1', item: { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Original prompt' }] } };
  const { client, socket } = fixture({ replacementPages: {
    start: { data: [prompt], nextCursor: 'next' },
    next: { data: [{ turnId: 'turn-1', item: { type: 'agentMessage', id: 'reply', text: 'Done' } }], nextCursor: null },
  } });
  try {
    await client.initialize();
    const result = await client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' });
    assert.equal(result.turn.id, 'new-turn');
    const reads = socket.sent.filter(row => row.method === 'thread/items/list');
    assert.equal(reads.length, 2);
    assert.deepEqual(reads.map(row => row.params.turnId), ['turn-1', 'turn-1']);
    assert.equal(reads[1].params.cursor, 'next');
    assert(socket.sent.indexOf(reads[1]) < socket.sent.findIndex(row => row.method === 'thread/revert'));
  } finally { client.close(); }
});

test('replacement refuses unsafe or incomplete native inputs before any mutation', async t => {
  const prompt = { turnId: 'turn-1', item: { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Original prompt' }] } };
  const variants = {
    'another delivered instruction': { start: { data: [prompt], nextCursor: 'next' }, next: { data: [{ ...prompt, item: { ...prompt.item, id: 'delivered' } }], nextCursor: null } },
    'image attachment': { start: { data: [{ ...prompt, item: { ...prompt.item, content: [...prompt.item.content, { type: 'localImage', path: '/tmp/book.png' }] } }], nextCursor: null } },
    'special text elements': { start: { data: [{ ...prompt, item: { ...prompt.item, content: [{ type: 'text', text: 'Image marker', textElements: [{ byteRange: { start: 0, end: 5 } }] }] } }], nextCursor: null } },
    'missing user input': { start: { data: [], nextCursor: null } },
    'unknown page completeness': { start: { data: [prompt] } },
    'wrong turn': { start: { data: [{ ...prompt, turnId: 'another-turn' }], nextCursor: null } },
    'repeating page cursor': { start: { data: [prompt], nextCursor: 'next' }, next: { data: [], nextCursor: 'next' } },
    'page traversal limit': Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index ? `page-${index}` : 'start', { data: index ? [] : [prompt], nextCursor: `page-${index + 1}` }])),
  };
  for (const [name, replacementPages] of Object.entries(variants)) await t.test(name, async () => {
    const { client, socket } = fixture({ replacementPages });
    try {
      await client.initialize();
      await assert.rejects(client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' }));
      assert.equal(socket.sent.filter(row => ['thread/revert', 'turn/start'].includes(row.method)).length, 0);
    } finally { client.close(); }
  });
});

test('replacement reports an acknowledged rewind when its new turn is rejected or unconfirmed', async t => {
  for (const timeout of [false, true]) await t.test(timeout ? 'unknown start outcome' : 'start rejected', async () => {
    const { client, socket } = fixture();
    try {
      await client.initialize(); if (timeout) client.timeoutMs = 20;
      const send = socket.send;
      socket.send = raw => {
        const request = JSON.parse(raw);
        if (request.method === 'turn/start') {
          socket.sent.push(request);
          if (!timeout) queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'Fixture replacement rejected' } })));
        } else send(raw);
      };
      const result = await client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' });
      assert.equal(result.rewound, true); assert.equal(result.beforeTurnId, 'turn-1'); assert.equal(result.turn, undefined);
      assert.match(result.sendError, timeout ? /outcome is unknown/ : /Fixture replacement rejected/);
      assert.equal(socket.sent.filter(row => row.method === 'thread/revert').length, 1);
      assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 1, 'never replay an unconfirmed write');
    } finally { client.close(); }
  });
});

test('a rejected native rewind never claims success and never starts its replacement', async () => {
  const { client, socket } = fixture();
  try {
    await client.initialize(); const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === 'thread/revert') {
        socket.sent.push(request);
        queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message: 'Fixture rewind rejected' } })));
      } else send(raw);
    };
    await assert.rejects(client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' }), /Fixture rewind rejected/);
    assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 0);
  } finally { client.close(); }
});

test('deleting a chat also deletes chats continued from its agents, then forgets it', async () => {
  const { client, socket, threads } = fixture(); await client.initialize(); await client.listThreads();
  threads.get(CHILD).status = { type: 'idle' };
  await client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' });
  const events = []; client.on('event', event => events.push(event));
  const result = await client.deleteThread(ROOT, {});
  assert.deepEqual(result, { deleted: true, alsoDeleted: [FORK] });
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/delete').map(row => row.params.threadId), [ROOT, FORK, ROOT]);
  assert.equal(threads.has(ROOT) || threads.has(FORK) || threads.has(CHILD), false);
  socket.emit('message', JSON.stringify({ method: 'thread/deleted', params: { threadId: ROOT } }));
  assert.equal(events.filter(event => event.data?.method === 'thread/deleted').length, 0, 'forgotten chats emit nothing more');
  client.close();
});

function pagedDeletionFixture(control = {}) {
  const f = fixture(), key = value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
  const childIds = Array.from({ length: 125 }, (_, index) => key(1000 + index)), forkIds = [FORK, key(8), ...childIds.map((_, index) => key(2000 + index))];
  const unrelatedIds = [key(5000), key(5001)]; f.threads.get(CHILD).status = { type: 'idle' };
  const add = (id, fields) => f.threads.set(id, { id, source: 'appServer', status: { type: 'idle' }, ...fields });
  add(FORK, { forkedFromId: CHILD }); add(key(8), { forkedFromId: CHILD });
  for (const id of childIds) add(id, { parentThreadId: ROOT });
  for (let index = 0; index < childIds.length; index++) add(forkIds[index + 2], { forkedFromId: childIds[index] });
  add(unrelatedIds[0], {}); add(unrelatedIds[1], { forkedFromId: unrelatedIds[0] });
  const send = f.socket.send;
  const reply = (request, result, error) => queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, ...(error ? { error: { code: -32600, message: error } } : { result }) })));
  f.socket.send = raw => {
    const request = JSON.parse(raw), params = request.params;
    if (request.method === 'thread/list') {
      f.socket.sent.push(request); const stage = params.ancestorThreadId ? 'descendants' : 'all';
      if (control.failStage === stage && params.cursor) return reply(request, null, `Fixture later ${stage} page failed`);
      const rows = [...f.threads.values()].filter(thread => !!thread.archived === !!params.archived).filter(thread => !params.ancestorThreadId || thread.parentThreadId === params.ancestorThreadId), start = Number(params.cursor || 0), next = start + params.limit;
      const nextCursor = control.badStage === stage ? control.badCursor === 'cycle' ? '100' : 7 : next < rows.length ? String(next) : null;
      return reply(request, { data: rows.slice(start, next).map(thread => ({ ...thread, forkedFromId: null })), nextCursor });
    }
    if (request.method === 'thread/read' && control.failStage === 'metadata' && params.threadId === key(8)) { f.socket.sent.push(request); return reply(request, null, 'Fixture fork metadata failed'); }
    if (request.method === 'thread/delete') {
      f.socket.sent.push(request);
      if (params.threadId === ROOT && forkIds.some(id => f.threads.has(id))) return reply(request, null, 'cannot delete thread: forked history still references it');
      if (params.threadId === ROOT) for (const id of [CHILD, ...childIds]) f.threads.delete(id);
      f.threads.delete(params.threadId); return reply(request, {});
    }
    send(raw);
  };
  return { ...f, childIds, forkIds, unrelatedIds, control };
}

test('deletion fallback paginates over 100 descendants and fork references without deleting unrelated chats', async t => {
  const f = pagedDeletionFixture(); t.after(() => f.client.close()); await f.client.initialize();
  const result = await f.client.deleteThread(ROOT, {});
  assert.deepEqual(result, { deleted: true, alsoDeleted: f.forkIds });
  const lists = f.socket.sent.filter(row => row.method === 'thread/list');
  assert.deepEqual(lists.filter(row => row.params.ancestorThreadId && !row.params.archived).map(row => row.params.cursor ?? null), [null, '100']);
  assert.deepEqual(lists.filter(row => !row.params.ancestorThreadId && !row.params.archived).map(row => row.params.cursor ?? null), [null, '100', '200']);
  assert.deepEqual(f.socket.sent.filter(row => row.method === 'thread/delete').map(row => row.params.threadId), [ROOT, ...f.forkIds, ROOT]);
  assert.deepEqual([...f.threads.keys()], f.unrelatedIds);
});

test('deletion fallback includes archived descendants and their archived referencing forks', async t => {
  const f = pagedDeletionFixture(); t.after(() => f.client.close()); await f.client.initialize();
  f.threads.get(f.childIds.at(-1)).archived = true;
  f.threads.get(f.forkIds.at(-1)).archived = true;
  const result = await f.client.deleteThread(ROOT, {});
  assert.deepEqual(new Set(result.alsoDeleted), new Set(f.forkIds));
  assert.deepEqual([...f.threads.keys()], f.unrelatedIds);
  assert(f.socket.sent.some(row => row.method === 'thread/list' && row.params.archived && row.params.ancestorThreadId === ROOT));
});

for (const [name, control] of [
  ['a later descendant page fails', { failStage: 'descendants' }], ['a later reference page fails', { failStage: 'all' }],
  ['a descendant cursor repeats', { badStage: 'descendants', badCursor: 'cycle' }], ['a reference cursor repeats', { badStage: 'all', badCursor: 'cycle' }],
  ['a descendant cursor is malformed', { badStage: 'descendants', badCursor: 'malformed' }], ['a reference cursor is malformed', { badStage: 'all', badCursor: 'malformed' }],
  ['fork metadata cannot be read', { failStage: 'metadata' }],
]) test(`deletion fallback preserves every chat when ${name}`, async t => {
  const f = pagedDeletionFixture(control); t.after(() => f.client.close()); await f.client.initialize();
  let failure; try { await f.client.deleteThread(ROOT, {}); } catch (error) { failure = error; }
  assert.deepEqual(f.socket.sent.filter(row => row.method === 'thread/delete').map(row => row.params.threadId), [ROOT], 'Only the rejected initial root deletion is allowed before complete discovery');
  assert.ok(failure, 'Incomplete reference discovery must be reported');
  assert.ok([ROOT, CHILD, ...f.childIds, ...f.forkIds, ...f.unrelatedIds].every(id => f.threads.has(id)), 'No chat may disappear after an incomplete fallback preflight');
  if (control.failStage) assert.match(failure.message, /rejected|failed|could not/i);
  else assert.match(failure.message, /complete|cursor|list/i);
  control.failStage = null; control.badStage = null;
  assert.deepEqual(await f.client.deleteThread(ROOT, {}), { deleted: true, alsoDeleted: f.forkIds }, 'Correcting the failed read permits a fresh deletion');
  assert.deepEqual([...f.threads.keys()], f.unrelatedIds);
});

test('providers report separate sign-in and usage per provider; MCP shows credential presence only', async () => {
  const { client, socket } = fixture(); await client.initialize();
  process.env.APP_TEST_OPENROUTER_KEY = 'PRIVATE CONFIG SECRET'; delete process.env.APP_TEST_COMPANY_KEY;
  const providers = await client.providers();
  assert.deepEqual(providers.openai.auth, { state: 'signedIn', method: 'ChatGPT', email: 'person@example.com', plan: 'pro' });
  assert.deepEqual(providers.openai.usage.map(limit => limit.limitId), ['codex']);
  assert.deepEqual(providers.claude.usage.map(limit => [limit.limitId, limit.primary.usedPercent, limit.secondary.windowDurationMins]), [['claude', 40, 10080]]);
  assert.equal(providers.claude.state, 'connected'); assert.deepEqual(providers.claude.models, ['Opus (Claude subscription)']);
  assert.deepEqual(providers.gemini.usage.map(limit => limit.limitId), ['antigravity-pro']); assert.equal(providers.gemini.state, 'connected');
  assert.deepEqual(providers.openrouter, [{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'APP_TEST_OPENROUTER_KEY', keySet: true }]);
  assert.deepEqual(providers.local.map(item => [item.id, item.baseUrl]), [['local', 'http://127.0.0.1:1234/v1']]);
  const mcp = await client.mcp();
  assert.deepEqual(mcp.servers.map(server => [server.name, server.enabled, server.transport]), [['rag', true, 'stdio'], ['remote', false, 'http'], ['whispertype', true, 'stdio']]);
  assert.deepEqual(mcp.servers[0].credentials, [{ name: 'OPENROUTER_API_KEY', source: 'config', set: true }]);
  assert.deepEqual(mcp.servers[1].credentials, [{ name: 'APP_TEST_BEARER', source: 'environment', set: false }]);
  assert.equal(mcp.servers[1].url, 'https://mcp.example/path');
  assert.deepEqual(mcp.servers[2].whispertype, { backend: 'local', model: 'openai/gpt-4o-mini-transcribe' });
  assert.doesNotMatch(JSON.stringify({ providers, mcp }), /PRIVATE CONFIG SECRET|token/);
  // Writes are versioned native config edits; nothing else is accepted.
  await client.saveMcp({ version: 'user-version', action: 'enable', name: 'remote', enabled: true });
  await client.saveMcp({ version: 'user-version', action: 'add', name: 'extra', command: '/bin/true', args: ['--flag'] });
  await client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: 'openrouter', model: 'openai/gpt-4o-mini-transcribe' });
  await client.saveMcp({ version: 'user-version', action: 'remove', name: 'rag' });
  assert.deepEqual(socket.sent.filter(row => row.method === 'config/batchWrite').map(row => row.params.edits), [
    [{ keyPath: 'mcp_servers.remote.enabled', value: true, mergeStrategy: 'replace' }],
    [{ keyPath: 'mcp_servers.extra', value: { command: '/bin/true', args: ['--flag'] }, mergeStrategy: 'replace' }],
    [{ keyPath: 'mcp_servers.whispertype.env.WHISPERTYPE_BACKEND', value: 'openrouter', mergeStrategy: 'replace' }, { keyPath: 'mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL', value: 'openai/gpt-4o-mini-transcribe', mergeStrategy: 'replace' }],
    [{ keyPath: 'mcp_servers.rag', value: null, mergeStrategy: 'replace' }]]);
  await assert.rejects(client.saveMcp({ version: 'stale', action: 'remove', name: 'rag' }), /changed in another client/);
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'add', name: 'bad.name', command: 'x' }), /server name/);
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'rag', backend: 'local' }), /Unsupported MCP change/);
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: 'gpu; rm' }), /OpenRouter, Codex sign-in or local/);
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 4, 'refused changes write nothing');
  await client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: 'codex' });
  assert.deepEqual(socket.sent.filter(row => row.method === 'config/batchWrite').at(-1).params.edits, [{ keyPath: 'mcp_servers.whispertype.env.WHISPERTYPE_BACKEND', value: 'codex', mergeStrategy: 'replace' }]);
  delete process.env.APP_TEST_OPENROUTER_KEY;
  client.close();
});

test('settings expose supported fields; providers require configured identity and respect managed restrictions', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  const settings = await client.settings();
  assert.equal(settings.main.provider, 'openai');
  assert.equal(settings.background.purpose, 'smartPruneFallback');
  assert.equal(settings.memory.generate, false);
  assert.equal(settings.version, 'user-version');
  assert.equal(settings.smartPrune.explicitOverride.available, false);
  assert.equal(settings.write.available, true);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE CONFIG SECRET|http_headers|api_key|config.toml/);
  // This case selects an editable API provider; alternate header auth is covered separately.
  delete configRead.config.model_providers.local.http_headers;
  await assert.rejects(client.createThread({ provider: 'unknown', model: 'remote' }), /configured provider/);
  await assert.rejects(client.createThread({ provider: 'local' }), /model for this provider/);
  assert.equal(socket.sent.filter(message => message.method === 'thread/start').length, 0);
  await client.createThread({ provider: 'local', model: 'remote-model' });
  assert.deepEqual(socket.sent.find(message => message.method === 'thread/start').params, { model: 'remote-model', modelProvider: 'local' });
  requirementsRead.requirements = { modelProvider: 'openai', modelProviders: { local: { name: 'Managed', api_key: 'PRIVATE CONFIG SECRET' } } };
  await assert.rejects(client.createThread({ provider: 'local', model: 'remote-model' }), /restricted/);
  assert.equal(socket.sent.filter(message => message.method === 'thread/start').length, 1);
  configRead.config.features = {}; configRead.config.memories = {};
  const unknown = await client.settings();
  assert.equal(unknown.smartPrune.enabled, null); assert.equal(unknown.memory.use, null);
  client.close();
});

test('main-provider requirements do not prohibit independently configured maintenance providers', async () => {
  const {client,configRead,requirementsRead}=fixture({prunerSupported:true});await client.initialize();
  requirementsRead.requirements={modelProvider:'openai'};
  await assert.rejects(client.createThread({provider:'local',model:'remote-model'}),/restricted/);
  await client.saveSettings({version:'user-version',background:{model:'local-small',provider:'local'}});
  const saved=await client.savePruner({version:'pruner-v1',model:'local-small',provider:'local'});
  assert.equal(saved.smartPrune.explicitOverride.provider,'local');
  assert.equal(configRead.config.model_provider,'openai');
  client.close();
});

test('context exposes actual scoped events without resuming and strips audit paths', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const initial = await client.context(ROOT);
  assert.equal(initial.tokenUsage, null); assert.equal(initial.smartPrune, null);
  const events = []; client.on('event', event => events.push(event));
  const emit = (method, params) => socket.emit('message', JSON.stringify({ method, params }));
  emit('thread/tokenUsage/updated', { threadId: ROOT, tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 800, cacheWriteInputTokens: 75, outputTokens: 10 }, last: { inputTokens: 100 }, modelContextWindow: 1000,
    contextAttribution: { systemInstructions: 20, developerMessages: 'not a number', toolResults: 0, estimatedTotal: 100, auditPath: '/private/audit', secret: 'PRIVATE AUDIT' }, secret: 'PRIVATE AUDIT' } });
  emit('thread/smartPrune/updated', { threadId: ROOT, smartPrune: { enabled: true, approxSavedTokens: 50, optimizerRequests: 2, latestAttempt: { status: 'failed', modelSlug: 'optimizer-model', failureReason: 'Failed to connect', auditPath: '/private/audit' } } });
  const result = await client.context(ROOT);
  assert.equal(result.tokenUsage.total.cachedInputTokens, 800);
  assert.equal(result.tokenUsage.total.cacheWriteInputTokens, 75);
  assert.equal(result.tokenUsage.last.inputTokens, 100, 'Latest input remains separate from cumulative usage');
  assert.deepEqual(result.tokenUsage.contextAttribution, { systemInstructions: 20, toolResults: 0, estimatedTotal: 100 }, 'Composition preserves reported zero, omits unknowns and keeps private fields out');
  assert.equal(result.smartPrune.latestAttempt.modelSlug, 'optimizer-model');
  assert.equal(result.smartPrune.latestAttempt.failureReason, 'Failed to connect');
  assert.equal((await client.context(CHILD)).smartPrune, null);
  assert.equal((await client.context(CHILD)).tokenUsage, null, 'Child context never borrows its parent snapshot');
  assert.doesNotMatch(JSON.stringify([result, events]), /PRIVATE AUDIT|private\/audit/);
  emit('thread/tokenUsage/updated', { threadId: CREATED, tokenUsage: { total: { inputTokens: 100000 } } });
  assert.equal(events.length, 2);
  assert.equal(socket.sent.some(message => message.method === 'thread/resume'), false);
  await assert.rejects(client.context('not-a-thread'), /Invalid thread/);
  client.close();
});


test('maintenance edits are narrow, preserve unknowns, and reject stale versions before mutation', async () => {
  const {client,socket,configRead}=fixture(); await client.initialize();
  await client.saveSettings({version:'user-version',background:{model:'gpt-6-luna',provider:'openai'},memory:{use:false}});
  assert.deepEqual(socket.sent.find(row=>row.method==='config/batchWrite').params, {expectedVersion:'user-version',reloadUserConfig:false,edits:[
    {keyPath:'background_model',value:'gpt-6-luna',mergeStrategy:'replace'},
    {keyPath:'background_provider',value:'openai',mergeStrategy:'replace'},
    {keyPath:'memories.use_memories',value:false,mergeStrategy:'replace'},
  ]});
  const writes=()=>socket.sent.filter(row=>row.method==='config/batchWrite').length;
  await assert.rejects(client.saveSettings({version:'outdated',memory:{use:true}}),/Reload settings/);
  await assert.rejects(client.saveSettings({version:'user-version',memory:{generate:null}}),/enabled or disabled/);
  await assert.rejects(client.saveSettings({version:'user-version',background:{provider:'unknown'}}),/configured provider/);
  await assert.rejects(client.saveSettings({version:'user-version',main:{model:'changed'}}),/Unsupported/);
  await assert.rejects(client.saveSettings({version:'user-version',memory:{admissionPolicy:'all'}}),/Unsupported/);
  assert.equal(writes(),1);
  await assert.rejects(client.savePruner({version:'v1',model:'cheap',provider:'openai'}),/running Elpis version/);
  assert.equal(socket.sent.some(row=>row.method==='pruner/write'),false);
  assert.equal(configRead.config.model,MODEL);
  client.close();
});


test('settings pages read and write only listed native options, respecting managed policy', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  Object.assign(configRead.config, { approval_policy: { granular: { sandbox_approval: true } }, sandbox_mode: 'workspace-write', service_tier: 'priority', developer_instructions: 'Be brief.', project_root_markers: ['.git', '.hg'], desktop: { 'git-worktree-root': '/work/trees' } });
  configRead.config.features.memories = true; configRead.config.memories.disable_on_external_context = true;
  const settings = await client.settings();
  assert.deepEqual(settings.options, { approvalPolicy: 'granular', sandboxMode: 'workspace-write', webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: 'fast', developerInstructions: 'Be brief.', projectRootMarkers: ['.git', '.hg'], worktreeRoot: '/work/trees' });
  assert.equal(settings.memory.enabled, true); assert.equal(settings.memory.skipExternalContext, true);
  await client.saveSettings({ version: 'user-version', options: { approvalPolicy: 'never', webSearch: null, developerInstructions: '  ', projectRootMarkers: [' .git ', 'package.json'], worktreeRoot: '/tmp/trees' }, memory: { enabled: false, skipExternalContext: false } });
  assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params, { expectedVersion: 'user-version', reloadUserConfig: false, edits: [
    { keyPath: 'features.memories', value: false, mergeStrategy: 'replace' },
    { keyPath: 'memories.disable_on_external_context', value: false, mergeStrategy: 'replace' },
    { keyPath: 'approval_policy', value: 'never', mergeStrategy: 'replace' },
    { keyPath: 'web_search', value: null, mergeStrategy: 'replace' },
    { keyPath: 'developer_instructions', value: null, mergeStrategy: 'replace' },
    { keyPath: 'project_root_markers', value: ['.git', 'package.json'], mergeStrategy: 'replace' },
    { keyPath: 'desktop.git-worktree-root', value: '/tmp/trees', mergeStrategy: 'replace' },
  ] });
  const writes = () => socket.sent.filter(row => row.method === 'config/batchWrite').length;
  const before = writes();
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { model: 'other' } }), /Unsupported setting/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { sandboxMode: 'everything' } }), /listed values/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { worktreeRoot: 'relative/trees' } }), /absolute folder/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { projectRootMarkers: ['../up'] } }), /without slashes/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { projectRootMarkers: [] } }), /one to sixteen/);
  requirementsRead.requirements = { allowedSandboxModes: ['read-only'] };
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { sandboxMode: 'danger-full-access' } }), error => error.status === 403 && /managed/.test(error.message));
  assert.equal(writes(), before, 'refused options write nothing');
  client.close();
});

test('hooks list native discovery and change only hooks.state for a listed, unmanaged hook', async () => {
  const { client, socket, hooksList } = fixture(); await client.initialize();
  const hooks = await client.hooks();
  assert.equal(hooks.version, 'user-version');
  assert.deepEqual(hooks.warnings, ['hooks.json: unknown field ignored']);
  assert.deepEqual(hooks.hooks.map(hook => [hook.event, hook.command, hook.trust, hook.managed]), [['preToolUse', 'rtk hook claude', 'untrusted', false], ['stop', 'audit', 'managed', true]]);
  const key = hooksList.data[0].hooks[0].key;
  await client.saveHook({ version: 'user-version', key, trust: true });
  await client.saveHook({ version: 'user-version', key, enabled: false });
  assert.deepEqual(socket.sent.filter(row => row.method === 'config/batchWrite').map(row => row.params), [
    { edits: [{ keyPath: 'hooks.state', value: { [key]: { trusted_hash: 'sha256:current' } }, mergeStrategy: 'upsert' }], expectedVersion: 'user-version', reloadUserConfig: true },
    { edits: [{ keyPath: 'hooks.state', value: { [key]: { enabled: false } }, mergeStrategy: 'upsert' }], expectedVersion: 'user-version', reloadUserConfig: true },
  ]);
  await assert.rejects(client.saveHook({ version: 'user-version', key: hooksList.data[0].hooks[1].key, enabled: false }), /Managed hooks/);
  await assert.rejects(client.saveHook({ version: 'user-version', key: 'user:/missing:stop:0:0', enabled: false }), /no longer configured/);
  await assert.rejects(client.saveHook({ version: 'outdated', key, enabled: true }), /Reload settings/);
  await assert.rejects(client.saveHook({ version: 'user-version', key, enabled: true, trust: true }), /enable, disable or trust/);
  await assert.rejects(client.saveHook({ version: 'user-version', key, trust: false }), /confirmed/);
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 2);
  await client.resetMemories({});
  assert.equal(socket.sent.filter(row => row.method === 'memory/reset').length, 1);
  await assert.rejects(client.resetMemories({ all: true }), /Unsupported/);
  client.close();
});

test('pruning override edits preserve separation and reject stale or incomplete pairs', async () => {
  const {client,socket,configRead}=fixture({prunerSupported:true}); await client.initialize();
  const initial=await client.settings();assert.equal(initial.smartPrune.explicitOverride.model,'optimizer-original');
  assert.doesNotMatch(JSON.stringify(initial),/PRIVATE CONFIG SECRET|systemPrompt/);
  await assert.rejects(client.savePruner({version:'pruner-v1',model:'gpt-6-luna',provider:null}),/provider ID/);
  await assert.rejects(client.savePruner({version:'outdated',model:'gpt-6-luna',provider:'openai'}),/Reload settings/);
  await assert.rejects(client.savePruner({version:'pruner-v1',model:'gpt-6-luna',provider:'unknown'}),/configured provider/);
  await assert.rejects(client.savePruner({version:'pruner-v1',model:null,provider:null,systemPrompt:'replace'}),/Unsupported/);
  assert.equal(socket.sent.some(row=>row.method==='pruner/write'),false);
  const changed=await client.savePruner({version:'pruner-v1',model:'gpt-6-luna',provider:'openai'});
  assert.equal(changed.smartPrune.explicitOverride.model,'gpt-6-luna');
  assert.deepEqual(socket.sent.find(row=>row.method==='pruner/write').params,{expectedVersion:'pruner-v1',model:'gpt-6-luna',provider:'openai'});
  const cleared=await client.savePruner({version:'pruner-v2',model:null,provider:null});
  assert.equal(cleared.smartPrune.explicitOverride.model,null);
  assert.equal(configRead.config.model,MODEL);assert.equal(configRead.config.background_model,'cheap-model');
  assert.equal(socket.sent.some(row=>row.method==='config/batchWrite'),false);
  client.close();
});

test('desktop server closes even when a local request body never finishes', async () => {
  const {client,socket}=fixture(); await client.initialize();
  const app=await startDesktopServer({client});
  const url=new URL(app.url);
  const pending=net.createConnection({host:url.hostname,port:Number(url.port)});
  await new Promise(resolve=>pending.once('connect',resolve));
  pending.write('POST /api/session HTTP/1.1\r\nHost: '+url.host+'\r\nContent-Length: 1024\r\n\r\n{');
  await new Promise(resolve=>setTimeout(resolve,30));
  const closed=app.close();
  let timer;
  const completed=await Promise.race([closed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),500);})]);
  clearTimeout(timer); pending.destroy(); await closed;
  assert.equal(completed,true,'quitting cannot wait indefinitely for an unfinished HTTP body');
  assert.equal(socket.closed,true,'desktop detaches its connection to the native runtime');
});

test('permission modes become Elpis approval and sandbox settings, and resume reports the mode', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  try {
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'go', permissions: 'full' });
    const full = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual([full.approvalPolicy, full.approvalsReviewer, full.sandboxPolicy], ['never', 'user', { type: 'dangerFullAccess' }]);
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'again', permissions: 'auto' });
    const auto = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual([auto.approvalPolicy, auto.approvalsReviewer, auto.sandboxPolicy], ['on-request', 'auto_review', { type: 'workspaceWrite' }]);
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'plain' });
    const plain = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.equal('approvalPolicy' in plain || 'sandboxPolicy' in plain, false, 'no mode chosen leaves the chat as configured');
    await assert.rejects(client.send(ROOT, { text: 'x', permissions: 'root' }), /permission mode/);
    await client.createThread({ permissions: 'ask' });
    const started = socket.sent.findLast(message => message.method === 'thread/start').params;
    assert.deepEqual([started.approvalPolicy, started.approvalsReviewer, started.sandbox], ['on-request', 'user', 'workspace-write']);
  } finally { client.close(); }
});

test('plan mode is sent with the chat model only when it changes, and resume reports it', async () => {
  const { client, socket, threads } = fixture(); await client.initialize(); await client.models();
  try {
    Object.assign(threads.get(ROOT), { status: { type: 'idle' }, model: 'gpt-6-luna', reasoningEffort: 'high', collaborationMode: { mode: 'plan', settings: {} } });
    assert.equal((await client.resume(ROOT, {})).planMode, true, 'a chat left in Plan mode reopens in it');
    await client.send(ROOT, { text: 'plan it', mode: 'plan' });
    const plan = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual(plan.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6-luna', reasoning_effort: 'high', developer_instructions: null } });
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'Implement the plan.', mode: 'default', model: MODEL });
    assert.deepEqual(socket.sent.findLast(message => message.method === 'turn/start').params.collaborationMode.mode, 'default');
    assert.equal(socket.sent.findLast(message => message.method === 'turn/start').params.collaborationMode.settings.model, MODEL);
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'plain' });
    assert.equal('collaborationMode' in socket.sent.findLast(message => message.method === 'turn/start').params, false, 'an unchanged mode is left to the engine');
    await assert.rejects(client.send(ROOT, { text: 'x', mode: 'pair' }), /chat mode/);
  } finally { client.close(); }
});

test('a pasted provider key is saved privately in the Elpis home and never sent back', async () => {
  const { client, configRead } = fixture(); await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-provider-key-'));
  try {
    configRead.layers[0].name.file = path.join(root, 'config.toml');
    const before = (await client.providerSettings()).providers.find(provider => provider.id === 'openrouter');
    assert.deepEqual([before.auth.keySet, before.auth.acceptsKey], [false, true]);
    const after = await client.saveProviderKey({ provider: 'openrouter', key: '  sk-or-fixture-secret  ' });
    assert.deepEqual(after.providers.find(provider => provider.id === 'openrouter').auth, { source: 'saved', keySet: true, envKey: 'APP_TEST_OPENROUTER_KEY', acceptsKey: true });
    assert(!JSON.stringify(after).includes('sk-or-fixture-secret'), 'the key is never returned');
    const file = path.join(root, 'provider-keys.json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { openrouter: 'sk-or-fixture-secret' });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'readable by its owner alone');
    await assert.rejects(client.saveProviderKey({ provider: 'openrouter', key: 'two words' }), /visible ASCII/);
    await assert.rejects(client.saveProviderKey({ provider: 'openai', key: 'sk-x' }), /does not take an API key/);
  } finally { client.close(); }
});

test('fork chat from here copies history through the chosen turn and names the copy', async () => {
  const { client, socket } = fixture(); await client.initialize();
  try {
    const result = await client.forkThread(ROOT, { lastTurnId: 'turn-3' });
    const fork = socket.sent.findLast(message => message.method === 'thread/fork').params;
    assert.equal(fork.threadId, ROOT); assert.equal(fork.lastTurnId, 'turn-3');
    assert.equal(result.thread.id, FORK); assert.equal(result.thread.name, 'Existing root (fork)');
    await client.forkThread(ROOT, {});
    assert.equal('lastTurnId' in socket.sent.findLast(message => message.method === 'thread/fork').params, false);
  } finally { client.close(); }
});

test('Smart Prune is switched by its feature key, and a writable config gives no "cannot save" reason', async () => {
  const { optionEdits, settingsSnapshot } = await import('./elpis-features.mjs');
  assert.deepEqual(optionEdits({ automaticPruning: true }), [{ keyPath: 'features.automatic_context_pruning', value: true, mergeStrategy: 'replace' }]);
  assert.throws(() => optionEdits({ automaticPruning: 'yes' }), /listed values/);
  const writable = settingsSnapshot({ config: {}, layers: [{ name: { type: 'user', file: '/home/fixture/.elpis/config.toml' }, version: 'v1' }] }, { requirements: {} });
  assert.deepEqual(writable.write, { available: true, reason: null });
  assert.match(settingsSnapshot({ config: {}, layers: [] }, { requirements: {} }).write.reason, /no writable config\.toml/);
});
