import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { parseClaudeMcp } from './claude-mcp-import.mjs';
import { DesktopClient, existingSocket } from './client.mjs';
import { startDesktopServer } from './server.mjs';
import { isAgentRun } from '../lib/agent-runs.mjs';
import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';

const ROOT = '00000000-0000-0000-0000-000000000001';
const CHILD = '00000000-0000-0000-0000-000000000002';
const CREATED = '00000000-0000-0000-0000-000000000003';
const MODEL = 'test-model';
const FORK = '00000000-0000-0000-0000-000000000007';
// The engine's built-in permission profiles and the sandbox each one runs.
const PROFILE_SANDBOX = { ':workspace': { type: 'workspaceWrite' }, ':danger-full-access': { type: 'dangerFullAccess' }, ':bypass-permissions': { type: 'dangerFullAccess' } };

test('A32 default effort uses the shared versioned writer and rejects invalid values', async () => {
  const { client, socket } = fixture(); await client.initialize();
  try {
    await client.saveSettings({ version: 'user-version', options: { reasoningEffort: 'high' } });
    assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params, {
      expectedVersion: 'user-version', reloadUserConfig: false,
      edits: [{ keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' }],
    });
    const before = socket.sent.filter(row => row.method === 'config/batchWrite').length;
    await assert.rejects(client.saveSettings({ version: 'user-version', options: { reasoningEffort: 'banana' } }), /listed values/);
    assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, before);
  } finally { client.close(); }
});

test('A32 feature defaults use native advertised keys and refuse managed or forged changes', async () => {
  const { client, socket, requirementsRead } = fixture(); await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'experimentalFeature/list') return send(raw);
    socket.sent.push(request);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: {
      data: [{ name: 'shell_tool', displayName: 'Shell', enabled: true, stage: 'stable' }], nextCursor: null,
    } })));
  };
  try {
    const settings = await client.settings();
    assert.equal(settings.features.data[0].enabled, true);
    await client.saveSettings({ version: 'user-version', features: { shell_tool: false } });
    assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params.edits,
      [{ keyPath: 'features."shell_tool"', value: false, mergeStrategy: 'replace' }]);
    const writes = () => socket.sent.filter(row => row.method === 'config/batchWrite').length;
    const before = writes();
    await assert.rejects(client.saveSettings({ version: 'user-version', features: { shell_tool: 'no' } }), /on or off/);
    await assert.rejects(client.saveSettings({ version: 'user-version', features: { forged: true } }), /Unsupported/);
    requirementsRead.requirements = { featureRequirements: { shell_tool: true } };
    await assert.rejects(client.saveSettings({ version: 'user-version', features: { shell_tool: false } }), /Managed policy/);
    assert.equal(writes(), before);
  } finally { client.close(); }
});

