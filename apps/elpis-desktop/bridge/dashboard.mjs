// Desktop transports the TUI's dashboard, without another renderer or audit-file projection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, elpisHome, object, threadId } from './client.mjs';
import { DASHBOARD_ASSETS, DASHBOARD_SUBSCRIPTIONS } from './dashboard-assets.mjs';

export { DASHBOARD_ASSETS } from './dashboard-assets.mjs';
const PREFIX = '/api/dashboard/';
const ASSETS = new URL('./resources/dashboard/', import.meta.url);
const SOURCE = new URL('../../../codex-rs/tui/src/dashboard_assets/', import.meta.url);
const totals = value => value ? {
  input: value.inputTokens ?? 0, cached_input: value.cachedInputTokens ?? 0,
  cache_write: value.cacheWriteInputTokens ?? null, output: value.outputTokens ?? 0,
  reasoning_output: value.reasoningOutputTokens ?? 0, total: value.totalTokens ?? 0,
} : null;
const snake = value => value.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
const counts = (value, names) => Object.fromEntries(names.map(name => [snake(name), value?.[name] ?? 0]));
const pruneCounts = ['examinedOutputs', 'admittedOutputs', 'unchangedOutputs', 'failedBatches', 'approxSourceTokens', 'approxAdmittedTokens', 'approxSavedTokens', 'optimizerRequests', 'optimizerUsageReports', 'optimizerLatencyMs'];
const colors = { userMessages: '#6fb5fd', agentMessages: '#039b2c', reasoning: '#03dae5', toolCalls: '#a2810b', toolResults: '#fcb24f', systemInstructions: '#f0445d', developerMessages: '#ef8cff', toolDefinitions: '#919191', unrecognizedItems: '#a6fc18' };

function pruneState(prune, settings) {
  const latest = prune?.latest, attempt = prune?.latestAttempt;
  return {
    configured_enabled: settings.smartPrune.enabled ?? false,
    current_thread_next_turn_enabled: prune?.enabled ?? false,
    ...counts(prune, pruneCounts), optimizer_usage: totals(prune?.optimizerUsage) ?? totals({}),
    latest: latest ? { ...counts(latest, pruneCounts.slice(0, 2).concat(pruneCounts.slice(4, 7))),
      request_linkage_verified: latest.requestLinkageVerified, response_linkage_verified: latest.responseLinkageVerified,
      response_usage: totals(latest.responseUsage) } : null,
    latest_attempt: attempt ? { ...counts(attempt, ['candidateOutputs', 'admittedOutputs', 'approxSavedTokens', 'latencyMs']),
      status: attempt.status, failure_reason: attempt.failureReason, model: attempt.modelSlug,
      reasoning_effort: attempt.reasoningEffort, usage: totals(attempt.usage) } : null,
  };
}

/** Convert native app-server facts to the dashboard_server.rs wire format; never estimate missing telemetry. */
export function dashboardState(input, settings, limits, activity) {
  const { thread, context, sources, smartPrune } = input;
  const ledger = context.ledger, usage = context.tokenUsage;
  const categories = ledger.basis === 'engine' ? ledger.categories.map(row => ({ label: row.label, tokens: row.tokens, color: colors[row.id] })) : null;
  const model = thread.model ?? settings.main.model ?? 'Unavailable';
  const provider = DASHBOARD_SUBSCRIPTIONS.find(row => model.startsWith(row.prefix))?.id ?? thread.modelProvider ?? settings.main.provider;
  const choice = value => ({ model: value?.model ?? null, provider: value?.model ? value.provider ?? provider : null });
  return {
    schema_version: 1, revision: 1, generated_at: Date.now(),
    context: { model, used_tokens: ledger.used, window_tokens: ledger.window,
      used_percent: ledger.used !== null && ledger.window ? Math.round(ledger.used * 100 / ledger.window) : null,
      attributed_tokens: categories?.reduce((sum, row) => sum + row.tokens, 0) ?? null,
      categories, saved_tokens: smartPrune?.approxSavedTokens ?? 0,
      sources: sources?.map(row => ({ name: row.name, category: row.group, estimated_tokens: row.estimatedTokens, admitted: row.included })) ?? null,
      backtrack_points: null,
      models: { chat: { model, provider }, background: choice(settings.background), pruner: choice(settings.smartPrune.explicitOverride) },
    },
    tokens: { session_total: totals(usage?.total), last_turn: totals(usage?.last) },
    activity: activity ?? { current: null, recent: [] }, smart_prune: pruneState(smartPrune, settings), limits,
  };
}

function limitRows(providers) {
  return [...(providers.openai?.usage ?? []), ...(providers.claude?.usage ?? []), ...(providers.gemini?.usage ?? [])].flatMap(limit =>
    ['primary', 'secondary'].flatMap((key, index) => limit[key] ? [{ label: `${limit.limitName ?? limit.limitId ?? 'Usage'} ${limit[key].windowDurationMins ?? (index ? 'Weekly' : 'Current')}${limit[key].windowDurationMins ? ' min' : ''}`,
      used_percent: Math.round(limit[key].usedPercent), resets_at: limit[key].resetsAt ? new Date(limit[key].resetsAt * 1000).toLocaleString() : null }] : []));
}