test('A32 missing or disabled writable config layers explain why and write nothing', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  try {
    configRead.layers[0].disabledReason = 'Read-only policy';
    assert.equal((await client.settings()).write.available, false);
    await assert.rejects(client.saveSettings({ version: 'user-version', options: { webSearch: 'cached' } }), /no writable config/);
    configRead.layers = [];
    await assert.rejects(client.saveSettings({ version: 'user-version', options: { webSearch: 'cached' } }), /no writable config/);
    assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 0);
  } finally { client.close(); }
});
function fixture({ prunerSupported = false, omitWorkflowParentInList = false, replacementPages, promptPages, browserConfig, threadListPaging = false, archiveDirectory = path.join(os.tmpdir(), `bridge-archives-${randomUUID()}`), clientOptions = {} } = {}) {
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
    [ROOT, { id: ROOT, name: 'Existing root', source: 'cli', cwd: os.tmpdir(), model: MODEL, modelProvider: 'openai', status: { type: 'idle' } }],
    [CHILD, { id: CHILD, name: null, preview: '', agentNickname: 'Sagan', model: MODEL, modelProvider: 'openai', parentThreadId: ROOT, canAcceptDirectInput: false, source: { subAgent: { thread_spawn: { parent_thread_id: ROOT, agent_path: '/root/failure_reporting' } } }, status: { type: 'active' } }],
  ]);
  const socket = new EventEmitter(); socket.sent = []; socket.closed = false;
  // A thread's applied permissions, as the engine reports them in thread/settings/updated and thread/resume.
  const engineSettings = new Map();
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result;
    switch (request.method) {
      case 'initialize': result = { userAgent: 'protocol-test' }; break;
      case 'config/read': result = configRead; break;
      case 'configRequirements/read': result = requirementsRead; break;
      case 'pruner/read': if (prunerSupported) {result=pruner;break;} queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: {code: -32601, message: 'Unknown method'} }))); return;
      case 'pruner/write': pruner={...pruner,model:request.params.model,provider:request.params.provider,reasoningEffort:request.params.reasoningEffort ?? null,version:'pruner-v2'};result=pruner;break;
      case 'config/batchWrite': result = {status:'ok'}; break;
      case 'hooks/list': result = hooksList; break;
      case 'memory/reset': result = {}; break;
      // Like native stored rows, listed threads do not report forkedFromId; thread/read does.
      case 'thread/list': {
        let data = [...threads.values()].filter(thread => !!thread.archived === !!request.params.archived).filter(thread => !request.params.ancestorThreadId || thread.parentThreadId === request.params.ancestorThreadId);
        let nextCursor = null;
        if (threadListPaging) {
          data = data.filter(thread => !request.params.sourceKinds?.length || request.params.sourceKinds.includes(typeof thread.source === 'object' ? 'subAgentThreadSpawn' : thread.source));
          // Like the engine's index: search matches the first message in exact letter case, not a name given later.
          if (request.params.searchTerm) data = data.filter(thread => (thread.preview ?? '').includes(request.params.searchTerm));
          const offset = Number(request.params.cursor ?? 0), end = offset + request.params.limit;
          if (end < data.length) nextCursor = String(end);
          data = data.slice(offset, end);
        }
        result = { data: data.map(thread => ({ ...thread, forkedFromId: null, ...(omitWorkflowParentInList && thread.source?.subAgent?.other?.startsWith('work_graph:') ? {parentThreadId:null} : {}) })), nextCursor }; break;
      }
      case 'thread/read': result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      case 'thread/subscribe': result = { thread: structuredClone(threads.get(request.params.threadId)) }; break;
      // Like the engine (thread_processor.rs), an archived chat refuses to resume, naming the terminal's command.
      case 'thread/resume': if (threads.get(request.params.threadId)?.archived) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: `session ${request.params.threadId} is archived. Run \`codex unarchive ${request.params.threadId}\` to unarchive it first.` } }))); return; }
        result = { ...(engineSettings.has(request.params.threadId) ? (({ sandboxPolicy, ...rest }) => ({ ...rest, sandbox: sandboxPolicy }))(engineSettings.get(request.params.threadId)) : {}), thread: structuredClone(threads.get(request.params.threadId)), model: threads.get(request.params.threadId).model ?? MODEL, collaborationMode: threads.get(request.params.threadId).collaborationMode, initialTurnsPage: { data: threads.get(request.params.threadId).status?.type === 'active' ? [{ id: 'running-turn', status: 'inProgress' }] : [] } }; break;
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
        : promptPages?.[request.params.cursor ?? 'start'] ?? { data: [{ turnId: 't1', item: { type: 'agentMessage', id: 'item1', text: 'Actual fixture transcript' }, startedAtMs: 1 }], nextCursor: null }; break;
      case 'model/list': result = { data: [{ id: MODEL, model: MODEL, displayName: 'Test model' }, { id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)' }], nextCursor: null }; break;
      case 'account/logout': result = {}; break;
      case 'thread/start': {
        const thread = { id: CREATED, source: 'cli', canAcceptDirectInput: true, status: { type: 'idle' } };
        threads.set(CREATED, thread); result = { thread }; break;
      }
      case 'turn/start': threads.get(request.params.threadId).status = { type: 'active' }; result = { turn: { id: 'new-turn', status: 'inProgress', items: [] } }; break;
      case 'turn/steer': result = { turnId: request.params.expectedTurnId }; break;
      case 'turn/settings/update': result = { status: 'applied' }; break;
      case 'thread/settings/update': {
        // As the engine: the request only queues the change; the applied settings follow in
        // thread/settings/updated, and only when they changed.
        const p = request.params, before = JSON.stringify(engineSettings.get(p.threadId) ?? null);
        const applied = p.cwd ? { ...engineSettings.get(p.threadId), cwd: p.cwd } : p.effort ? { ...engineSettings.get(p.threadId), reasoningEffort: p.effort } : { approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandboxPolicy: p.permissions ? PROFILE_SANDBOX[p.permissions] : p.sandboxPolicy, activePermissionProfile: p.permissions ? { id: p.permissions } : null };
        if (p.cwd) threads.get(p.threadId).cwd = p.cwd;
        engineSettings.set(p.threadId, applied); result = {};
        if (JSON.stringify(applied) !== before) setTimeout(() => socket.emit('message', JSON.stringify({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: { ...applied, model: threads.get(p.threadId).model ?? MODEL } } })), 5);
        break;
      }
      case 'turn/interrupt': threads.get(request.params.threadId).status = { type: 'idle' }; result = {}; break;
      case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
      case 'workGraph/list': result = {data:workflowRecords.filter(graph => graph.rootThreadId === request.params.rootThreadId)}; break;
      case 'workGraph/runWithProviders':
      case 'workGraph/run': result = {graphId:'graph-1',threadId:request.params.rootThreadId,turnId:'workflow-turn'}; break;
      default: throw new Error(`Unexpected protocol method ${request.method}`);
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  socket.close = () => { socket.closed = true; socket.emit('close'); };
  // 156e765a4 adds optional gh instructions. Provider routing tests must not read the operator's connector or credentials.
  const workflowHome = path.join(os.tmpdir(), `bridge-workflows-${randomUUID()}`);
  const client = new DesktopClient(socket, { home: workflowHome, browserConfig, archiveDirectory, githubConnector: { instructions: async () => null }, workflowOptions: { stateDir: workflowHome, nodeSpec: node => ({ name: node.name, command: process.execPath, args: [fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs', import.meta.url))], env: { FAKE_ACP_MODELS: node.model }, model: node.model }) }, ...clientOptions });
  return { socket, client, threads, configRead, requirementsRead, workflowRecords, hooksList, engineSettings };
}

test('LEDGER uses native marketplace/catalog/plugin methods and versioned plugin config; rejects forged or stale changes', async () => {
  const f = fixture();
  const plugin = { id: 'docs@ledger', name: 'docs', installed: false, enabled: false, installPolicy: 'AVAILABLE' };
  const marketplace = { name: 'ledger', path: '/catalog/.claude-plugin/marketplace.json', plugins: [plugin] };
  const send = f.socket.send;
  let rejectInstall = false;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    let result;
    if (request.method === 'skills/list') result = { data: [] };
    else if (request.method === 'plugin/list') result = { marketplaces: [marketplace] };
    else if (request.method === 'plugin/installed') result = { marketplaces: [{ ...marketplace, plugins: plugin.installed ? [plugin] : [] }] };
    else if (request.method === 'plugin/search') result = { data: [{ plugin, marketplaceName: 'ledger', marketplacePath: marketplace.path }], nextCursor: 'next' };
    else if (request.method === 'plugin/install') { if (!rejectInstall) { plugin.installed = true; plugin.enabled = true; } result = { appsNeedingAuth: [{ name: 'Calendar', secret: 'private' }] }; }
    else if (request.method === 'plugin/uninstall') { plugin.installed = false; result = {}; }
    else if (request.method === 'marketplace/add' || request.method === 'marketplace/remove') result = {};
    else return send(raw);
    f.socket.sent.push(request);
    queueMicrotask(() => f.socket.emit('message', JSON.stringify(rejectInstall && request.method === 'plugin/install'
      ? { id: request.id, error: { code: -32602, message: 'Plugin blocked by policy' } } : { id: request.id, result })));
  };
  f.client.close();
  // Give customize the same isolated GitHub connector used by production, without invoking a command.
  f.socket.closed = false;
  const client = new DesktopClient(f.socket, { githubConnector: { snapshot: async () => ({ name: 'GitHub', transport: 'gh', enabled: false }) } });
  await client.initialize();
  try {
    const last = method => f.socket.sent.findLast(row => row.method === method)?.params;
    for (const source of ['owner/repo', 'https://example.org/catalog.git', 'git@example.org:owner/catalog.git', '/catalog']) {
      await client.changeMarketplace({ action: 'add', source });
      assert.deepEqual(last('marketplace/add'), { source });
    }
    const found = await client.pluginCatalog({ cwd: '/workspace', search: 'docs', cursor: 'old-page' });
    assert.equal(found.nextCursor, 'next');
    assert.deepEqual(last('plugin/search'), { cwds: ['/workspace'], searchTerm: 'docs', cursor: 'old-page', limit: 50 });
    const result = await client.changePlugin({ action: 'install', id: plugin.id });
    assert.deepEqual(last('plugin/install'), { pluginName: 'docs', marketplacePath: marketplace.path });
    assert.deepEqual(result.appsNeedingAuth, [{ name: 'Calendar' }]);
    assert.equal(result.plugins.version, 'user-version');
    await client.changePlugin({ action: 'enable', id: plugin.id, enabled: false, version: 'user-version' });
    assert.deepEqual(last('config/batchWrite'), { expectedVersion: 'user-version', reloadUserConfig: true, edits: [{ keyPath: 'plugins."docs@ledger".enabled', value: false, mergeStrategy: 'replace' }] });
    const writes = () => f.socket.sent.filter(row => ['plugin/install', 'plugin/uninstall', 'config/batchWrite', 'marketplace/add'].includes(row.method)).length;
    const before = writes();
    await assert.rejects(client.changePlugin({ action: 'enable', id: plugin.id, enabled: false, version: 'stale' }), /changed in another client/);
    await assert.rejects(client.changePlugin({ action: 'enable', id: 'forged@market', enabled: false, version: 'user-version' }), /not installed/);
    await assert.rejects(client.changePlugin({ action: 'enable', id: plugin.id, enabled: 'false', version: 'user-version' }), /on or off/);
    await assert.rejects(client.changeMarketplace({ action: 'add', source: '/catalog', cwd: 'relative' }), /project folder/);
    await assert.rejects(client.changePlugin({ action: 'install', id: 'forged@market' }), /not listed/);
    assert.equal(writes(), before);
    await client.changePlugin({ action: 'uninstall', id: plugin.id });
    assert.deepEqual(last('plugin/uninstall'), { pluginId: plugin.id });
    plugin.installPolicy = 'NOT_AVAILABLE';
    await assert.rejects(client.changePlugin({ action: 'install', id: plugin.id }), /Installation unavailable/);
    plugin.installPolicy = 'AVAILABLE'; rejectInstall = true;
    await assert.rejects(client.changePlugin({ action: 'install', id: plugin.id }), /Plugin blocked by policy/);
    await client.changeMarketplace({ action: 'remove', name: 'ledger' });
    assert.deepEqual(last('marketplace/remove'), { marketplaceName: 'ledger' });
  } finally { client.close(); }
});

test('conversation pages keep a full page of chats when recent agent runs outnumber them', async () => {
  const f = fixture({ threadListPaging: true });
  f.threads.clear();
  const chats = [];
  for (let i = 0; i < 120; i++) {
    const chat = { id: randomUUID(), name: `Synthetic chat ${i}`, source: 'vscode', status: { type: 'idle' } };
    chats.push(chat); f.threads.set(chat.id, chat);
    for (let j = 0; j < 2; j++) {
      const run = { id: randomUUID(), source: j ? { subAgent: { thread_spawn: {} } } : 'exec', parentThreadId: chat.id, status: { type: 'idle' } };
      f.threads.set(run.id, run);
    }
  }
  const { transpileModule, ModuleKind } = await import('typescript');
  const source = await fs.readFile(new URL('../lib/conversation-page.ts', import.meta.url), 'utf8');
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const loaded = {};
  new Function('exports', 'require', compiled)(loaded, id => {
    assert.equal(id, './api'); return { isAgentRun };
  });
  const server = await startDesktopServer({ client: f.client });
  try {
    const url = new URL(server.url), origin = url.origin;
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    const session = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const request = async route => {
      const response = await fetch(`${origin}/api${route}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); return response.json();
    };
    const first = await loaded.loadConversationPage(request);
    assert.equal(first.data.filter(thread => !isAgentRun(thread)).length, 100);
    assert.deepEqual(first.data.filter(thread => !isAgentRun(thread)).map(thread => thread.id), chats.slice(0, 100).map(thread => thread.id));
    assert.ok(first.data.some(isAgentRun), 'recent background runs remain available in their own section');
    assert.equal(first.nextCursor, '100');
    const second = await loaded.loadConversationPage(request, first.nextCursor);
    assert.deepEqual(second.data.map(thread => thread.id), chats.slice(100).map(thread => thread.id));
    assert.equal(second.nextCursor, null);
    const queries = f.socket.sent.filter(request => request.method === 'thread/list');
    assert.equal(queries.filter(request => !request.params.sourceKinds?.length || request.params.sourceKinds.includes('exec')).length, 1, 'background runs are refreshed separately from chat pagination');
  } finally { await server.close(); f.client.close(); }
});

test('Subagents permits optional delegation and refreshes its policy on the next turn of a loaded chat', async () => {
  const { client, socket, threads, configRead } = fixture();
  try {
    await client.initialize(); await client.resume(ROOT, {});
    const policies = new Set();
    for (const enabled of [undefined, false, true, true]) {
      configRead.config.features.multi_agent = enabled;
      threads.get(ROOT).status = { type: 'idle' };
      await client.send(ROOT, { text: 'Please solve this task' });
      const params = socket.sent.findLast(row => row.method === 'turn/start').params;
      const policy = params.additionalContext?.['elpis.subagents'];
      assert.equal(policy?.kind, 'application', 'the setting reaches the model as application instructions');
      policies.add(policy.value);
      if (enabled === false) {
        assert.match(policy.value, /earlier instructions.*delegation.*no longer apply/);
        assert.match(policy.value, /Subagents are disabled/);
        assert.match(policy.value, /Do not start, resume, or delegate/);
        assert.match(policy.value, /even when a user request, AGENTS.md, or skill asks/);
        assert.match(policy.value, /shell-launched agents \(claude, codex, agy, elpis, gemini\)/);
        assert.match(policy.value, /MCP delegate tools/);
      } else {
        assert.match(policy.value, /earlier instructions.*delegation.*no longer apply/);
        assert.match(policy.value, /work directly or delegate/);
        assert.match(policy.value, /never requires spawning an agent/);
        assert.match(policy.value, /Honor explicit user requests/);
      }
      assert.equal(params.input[0].text, 'Please solve this task');
    }
    assert.equal(policies.size, 4, 'native mode hints changing between turns cannot leave a deduplicated, stale policy');
    assert.equal(socket.sent.filter(row => row.method === 'thread/resume').length, 1, 'already-loaded chats get the changed policy without reloading');
    assert.equal(socket.sent.some(row => row.method === 'config/batchWrite'), false, 'sending does not change global settings');
  } finally { client.close(); }
});

test('idle account usage and concurrent desktop readers share one model list; account changes refresh it', async () => {
  const { client, socket } = fixture();
  const reads = () => socket.sent.filter(request => request.method === 'model/list').length;
  try {
    await Promise.all([client.models(), client.providers(), client.providers()]);
    assert.equal(reads(), 1, 'the first desktop catalogue is shared');
    await client.providers();
    socket.emit('message', JSON.stringify({ method: 'account/rateLimits/updated', params: {} }));
    await Promise.all([client.models(), client.providers()]);
    assert.equal(reads(), 1, 'usage updates do not change the model catalogue');
    socket.emit('message', JSON.stringify({ method: 'account/updated', params: {} }));
    await Promise.all([client.models(), client.providers()]);
    assert.equal(reads(), 2, 'a real account change refreshes the shared catalogue');
    await client.saveSettings({ version: 'user-version', main: { model: MODEL, provider: 'openai' } });
    await client.models();
    assert.equal(reads(), 3, 'a saved provider choice refreshes the catalogue');
    await client.signIn({ action: 'signOut' });
    await client.models();
    assert.equal(reads(), 4, 'sign-out refreshes the catalogue even without an account notification');
  } finally { client.close(); }
});

test('a failed model list is retried and non-default pages are read separately', async () => {
  const { client, socket } = fixture();
  const send = socket.send;
  let fail = true;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === 'model/list' && fail) {
      fail = false; socket.sent.push(request);
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32603, message: 'catalogue unavailable' } })));
    } else send(raw);
  };
  try {
    await assert.rejects(client.models(), /rejected the operation/);
    await client.models();
    await client.models({ cursor: 'next' });
    assert.equal(socket.sent.filter(request => request.method === 'model/list').length, 3);
  } finally { client.close(); }
});

test('desktop browser MCP follows new, resumed and forked desktop chats without writing user config', async () => {
  const browserConfig={'mcp_servers.elpis_browser':{command:'node',args:['browser-mcp.mjs'],env:{ELPIS_BROWSER_SOCKET:'/tmp/private-browser.sock'}}};
  const {client,socket}=fixture({browserConfig});
  try {
    await client.initialize();await client.createThread({});
    assert.deepEqual(socket.sent.find(row=>row.method==='thread/start').params.config,browserConfig);
    await client.resume(ROOT,{});await client.forkThread(ROOT,{});
    for(const method of ['thread/resume','thread/fork'])assert.deepEqual(socket.sent.find(row=>row.method===method).params.config,browserConfig);
    assert.equal(socket.sent.some(row=>row.method==='config/batchWrite'),false);
  } finally {client.close();}
});

test('browser session capabilities are separate on create/resume/fork and revoked on deletion', async () => {
  const requested = [], bound = [], closed = [];
  const browserConfig = {
    forSession(id) { requested.push(id); return { 'mcp_servers.elpis_browser': { env: { ELPIS_BROWSER_CAPABILITY: `scope-${id}` } } }; },
    bind(from, to) { bound.push([from, to]); }, close(id) { closed.push(id); },
  };
  const { client, socket } = fixture({ browserConfig });
  try {
    await client.initialize(); await client.createThread({}); await client.resume(ROOT, {}); await client.forkThread(ROOT, {});
    const start = socket.sent.find(row => row.method === 'thread/start'), resume = socket.sent.find(row => row.method === 'thread/resume'), fork = socket.sent.find(row => row.method === 'thread/fork');
    assert.equal(new Set(requested).size, 3, 'each new or resumed session gets its own scope');
    assert.equal(resume.params.config['mcp_servers.elpis_browser'].env.ELPIS_BROWSER_CAPABILITY, `scope-${ROOT}`);
    assert.deepEqual(bound, [[requested[0], CREATED], [requested[2], FORK]]);
    assert.notDeepEqual(start.params.config, fork.params.config);
    await client.deleteThread(ROOT, {}); assert.ok(closed.includes(ROOT));
  } finally { client.close(); }
});

test('a chat that runs the canvas\'s agents turns the multi-agent runtime on for itself only, beside the browser config', async () => {
  // The Ledger's SUBAGENTS switch (features.multi_agent = false) stops a model delegating in ordinary chats; with it the
  // engine refused every canvas run: "multi-agent runtime is disabled; this session cannot run a work graph".
  const browserConfig={'mcp_servers.elpis_browser':{command:'node',args:['browser-mcp.mjs']}};
  const {client,socket}=fixture({browserConfig});
  try {
    await client.initialize();
    await client.createThread({cwd:'/tmp/project',agents:true});
    assert.deepEqual(socket.sent.findLast(row=>row.method==='thread/start').params.config,{...browserConfig,'features.multi_agent':true});
    await client.createThread({cwd:'/tmp/project'});
    assert.deepEqual(socket.sent.findLast(row=>row.method==='thread/start').params.config,browserConfig,'an ordinary chat keeps the user\'s switch');
    await assert.rejects(client.createThread({agents:'yes'}),/agents must be true or false/);
    assert.equal(socket.sent.some(row=>row.method==='config/batchWrite'||row.method==='config/value/write'),false,'the user config is never written');
  } finally {client.close();}
});

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

test('connection models forward the OpenRouter audio filter and explain a missing connection key', async () => {
  const { client, configRead } = fixture(); await client.initialize();
  configRead.config.model_providers.openrouter = { base_url: 'https://openrouter.ai/api/v1', experimental_bearer_token: 'catalog-key' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'voice/audio', architecture: { input_modalities: ['audio'] }, supported_parameters: [] },
    { id: 'text/chat', architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] }] }));
  try {
    const result = await client.models({ provider: 'openrouter', inputModality: 'audio' });
    assert.deepEqual(result.data.map(row => row.model), ['voice/audio']);
    await assert.rejects(client.models({ inputModality: 'audio' }), /OpenRouter audio models/);
    await assert.rejects(client.models({ provider: 'openrouter', inputModality: 'video' }), /OpenRouter audio models/);
    configRead.config.model_providers.openrouter = { base_url: 'https://openrouter.ai/api/v1', env_key: 'ELPIS_D1_MISSING_KEY' };
    await assert.rejects(client.models({ provider: 'openrouter', inputModality: 'audio' }), /Add an API key for this connection/);
  } finally { globalThis.fetch = original; client.close(); }
});

test('the current API default loads its own catalog instead of the engine startup catalog', async () => {
  const { client, socket, configRead, requirementsRead } = fixture(); await client.initialize();
  configRead.config.model_provider = 'anthropic-credits';
  configRead.config.model = 'claude-opus-5-5';
  configRead.config.model_providers['anthropic-credits'] = { name: 'Anthropic credits', base_url: 'http://127.0.0.1:44103/v1', wire_api: 'responses', requires_openai_auth: false,
    http_headers: { 'x-elpis-gateway-token': 'PRIVATE GATEWAY TOKEN', 'x-elpis-provider': 'anthropic-credits', 'x-elpis-wire': 'anthropic_messages' } };
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, provider: options.headers.get('x-elpis-provider') });
    return new Response(JSON.stringify({ models: [{ slug: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const before = socket.sent.filter(message => message.method === 'model/list').length;
    const credits = await client.models({ provider: 'anthropic-credits' });
    assert.deepEqual(credits.data.map(model => model.model), ['claude-opus-5-5']);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:44103/v1/models', provider: 'anthropic-credits' }]);
    assert.equal(socket.sent.filter(message => message.method === 'model/list').length, before, 'the old engine catalog is not relabeled');
    assert.doesNotMatch(JSON.stringify(credits), /PRIVATE GATEWAY TOKEN|x-elpis-/);
    await client.createThread({ provider: 'anthropic-credits', model: credits.data[0].model });
    const start = socket.sent.findLast(message => message.method === 'thread/start');
    assert.deepEqual([start.params.modelProvider, start.params.model], ['anthropic-credits', 'claude-opus-5-5']);
    await client.createThread({ provider: 'anthropic-credits' });
    const inherited = socket.sent.findLast(message => message.method === 'thread/start');
    assert.equal(inherited.params.modelProvider, 'anthropic-credits');
    assert.equal(inherited.params.model, undefined, 'a primary connection can inherit its configured model');
    requirementsRead.requirements = { modelProvider: 'openai' };
    await assert.rejects(client.models({ provider: 'anthropic-credits' }), /restricted/);
    assert.equal(calls.length, 1, 'managed policy is checked before another endpoint lookup');
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

test('search finds a chat by its name in any letter case, also past the first page the sidebar loaded', async () => {
  const { client, threads } = fixture({ threadListPaging: true }); await client.initialize();
  const chat = (id, name, preview, source = 'vscode') => threads.set(id, { id, name, preview, source, status: { type: 'idle' }, cwd: '/work' });
  for (let i = 0; i < 230; i++) chat(`filler-${i}`, `Filler chat ${i}`, `lorem ${i}`);
  chat('named-main', 'main', 'Set up the repo'); chat('branch', 'Main branch cleanup', 'tidy the branches');
  chat('hermes', 'Hermes main setup', 'configure hermes'); chat('domain', 'Domain notes', 'dns records');
  chat('mention', 'Release checklist', 'merge into main tomorrow'); chat('run', 'main', 'background run', 'exec');
  try {
    for (const term of ['main', 'MAIN', 'mai', 'Main']) {
      const found = (await client.listThreads({ searchTerm: term, limit: 100 })).data.map(thread => thread.id);
      assert.deepEqual(['named-main', 'branch', 'hermes', 'domain', 'mention'].filter(id => !found.includes(id)), [], `${term} misses named chats`);
      assert.ok(!found.includes('run') && !found.some(id => id.startsWith('filler-')), `${term} lists only matches`);
    }
  } finally { client.close(); }
});

test('background sources are excluded from ordinary lists and search, and explicitly available to Agent runs', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  threads.set(CREATED, { id: CREATED, source: 'exec', name: 'Worker · inspect', parentThreadId: ROOT, status: { type: 'idle' } });
  threads.set(FORK, { id: FORK, source: 'vscode', name: 'Worker · my own chat', status: { type: 'idle' } });
  try {
    for (const options of [{}, { searchTerm: 'Worker' }, { archived: false }]) {
      const listed = await client.listThreads(options);
      assert.deepEqual(listed.data.map(thread => thread.id), [ROOT, FORK]);
      assert.ok(!socket.sent.findLast(row => row.method === 'thread/list').params.sourceKinds.includes('exec'));
    }
    assert.deepEqual((await client.listThreads({ includeAgentRuns: true })).data.map(thread => thread.id), [ROOT, CHILD, CREATED, FORK]);
    assert.deepEqual((await client.listThreads({ ancestorThreadId: ROOT })).data.map(thread => thread.id), [CHILD, CREATED]);
  } finally { client.close(); }
});

test('listed spawned agents recover their parent from recorded source without grouping independent desktop chats', async () => {
  const { client, threads } = fixture(); await client.initialize();
  threads.get(CHILD).parentThreadId = null;
  threads.set(FORK, { id: FORK, source: 'vscode', name: 'Elpis — keyboard shortcuts', status: { type: 'idle' } });
  try {
    const listed = (await client.listThreads({ includeAgentRuns: true })).data;
    const agent = listed.find(thread => thread.id === CHILD);
    assert.equal(agent.parentThreadId, ROOT, 'the source records subAgent.thread_spawn.parent_thread_id');
    assert.equal(agent.desktopAccess.writable, false);
    assert.equal(listed.find(thread => thread.id === FORK).parentThreadId, undefined, 'a name is not evidence of parentage');
  } finally { client.close(); }
});

test('background runs are read-only; only an idle run may explicitly continue in a normal chat without sending', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  threads.set(CREATED, { id: CREATED, source: 'exec', name: 'Worker · inspect', parentThreadId: ROOT, model: MODEL, modelProvider: 'openai', canAcceptDirectInput: true, status: { type: 'active' } });
  try {
    for (const id of [CHILD, CREATED]) {
      assert.equal((await client.readThread(id)).thread.desktopAccess.writable, false);
      await assert.rejects(client.send(id, { text: 'Hello' }), /background|parent|continued conversation name/i);
      await assert.rejects(client.continueThread(id, {}), /finish/i);
    }
    assert.equal(socket.sent.filter(row => row.method === 'thread/fork' || row.method === 'turn/start').length, 0);
    threads.get(CREATED).status = { type: 'idle' };
    assert.equal((await client.readThread(CREATED)).thread.desktopAccess.canContinue, true);
    const continued = await client.continueThread(CREATED, {});
    assert.equal(continued.thread.id, FORK);
    assert.equal(continued.thread.desktopAccess.writable, true);
    assert.equal(continued.thread.source, 'appServer');
    assert.equal(continued.thread.forkedFromId, CREATED);
    assert.equal(threads.get(CREATED).source, 'exec');
    assert.equal(threads.get(CREATED).parentThreadId, ROOT);
    assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 0);
    assert.deepEqual(socket.sent.find(row => row.method === 'thread/fork').params, { threadId: CREATED, model: MODEL, modelProvider: 'openai' });
    await client.send(FORK, { text: 'Now talk here' });
    assert.equal(socket.sent.find(row => row.method === 'turn/start').params.threadId, FORK);
  } finally { client.close(); }
});

test('opening a completed parent-owned child reads history without resuming it', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  threads.get(CHILD).status = { type: 'notLoaded' };
  delete threads.get(CHILD).canAcceptDirectInput;
  try {
    const opened = await client.resume(CHILD, {});
    assert.equal(opened.thread.desktopAccess.writable, false);
    assert.equal(opened.activeTurnId, null);
    assert.equal((await client.readThread(CHILD)).data[0].item.text, 'Actual fixture transcript');
    assert.equal(socket.sent.some(row => ['thread/resume', 'thread/subscribe', 'thread/settings/update'].includes(row.method) && row.params.threadId === CHILD), false);
  } finally { client.close(); }
});

test('a child in a legacy drain reports history-only until its viewer reconnects', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/subscribe' || request.params.threadId !== CHILD) return send(raw);
    socket.sent.push(request);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { thread: structuredClone(threads.get(CHILD)), followingLive: false } })));
  };
  try {
    assert.equal((await client.resume(CHILD, {})).followingLive, false);
    assert.equal((await client.resume(CHILD, {})).followingLive, false, 'a second open keeps the truthful state');
    assert.equal(socket.sent.filter(row => row.method === 'thread/subscribe' && row.params.threadId === CHILD).length, 1);
    assert.equal(socket.sent.some(row => ['thread/resume', 'thread/settings/update', 'turn/start'].includes(row.method) && row.params.threadId === CHILD), false);
  } finally { client.close(); }
});

test('a finished child can continue from stored history when its parent is not loaded', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  threads.get(CHILD).status = { type: 'notLoaded' };
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === 'thread/resume' && request.params.threadId === CHILD) {
      socket.sent.push(request);
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'parent is not loaded; resume the parent first' } })));
    } else send(raw);
  };
  try {
    const continued = await client.continueThread(CHILD, {});
    assert.equal(continued.thread.id, FORK);
    assert.equal(continued.thread.name, 'Chat (continued)');
    assert.equal(socket.sent.some(row => row.method === 'thread/resume'), false, 'forking a finished run must not load its parent or take over the run');
    assert.equal(socket.sent.some(row => row.method === 'turn/start'), false);
  } finally { client.close(); }
});

test('the auto-review reviewer\'s own threads are never listed as chats', async () => {
  const { client, threads } = fixture(); await client.initialize();
  const reviewer = 'guardian-review-thread';
  threads.set(reviewer, { ...threads.get(ROOT), id: reviewer, name: 'Guardian review', source: { subAgent: { other: 'guardian' } } });
  try { assert.deepEqual((await client.listThreads()).data.map(thread => thread.id).filter(id => id === reviewer), []); }
  finally { client.close(); }
});

test('existing chats are written directly after a native rejoin; parent-owned agents explicitly continue in a fork', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  const listed = await client.listThreads({ includeAgentRuns: true });
  assert.equal(listed.data.length, 2);
  assert.deepEqual(listed.data.map(thread => [thread.desktopAccess.writable, thread.desktopAccess.mode]), [[true, 'direct'], [false, 'continue']]);
  assert.ok(socket.sent.find(row => row.method === 'thread/list').params.sourceKinds.includes('subAgentThreadSpawn'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/subscribe').map(row => row.params.threadId), [CHILD], 'working agents are followed live without resuming them');
  const liveChild = await client.resume(CHILD, {});
  assert.equal(liveChild.activeTurnId, 'running-turn');
  assert.equal(liveChild.thread.desktopAccess.writable, false);
  assert.equal(socket.sent.some(row => ['thread/resume', 'thread/settings/update', 'turn/start'].includes(row.method) && row.params.threadId === CHILD), false);
  const events = []; client.on('event', event => events.push(event));
  socket.emit('message', JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: CHILD, turnId: 'running-turn', itemId: 'child-message', delta: 'live child' } }));
  assert.ok(events.some(event => event.data?.method === 'item/agentMessage/delta' && event.data.params.delta === 'live child'));
  const child = await client.readThread(CHILD);
  assert.equal(child.data[0].item.text, 'Actual fixture transcript');
  await client.send(ROOT, { text: 'Continue the root' });
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/resume').map(row => row.params), [
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

for (const found of [true, false]) test(`fork recovers a stale turn only through its exact persisted message (found=${found})`, async () => {
  const { client, socket } = fixture();
  try {
    await client.initialize();
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === 'thread/fork' && request.params.lastTurnId === 'stale-turn') {
        socket.sent.push(request);
        queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'turn not found: stale-turn' } })));
      } else if (request.method === 'thread/items/list') {
        socket.sent.push(request);
        queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { data: [
          { turnId: 'newer-turn', item: { id: 'newer-answer', type: 'agentMessage' } },
          ...(found ? [{ turnId: 'persisted-turn', item: { id: 'selected-answer', type: 'agentMessage' } }] : []),
        ], nextCursor: null } })));
      } else send(raw);
    };
    if (found) {
      const result = await client.forkThread(ROOT, { lastTurnId: 'stale-turn', lastItemId: 'selected-answer' });
      assert.equal(result.thread.id, FORK);
      assert.deepEqual(socket.sent.filter(row => row.method === 'thread/fork').map(row => row.params.lastTurnId), ['stale-turn', 'persisted-turn']);
    } else {
      await assert.rejects(client.forkThread(ROOT, { lastTurnId: 'stale-turn', lastItemId: 'selected-answer' }), /refresh|reload/i);
      assert.equal(socket.sent.filter(row => row.method === 'thread/fork').length, 1, 'Never fork latest history when the selected message is missing');
    }
    assert.equal(socket.sent.some(row => row.method === 'turn/start'), false, 'Fork recovery never sends a new message');
  } finally { client.close(); }
});

test('an effort picked in a chat is saved at once; a running native turn takes it now, a Claude turn through its bridge', async () => {
  const { client, socket, threads } = fixture(); await client.initialize(); await client.models();
  await client.createThread({ model: MODEL });
  await client.send(CREATED, { text: 'Do the task', model: MODEL });
  const sent = method => socket.sent.filter(row => row.method === method).map(row => row.params);
  assert.deepEqual(await client.setEffort(CREATED, { effort: 'xhigh' }), { reasoningEffort: 'xhigh' });
  assert.deepEqual(sent('thread/settings/update').at(-1), { threadId: CREATED, effort: 'xhigh' }, 'later turns and a restart keep it');
  assert.deepEqual(sent('turn/settings/update'), [{ threadId: CREATED, turnId: 'running-turn', effort: 'xhigh' }], 'the running turn takes it');
  // A Claude turn is not the engine's: the bridge applies the saved effort to it.
  Object.assign(threads.get(CREATED), { model: 'claude/opus' });
  await client.setEffort(CREATED, { effort: 'low' });
  assert.deepEqual(sent('thread/settings/update').at(-1), { threadId: CREATED, effort: 'low' });
  assert.equal(sent('turn/settings/update').length, 1);
  // An idle chat only saves it.
  Object.assign(threads.get(CREATED), { model: MODEL, status: { type: 'idle' } });
  await client.setEffort(CREATED, { effort: 'medium' });
  assert.equal(sent('turn/settings/update').length, 1);
  const before = socket.sent.length;
  await assert.rejects(client.setEffort(CREATED, { effort: 'very high' }), /reasoning effort/);
  await assert.rejects(client.setEffort(CREATED, {}), /reasoning effort/);
  await assert.rejects(client.setEffort(CHILD, { effort: 'high' }), /parent/);
  assert.equal(socket.sent.slice(before).some(row => row.method.endsWith('settings/update')), false, 'a refused effort changes nothing');
  client.close();
});

test('new roots send, steer and interrupt through typed protocol without overriding permissions', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.models();
  await assert.rejects(client.createThread({ model: 'invented' }), /model list/);
  await assert.rejects(client.createThread({ approvalPolicy: 'never' }), /Unsupported/);
  const created = await client.createThread({ model: MODEL });
  assert.equal(created.thread.desktopAccess.writable, true);
  const first = client.send(CREATED, { text: 'Do the task', model: MODEL });
  const duplicate = assert.rejects(client.send(CREATED, { text: 'Race' }), /Use Steer/);
  assert.equal((await first).turn.id, 'new-turn');
  await duplicate;
  assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 1, 'a queued duplicate never starts another turn or silently steers');
  await assert.rejects(client.send(CREATED, { text: 'Do not silently steer' }), /Use Steer/);
  assert.equal((await client.steer(CREATED, { text: 'Clarify', expectedTurnId: 'new-turn' })).turnId, 'new-turn');
  await client.interrupt(CREATED, { turnId: 'new-turn' });
  const request = socket.sent.find(row => row.method === 'turn/start');
  const { additionalContext, ...params } = request.params;
  assert.equal(additionalContext['elpis.subagents'].kind, 'application');
  assert.deepEqual(params, { threadId: CREATED, input: [{ type: 'text', text: 'Do the task', text_elements: [] }], model: MODEL });
  assert.equal(socket.sent.some(row => row.method === 'thread/resume'), false);
  client.close(); assert.equal(socket.closed, true);
});

test('opening a chat lets Elpis unload the idle chats left behind, never a working one (A47)', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.models();
  const released = () => socket.sent.filter(row => row.method === 'thread/unsubscribe').map(row => row.params.threadId);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  await client.createThread({ model: MODEL });
  await client.resume(ROOT, {}); await settle();
  assert.deepEqual(released(), [CREATED]);
  // Back in the left chat, it is followed again and runs a turn; leaving it then keeps it followed.
  await client.resume(CREATED, {}); await settle();
  assert.deepEqual(released(), [CREATED, ROOT]);
  await client.send(CREATED, { text: 'Work', model: MODEL });
  await client.resume(ROOT, {}); await settle();
  assert.deepEqual(released(), [CREATED, ROOT]);
});

test('a message to a chat the app wrongly thinks busy is delivered, not refused as unavailable (A58)', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.models();
  await client.createThread({ model: MODEL });
  // As the engine: a steer naming any turn but the running one is refused.
  const send = socket.send; let running = null;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const refusal = request.params?.input?.[0]?.text === 'Review this' ? 'active turn uses a different output schema'
      : request.params?.expectedTurnId === running ? null : running ? `expected active turn id \`${request.params?.expectedTurnId}\` but found \`${running}\`` : 'no active turn to steer';
    if (request.method !== 'turn/steer' || !refusal) return send(raw);
    socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: refusal } })));
  };
  // The turn the app saw has finished: the message starts a new turn.
  assert.equal((await client.steer(CREATED, { text: 'Are you there?', expectedTurnId: 'finished-turn' })).turn?.id, 'new-turn');
  assert.equal(socket.sent.findLast(row => row.method === 'turn/start').params.input[0].text, 'Are you there?');
  // Another turn replaced it: the message joins the running turn instead.
  running = 'running-turn';
  assert.equal((await client.steer(CREATED, { text: 'Also this', expectedTurnId: 'new-turn' })).turnId, 'running-turn');
  assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 1);
  // Any other refusal keeps the engine's reason instead of a bare code.
  await assert.rejects(client.steer(CREATED, { text: 'Review this', expectedTurnId: 'running-turn' }), /different output schema/);
});

test('a message steered into a compaction is handed back for the queue, not refused or sent as a new turn', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.models();
  await client.createThread({ model: MODEL });
  // As the engine (codex-rs app-server turn_processor.rs): a compact turn cannot be steered.
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'turn/steer') return send(raw);
    socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'cannot steer a compact turn' } })));
  };
  assert.deepEqual(await client.steer(CREATED, { text: 'After compacting', expectedTurnId: 'compact-turn' }), { compacting: true });
  assert.equal(socket.sent.filter(row => row.method === 'turn/start').length, 0, 'nothing starts beside the compaction');
  assert.equal(socket.sent.filter(row => row.method === 'thread/turns/list').length, 0);
  // A review turn still says why it refuses.
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'turn/steer') return send(raw);
    socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'cannot steer a review turn' } })));
  };
  await assert.rejects(client.steer(CREATED, { text: 'Review this', expectedTurnId: 'review-turn' }), /cannot steer a review turn/);
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
  socket.emit('message', JSON.stringify({ id: 'future', method: 'future/requestApproval', params: { threadId: CREATED } }));
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

test('prompt index route pages the full thread and returns ordered, bounded prompt and reply previews', async t => {
  const prompt = (turnId, content) => ({ turnId, item: { id: `u-${turnId}`, type: 'userMessage', content } });
  const promptPages = {
    start: { data: [{ turnId: 't5', item: { id: 'reply-later', type: 'agentMessage', text: 'Later fifth answer' } }, { turnId: 't5', item: { id: 'reply', type: 'agentMessage', text: 'Fifth answer' } }, prompt('t5', [{ type: 'text', text: 'Fifth prompt' }]), prompt('t4', [{ type: 'text', text: 'Fourth prompt' }])], nextCursor: 'middle' },
    middle: { data: [{ turnId: 't3', item: { id: 'reply-3', type: 'agentMessage', content: [{ type: 'text', text: 'Third answer' }] } }, prompt('t3', [{ type: 'text', text: 'Third prompt' }]), { turnId: 't2', item: { id: 'reply-2', type: 'agentMessage', text: 'B'.repeat(700) } }, prompt('t2', [{ type: 'text', text: 'Second prompt' }])], nextCursor: 'oldest' },
    oldest: { data: [prompt('t1', [{ type: 'text', text: 'A'.repeat(240) }, { type: 'image', image: 'not text' }])], nextCursor: null },
  };
  const { client, socket } = fixture({ promptPages }); await client.initialize();
  const app = await startDesktopServer({ client }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const route = `/api/threads/${ROOT}/prompts`;
  const response = await fetch(origin + route, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data.map(row => row.turnId), ['t1', 't2', 't3', 't4', 't5']);
  assert.deepEqual(result.data.map(row => row.itemId), ['u-t1', 'u-t2', 'u-t3', 'u-t4', 'u-t5']);
  assert.equal(result.data[0].text, 'A'.repeat(200));
  assert.deepEqual(result.data.slice(1).map(row => row.text), ['Second prompt', 'Third prompt', 'Fourth prompt', 'Fifth prompt']);
  assert.deepEqual(result.data.map(row => row.reply), ['', 'B'.repeat(600), 'Third answer', '', 'Fifth answer']);
  assert.doesNotMatch(JSON.stringify(result), /not text/);
  assert.deepEqual(socket.sent.filter(row => row.method === 'thread/items/list').map(row => row.params.cursor ?? null), [null, 'middle', 'oldest']);
  assert.equal((await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' })).status, 405);
});

test('the prompt index keeps the original item ID when a turn spans pages of steering messages (A98)', async () => {
  const prompt = (itemId, text) => ({ turnId: 'long-turn', item: { id: itemId, type: 'userMessage', content: [{ type: 'text', text }] } });
  const { client } = fixture({ promptPages: {
    start: { data: [prompt('last-steer', 'Later steering')], nextCursor: 'middle' },
    middle: { data: [prompt('earlier-steer', 'Earlier steering')], nextCursor: 'oldest' },
    oldest: { data: [prompt('original', 'The original prompt')], nextCursor: null },
  } });
  try {
    await client.initialize();
    assert.deepEqual((await client.readPrompts(ROOT)).data, [{ turnId: 'long-turn', itemId: 'original', text: 'The original prompt', reply: '' }]);
  } finally { client.close(); }
});

test('provider history cursors fit the HTTP query and stay bound to their chat (A98)', async t => {
  // providerPage records consumed native item IDs. A valid 100-item continuation
  // already exceeds pageQuery's 4096-character HTTP limit.
  const cursor = 'acp-page:' + Buffer.from(JSON.stringify({ nativeSeen: Array.from({ length: 100 }, () => randomUUID()) })).toString('base64url');
  assert.ok(cursor.length > 4096);
  const prompt = turnId => ({ turnId, item: { id: turnId, type: 'userMessage', content: [{ type: 'text', text: turnId }] } });
  const { client, socket } = fixture({ promptPages: {
    start: { data: [prompt('newest')], nextCursor: cursor },
    [cursor]: { data: [prompt('oldest')], nextCursor: null },
  } });
  await client.initialize();
  const app = await startDesktopServer({ client }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const headers = { Cookie: auth.headers.get('set-cookie').split(';')[0] };
  const read = (id, after) => fetch(`${origin}/api/threads/${id}?limit=100${after ? '&cursor=' + encodeURIComponent(after) : ''}`, { headers });
  const first = await (await read(ROOT)).json();
  assert.ok(first.nextCursor.length <= 4096, `HTTP cursor is ${first.nextCursor.length} characters`);
  assert.equal((await (await read(ROOT)).json()).nextCursor, first.nextCursor, 'repeated pages share a continuation');
  const wrongChat = await read(CHILD, first.nextCursor);
  assert.equal(wrongChat.status, 400);
  const count = socket.sent.filter(row => row.method === 'thread/items/list').length;
  const stale = await read(ROOT, 'desktop-page:unknown');
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /history|conversation/i);
  assert.equal(socket.sent.filter(row => row.method === 'thread/items/list').length, count, 'unknown continuations never reach the engine');
  const second = await read(ROOT, first.nextCursor);
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).data.map(row => row.turnId), ['oldest']);
  assert.equal(socket.sent.filter(row => row.method === 'thread/items/list').at(-1).params.cursor, cursor, 'the engine receives its original cursor');
  const index = await (await fetch(`${origin}/api/threads/${ROOT}/prompts`, { headers })).json();
  assert.deepEqual(index.data.map(row => row.turnId), ['oldest', 'newest']);
});

test('live voice delivers SDP privately and ends the native call when its window disconnects', async t => {
  const { client, socket } = fixture(); await client.initialize();
  const nativeSend = socket.send;
  let stopCount = 0, startRequest, holdStart = false, finishStart, chatgpt = true, savedVoice;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const answer = result => queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
    if (request.method === 'config/read') { answer({ config: { realtime: savedVoice ? { voice: savedVoice } : undefined } }); return; }
    if (request.method === 'config/batchWrite') { socket.sent.push(request); savedVoice = request.params.edits[0].value; answer({}); return; }
    if (request.method === 'account/read' && !chatgpt) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { account: { type: 'apiKey' } } }))); return; }
    if (!request.method?.startsWith('thread/realtime/')) return nativeSend(raw);
    socket.sent.push(request);
    if (request.method === 'thread/realtime/start') startRequest = request;
    if (request.method === 'thread/realtime/stop') stopCount++;
    const reply = () => {
      socket.emit('message', JSON.stringify({ id: request.id, result: request.method.endsWith('listVoices') ? { voices: { v1: ['cove', 'juniper'], v2: ['alloy'], defaultV1: 'cove', defaultV2: 'alloy' } } : {} }));
      if (request.method.endsWith('/start')) socket.emit('message', JSON.stringify({ method: 'thread/realtime/sdp', params: { threadId: ROOT, sdp: 'v=0\r\nanswer' } }));
    };
    if (holdStart && request.method.endsWith('/start')) finishStart = reply; else queueMicrotask(reply);
  };
  const app = await startDesktopServer({ client }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
  const headers = { Origin: origin, Cookie: auth.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const post = (body, signal) => fetch(origin + '/api/voice', { method: 'POST', headers, body: JSON.stringify(body), signal });
  const catalog = await (await fetch(origin + '/api/voice', { headers })).json();
  assert.deepEqual(catalog, { available: true, voices: ['cove', 'juniper'], voice: 'cove' }, 'no saved choice: the native default');
  const choose = voice => fetch(origin + '/api/voice/choice', { method: 'POST', headers, body: JSON.stringify({ voice }) });
  assert.equal((await post({ threadId: 'invalid', sdp: 'v=0\r\noffer' })).status, 400);
  const unsupported = await choose('alloy'); // a voice of another protocol version
  assert.equal(unsupported.status, 400); assert.match(await unsupported.text(), /Choose one of the listed voices/);
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 0, 'an unlisted voice is never saved');
  assert.deepEqual(await (await choose('juniper')).json(), { available: true, voices: ['cove', 'juniper'], voice: 'juniper' });
  assert.deepEqual(socket.sent.find(row => row.method === 'config/batchWrite').params.edits, [{ keyPath: 'realtime.voice', value: 'juniper', mergeStrategy: 'replace' }]);
  assert.equal(socket.sent.filter(row => row.method === 'thread/realtime/start').length, 0);
  const abort = new AbortController();
  const response = await post({ threadId: ROOT, sdp: 'v=0\r\noffer' }, abort.signal);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /ndjson/);
  const reader = response.body.getReader();
  let received = ''; while (!received.includes('answer')) received += new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(received, /PRIVATE CONFIG SECRET|auth|token/);
  assert.equal(JSON.parse(received.trim()).sdp, 'v=0\r\nanswer');
  assert.equal(startRequest.params.transport.type, 'webrtc');
  assert.equal(startRequest.params.voice, 'juniper', 'the call speaks in the saved voice');
  assert.equal(startRequest.params.initialItems[0].role, 'developer', 'voice receives the current Elpis execution context');
  assert.equal((await post({ threadId: ROOT, sdp: 'v=0\r\noffer' })).status, 409);
  abort.abort(); await reader.cancel().catch(() => {});
  const deadline = Date.now() + 2000;
  while (!stopCount && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopCount, 1, 'closing the stream must release the native call');
  holdStart = true; const duringStart = new AbortController();
  const pending = await post({ threadId: ROOT, sdp: 'v=0\r\noffer' }, duringStart.signal);
  const startingDeadline = Date.now() + 2000;
  while (!finishStart && Date.now() < startingDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof finishStart, 'function');
  duringStart.abort(); await pending.body.cancel().catch(() => {}); finishStart();
  const endedDeadline = Date.now() + 2000;
  while (stopCount < 2 && Date.now() < endedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopCount, 2, 'End during native startup must stop the late call');
  chatgpt = false;
  const denied = await post({ threadId: ROOT, sdp: 'v=0\r\noffer' });
  assert.match(await denied.text(), /Voice needs a ChatGPT connection/);
  assert.equal(socket.sent.filter(row => row.method === 'thread/realtime/start').length, 2, 'API-key accounts must never start a call');
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
  const result = await (await get('/api/threads')).json(); assert.deepEqual(result.data.map(thread => thread.id), [ROOT]);
  const all = await (await get('/api/threads?includeAgentRuns=true')).json(); assert.equal(all.data.length, 2);
  assert.equal((await get('/api/threads?includeAgentRuns=yes')).status, 400);
  const child = await (await get(`/api/threads/${CHILD}`)).json(); assert.equal(child.thread.id, CHILD);
  assert.equal(child.thread.desktopAccess.writable, false);
  assert.equal((await post(`/api/threads/${CHILD}/continue`, {}, { Cookie: cookie })).status, 409);
  const settings = await (await get('/api/settings')).json(); assert.equal(settings.smartPrune.enabled, true);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE CONFIG SECRET|private\/config/);
  const context = await (await get(`/api/threads/${ROOT}/context`)).json(); assert.equal(context.tokenUsage, null);
  for (const route of ['/api/dashboard', '/api/dashboard/', '/api/dashboard/agents.json']) {
    assert.equal((await get(route)).status, 404, 'OBSRM: the retired page transport is no longer served');
  }
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
  const worker=(await client.listThreads({includeAgentRuns:true})).data.find(thread=>thread.id===CHILD);
  assert.equal(worker.workflowTaskTitle,'Inspect actual project');
  assert.equal(worker.parentThreadId,ROOT,'list must preserve the native read and recorded graph lineage');
  assert.deepEqual(socket.sent.filter(row=>row.method==='thread/read').map(row=>row.params.threadId),[CHILD]);
  const again=(await client.listThreads({includeAgentRuns:true})).data.find(thread=>thread.id===CHILD);
  assert.equal(again.parentThreadId,ROOT);
  assert.equal(socket.sent.filter(row=>row.method==='thread/read').length,1,'verified workflow metadata is reused');
  threads.get(CHILD).source={subAgent:{other:`work_graph:${graphId}:different-task`}};
  const unrelated=(await client.listThreads({includeAgentRuns:true})).data.find(thread=>thread.id===CHILD);
  assert.equal(unrelated.workflowTaskTitle,undefined);
  assert.equal(unrelated.parentThreadId,null,'unrecorded task cannot inherit cached lineage');
  client.close();
});