export function createDashboard({ client, home = elpisHome() }) {
  const sessions = new Map(), activity = new Map(), evidence = new Map(), states = new Map();
  let agentRead;
  const observe = event => {
    if (event.type !== 'message') return;
    const { method, params } = event.data;
    if (method === 'thread/deleted') { activity.delete(params.threadId); agentRead = null; return; }
    if (!['turn/started', 'turn/activityUpdated', 'turn/costUpdated'].includes(method)) return;
    const state = activity.get(params.threadId) ?? { current: null, recent: [] };
    if (method === 'turn/started') state.current = { id: params.turn.id, status: 'running', started_at: params.turn.startedAt ? params.turn.startedAt * 1000 : null, cost: null };
    else {
      const row = state.current?.id === params.turnId ? state.current : state.recent.find(row => row.id === params.turnId);
      if (method === 'turn/costUpdated') {
        if (row) row.cost = { type: 'unavailable', reason: snake(params.cost.reason) };
      } else {
        state.recent = [{ ...row, id: params.turnId, status: params.status, duration_ms: params.durationMs, time_to_first_token_ms: params.timeToFirstTokenMs, cost: row?.cost ?? null }, ...state.recent.filter(row => row.id !== params.turnId)].slice(0, 20);
        if (state.current?.id === params.turnId) state.current = null;
      }
    }
    activity.set(params.threadId, state);
  };
  client.on('event', observe);
  async function agents() {
    if (agentRead && Date.now() - agentRead.at < 2000) return agentRead.value;
    const value = (async () => {
      const rows = []; let cursor;
      do {
        const page = await client.observabilityChats({ cursor, limit: 100 });
        rows.push(...page.data); cursor = page.nextCursor;
        if (rows.length > 10000) throw new BridgeError('Too many conversations to display', 413);
      } while (cursor);
      return rows;
    })();
    agentRead = { at: Date.now(), value };
    value.catch(() => { agentRead = null; });
    return value;
  }
  async function selected(url) {
    const id = url.searchParams.get('thread');
    if (id) return threadId(id);
    return (await agents()).find(row => !row.parentThreadId)?.id ?? null;
  }
  async function inputFor(url) {
    const id = await selected(url);
    return id ? client.dashboardInputs(id) : null;
  }
  async function register(label, file) {
    if (typeof file !== 'string') return null;
    const root = await fs.realpath(home), relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    let checked = root;
    for (const part of relative.split(path.sep)) { checked = path.join(checked, part); if ((await fs.lstat(checked)).isSymbolicLink()) return null; }
    for (const [id, row] of evidence) if (row.file === file) return { label, url: id };
    const handle = await fs.open(file, 'r');
    if (!(await handle.stat()).isFile()) { await handle.close(); return null; }
    // Keep the opened inode, as dashboard_evidence.rs does, rather than reopening a replaceable path.
    if (process.platform === 'linux' && await fs.readlink(`/proc/self/fd/${handle.fd}`) !== file) { await handle.close(); return null; }
    const id = randomUUID().replaceAll('-', ''); evidence.set(id, { handle, file });
    if (evidence.size > 128) { const first = evidence.keys().next().value; await evidence.get(first).handle.close(); evidence.delete(first); }
    return { label, url: id };
  }
  return {
    async open(url) {
      const token = randomUUID().replaceAll('-', '');
      const id = await selected(url); sessions.set(token, id);
      if (sessions.size > 128) sessions.delete(sessions.keys().next().value);
      return { url: `${PREFIX}${id ? `?thread=${encodeURIComponent(id)}` : ''}#evidence=${token}` };
    },
    async route(request, response, url, json, body) {
      const resource = url.pathname.slice(PREFIX.length), method = request.method;
      if (resource === '' || DASHBOARD_ASSETS.includes(resource)) {
        if (method !== 'GET') throw new BridgeError('Method is not allowed', 405);
        const name = resource || 'index.html';
        const bytes = await fs.readFile(new URL(name, ASSETS)).catch(error => { if (error.code !== 'ENOENT') throw error; return fs.readFile(new URL(name, SOURCE)); });
        const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(bytes); return;
      }
      if (resource === 'data.json' && method === 'GET') {
        const input = await inputFor(url);
        if (!input) return json(response, 200, { state: null, heartbeat_at: Date.now() });
        const [settings, providers] = await Promise.all([client.settings(), client.providers()]);
        let state = dashboardState(input, settings, limitRows(providers), activity.get(input.thread.id));
        const key = JSON.stringify({ ...state, revision: 0, generated_at: 0 });
        const previous = states.get(input.thread.id);
        if (previous?.key === key) state = previous.state;
        else { state.revision = (previous?.state.revision ?? 0) + 1; states.set(input.thread.id, { key, state }); }
        return json(response, 200, { state, heartbeat_at: Date.now() });
      }
      if (resource === 'agents.json' && method === 'GET') return json(response, 200, { agents: (await agents()).map(row => {
        const status = row.status?.type, state = status === 'active' ? row.status.activeFlags?.includes('waitingOnApproval') || row.status.activeFlags?.includes('waitingOnUserInput') ? 'needs_you' : 'working' : status === 'idle' ? 'ready' : 'inactive';
        return { id: row.id, parent_id: row.parentThreadId ?? null, title: row.name || row.workflowTaskTitle || row.agentNickname || row.preview || 'Untitled conversation', model: row.model ?? null, color: null, status: state, status_label: { needs_you: 'Needs you', working: 'Working', ready: 'Ready', inactive: 'Inactive' }[state] };
      }) });
      const [kind, token, argument, extra] = resource.split('/');
      if (!sessions.has(token)) throw new BridgeError('Open the dashboard again from Observability', 403);
      if (extra || !['threads', 'models', 'provider-keys', 'pruner-settings', 'evidence'].includes(kind)) throw new BridgeError('Unknown dashboard operation', 404);
      if (kind === 'threads' && argument && method === 'GET') {
        threadId(argument);
        if (!(await agents()).some(row => row.id === argument)) throw new BridgeError('Conversation is no longer available', 404);
        const limit = Number(url.searchParams.get('limit') ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError('Limit must be 1 through 100');
        const page = await client.readThread(argument, { limit, ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) });
        const { id, name, preview, model, modelProvider, parentThreadId, agentNickname, status } = page.thread;
        return json(response, 200, { ...page, thread: { id, name, preview, model, modelProvider, parentThreadId, agentNickname, status } });
      }
      if (kind === 'models') {
        if (method === 'POST' && !argument) {
          const result = await client.dashboardModel(sessions.get(token), await body(request));
          if (result.threadId) sessions.set(token, result.threadId);
          return json(response, 200, result);
        }
        if (method === 'GET' && argument) return json(response, 200, { models: (await client.dashboardModels(decodeURIComponent(argument))).map(row => ({ id: row.model, name: row.displayName })) });
        if (method === 'GET') return json(response, 200, { providers: await client.dashboardProviders() });
      }
      if (kind === 'provider-keys' && !argument) {
        let settings;
        if (method === 'POST') { const edit = object(await body(request), ['provider', 'api_key']); settings = await client.saveProviderKey({ provider: edit.provider, key: edit.api_key }); }
        else settings = await client.providerSettings();
        return json(response, 200, { providers: settings.providers.filter(row => row.auth.acceptsKey).map(row => ({ id: row.id, name: row.name, env_var: row.auth.envKey, masked: row.auth.keySet ? '••••••••' : null, source: row.auth.source })) });
      }
      if (kind === 'pruner-settings' && !argument) {
        const result = await client.dashboardPruner(method === 'POST' ? await body(request, 131072) : undefined);
        if (!result.defaultSystemPrompt) throw new BridgeError('Update Elpis to edit Smart Prune instructions', 503);
        return json(response, 200, { settings: { system_prompt: result.systemPrompt }, default_system_prompt: result.defaultSystemPrompt });
      }
      if (kind === 'evidence' && method === 'GET') {
        if (argument === 'index.json') {
          const input = await inputFor(url), rows = [];
          const record = async (label, file) => { try { const entry = await register(label, file); if (entry) rows.push({ ...entry, url: `${PREFIX}evidence/${token}/${entry.url}` }); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
          if (input) {
            await record('Rollout', input.rolloutPath);
            const attempt = input.smartPrune?.latestAttempt?.auditPath;
            if (/^smart-prune\/attempts\/[^/]+\.json$/.test(attempt ?? '')) await record('Smart Prune attempt', path.join(home, 'logs', attempt));
            const admission = input.smartPrune?.latest?.auditPath;
            if (/^smart-prune\/admissions\/[^/]+$/.test(admission ?? '')) {
              await record('Smart Prune admission', path.join(home, 'logs', admission, 'manifest.json'));
              await record('Optimizer conversation', path.join(home, 'logs', admission, 'ace.json'));
            }
          }
          return json(response, 200, rows);
        }
        const row = evidence.get(argument);
        if (!row) throw new BridgeError('Evidence is no longer available', 404);
        const size = (await row.handle.stat()).size;
        if (size > 32 * 1024 * 1024) throw new BridgeError('Evidence exceeds 32 MiB', 413);
        const bytes = Buffer.alloc(size), { bytesRead } = await row.handle.read(bytes, 0, size, 0);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(bytes.subarray(0, bytesRead)); return;
      }
      throw new BridgeError('Unknown dashboard operation', 404);
    },
    async close() { client.off('event', observe); await Promise.all([...evidence.values()].map(row => row.handle.close())); },
  };
}