test('workflow history includes native teams discovered through their task chats', async () => {
  const { client, threads, workflowRecords } = fixture();
  try {
    await client.initialize();
    const id = '00000000-0000-0000-0000-000000000099';
    threads.get(CHILD).source = { subAgent: { other: `work_graph:${id}:review` } };
    workflowRecords.push({ id, rootThreadId: ROOT, name: 'Native review', status: 'running', tasks: [] });
    const result = await client.workflowHistory();
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].id, id);
    assert.equal(result.data[0].rootThreadId, ROOT);
  } finally { client.close(); }
});

test('workflow history Remove and restart Undo are profile-scoped; active work and chats are preserved', async t => {
  const dir = createTestTempDir(path.join(os.tmpdir(), 'elpis-history-'));
  const home = path.join(dir, 'profile'), ambient = path.join(dir, 'ambient');
  const savedId = '00000000-0000-0000-0000-000000000098', activeId = '00000000-0000-0000-0000-000000000099', nativeId = '00000000-0000-0000-0000-000000000096';
  const saved = { id: savedId, rootThreadId: ROOT, name: 'Finished team', status: 'cancelled', tasks: [{ id: 'not-started', status: 'pending' }] };
  const seed = async (profile, record) => {
    await fs.mkdir(path.join(profile, 'desktop-workflows'), { recursive: true });
    const file = path.join(profile, 'desktop-workflows', `${record.id}.json`), bytes = JSON.stringify(record);
    await fs.writeFile(file, bytes); return { file, bytes };
  };
  const original = await seed(home, saved), untouched = await seed(ambient, { ...saved, name: 'Other profile' });
  const beforeHome = process.env.ELPIS_HOME, connect = DesktopClient.connect;
  let app, first, second;
  const open = async client => {
    const result = await startDesktopServer({ ...(client ? { client } : {}), elpisHome: home, trashFile: path.join(home, 'chat-trash.json'),
      loveSpot: { directory: path.join(home, 'drawing'), screenshots: path.join(home, 'screenshots') } });
    const url = new URL(result.url), origin = url.origin;
    const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
    assert.equal(auth.status, 200);
    const headers = { Origin: origin, 'Content-Type': 'application/json', Cookie: auth.headers.get('set-cookie').split(';')[0] };
    return { app: result, request: (route = '', method = 'GET') => fetch(`${origin}/api/workflows/history${route}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) }) };
  };
  try {
    process.env.ELPIS_HOME = ambient;
    // Stand in only for the Unix transport: the server's actual options construct the real client and storage.
    DesktopClient.connect = async options => {
      first = fixture({ clientOptions: { ...options, home: options.home, workflowOptions: {} } }); await first.client.initialize();
      first.threads.get(CHILD).source = { subAgent: { other: `work_graph:${activeId}:review` } };
      first.workflowRecords.push({ id: activeId, rootThreadId: ROOT, name: 'Still working', status: 'running', tasks: [] });
      return first.client;
    };
    let opened = await open(); app = opened.app; let request = opened.request;
    DesktopClient.connect = connect;
    let history = await (await request()).json();
    assert.deepEqual(history.data.map(run => run.name).sort(), ['Finished team', 'Still working']);
    assert.equal(history.canUndo, false);
    const refused = await request(`/${activeId}/remove`, 'POST');
    assert.equal(refused.status, 409); assert.match((await refused.json()).error, /finish|running/i);
    assert.equal((await request('/00000000-0000-0000-0000-000000000097/remove', 'POST')).status, 404);
    const continuation = { ...saved, id: nativeId, status: 'succeeded', next: { status: 'waiting' } };
    first.workflowRecords.push(continuation);
    for (const status of ['waiting', 'starting', 'running', 'unknown', undefined]) {
      continuation.next.status = status;
      const blocked = await request(`/${nativeId}/remove`, 'POST');
      assert.equal(blocked.status, 409, `a succeeded parent cannot hide a ${status ?? 'missing-status'} continuation`);
      const visible = (await (await request()).json()).data.find(run => run.id === nativeId);
      assert.ok(visible); assert.equal(visible.removable, false);
    }
    continuation.next.status = 'succeeded';
    assert.equal((await request(`/${nativeId}/remove`, 'POST')).status, 200, 'only a terminal continuation permits removal');
    assert.equal((await request('/undo', 'POST')).status, 200);
    first.workflowRecords.pop();
    // A second Remove waits behind a held metadata write. Its native run resumes before that queue advances.
    const resumed = { ...saved, id: nativeId, status: 'completed' }; first.workflowRecords.push(resumed);
    const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const writing = gate(), releaseWrite = gate(), queued = gate();
    const renameBeforeQueue = fs.rename, removeBeforeQueue = first.client.removeWorkflowHistory;
    let holdWrite = true, firstRemoval, queuedRemoval;
    fs.rename = async (source, target) => {
      if (holdWrite && target === path.join(home, 'desktop-workflow-history.json')) { holdWrite = false; writing.resolve(); await releaseWrite.promise; }
      return renameBeforeQueue(source, target);
    };
    first.client.removeWorkflowHistory = function(id, body) {
      const pending = removeBeforeQueue.call(this, id, body);
      if (id === nativeId) queued.resolve();
      return pending;
    };
    try {
      firstRemoval = request(`/${savedId}/remove`, 'POST'); await writing.promise;
      queuedRemoval = request(`/${nativeId}/remove`, 'POST'); await queued.promise;
      // The fixture transport replies in microtasks; drain any eager reads while the first write stays held.
      await new Promise(resolve => setImmediate(resolve));
      resumed.status = 'running'; releaseWrite.resolve();
      assert.equal((await firstRemoval).status, 200);
      assert.equal((await queuedRemoval).status, 409, 'the queued action must read resumed state, not a pre-queue snapshot');
      assert.ok((await (await request()).json()).data.some(run => run.id === nativeId), 'resumed work stays in history');
    } finally {
      releaseWrite.resolve(); fs.rename = renameBeforeQueue; first.client.removeWorkflowHistory = removeBeforeQueue;
      await Promise.allSettled([firstRemoval, queuedRemoval].filter(Boolean));
    }
    assert.equal((await request('/undo', 'POST')).status, 200);
    first.workflowRecords.pop();
    const rename = fs.rename;
    fs.rename = (source, target) => target === path.join(home, 'desktop-workflow-history.json') ? Promise.reject(Object.assign(new Error('Disk full'), { code: 'ENOSPC' })) : rename(source, target);
    try {
      const failed = await request(`/${savedId}/remove`, 'POST');
      assert.equal(failed.status, 503); assert.match((await failed.json()).error, /Nothing was removed/);
    } finally { fs.rename = rename; }
    history = await (await request()).json();
    assert.ok(history.data.some(run => run.id === savedId)); assert.equal(history.canUndo, false);
    assert.equal((await request(`/${savedId}/remove`, 'POST')).status, 200);
    history = await (await request()).json();
    assert.deepEqual(history.data.map(run => run.id), [activeId]); assert.equal(history.canUndo, true);
    // Even an external resume must make a removed record visible again while it works.
    const native = { ...saved, id: nativeId, status: 'completed' }; first.workflowRecords.push(native);
    assert.equal((await request(`/${nativeId}/remove`, 'POST')).status, 200);
    native.status = 'running';
    assert.ok((await (await request()).json()).data.some(run => run.id === nativeId), 'removal cannot conceal resumed work');
    assert.equal((await request('/undo', 'POST')).status, 200);
    first.workflowRecords.pop();
    await app.close(); app = null;
    second = fixture({ clientOptions: { home, workflowOptions: {} } }); await second.client.initialize();
    opened = await open(second.client); app = opened.app; request = opened.request;
    history = await (await request()).json(); assert.deepEqual(history.data, []); assert.equal(history.canUndo, true);
    assert.equal((await request('/undo', 'POST')).status, 200);
    history = await (await request()).json();
    assert.deepEqual(history.data.map(run => run.name), ['Finished team']); assert.equal(history.canUndo, false);
    assert.equal(await fs.readFile(original.file, 'utf8'), original.bytes, 'history removal never rewrites the run');
    assert.equal(await fs.readFile(untouched.file, 'utf8'), untouched.bytes, 'the ambient profile is untouched');
    for (const f of [first, second]) assert.deepEqual(f.socket.sent.filter(row => /thread\/(?:archive|unarchive|delete)|workGraph\/(?:run|stop)|workflowRun\/(?:start|stop|resume)/.test(row.method)), [], 'history actions never mutate chats or execution');
  } finally {
    DesktopClient.connect = connect;
    if (beforeHome === undefined) delete process.env.ELPIS_HOME; else process.env.ELPIS_HOME = beforeHome;
    await app?.close(); first?.client.close(); second?.client.close(); removeTestTempDir(dir);
  }
});

test('manual workflows require an idle root and dispatch the reviewed graph through ACP', async () => {
  const {client,socket,threads}=fixture(); await client.initialize();
  const task={id:'inspect',title:'Inspect',instruction:'Read the evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Report evidence']};
  const draft={rootThreadId:ROOT,name:'Reviewed workflow',maxConcurrency:2,tasks:[task]};
  assert.deepEqual(await client.workflows(ROOT),{data:[]});
  await assert.rejects(client.runWorkflow({...draft,rootThreadId:CHILD}),/root conversation/);
  threads.get(ROOT).status={type:'active'};
  await assert.rejects(client.runWorkflow(draft),/Wait for/);
  threads.get(ROOT).status={type:'idle'};
  await assert.rejects(client.runWorkflow({...draft,approvalPolicy:'never'}),/Unsupported/);
  await assert.rejects(client.runWorkflow({...draft,tasks:[{...task,model:'bad model'}]}),/model ID/);
  assert.equal(socket.sent.some(row=>row.method==='workGraph/run'),false);
  const started=await client.runWorkflow(draft);
  const record=(await client.workflows(ROOT)).data.find(row=>row.id===started.graphId);
  assert.equal(record.name,draft.name); assert.equal(record.tasks[0].instruction,task.instruction);
  assert.equal(socket.sent.some(row=>row.method==='turn/start'),false);
  assert.equal(socket.sent.filter(row=>row.method==='workGraph/run').length,0);
  client.close();
});

test('a task reasoning effort is validated and retained for ACP execution', async () => {
  const {client,socket}=fixture(); await client.initialize();
  const task={id:'inspect',title:'Inspect',instruction:'Read the evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Report evidence']};
  const draft={rootThreadId:ROOT,name:'Effort workflow',tasks:[{...task,reasoningEffort:'high'},{...task,id:'plain',dependsOn:['inspect']}]};
  for(const bad of ['','High','x','high effort','a'.repeat(17),7,null])
    await assert.rejects(client.runWorkflow({...draft,tasks:[{...task,reasoningEffort:bad}]}),/reasoning effort/,JSON.stringify(bad));
  assert.equal(socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
  const started=await client.runWorkflow(draft);
  const record=(await client.workflows(ROOT)).data.find(row=>row.id===started.graphId);
  assert.equal(record.tasks[0].reasoningEffort,'high');
  assert.equal(socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
  client.close();
});

test('worktree isolation is validated and retained by the ACP workflow', async () => {
  const {client,socket}=fixture(); await client.initialize();
  const task={id:'inspect',title:'Inspect',instruction:'Read the evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Report evidence']};
  const draft={rootThreadId:ROOT,name:'Isolated workflow',isolation:'worktree',tasks:[task]};
  for(const bad of ['','Worktree','copy',true,null,{}])
    await assert.rejects(client.runWorkflow({...draft,isolation:bad}),/isolation/,JSON.stringify(bad));
  assert.equal(socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
  const started=await client.runWorkflow(draft);
  assert.equal((await client.workflows(ROOT)).data.find(row=>row.id===started.graphId).isolation,'worktree');
  assert.equal(socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
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
  assert.deepEqual(socket.sent.findLast(row => row.method === 'thread/start').params, { model: 'fixture/custom-model', modelProvider: 'local', approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access', elpisPermissionSource: 'default' }, 'a new chat starts in the default mode, Full access');
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
  assert.deepEqual(socket.sent.filter(message => message.method === 'thread/resume').map(message => message.params).at(-1),
    { threadId: ROOT, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } }, 'an owned chat is read again without overrides');
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

test('an archived chat opens without an error, and writing in it brings it back and sends; no terminal command is named', async () => {
  const { client, socket, threads } = fixture(); await client.initialize(); await client.listThreads();
  await client.archiveThread(ROOT, {});
  const opened = await client.resume(ROOT, {});
  assert.equal(opened.thread.id, ROOT, 'opening an archived chat shows it, read from the engine');
  assert.equal(threads.get(ROOT).archived, true, 'opening it leaves it archived');
  const events = []; client.on('event', event => events.push(event));
  await client.send(ROOT, { text: 'One more thing' });
  assert.equal(threads.get(ROOT).archived, undefined, 'sending brings it back first');
  assert.deepEqual(socket.sent.filter(row => ['thread/unarchive', 'turn/start'].includes(row.method) && row.params.threadId === ROOT).map(row => row.method), ['thread/unarchive', 'turn/start']);
  assert.equal(threads.get(CHILD).archived, undefined, 'its agent comes back with it');
  assert.match(JSON.stringify(socket.sent.filter(row => row.method === 'turn/start').at(-1).params.input), /One more thing/);
  assert.equal((await client.listThreads()).data.some(thread => thread.id === ROOT), true, 'it is in the chat list again');
  socket.emit('message', JSON.stringify({ method: 'thread/unarchived', params: { threadId: ROOT } }));
  assert(events.some(event => event.data?.method === 'thread/unarchived'), 'the window hears that a chat came back');
  threads.get(ROOT).status = { type: 'idle' }; threads.get(ROOT).archived = true;
  const error = await client.setServiceTier(ROOT, { enabled: true }).then(() => null, error => error);
  assert(error, 'a change other than a message still needs the chat back');
  assert.doesNotMatch(error.message, /codex/i); assert.match(error.message, /archived/i);
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
    'missing user input': { start: { data: [], nextCursor: null } },
    'unreadable input part': { start: { data: [{ ...prompt, item: { ...prompt.item, content: ['not a part'] } }], nextCursor: null } },
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

test('replacement resends the edited text with the message\'s attachments and keeps the chat as it was in an archived copy', async t => {
  const prompt = { turnId: 'turn-1', item: { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Original prompt' }] } };
  const image = { type: 'localImage', path: '/tmp/book.png' }, quoted = { type: 'text', text: 'File: note.txt\nBody', textElements: [{ byteRange: { start: 0, end: 5 }, placeholder: 'Attachment: note.txt' }] };
  const variants = {
    'image and file attachments': { start: { data: [{ ...prompt, item: { ...prompt.item, content: [...prompt.item.content, image, quoted] } }], nextCursor: null }, kept: [image, quoted] },
    'a delivered follow-up goes with its turn': { start: { data: [prompt], nextCursor: 'next' }, next: { data: [{ ...prompt, item: { ...prompt.item, id: 'delivered', content: [{ type: 'text', text: 'Follow-up' }] } }], nextCursor: null }, kept: [] },
  };
  for (const [name, { kept, ...replacementPages }] of Object.entries(variants)) await t.test(name, async () => {
    const { client, socket } = fixture({ replacementPages });
    try {
      await client.initialize();
      const result = await client.revert(ROOT, { beforeTurnId: 'turn-1', text: 'Edited prompt' });
      assert.equal(result.turn.id, 'new-turn');
      assert.deepEqual(socket.sent.find(row => row.method === 'turn/start').params.input, [{ type: 'text', text: 'Edited prompt', text_elements: [] }, ...kept]);
      const order = ['thread/fork', 'thread/archive', 'thread/revert', 'turn/start'].map(method => socket.sent.findIndex(row => row.method === method));
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'the copy is kept and archived before anything is replaced');
      assert.equal(socket.sent.find(row => row.method === 'thread/fork').params.beforeTurnId, undefined, 'the copy is the whole chat');
      assert.deepEqual((await client.versions(ROOT, { action: 'list' })).versions, [{ turnId: 'new-turn', index: 2, count: 2, previous: FORK }]);
      assert.deepEqual((await client.versions(FORK, { action: 'list' })).versions, [{ turnId: 'turn-1', index: 1, count: 2, next: ROOT }]);
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

test('delete locks release across sequential, descendant and bulk deletes, but still reject a concurrent mutation of the same chat', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.listThreads();
  f.threads.get(CHILD).status = { type: 'idle' };
  await f.client.send(CHILD, { text: 'Follow up', continueAs: 'Failure reporting (continued)' });
  assert.deepEqual(await f.client.deleteThread(ROOT, {}), { deleted: true, alsoDeleted: [FORK] });
  assert.ok(!f.threads.has(ROOT) && !f.threads.has(CHILD) && !f.threads.has(FORK), 'the root, child and continued fork are gone');

  const ids = [8, 9, 10, 11, 12].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`);
  for (const id of ids) f.threads.set(id, { id, cwd: os.tmpdir(), source: 'cli', status: { type: 'idle' } });
  assert.deepEqual(await f.client.deleteThread(ids[0], {}), { deleted: true, alsoDeleted: [] }, 'the next delete starts after the first released its lock');
  assert.deepEqual(await Promise.all(ids.slice(1, 4).map(id => f.client.deleteThread(id, {}))), ids.slice(1, 4).map(() => ({ deleted: true, alsoDeleted: [] })), 'independent bulk deletes may run together');

  const held = ids[4], send = f.socket.send; let release;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === 'thread/delete' && request.params.threadId === held && !release) {
      f.socket.sent.push(request);
      release = () => { f.threads.delete(held); queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, result: {} }))); };
      return;
    }
    send(raw);
  };
  const deleting = f.client.deleteThread(held, {});
  for (let attempt = 0; !release && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.client.renameThread(held, { name: 'Too soon' }), error => error?.status === 409 && /Another operation/.test(error.message));
  release(); await deleting;
  assert.deepEqual(await f.client.deleteThread(held, {}), { deleted: true, alsoDeleted: [] }, 'a deleted ID holds no stale lock');
});

test('deleting a chat waits for its pending operation and then releases its lock', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.listThreads();
  const id = '00000000-0000-0000-0000-000000000080';
  f.threads.set(id, { id, cwd: os.tmpdir(), source: 'cli', status: { type: 'idle' } });
  const send = f.socket.send; let release;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === 'thread/name/set' && request.params.threadId === id) {
      f.socket.sent.push(request);
      release = () => { f.threads.get(id).name = request.params.name; queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, result: {} }))); };
      return;
    }
    send(raw);
  };
  const renaming = f.client.renameThread(id, { name: 'Renamed' });
  for (let attempt = 0; !release && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release, 'the earlier operation holds the chat lock');
  const deleting = f.client.archiveThread(id, {}).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.socket.sent.some(row => row.method === 'thread/archive' && row.params.threadId === id), false);
  release(); await renaming;
  const result = await deleting;
  assert.ifError(result.error);
  assert.equal(result.value.archived, true);
  assert.equal(f.threads.get(id).archived, true);
  await f.client.unarchiveThread(id, {});
  assert.equal((await f.client.archiveThread(id, {})).archived, true, 'the next deletion also works');
});

test('an annotation waits for a pending chat operation and is sent once', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.initialize(); await f.client.listThreads();
  const send = f.socket.send; let release;
  f.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method === 'thread/name/set' && request.params.threadId === ROOT) {
      f.socket.sent.push(request);
      release = () => { f.threads.get(ROOT).name = request.params.name; queueMicrotask(() => f.socket.emit('message', JSON.stringify({ id: request.id, result: {} }))); };
      return;
    }
    send(raw);
  };
  const rename = f.client.renameThread(ROOT, { name: 'Renamed' });
  for (let attempt = 0; !release && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release, 'the earlier operation holds the chat lock');
  const attachment = { id: 'annotation', name: 'Browser comments.txt', type: 'text', mimeType: 'text/plain', text: 'Make this heading shorter.' };
  const sent = f.client.send(ROOT, { text: '', attachments: [attachment] }).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.socket.sent.filter(row => row.method === 'turn/start').length, 0);
  release(); await rename;
  const result = await sent;
  assert.ifError(result.error);
  assert.ok(result.value.turn.id);
  const turns = f.socket.sent.filter(row => row.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.match(JSON.stringify(turns[0].params.input), /Make this heading shorter/);
  await assert.rejects(f.client.send(ROOT, { text: '', attachments: [{ ...attachment, text: '' }] }), /empty or invalid/);
  assert.equal(f.socket.sent.filter(row => row.method === 'turn/start').length, 1);
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

test('Claude MCP import previews safely, rejects stale and duplicate entries, and writes without reload', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-claude-mcp-'));
  const configPath = path.join(home, 'config.toml');
  await fs.writeFile(configPath, '', { mode: 0o600 });
  const file = path.join(home, '.claude.json');
  const source = { mcpServers: { shadcn: { command: 'npx', args: ['shadcn', 'mcp'], env: { SECRET: 'private-value' } }, rag: { command: 'old' } } };
  await fs.writeFile(file, JSON.stringify(source));
  const { client, socket, configRead } = fixture({ clientOptions: { appHome: home } });
  configRead.layers[0].name.file = configPath;
  await client.initialize();
  const preview = await client.previewClaudeMcp();
  assert.deepEqual(preview.servers.map(row => [row.name, row.status]), [['shadcn','available'],['rag','exists']]);
  assert.doesNotMatch(JSON.stringify(preview), /private-value|npx/);
  await assert.rejects(client.importClaudeMcp({ version: preview.version, revision: preview.revision, names: ['rag'] }), /Unsupported|changed/i);
  const input = { version: preview.version, revision: preview.revision, names: ['shadcn'] };
  await fs.writeFile(file, JSON.stringify({ ...source, changed: true }));
  await assert.rejects(client.importClaudeMcp(input), /changed/);
  await fs.writeFile(file, JSON.stringify(source));
  assert.deepEqual(await client.importClaudeMcp(input), { imported: 1 });
  const writes = socket.sent.filter(row => row.method === 'config/batchWrite');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params.edits, [{keyPath:'mcp_servers.shadcn', value:source.mcpServers.shadcn, mergeStrategy:'replace'}]);
  assert.equal(writes[0].params.reloadUserConfig, false);
  assert.equal(socket.sent.some(row => row.method === 'config/mcpServer/reload'), false);
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
  assert.equal('local' in providers, false, 'loopback addresses are not listed as local servers');
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
  await assert.rejects(client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: 'local', model: 'invalid model' }), { message: 'Choose an OpenRouter model.' });
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
  assert.deepEqual(socket.sent.find(message => message.method === 'thread/start').params, { model: 'remote-model', modelProvider: 'local', approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access', elpisPermissionSource: 'default' });
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

test('the context ledger measures the latest request and reconciles the estimated categories to it, as the TUI ledger does', async () => {
  const { contextLedger } = await import('./elpis-features.mjs');
  const attribution = { userMessages: 1000, agentMessages: 3000, reasoning: 0, toolCalls: 500, toolResults: 27000, systemInstructions: 8000, developerMessages: 1500, toolDefinitions: 9000, outputSchema: 1000, unrecognizedItems: 0, estimatedTotal: 51000 };
  const usage = (last, window, contextAttribution) => ({ total: { totalTokens: 900000 }, last, modelContextWindow: window, contextAttribution });
  const ledger = contextLedger(usage({ inputTokens: 48000, outputTokens: 2000, totalTokens: 50000 }, 200000, attribution));
  assert.equal(ledger.used, 50000, 'measured: the latest request\'s total tokens (tokens_in_context_window), not the cumulative total');
  assert.equal(ledger.window, 200000);
  assert.deepEqual(ledger.categories.map(row => [row.label, row.tokens]), [
    ['User messages', 980], ['Agent messages', 2941], ['Tool calls', 490], ['Tool results', 26471],
    ['System instructions', 7843], ['Developer messages', 1471], ['Tool definitions + schema', 9804],
  ], 'TUI names and order, zero rows dropped, largest-remainder shares that sum to the measured total');
  assert.equal(ledger.categories.reduce((sum, row) => sum + row.tokens, 0), 50000);
  assert.deepEqual(contextLedger(usage({ totalTokens: 50000 }, 200000, null)), { used: 50000, window: 200000, categories: [] }, 'no attribution: measured total only');
  assert.deepEqual(contextLedger(usage({ totalTokens: 7 }, 0, attribution)).window, null, 'a window of zero is capacity unknown');
  assert.deepEqual(contextLedger(usage({ totalTokens: 0 }, 1000, attribution)).categories, [], 'nothing measured, nothing attributed');
  assert.deepEqual(contextLedger(null), { used: null, window: null, categories: [] });

  const { client, socket } = fixture(); await client.initialize();
  assert.deepEqual((await client.context(ROOT)).ledger, { used: null, window: null, categories: [] });
  const emit = (method, params) => socket.emit('message', JSON.stringify({ method, params }));
  emit('thread/tokenUsage/updated', { threadId: ROOT, tokenUsage: usage({ totalTokens: 51000 }, 200000, attribution) });
  // A replay after resume carries no shares; the last known ones stay, scaled to the new measured total.
  emit('thread/tokenUsage/updated', { threadId: ROOT, tokenUsage: usage({ totalTokens: 50000 }, 200000) });
  const result = await client.context(ROOT);
  assert.equal(result.tokenUsage.contextAttribution.toolResults, 27000);
  assert.equal(result.ledger.used, 50000);
  assert.equal(result.ledger.categories.find(row => row.id === 'toolResults').tokens, 26471);
  assert.deepEqual((await client.context(CHILD)).ledger, { used: null, window: null, categories: [] });
  client.close();
});

test('saved replies use the model recorded in each turn context and never guess a missing one', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-turn-models-'));
  const rollout = path.join(temp, 'rollout.jsonl');
  await fs.writeFile(rollout, [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6.1-sol' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'older' } }),
  ].join('\n'));
  const { rolloutTurnModels } = await import('./elpis-features.mjs');
  assert.deepEqual([...await rolloutTurnModels(rollout)], [['t1', 'gpt-6.1-sol']]);
  const { client, threads } = fixture(); await client.initialize(); threads.get(ROOT).path = rollout;
  const page = await client.readThread(ROOT);
  assert.equal(page.data[0].model, 'gpt-6.1-sol');
  client.close();
});

test('an old chat shows the last usage its rollout recorded, plain or compressed, until live events replace it', async () => {
  const { restoredTokenUsage } = await import('./elpis-features.mjs');
  const zlib = await import('node:zlib');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-rollout-usage-'));
  const usage = total => ({ input_tokens: total - 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 7, total_tokens: total });
  const line = payload => JSON.stringify({ timestamp: '2026-10-16T00:00:00Z', type: 'event_msg', payload });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id: ROOT } }),
    line({ type: 'token_count', info: { total_token_usage: usage(30000), last_token_usage: usage(30000), model_context_window: 200000 } }),
    line({ type: 'token_count', info: { total_token_usage: usage(70000), last_token_usage: usage(40000), model_context_window: 200000 }, rate_limits: null }),
    // A large tool result after it, and a rate-limit-only count with no usage, as real rollouts have.
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300000) } }),
    line({ type: 'token_count', info: null, rate_limits: { primary: null } })];
  const plain = path.join(temp, 'rollout-a.jsonl'), packed = path.join(temp, 'rollout-b.jsonl.zst'), empty = path.join(temp, 'rollout-c.jsonl');
  await fs.writeFile(plain, lines.join('\n') + '\n');
  await fs.writeFile(packed, zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n')));
  await fs.writeFile(empty, lines[0] + '\n');
  const expected = { total: { inputTokens: 69900, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 7, totalTokens: 70000 },
    last: { inputTokens: 39900, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 7, totalTokens: 40000 }, modelContextWindow: 200000, contextAttribution: null };
  assert.deepEqual(await restoredTokenUsage(plain), expected, 'the last count that carries usage, read from the end of the file');
  assert.deepEqual(await restoredTokenUsage(packed), expected, 'compressed rollouts are read the same way');
  assert.equal(await restoredTokenUsage(empty), null);
  for (const bad of [null, 'rollout.jsonl', path.join(temp, 'missing.jsonl'), path.join(temp, 'notes.txt')]) assert.equal(await restoredTokenUsage(bad), null, `${bad} is not read`);

  const { client, socket, threads } = fixture(); await client.initialize();
  threads.get(ROOT).path = plain;
  const restored = await client.context(ROOT);
  assert.deepEqual(restored.ledger, { used: 40000, window: 200000, categories: [] }, 'measured numbers as soon as the chat opens; shares wait for the next request, as in the TUI');
  assert.equal(restored.availability.tokenUsage, 'restored');
  assert.equal(socket.sent.some(message => message.method === 'thread/resume'), false, 'reading usage does not resume the chat');
  socket.emit('message', JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: ROOT, tokenUsage: { last: { totalTokens: 41000 }, modelContextWindow: 200000 } } }));
  const live = await client.context(ROOT);
  assert.equal(live.ledger.used, 41000); assert.equal(live.availability.tokenUsage, 'live');
  client.close();
});


test('encrypted reasoning weighs what the model is sent, as the engine counts it (A225, A260)', async () => {
  const { sizedItem } = await import('./elpis-features.mjs');
  const tokens = item => { const [key, bytes] = sizedItem(item); return [key, Math.ceil(bytes / 4)]; };
  const reasoning = length => ({ type: 'reasoning', summary: [], encrypted_content: 'g'.repeat(length) });
  const old = length => Math.ceil(Math.max(0, Math.floor(length * 3 / 4) - 650) / 4);
  // The same values the engine's tests pin (core elpis_context_attribution_tests.rs).
  for (const [length, expected] of [[0, 0], [1287, 0], [1288, 1], [2701, 100], [7287, 425], [142687, 10000]]) assert.deepEqual(tokens(reasoning(length)), ['reasoning', expected], `${length} characters`);
  assert.deepEqual(tokens({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'plain' }] }), ['reasoning', 0], 'no encrypted content weighs nothing');
  for (const type of ['compaction', 'context_compaction']) assert.deepEqual(tokens({ type, encrypted_content: 'g'.repeat(57272) }), ['reasoning', 3960], `a ${type} at the same rate`);
  // His chats: every gpt-6.1-sol response with reasoning, its reported reasoning tokens then each item's encrypted length.
  const measured = JSON.parse(await fs.readFile(new URL('../../../codex-rs/core/src/elpis_reasoning_cost.json', import.meta.url), 'utf8'));
  let reported = 0, estimated = 0, before = 0;
  for (const chat of measured.chats) {
    const sum = rows => rows.reduce((total, value) => total + value, 0);
    const chatReported = sum(chat.map(([count]) => count)), chatEstimated = sum(chat.flatMap(([, ...lengths]) => lengths.map(length => tokens(reasoning(length))[1])));
    if (chat.length >= 20) assert.ok(chatEstimated / chatReported >= 0.95 && chatEstimated / chatReported < 1.2, `a chat at ${(chatEstimated / chatReported).toFixed(3)}`);
    reported += chatReported; estimated += chatEstimated; before += sum(chat.flatMap(([, ...lengths]) => lengths.map(old)));
  }
  assert.equal(reported, 2625861);
  assert.ok(Math.abs(estimated / reported - 1) < 0.03, `all chats at ${(estimated / reported).toFixed(3)}`);
  assert.ok(before / reported > 2.5, 'the decoded-size estimate it replaces counted nearly three times what was sent');
  // Any length: rounded up by less than a token, never more as it shrinks, never above the old estimate and below it wherever it counts anything.
  let seed = 0x5eed1024, last = -1;
  const lengths = [0, 1, 866, 867, 1286, 1287, 1288, 1592, 2701, 2702, ...Array.from({ length: 500 }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 70000)].sort((a, b) => a - b);
  for (const length of lengths) {
    const [, count] = tokens(reasoning(length)), exact = Math.max(0, length - 1287) / 14.14;
    assert.ok(count >= exact - 1e-9 && count < exact + 1, `${length}: ${count}`);
    assert.ok(count >= last, 'longer reasoning never weighs less'); last = count;
    assert.ok(count <= old(length) && (count === 0 || count < old(length)), `${length}: ${count} vs ${old(length)}`);
  }
});

test('an old chat shows category shares estimated from its saved transcript, until the engine sends its own', async () => {
  const { rolloutShares, contextLedger } = await import('./elpis-features.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-rollout-shares-'));
  const record = (type, payload) => JSON.stringify({ timestamp: '2026-10-17T00:00:00Z', type, payload });
  const item = payload => record('response_item', payload);
  const text = (role, kind, body) => item({ type: 'message', role, content: [{ type: kind, text: body }] });
  const count = (total, window = 20000) => record('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: total }, model_context_window: window } });
  // The engine's classifier (core elpis_context_attribution.rs) on bytes ÷ 4, rounded up, per item.
  const lines = [record('session_meta', { id: ROOT, base_instructions: { text: 'S'.repeat(400) } }),
    text('developer', 'input_text', 'D'.repeat(800)), text('user', 'input_text', 'U'.repeat(40)), text('assistant', 'output_text', 'A'.repeat(100)),
    item({ type: 'reasoning', summary: [], encrypted_content: 'E'.repeat(2000) }),
    item({ type: 'function_call', name: 'exec', arguments: 'a'.repeat(87), call_id: 'c1' }),
    item({ type: 'function_call_output', call_id: 'c1', output: 'R'.repeat(3998) }),
    count(2000)];
  const write = async (name, rows) => { const file = path.join(temp, name); await fs.writeFile(file, rows.join('\n') + '\n'); return file; };
  const plain = await write('rollout-a.jsonl', lines);
  const shares = await rolloutShares(plain);
  assert.deepEqual(shares, { systemInstructions: 100, developerMessages: 200, userMessages: 10, agentMessages: 25, reasoning: 51, toolCalls: 25, toolResults: 1000, toolDefinitions: 0, outputSchema: 0, unrecognizedItems: 0 },
    'each item counted as the engine counts it: text bytes ÷ 4, a reasoning blob past its 1,287-character overhead at 14.14 characters a token, a call by name, namespace and arguments');
  const usage = total => ({ last: { totalTokens: total }, modelContextWindow: 20000 });
  const ledger = contextLedger(usage(2000), shares);
  assert.deepEqual(ledger.categories.map(row => [row.label, row.tokens]), [
    ['User messages', 10], ['Agent messages', 25], ['Reasoning + compaction', 51], ['Tool calls', 25], ['Tool results', 1000],
    ['System instructions', 100], ['Developer messages', 200], ['Tool definitions + schema', 589]], 'what the transcript cannot hold (the tool definitions) is the rest of the measured total');
  assert.equal(ledger.basis, 'transcript'); assert.equal(ledger.categories.reduce((sum, row) => sum + row.tokens, 0), 2000);
  const engine = contextLedger({ ...usage(2000), contextAttribution: { userMessages: 5, toolDefinitions: 5, estimatedTotal: 10 } }, shares);
  assert.equal(engine.basis, 'engine', 'the engine\'s own shares win over the transcript'); assert.deepEqual(engine.categories.map(row => row.tokens), [1000, 1000]);
  assert.deepEqual(contextLedger(usage(2000), null), { used: 2000, window: 20000, categories: [] });

  // A transcript that cannot be what the model last saw is not attributed: far more than was measured, a compaction without its
  // replacement history, a rolled-back turn. With the replacement history, only what follows it counts.
  assert.equal(contextLedger(usage(1000), shares).categories.length, 0, 'the transcript is bigger than the measured context (history was shortened): unavailable');
  assert.equal(await rolloutShares(await write('rollout-b.jsonl', [...lines, record('compacted', { message: 'summary' })])), null);
  assert.equal(await rolloutShares(await write('rollout-c.jsonl', [...lines, record('event_msg', { type: 'thread_rolled_back', num_turns: 1 })])), null);
  const compacted = await rolloutShares(await write('rollout-d.jsonl', [...lines, record('compacted', { message: 'summary', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'U'.repeat(80) }] }], window_number: 2 }), text('assistant', 'output_text', 'A'.repeat(40))]));
  assert.deepEqual([compacted.userMessages, compacted.agentMessages, compacted.toolResults, compacted.systemInstructions], [20, 10, 0, 100]);
  for (const bad of [null, 'rollout.jsonl', path.join(temp, 'missing.jsonl'), path.join(temp, 'notes.txt')]) assert.equal(await rolloutShares(bad), null, `${bad} is not read`);

  // Through the bridge: a chat opened from its rollout has its shares at once, marked as estimated; the engine's replace them.
  const { client, socket, threads } = fixture(); await client.initialize();
  threads.get(ROOT).path = plain;
  const opened = await client.context(ROOT);
  assert.equal(opened.ledger.basis, 'transcript'); assert.equal(opened.ledger.used, 2000);
  assert.equal(opened.ledger.categories.find(row => row.id === 'toolResults').tokens, 1000);
  assert.equal(opened.tokenUsage.contextAttribution, null, 'the usage itself still says no shares were reported');
  // The ledger's Compact session, as the terminal's /compact: not while the chat is in the middle of a turn.
  assert.deepEqual(opened.compact, { available: true });
  threads.get(ROOT).status = { type: 'active' };
  assert.deepEqual((await client.context(ROOT)).compact, { available: false, reason: 'Available when Elpis finishes this turn' });
  threads.get(ROOT).status = { type: 'idle' };
  socket.emit('message', JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: ROOT, tokenUsage: { last: { totalTokens: 2000 }, modelContextWindow: 20000, contextAttribution: { userMessages: 1, toolResults: 3, estimatedTotal: 4 } } } }));
  const live = await client.context(ROOT);
  assert.equal(live.ledger.basis, 'engine'); assert.deepEqual(live.ledger.categories.map(row => [row.id, row.tokens]), [['userMessages', 500], ['toolResults', 1500]]);
  client.close();
});

test('the ledger switches write the keys the TUI ledger writes: Smart Prune and Subagents features, and the rag MCP server', async t => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const writes = () => socket.sent.filter(message => message.method === 'config/batchWrite').map(message => message.params);
  assert.deepEqual(await client.contextSwitches(), { version: 'user-version', write: { available: true }, smartPrune: true, subagents: true, rag: true },
    'Subagents is on unless features.multi_agent is false (its default); RAG is the rag server\'s enabled flag');
  await client.saveContextSwitches({ version: 'user-version', subagents: false });
  await client.saveContextSwitches({ version: 'user-version', smartPrune: false });
  assert.deepEqual(writes(), [
    { edits: [{ keyPath: 'features.multi_agent', value: false, mergeStrategy: 'replace' }], expectedVersion: 'user-version', reloadUserConfig: true },
    { edits: [{ keyPath: 'features.automatic_context_pruning', value: false, mergeStrategy: 'replace' }], expectedVersion: 'user-version', reloadUserConfig: true },
  ], 'one key per switch, reloaded so open chats use it from their next turn');
  assert.equal(socket.sent.some(message => message.method === 'config/mcpServer/reload'), false);
  await client.saveContextSwitches({ version: 'user-version', rag: false });
  assert.deepEqual(writes().at(-1).edits, [{ keyPath: 'mcp_servers.rag.enabled', value: false, mergeStrategy: 'replace' }]);
  assert.equal(socket.sent.some(message => message.method === 'config/mcpServer/reload'), true, 'MCP servers reload after the RAG switch');
  configRead.config.features.multi_agent = false; configRead.config.mcp_servers.rag.enabled = false;
  assert.deepEqual(await client.contextSwitches(), { version: 'user-version', write: { available: true }, smartPrune: true, subagents: false, rag: false });
  await assert.rejects(client.saveContextSwitches({ version: 'old-version', rag: true }), error => error.status === 409);
  await assert.rejects(client.saveContextSwitches({ version: 'user-version', rag: 'yes' }), /on or off/);
  await assert.rejects(client.saveContextSwitches({ version: 'user-version', memories: true }), /Unsupported request fields/);
  await assert.rejects(client.saveContextSwitches({ version: 'user-version' }), /No switch/);
  delete configRead.config.mcp_servers.rag;
  assert.equal((await client.contextSwitches()).rag, null, 'no rag server configured: no RAG switch to flip');
  await assert.rejects(client.saveContextSwitches({ version: 'user-version', rag: true }), error => error.status === 409);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-desktop-test-')); const out = path.join(temp, 'out'); await fs.mkdir(out); await fs.writeFile(path.join(out, 'index.html'), '<h1>Elpis</h1>');
  const app = await startDesktopServer({ client, staticDir: out }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const request = (method, data, headers = {}) => fetch(origin + '/api/context/switches', { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await request('GET')).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await request('GET', null, { Cookie: cookie })).json()).subagents, false);
  const saved = await request('POST', { version: 'user-version', subagents: true }, { Cookie: cookie });
  assert.equal(saved.status, 200); assert.deepEqual(writes().at(-1).edits, [{ keyPath: 'features.multi_agent', value: true, mergeStrategy: 'replace' }]);
  client.close();
});


test('the main model is saved where the TUI reads it: model and model_provider in config.toml', async () => {
  const {client,socket}=fixture(); await client.initialize();
  await client.saveSettings({version:'user-version',main:{model:'gpt-6-luna',provider:'openai'}});
  assert.deepEqual(socket.sent.find(row=>row.method==='config/batchWrite').params.edits, [
    {keyPath:'model',value:'gpt-6-luna',mergeStrategy:'replace'},
    {keyPath:'model_provider',value:'openai',mergeStrategy:'replace'},
  ]);
  await assert.rejects(client.saveSettings({version:'user-version',main:{model:null}}),/Choose a main model/);
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
  await assert.rejects(client.saveSettings({version:'user-version',main:{provider:'unknown'}}),/configured provider/);
  await assert.rejects(client.saveSettings({version:'user-version',main:{effort:'high'}}),/Unsupported/);
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
  assert.deepEqual(settings.options, { reasoningEffort: null, defaultPermissions: 'custom', webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: 'fast', developerInstructions: 'Be brief.', projectRootMarkers: ['.git', '.hg'], worktreeRoot: '/work/trees' });
  assert.equal(settings.memory.enabled, true); assert.equal(settings.memory.skipExternalContext, true);
  await client.saveSettings({ version: 'user-version', options: { webSearch: null, developerInstructions: '  ', projectRootMarkers: [' .git ', 'package.json'], worktreeRoot: '/tmp/trees' }, memory: { enabled: false, skipExternalContext: false } });
  assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params, { expectedVersion: 'user-version', reloadUserConfig: false, edits: [
    { keyPath: 'features.memories', value: false, mergeStrategy: 'replace' },
    { keyPath: 'memories.disable_on_external_context', value: false, mergeStrategy: 'replace' },
    { keyPath: 'web_search', value: null, mergeStrategy: 'replace' },
    { keyPath: 'developer_instructions', value: null, mergeStrategy: 'replace' },
    { keyPath: 'project_root_markers', value: ['.git', 'package.json'], mergeStrategy: 'replace' },
    { keyPath: 'desktop.git-worktree-root', value: '/tmp/trees', mergeStrategy: 'replace' },
  ] });
  const writes = () => socket.sent.filter(row => row.method === 'config/batchWrite').length;
  const before = writes();
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { model: 'other' } }), /Unsupported setting/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: 'everything' } }), /listed values/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { worktreeRoot: 'relative/trees' } }), /absolute folder/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { projectRootMarkers: ['../up'] } }), /without slashes/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { projectRootMarkers: [] } }), /one to sixteen/);
  requirementsRead.requirements = { allowedSandboxModes: ['read-only'] };
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: 'full' } }), error => error.status === 403 && /managed/.test(error.message));
  requirementsRead.requirements = { allowedPermissionProfiles: { ':workspace': true } };
  assert.deepEqual((await client.settings()).managed.allowedPermissionProfiles, { ':workspace': true });
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: 'full' } }), error => error.status === 403 && /managed/.test(error.message));
  requirementsRead.requirements = { allowedApprovalsReviewers: ['user'] };
  assert.deepEqual((await client.settings()).managed.allowedApprovalsReviewers, ['user']);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: 'auto' } }), error => error.status === 403 && /managed/.test(error.message));
  assert.equal(writes(), before, 'refused options write nothing');
  client.close();
});

test('a chat started without a mode gets the default one explicitly, so the engine fallback (asking) never decides it', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const started = async (body = {}) => { await client.createThread(body); const { approvalPolicy, approvalsReviewer, permissions } = socket.sent.findLast(row => row.method === 'thread/start').params; return { approvalPolicy, approvalsReviewer, permissions }; };
  Object.assign(configRead.config, { default_permissions: ':danger-full-access' });
  assert.deepEqual(await started(), { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
  assert.deepEqual(await started({ cwd: '/tmp/project' }), { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
  assert.equal(socket.sent.findLast(row => row.method === 'config/read').params.cwd, '/tmp/project', 'the project folder\'s own config layers count');
  configRead.config.approval_policy = 'on-request'; configRead.config.default_permissions = ':workspace';
  assert.deepEqual(await started(), { approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace' });
  assert.deepEqual(await started({ permissions: 'bypass' }), { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':bypass-permissions' }, 'a chosen mode wins');
  configRead.config.default_permissions = ':read-only';
  assert.deepEqual(await started(), { approvalPolicy: undefined, approvalsReviewer: undefined, permissions: undefined }, 'a custom config is left to the engine');
  client.close();
});

test('default permissions: Full access when the config names no approval policy; each preset saves approval, reviewer and sandbox together', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  const user = configRead.layers[0];
  const mode = async () => (await client.settings()).options.defaultPermissions;
  const save = async defaultPermissions => { await client.saveSettings({ version: 'user-version', options: { defaultPermissions } }); return socket.sent.findLast(row => row.method === 'config/batchWrite').params.edits; };
  // As Masih's config: a full-access profile and no approval policy. The engine alone would ask (on-request).
  Object.assign(configRead.config, { default_permissions: ':danger-full-access', approvals_reviewer: 'user' }); user.config.default_permissions = ':danger-full-access';
  assert.equal(await mode(), 'full');
  configRead.config.default_permissions = user.config.default_permissions = ':workspace';
  assert.equal(await mode(), 'full', 'no approval policy is the Elpis default, Full access');
  configRead.config.approval_policy = 'on-request';
  assert.equal(await mode(), 'ask');
  configRead.config.approvals_reviewer = 'auto_review';
  assert.equal(await mode(), 'auto');
  Object.assign(configRead.config, { approval_policy: 'never', default_permissions: ':danger-full-access' });
  assert.equal(await mode(), 'full');
  configRead.config.default_permissions = ':bypass-permissions';
  assert.equal(await mode(), 'custom', 'Bypass is per chat, never a Settings preset');
  configRead.config.default_permissions = ':read-only';
  assert.equal(await mode(), 'custom');
  const preset = (approval, reviewer, key, sandbox) => [{ keyPath: 'approval_policy', value: approval, mergeStrategy: 'replace' }, { keyPath: 'approvals_reviewer', value: reviewer, mergeStrategy: 'replace' }, { keyPath: key, value: sandbox, mergeStrategy: 'replace' }];
  assert.deepEqual(await save('full'), preset('never', 'user', 'default_permissions', ':danger-full-access'));
  assert.deepEqual(await save('ask'), preset('on-request', 'user', 'default_permissions', ':workspace'));
  assert.deepEqual(await save('auto'), preset('on-request', 'auto_review', 'default_permissions', ':workspace'));
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: 'bypass' } }), /listed values/);
  await assert.rejects(client.saveSettings({ version: 'user-version', options: { defaultPermissions: null } }), /listed values/);
  // A config without profiles keeps the legacy key.
  delete configRead.config.default_permissions; delete user.config.default_permissions; Object.assign(configRead.config, { sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'user' }); user.config.sandbox_mode = 'workspace-write';
  assert.equal(await mode(), 'ask');
  assert.deepEqual(await save('full'), preset('never', 'user', 'sandbox_mode', 'danger-full-access'));
  client.close();
});

// Antigravity's usage vanished ("Usage not reported") after being shown: a model list that timed out read as "no
// subscription models", so the app took the subscriptions for signed out and dropped their usage. Unknown is not signed out.
test('a model list that cannot be read leaves the subscriptions unknown, not signed out', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const fail = message => { socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32000, message } }))); };
    if (request.method === 'model/list') return fail('model/list timed out');
    // The subscriptions' limits were slower than the bridge waits, so only ChatGPT's came back.
    if (request.method === 'account/rateLimits/read') { socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { rateLimits: { limitId: 'codex', primary: null }, rateLimitsByLimitId: {} } }))); return; }
    return send(raw);
  };
  const providers = await client.providers();
  assert.deepEqual([providers.claude.state, providers.gemini.state], ['unknown', 'unknown']);
  assert.deepEqual([providers.claude.usage, providers.gemini.usage], [[], []]);
  socket.send = send;
  // A list that was read and offers no Antigravity model does mean it is not connected.
  const { providersSnapshot } = await import('./elpis-features.mjs');
  assert.equal(providersSnapshot({ account: null, limits: {}, config: {}, models: [], anthropic: null }).gemini.state, 'notConnected');
  // Elpis's own Anthropic sign-out stays a sign-out whatever the list says.
  assert.equal(providersSnapshot({ account: null, limits: {}, config: {}, models: null, anthropic: { signedOut: true } }).claude.state, 'notConnected');
  client.close();
});

test('internal gateway routes are neither local servers nor editable custom providers', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  // How config/read reports a provider the engine routes through its own gateway (here, the Anthropic credits).
  configRead.config.model_providers['anthropic-credits'] = { name: 'Anthropic promotional credits', base_url: 'http://127.0.0.1:44103/v1', wire_api: 'responses', requires_openai_auth: false,
    http_headers: { 'x-elpis-gateway-token': 'GATEWAY SECRET', 'x-elpis-provider': 'anthropic-credits', 'x-elpis-wire': 'anthropic_messages', 'x-elpis-upstream': 'https://api.anthropic.com/v1' } };
  const providers = await client.providers();
  assert.equal('local' in providers, false);
  assert.doesNotMatch(JSON.stringify(providers), /anthropic-credits|44103/);
  const settings = await client.providerSettings();
  const credits = settings.providers.find(provider => provider.id === 'anthropic-credits');
  assert.equal(credits.gateway, true); assert.equal(credits.editable, false); assert.equal(credits.auth.acceptsKey, false);
  assert.equal(settings.providers.find(provider => provider.id === 'openrouter').gateway, false);
  assert.doesNotMatch(JSON.stringify(settings), /GATEWAY SECRET/);
  await assert.rejects(client.saveProvider({ version: 'user-version', id: 'anthropic-credits', name: 'Changed', baseUrl: 'https://api.anthropic.com/v1', credential: { action: 'preserve' } }), error => error.status === 403);
  assert.equal(socket.sent.filter(row => row.method === 'config/batchWrite').length, 0, 'an internal route is never rewritten');
  // Its models come from the gateway's own list, so a chat can start on one of them.
  await client.createThread({ provider: 'anthropic-credits', model: 'claude-sonnet-5-5' });
  const start = socket.sent.findLast(row => row.method === 'thread/start').params;
  assert.deepEqual([start.model, start.modelProvider], ['claude-sonnet-5-5', 'anthropic-credits']);
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

test('pruning effort round trips through the shared pruner RPC and Default clears it', async t => {
  const { client, socket, configRead } = fixture({ prunerSupported: true });
  t.after(() => client.close());
  await client.initialize();
  const choice = { model: 'gpt-6-luna', provider: 'openai' };
  const saved = await client.savePruner({ version: 'pruner-v1', ...choice, reasoningEffort: 'max' });
  assert.deepEqual(socket.sent.find(row => row.method === 'pruner/write').params,
    { expectedVersion: 'pruner-v1', ...choice, reasoningEffort: 'max' });
  assert.equal(saved.smartPrune.explicitOverride.reasoningEffort, 'max');
  assert.equal((await client.settings()).smartPrune.explicitOverride.reasoningEffort, 'max');
  const cleared = await client.savePruner({ version: 'pruner-v2', ...choice, reasoningEffort: null });
  assert.equal(cleared.smartPrune.explicitOverride.reasoningEffort, null);
  assert.equal(socket.sent.filter(row => row.method === 'pruner/write').at(-1).params.reasoningEffort, null);
  assert.equal(configRead.config.model, MODEL);
  assert.equal(socket.sent.some(row => row.method === 'config/batchWrite'), false);
});

test('pruning effort stays unset when omitted and rejects malformed efforts before writing', async t => {
  const { client, socket } = fixture({ prunerSupported: true });
  t.after(() => client.close());
  await client.initialize();
  const choice = { version: 'pruner-v1', model: 'gpt-6-luna', provider: 'openai' };
  assert.equal((await client.settings()).smartPrune.explicitOverride.reasoningEffort, null);
  for (const reasoningEffort of ['', 'Max', 'high effort', 'a'.repeat(17), 7, {}, false]) {
    await assert.rejects(client.savePruner({ ...choice, reasoningEffort }), /reasoning effort/);
  }
  assert.equal(socket.sent.some(row => row.method === 'pruner/write'), false);
  const saved = await client.savePruner(choice);
  assert.equal(saved.smartPrune.explicitOverride.reasoningEffort, null);
  assert.equal(Object.hasOwn(socket.sent.find(row => row.method === 'pruner/write').params, 'reasoningEffort'), false);
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
    // Each mode is a named profile: the engine restores a profile id after a restart, not a bare sandbox.
    assert.deepEqual([full.approvalPolicy, full.approvalsReviewer, full.permissions, 'sandboxPolicy' in full], ['never', 'user', ':danger-full-access', false]);
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'again', permissions: 'auto' });
    const auto = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual([auto.approvalPolicy, auto.approvalsReviewer, auto.permissions, 'sandboxPolicy' in auto], ['on-request', 'auto_review', ':workspace', false]);
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'plain' });
    const plain = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.equal('approvalPolicy' in plain || 'sandboxPolicy' in plain, false, 'no mode chosen leaves the chat as configured');
    await assert.rejects(client.send(ROOT, { text: 'x', permissions: 'root' }), /permission mode/);
    await client.createThread({ permissions: 'ask' });
    const started = socket.sent.findLast(message => message.method === 'thread/start').params;
    assert.deepEqual([started.approvalPolicy, started.approvalsReviewer, started.permissions, 'sandbox' in started], ['on-request', 'user', ':workspace', false]);
  } finally { client.close(); }
});

test('an agent chat can keep its own permission choice without forking or changing its parent', async () => {
  const { client, engineSettings, socket } = fixture(); await client.initialize();
  try {
    const parent = structuredClone(engineSettings.get(ROOT));
    assert.equal((await client.setPermissions(CHILD, { permissions: 'full' })).permissions, 'full');
    assert.equal(engineSettings.get(CHILD).approvalPolicy, 'never');
    assert.deepEqual(engineSettings.get(ROOT), parent);
    assert.equal(socket.sent.some(row => row.method === 'thread/fork'), false);
  } finally { client.close(); }
});

test('a running chat the list already follows still reports its mode, Plan and effort when opened', async () => {
  const { client, threads, engineSettings } = fixture(); await client.initialize();
  try {
    Object.assign(threads.get(ROOT), { status: { type: 'active' }, collaborationMode: { mode: 'plan' } });
    engineSettings.set(ROOT, { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: 'xhigh' });
    await client.listThreads({});
    await new Promise(resolve => setTimeout(resolve, 10)); // the list follows the running chat in the background
    const opened = await client.resume(ROOT, {});
    assert.equal(opened.permissions, 'full');
    assert.equal(opened.planMode, true);
    assert.equal(opened.thread.reasoningEffort, 'xhigh');
    assert.equal(opened.activeTurnId, 'running-turn');
    // A chat left as configured reports Ask for approval, not Full access.
    delete threads.get(ROOT).collaborationMode;
    engineSettings.set(ROOT, { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' }, activePermissionProfile: null, reasoningEffort: null });
    const again = await client.resume(ROOT, {});
    assert.equal(again.permissions, 'ask');
    assert.equal(again.planMode, false);
  } finally { client.close(); }
});

test('bypass permissions selects the engine profile, never a sandbox, and resume reports it', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  try {
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'go', permissions: 'bypass' });
    const turn = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual([turn.approvalPolicy, turn.approvalsReviewer, turn.permissions], ['never', 'user', ':bypass-permissions']);
    assert.equal('sandboxPolicy' in turn, false, 'the engine rejects a profile combined with a sandbox');
    await client.createThread({ permissions: 'bypass' });
    const started = socket.sent.findLast(message => message.method === 'thread/start').params;
    assert.deepEqual([started.approvalPolicy, started.approvalsReviewer, started.permissions], ['never', 'user', ':bypass-permissions']);
    assert.equal('sandbox' in started, false);
    // Leaving bypass for Full access selects the full-access profile, which replaces the bypass profile.
    threads.get(ROOT).status = { type: 'idle' };
    await client.send(ROOT, { text: 'calmer', permissions: 'full' });
    const full = socket.sent.findLast(message => message.method === 'turn/start').params;
    assert.deepEqual([full.permissions, 'sandboxPolicy' in full], [':danger-full-access', false]);

  } finally { client.close(); }
  // A chat reopens in the mode the engine reports; only the bypass profile reads as bypass.
  const reopened = async reported => {
    const { client, socket, threads } = fixture(); await client.initialize();
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method !== 'thread/resume') return send(raw);
      socket.sent.push(request);
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result: { thread: structuredClone(threads.get(request.params.threadId)), model: MODEL, initialTurnsPage: { data: [] }, ...reported } })));
    };
    try { return (await client.resume(ROOT, {})).permissions; } finally { client.close(); }
  };
  const unsandboxed = { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: { id: ':bypass-permissions' } }), 'bypass');
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: { id: ':danger-full-access' } }), 'full');
  assert.equal(await reopened({ ...unsandboxed, activePermissionProfile: null }), 'full');
  assert.equal(await reopened({ ...unsandboxed, approvalPolicy: 'on-request', activePermissionProfile: { id: ':bypass-permissions' } }), 'ask', 'bypass needs approvals set to never');
});

test('a chat can change folders during a turn through native settings for later turns', async () => {
  const { client, socket, threads } = fixture(); await client.initialize();
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-move-')));
  const nextDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-move-next-')));
  try {
    assert.deepEqual(await client.setFolder(ROOT, { cwd: dir }), { cwd: dir });
    assert.deepEqual(socket.sent.findLast(message => message.method === 'thread/settings/update').params, { threadId: ROOT, cwd: dir });
    assert.equal(threads.get(ROOT).cwd, dir, 'the engine holds the new folder');
    for (const cwd of ['relative/folder', path.join(dir, 'missing'), 42]) await assert.rejects(client.setFolder(ROOT, { cwd }), /folder/i);
    threads.get(ROOT).status = { type: 'active' };
    const updates = socket.sent.filter(message => message.method === 'thread/settings/update').length;
    assert.deepEqual(await client.setFolder(ROOT, { cwd: nextDir }), { cwd: nextDir });
    assert.equal(threads.get(ROOT).status.type, 'active', 'the running turn stays active');
    assert.equal(threads.get(ROOT).cwd, nextDir, 'the engine saves the new folder for later turns');
    assert.equal(socket.sent.filter(message => message.method === 'thread/settings/update').length, updates + 1);
    assert.deepEqual(socket.sent.findLast(message => message.method === 'thread/settings/update').params, { threadId: ROOT, cwd: nextDir });
  } finally {
    client.close(); await fs.rm(dir, { recursive: true, force: true }); await fs.rm(nextDir, { recursive: true, force: true });
  }
});

test('changing a chat\'s permissions applies now through the engine settings and reads the mode back', async () => {
  const { client, socket, threads, engineSettings } = fixture(); await client.initialize();
  const events = []; client.on('event', event => events.push(event));
  try {
    // Native and bridged (Claude) chats alike, idle or running: the change is a settings update, not a queued turn field.
    threads.get(ROOT).status = { type: 'active' };
    const BRIDGED = '00000000-0000-0000-0000-000000000009';
    threads.set(BRIDGED, { id: BRIDGED, name: 'Claude chat', source: 'cli', model: 'claude/opus', modelProvider: 'openai', status: { type: 'idle' } });
    for (const id of [ROOT, BRIDGED]) {
      assert.deepEqual(await client.setPermissions(id, { permissions: 'full' }), { permissions: 'full' });
      const update = socket.sent.findLast(message => message.method === 'thread/settings/update').params;
      assert.deepEqual(update, { threadId: id, approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access', elpisPermissionSource: 'chat' });
      assert.equal(engineSettings.get(id).approvalPolicy, 'never', 'the engine holds the new mode');
      assert.equal(socket.sent.some(message => message.method === 'turn/start'), false, 'nothing waits for the next turn');
    }
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: 'auto' }), { permissions: 'auto' });
    assert.deepEqual(engineSettings.get(ROOT).approvalsReviewer, 'auto_review');
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: 'bypass' }), { permissions: 'bypass' });
    assert.deepEqual(socket.sent.findLast(message => message.method === 'thread/settings/update').params,
      { threadId: ROOT, approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':bypass-permissions', elpisPermissionSource: 'chat' });
    // The app hears the applied mode from the engine's notification.
    assert.equal(events.filter(event => event.data?.method === 'thread/settings/updated').at(-1).data.params.permissions, 'bypass');
    // Choosing the mode a chat already has changes nothing, so no notification comes; the mode is read back instead.
    assert.deepEqual(await client.setPermissions(ROOT, { permissions: 'bypass' }), { permissions: 'bypass' });
    // A refusal is reported, not assumed applied.
    await assert.rejects(client.setPermissions(ROOT, { permissions: 'root' }), /permission mode/);
  } finally { client.close(); }
});

test('Full access and Bypass also answer what the chat was already asking; questions and Approve for me still wait', async () => {
  const { client, socket } = fixture(); await client.initialize(); await client.createThread({});
  const ask = (id, method, params, thread = CREATED) => socket.emit('message', JSON.stringify({ id, method, params: { threadId: thread, turnId: 'turn1', ...params } }));
  const answered = id => socket.sent.find(message => message.id === id && 'result' in message)?.result;
  const waiting = () => client.pendingApprovals.map(approval => approval.method).sort();
  try {
    ask('command', 'item/commandExecution/requestApproval', { command: 'npm test', availableDecisions: ['accept', 'decline'] });
    ask('file', 'item/fileChange/requestApproval', {});
    ask('tool', 'mcpServer/elicitation/request', { serverName: 'rag', mode: 'form', message: 'Run query_knowledge_base?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' } });
    ask('form', 'mcpServer/elicitation/request', { serverName: 'survey', mode: 'form', message: 'Details', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } });
    ask('question', 'item/tool/requestUserInput', { questions: [{ id: 'q', header: 'Pick', question: 'Which?' }] });
    assert.equal(client.pendingApprovals.length, 5);
    // "Approve for me" hands later requests to the reviewer; a request already put to the person stays theirs.
    await client.setPermissions(CREATED, { permissions: 'auto' });
    assert.equal(client.pendingApprovals.length, 5);
    await client.setPermissions(CREATED, { permissions: 'full' });
    assert.deepEqual(answered('command'), { decision: 'accept' });
    assert.deepEqual(answered('file'), { decision: 'accept' });
    assert.deepEqual(answered('tool'), { action: 'accept', content: null, _meta: null });
    assert.deepEqual(waiting(), ['item/tool/requestUserInput', 'mcpServer/elicitation/request'], 'a form and a question are answers, not permissions');
    // Bypass grants a waiting permission request for its turn.
    await client.setPermissions(CREATED, { permissions: 'ask' });
    const network = { network: { enabled: true }, fileSystem: null };
    ask('grant', 'item/permissions/requestApproval', { permissions: network, reason: 'fetch' });
    await client.setPermissions(CREATED, { permissions: 'bypass' });
    assert.deepEqual(answered('grant'), { permissions: { network: { enabled: true } }, scope: 'turn' });
  } finally { client.close(); }
});

test('a permission change the engine refuses is shown as an error', async () => {
  const { client, socket } = fixture(); await client.initialize();
  try {
    const send = socket.send;
    socket.send = raw => {
      const request = JSON.parse(raw);
      if (request.method === 'thread/settings/update') {
        socket.sent.push(request);
        queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'invalid thread settings override: Configured value for `permission_profile` is disallowed by requirements' } })));
        return;
      }
      return send(raw);
    };
    await assert.rejects(client.setPermissions(ROOT, { permissions: 'bypass' }), /disallowed by requirements/);
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

test('the agents a work graph may use follow Elpis: 256 in a graph, and at once its agent threads, never over 32', async () => {
  const { settingsSnapshot } = await import('./elpis-features.mjs');
  const allowed = config => settingsSnapshot({ config, layers: [] }, { requirements: {} }).agents;
  assert.deepEqual(allowed({}), { graph: 256, atOnce: 6, source: 'Elpis default' });
  assert.deepEqual(allowed({ agents: { max_threads: 3 } }), { graph: 256, atOnce: 3, source: 'agents.max_threads' });
  assert.equal(allowed({ agents: { max_threads: 50 } }).atOnce, 32);
  // Multi-agent v2 counts the chat itself among its threads per session (4 by default).
  assert.equal(allowed({ features: { multi_agent_v2: true } }).atOnce, 3);
  assert.equal(allowed({ features: { multi_agent_v2: { max_concurrent_threads_per_session: 9 } } }).atOnce, 8);
  assert.equal(allowed({ features: { multi_agent_v2: true }, agents: { max_concurrent_threads_per_session: 5 } }).atOnce, 5);
  assert.equal(allowed({ features: { multi_agent_v2: false }, agents: { max_threads: 2 } }).atOnce, 2);
});

test('an operation Elpis does not support (-32601) shows its message, not only the code', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/read') return answer(raw);
    socket.sent.push(request);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32601, message: 'thread/read is not supported yet' } })));
  };
  try {
    const error = await client.readThread(ROOT, {}).then(() => null, failure => failure);
    assert.equal(error?.code, -32601);
    assert.match(error.message, /thread\/read is not supported yet/);
    assert.doesNotMatch(error.message, /rejected the operation/);
  } finally { client.close(); }
});

/** As the engine answers for a chat it keeps only as whole turns (older history, or a new chat before its first
 * message is recorded): no item pages (-32601), as the TUI's LegacyOnly history expects; thread/read has the turns. */
function wholeTurnHistory(socket, turns) {
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const reply = body => { socket.sent.push(request); queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...body }))); };
    if (request.method === 'thread/items/list') return reply({ error: { code: -32601, message: 'thread/items/list is not supported yet' } });
    if (request.method === 'thread/read' && request.params.includeTurns) return reply(turns
      ? { result: { thread: { id: request.params.threadId, name: 'Existing root', status: { type: 'idle' }, turns } } }
      : { error: { code: -32600, message: `thread ${request.params.threadId} is not materialized yet; includeTurns is unavailable before first user message` } });
    return answer(raw);
  };
}

test('-32601 mid-conversation: a chat without item pages opens from its turns, a page at a time', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const user = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] });
  const agent = (id, text) => ({ type: 'agentMessage', id, text });
  wholeTurnHistory(socket, [{ id: 't1', status: 'completed', items: [user('u1', 'first'), agent('a1', 'one')] },
    { id: 't2', status: 'completed', items: [user('u2', 'second'), agent('a2', 'two')] }]);
  try {
    const first = await client.readThread(ROOT, { limit: 3 });
    assert.equal(first.thread.id, ROOT);
    // Newest first, as thread/items/list's descending pages are.
    assert.deepEqual(first.data.map(entry => [entry.turnId, entry.item.id]), [['t2', 'a2'], ['t2', 'u2'], ['t1', 'a1']]);
    assert.equal(typeof first.nextCursor, 'string');
    const asked = socket.sent.filter(message => message.method === 'thread/items/list').length;
    const rest = await client.readThread(ROOT, { cursor: first.nextCursor, limit: 3 });
    assert.deepEqual(rest.data.map(entry => entry.item.id), ['u1']);
    assert.equal(rest.nextCursor, null);
    assert.equal(socket.sent.filter(message => message.method === 'thread/items/list').length, asked, 'its own cursor goes straight to the turns');
    // A recorded message of such a chat is found the same way.
    await assert.rejects(client.media(ROOT, 't1', 'u1', 0), /No local media recorded here/);
    await assert.rejects(client.readThread(ROOT, { cursor: 'whole-turns:-1' }), /cursor/i);
  } finally { client.close(); }
});

test('-32601 mid-conversation: a new chat before its first message is recorded opens empty', async () => {
  const { client, socket } = fixture(); await client.initialize();
  wholeTurnHistory(socket, null);
  try {
    const opened = await client.readThread(ROOT, {});
    assert.equal(opened.thread.id, ROOT);
    assert.deepEqual(opened.data, []);
    assert.equal(opened.nextCursor, null);
  } finally { client.close(); }
});

// Live check, 28 Oct: an imported Claude Code chat showed "<EXTERNAL SESSION IMPORTED>" as its reply. The engine's
// importer ends the last turn with that marker as an agent message, after the chat's real last reply.
test('an imported Claude Code chat ends on its own last reply, not the engine import marker', async () => {
  const MARKER = '<EXTERNAL SESSION IMPORTED>';
  const user = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text, text_elements: [] }] });
  const agent = (id, text) => ({ type: 'agentMessage', id, text });
  const turns = [{ id: 't1', status: 'completed', items: [user('u1', 'hello import'), agent('a1', 'hi from claude code'), agent('marker', MARKER)] },
    { id: 't2', status: 'completed', items: [user('u2', `What does ${MARKER} mean?`), agent('a2', `${MARKER} is the engine's import note.`)] }];
  const pages = fixture(); await pages.client.initialize();
  const answer = pages.socket.send;
  pages.socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/items/list') return answer(raw);
    pages.socket.sent.push(request);
    const data = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse();
    queueMicrotask(() => pages.socket.emit('message', JSON.stringify({ id: request.id, result: { data, nextCursor: null } })));
  };
  const whole = fixture(); await whole.client.initialize();
  wholeTurnHistory(whole.socket, turns);
  try {
    for (const { client } of [pages, whole]) {
      assert.deepEqual((await client.readThread(ROOT, {})).data.map(entry => entry.item.id), ['a2', 'u2', 'a1', 'u1'], 'the marker is dropped; a message that only quotes it stays');
      assert.deepEqual((await client.readPrompts(ROOT)).data.map(row => row.reply), ['hi from claude code', `${MARKER} is the engine's import note.`]);
    }
  } finally { pages.client.close(); whole.client.close(); }
});

test('other failures to read a chat are still reported', async () => {
  const { client, socket } = fixture(); await client.initialize();
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== 'thread/items/list') return answer(raw);
    socket.sent.push(request);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32603, message: 'failed to list thread items: disk' } })));
  };
  try {
    await assert.rejects(client.readThread(ROOT, {}), error => error.code === -32603);
    assert.equal(socket.sent.some(message => message.method === 'thread/read' && message.params.includeTurns), false);
  } finally { client.close(); }
});

test('dictation reads the ChatGPT sign-in, the Elpis home and the Gemini key privately, and only trusts Google for the key', async () => {
  const { client, configRead } = fixture(); await client.initialize();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-dictation-'));
  const variable = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    configRead.layers[0].name.file = path.join(root, 'config.toml');
    assert.deepEqual(await client.transcriptionEnvironment(), { chatgpt: false, home: root, geminiKey: null }, 'signed in, but no sign-in file in the home (a keyring store): the ChatGPT route cannot work');
    await fs.writeFile(path.join(root, 'auth.json'), '{}'); // a placeholder: only its existence is checked, never its contents
    assert.deepEqual(await client.transcriptionEnvironment(), { chatgpt: true, home: root, geminiKey: null });
    process.env.GEMINI_API_KEY = '  gm-env-key  ';
    assert.equal((await client.transcriptionEnvironment()).geminiKey, 'gm-env-key');
    await client.saveProviderKey({ provider: 'google-gemini', key: 'gm-saved-key' });
    assert.equal((await client.transcriptionEnvironment()).geminiKey, 'gm-saved-key', 'a key saved in the Elpis home stands before the variable, as in the engine');
    configRead.config.model_providers['google-gemini'] = { name: 'Proxy', base_url: 'https://proxy.example/v1beta', env_key: 'GEMINI_API_KEY', wire_api: 'gemini_generate_content' };
    assert.equal((await client.transcriptionEnvironment()).geminiKey, null, 'a Google Gemini connection pointed elsewhere never receives the key');
  } finally { if (variable === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = variable; client.close(); }
});

test('Voice can return the fallback engine to Automatic, which is no explicit backend at all', async () => {
  const { client, socket, configRead } = fixture(); await client.initialize();
  try {
    await client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: null, model: null });
    assert.deepEqual(socket.sent.findLast(row => row.method === 'config/batchWrite').params.edits, [
      { keyPath: 'mcp_servers.whispertype.env.WHISPERTYPE_BACKEND', value: null, mergeStrategy: 'replace' },
      { keyPath: 'mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL', value: null, mergeStrategy: 'replace' }]);
    delete configRead.config.mcp_servers.whispertype.env.WHISPERTYPE_BACKEND;
    assert.deepEqual((await client.mcp()).servers.find(server => server.name === 'whispertype').whispertype, { backend: null, model: 'openai/gpt-4o-mini-transcribe' });
    await assert.rejects(client.saveMcp({ version: 'user-version', action: 'whispertype', name: 'whispertype', backend: 'auto' }), /OpenRouter, Codex sign-in or local/);
  } finally { client.close(); }
});

test('A101 archived view sorts all pages by actual archive date and keeps why each was archived', async t => {
  const { client, threads } = fixture();
  threads.set(FORK, { id: FORK, source: 'cli', cwd: os.tmpdir(), name: 'Other task', status: { type: 'idle' } }); await client.initialize();
  t.after(() => client.close());
  await client.archiveThread(ROOT, {});
  await client.archiveThread(FORK, {});
  const result = await client.listArchivedThreads({ limit: 1 });
  assert.equal(result.data[0].id, FORK);
  assert.equal(result.data[0].archiveReason, 'Archived by you.');
  assert.ok(result.data[0].archivedAt > 0);
  const second = await client.listArchivedThreads({ limit: 1, cursor: result.nextCursor });
  assert.equal(second.data[0].id, ROOT);
  assert.equal(second.data[0].archiveReason, 'Archived by you.');
});


test('A101 archive order spans native pages, survives restart, and keeps pagination stable after restore', async t => {
  const archiveDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'a101-archive-pages-'));
  const h = fixture({ archiveDirectory, threadListPaging: true }); await h.client.initialize();
  t.after(() => h.client.close());
  h.threads.clear();
  for (let i = 0; i < 105; i++) {
    const id = `00000000-0000-0000-0000-${(i + 100).toString(16).padStart(12, '0')}`;
    h.threads.set(id, { id, name: `Task ${i}`, archived: true, source: 'cli', status: { type: 'notLoaded' } });
    await fs.writeFile(path.join(archiveDirectory, `${id}.json`), JSON.stringify({ archivedAt: 1000 + i, archiveReason: `Reason ${i}` }));
  }
  const first = await h.client.listArchivedThreads({ limit: 100 });
  assert.equal(first.data[0].name, 'Task 104'); assert.equal(first.data.at(-1).name, 'Task 5');
  await h.client.unarchiveThread(first.data.at(-1).id, {});
  const last = await h.client.listArchivedThreads({ limit: 100, cursor: first.nextCursor });
  assert.deepEqual(last.data.map(row => row.name), ['Task 4', 'Task 3', 'Task 2', 'Task 1', 'Task 0']);
  assert.equal(last.nextCursor, null);
  const cold = fixture({ archiveDirectory, threadListPaging: true }); await cold.client.initialize(); t.after(() => cold.client.close());
  cold.threads.clear(); for (const [id, row] of h.threads) cold.threads.set(id, structuredClone(row));
  const reloaded = await cold.client.listArchivedThreads({ limit: 1 });
  assert.equal(reloaded.data[0].archiveReason, 'Reason 104');
  await assert.rejects(cold.client.listArchivedThreads({ cursor: 'broken' }), /Invalid archive page cursor/);
  cold.threads.clear(); assert.deepEqual(await cold.client.listArchivedThreads({}), { data: [], nextCursor: null });
});

test('Claude MCP preview hides values and retains supported transports for selected import', () => {
  const raw = JSON.stringify({mcpServers:{shadcn:{command:'npx',args:['shadcn@latest','mcp'],env:{SECRET:'private-value'}},remote:{type:'http',url:'https://example.test/mcp',headers:{Authorization:'private-header'}},bad:{type:'sse',url:'https://example.test'},existing:{command:'x'}}});
  const parsed = parseClaudeMcp(raw, ['existing']);
  assert.deepEqual(parsed.preview.map(({name,transport,status}) => [name,transport,status]), [['shadcn','stdio','available'],['remote','http','available'],['bad','unsupported','unsupported'],['existing','stdio','exists']]);
  assert.doesNotMatch(JSON.stringify(parsed.preview), /private-value|private-header|example\.test|npx/);
  assert.deepEqual(parsed.definitions.shadcn, {command:'npx',args:['shadcn@latest','mcp'],env:{SECRET:'private-value'}});
  assert.deepEqual(parsed.definitions.remote, {url:'https://example.test/mcp',http_headers:{Authorization:'private-header'}});
  assert.equal(parsed.definitions.existing, undefined);
});

test('malformed definitions and unsupported fields cannot be silently imported', () => {
  const parsed = parseClaudeMcp(JSON.stringify({mcpServers:{bad:{command:'x',env:{SECRET:3}},extra:{command:'x',unexpected:'x'},wrong:{type:'http',url:'file:///tmp/x'}}}), []);
  assert.ok(parsed.preview.every(row => row.status === 'unsupported'));
  assert.deepEqual(Object.keys(parsed.definitions), []);
  assert.throws(() => parseClaudeMcp('{', []), /Could not read/);
});
