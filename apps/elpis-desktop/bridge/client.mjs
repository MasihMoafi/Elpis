import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ragMessage } from './rag-command.mjs';
import { providerSettingsSnapshot, providerEdits, privateConfigFile } from './provider-settings.mjs';
import { settingsSnapshot, tokenUsageSnapshot, smartPruneSnapshot, providersSnapshot, mcpSnapshot } from './elpis-features.mjs';
import { replacementEligibility } from '../lib/turn-replacement.ts';
import { providerModels } from './provider-models.mjs';
import { attachmentInput, recordedMedia } from './attachments.mjs';
import { scanDeletionThreads } from '../lib/thread-deletion.ts';
const string = value => typeof value === 'string' ? value : null;

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new BridgeError('Unsupported request fields');
  }
  return value;
}
export function text(value, label, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BridgeError(`Invalid ${label}`);
  return value;
}
export function threadId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new BridgeError('Invalid thread ID');
  return value;
}

// Mirrors shared-runtime.mjs's path derivation, but never creates directories or starts a runtime.
export function existingSocket(explicit, env = process.env) {
  const provided = explicit || env.ELPIS_APP_BRIDGE_SOCKET || env.ELPIS_BRIDGE_SOCKET;
  let candidates;
  if (provided) candidates = [provided.replace(/^unix:\/\//, '')];
  else {
    let home = path.resolve(env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'));
    try { home = fs.realpathSync(home); } catch {}
    const key = createHash('sha256').update(home).digest('hex').slice(0, 16);
    candidates = [env.XDG_RUNTIME_DIR && path.join(env.XDG_RUNTIME_DIR, 'elpis-bridge', key, 'bridge.sock'),
      path.join(os.tmpdir(), `elpis-bridge-${process.getuid?.()}`, key, 'bridge.sock')].filter(Boolean);
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new BridgeError('Bridge socket must be an absolute Unix socket path');
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { continue; }
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new BridgeError('Bridge socket must be private and owned by the current user', 403);
    }
    return candidate;
  }
  throw new BridgeError('No running Elpis bridge found. Start Elpis, or set ELPIS_APP_BRIDGE_SOCKET to its existing Unix socket.', 503);
}

const NOTIFICATIONS = new Set([
  'thread/tokenUsage/updated', 'thread/smartPrune/updated',
  'thread/started', 'thread/status/changed', 'thread/name/updated', 'thread/settings/updated',
  'thread/closed', 'thread/archived', 'thread/deleted', 'turn/started', 'turn/completed',
  'turn/aborted', 'turn/diff/updated', 'turn/plan/updated', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta', 'error', 'serverRequest/resolved',
]);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput']);
// Account changes have no thread; every app window may show them.
const LISTED = new Set(['thread/started', 'thread/status/changed', 'thread/name/updated']);
const ACCOUNT_NOTIFICATIONS = new Set(['account/updated', 'account/login/completed', 'account/rateLimits/updated']);
// Native refusals the person can act on (a fork still referencing a chat, a busy agent) are shown as Elpis wrote them.
const READ_RPCS = new Set(['initialize','thread/list','thread/read','thread/items/list','thread/turns/list','model/list','account/read','account/rateLimits/read','config/read','configRequirements/read','pruner/read','workGraph/list']);
const readRpc = (method, params) => READ_RPCS.has(method) || (method === 'thread/resume' && Object.keys(params || {}).every(key => ['threadId','excludeTurns','initialTurnsPage'].includes(key)));
const EXPLAINED = new Set(['account/read', 'account/rateLimits/read', 'thread/delete', 'thread/fork', 'thread/start', 'thread/resume', 'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/revert', 'turn/start', 'turn/interrupt', 'config/batchWrite', 'account/login/start', 'account/logout']);
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];
const EFFORT = /^[a-z]{2,16}$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class DesktopClient extends EventEmitter {
  #socket; #pending = new Map(); #owned = new Set(); #known = new Set(); #models = new Set();
  #approvals = new Map(); #mutating = new Set(); #closed = false; #ready = false; #attaching = new Map();
  #context = new Map();
  #workflowTitles = new Map(); #workflowLookups = new Map();
  #checkingApprovals = new Map();
  #disposed = false; #reconnecting = false; #retryTimer; #openSocket; #retryDelay; #retryAttempt = 0;
  constructor(socket, { timeoutMs = 30000, openSocket, reconnectDelayMs = 500 } = {}) {
    super(); this.#socket = socket; this.timeoutMs = timeoutMs;
    this.#openSocket = openSocket; this.#retryDelay = reconnectDelayMs;
    this.#bind(socket);
  }
  #bind(socket) {
    socket.on('message', data => { if (socket === this.#socket) this.#receive(data); });
    socket.on('close', (code, reason) => { if (socket === this.#socket) { if (!this.#closed && typeof code === 'number' && code !== 1000) console.warn('Elpis runtime socket closed', code, String(reason || '').slice(0, 200)); this.#disconnect(); } });
    socket.on('error', error => { if (socket === this.#socket) { if (!this.#closed) console.warn('Elpis runtime socket error', error?.code || '', String(error?.message || '').slice(0, 200)); this.#disconnect(); } });
  }
  static async connect(options = {}) {
    const { default: WebSocket } = await import('ws');
    const openSocket = async () => {
      await options.beforeConnect?.();
      const socketPath = existingSocket(options.socketPath);
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 8 * 1024 * 1024 });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new BridgeError('Bridge connection timed out', 504)); }, 10000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new BridgeError('Could not connect to the existing Elpis bridge', 503)); });
      });
      return socket;
    };
    const client = new DesktopClient(await openSocket(), { ...options, openSocket });
    try { await client.initialize(); } catch (error) { client.close(); throw error; }
    return client;
  }
  async initialize() {
    await this.#rpc('initialize', { clientInfo: { name: 'elpis-desktop', title: 'Elpis', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.#socket.send(JSON.stringify({ method: 'initialized', params: {} })); this.#ready = true;
  }
  get connected() { return this.#ready && !this.#closed; }
  get pendingApprovals() { return [...this.#approvals.values()].map(({ wireId, ...visible }) => visible); }
  #disconnect() {
    if (this.#closed) return;
    this.#closed = true; this.#ready = false;
    this.#socket.terminate?.();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError(pending.reading ? 'Elpis connection closed while reading. Reload the view after reconnecting.' : 'Elpis connection closed; the request outcome is unknown. Check the conversation before retrying.', 503)); }
    this.#pending.clear(); this.#approvals.clear(); this.#checkingApprovals.clear();
    this.#owned.clear(); this.#attaching.clear(); this.#context.clear(); this.#models.clear();
    this.emit('event', { type: 'connection', data: { connected: false } });
    this.#scheduleReconnect();
  }
  #scheduleReconnect() {
    if (this.#disposed || !this.#openSocket || this.#retryTimer || this.#reconnecting) return;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; void this.#reconnect(); }, Math.min(5000, this.#retryDelay * 2 ** Math.min(this.#retryAttempt++, 4)));
    this.#retryTimer.unref?.();
  }
  async #reconnect() {
    if (this.#disposed) return;
    this.#reconnecting = true;
    try {
      const socket = await this.#openSocket();
      if (this.#disposed) { socket.close(); return; }
      this.#socket = socket; this.#closed = false; this.#bind(socket);
      await this.initialize();
      if (!this.connected) return;
      this.#retryAttempt = 0;
      this.emit('event', { type: 'connection', data: { connected: true } });
    } catch {
      this.#disconnect();
    } finally {
      this.#reconnecting = false;
      if (this.#closed) this.#scheduleReconnect();
    }
  }
  close() { this.#disposed = true; clearTimeout(this.#retryTimer); this.#disconnect(); this.#socket.close(); }
  #rpc(method, params) {
    if (this.#closed) return Promise.reject(new BridgeError('Elpis is disconnected', 503));
    const id = `desktop-${randomUUID()}`, reading = readRpc(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); reject(new BridgeError(reading ? 'Elpis timed out while reading. Reload the view to try again.' : 'Elpis request timed out; its outcome is unknown. Refresh before retrying.', 504));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method, reading });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.#pending.delete(id); reject(new BridgeError('Could not send request to Elpis', 503)); }
    });
  }
  #receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(message.id);
      if (message.error) {
        const conflict = message.error.data?.config_write_error_code === 'configVersionConflict' || message.error.data?.reason === 'staleVersion';
        const workflow = pending.method === 'workGraph/run' || pending.method === 'workGraph/runWithProviders';
        const unsupported = workflow && /unknown (method|variant)/i.test(message.error.message ?? '');
        const detail = (workflow || EXPLAINED.has(pending.method)) && typeof message.error.message === 'string' ? message.error.message.slice(0,1000) : `Elpis rejected the operation (${message.error.code ?? 'unknown'}). No automatic retry was made.`;
        const error = new BridgeError(conflict ? 'Settings changed in another client. Reload settings before saving again.' : unsupported ? 'Update and restart Elpis to run workflows from this app.' : detail, conflict || message.error.data?.reason === 'threadBusy' ? 409 : unsupported ? 503 : workflow ? 400 : 502);
        error.code = message.error.code;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    const id = message.params?.threadId ?? message.params?.thread?.id;
    if (message.id !== undefined) {
      if (this.#owned.has(id)) this.#admitApproval(message, {ownerThreadId:id});
      else if (!this.#checkingApprovals.has(message.id)) {
        const check = {};
        this.#checkingApprovals.set(message.id, check);
        void this.#approvalOwner(id).then(owner => {
          if (this.#checkingApprovals.get(message.id) !== check) return;
          this.#checkingApprovals.delete(message.id);
          if (owner && this.#owned.has(owner.ownerThreadId) && !this.#closed) this.#admitApproval(message, owner);
        }).catch(() => {
          if (this.#checkingApprovals.get(message.id) === check) this.#checkingApprovals.delete(message.id);
          // Without verified ancestry this may belong to another client's work.
        });
      }
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      this.#checkingApprovals.delete(message.params?.requestId);
      for (const [key, pending] of this.#approvals) if (pending.wireId === message.params?.requestId) {
        this.#approvals.delete(key);
        this.emit('event', {type:'approvalResolved',data:{id:key}});
      }
    }
    if (ACCOUNT_NOTIFICATIONS.has(message.method)) { this.emit('event', { type: 'account', data: { method: message.method } }); return; }
    // Chat-level news (a chat started, renamed, or changed state) is listed anyway; item streams stay scoped.
    const tracked = this.#known.has(id) || this.#owned.has(id) || LISTED.has(message.method);
    if (message.method === 'thread/deleted' && tracked) this.#forget(id);
    if (NOTIFICATIONS.has(message.method) && tracked) {
      if (message.method === 'thread/tokenUsage/updated' || message.method === 'thread/smartPrune/updated') {
        const key = message.method === 'thread/tokenUsage/updated' ? 'tokenUsage' : 'smartPrune';
        const value = key === 'tokenUsage' ? tokenUsageSnapshot(message.params?.[key]) : smartPruneSnapshot(message.params?.[key]);
        this.#context.set(id, { ...this.#context.get(id), [key]: value });
        this.emit('event', { type: 'message', data: { method: message.method, params: { threadId: id, [key]: value } } });
        return;
      }
      this.emit('event', { type: 'message', data: { method: message.method, params: message.params } });
    }
  }
  async #approvalOwner(id) {
    const seen = new Set();
    let current = id, requester;
    while (current && !seen.has(current) && seen.size < 256) {
      threadId(current);
      if (this.#owned.has(current)) return {ownerThreadId:current,...(requester ? {thread:requester} : {})};
      seen.add(current);
      const {thread} = await this.#rpc('thread/read', {threadId:current,includeTurns:false});
      if (thread?.id !== current) return null;
      const decorated = this.#decorate(thread);
      if (current === id) requester = decorated;
      current = thread.parentThreadId;
    }
    return null;
  }
  #admitApproval(message, owner) {
    if ([...this.#approvals.values()].some(pending => pending.wireId === message.id)) return;
    if (!APPROVALS.has(message.method)) {
      this.#socket.send(JSON.stringify({id:message.id,error:{code:-32601,message:'This desktop client does not support this approval type'}}));
      this.emit('event', {type:'unsupportedApproval',data:{method:message.method,threadId:message.params?.threadId}});
      return;
    }
    const approval = {id:randomUUID(),wireId:message.id,method:message.method,params:message.params,supported:true,...owner};
    this.#approvals.set(approval.id,approval);
    const {wireId,...visible} = approval;
    this.emit('event',{type:'approval',data:visible});
  }
  async #loadWorkflowTitles(threads) {
    const candidates = threads.flatMap(thread => {
      const source = thread.source?.subAgent?.other;
      const match = typeof source === 'string' && /^work_graph:([0-9a-f-]{36}):(.+)$/.exec(source);
      if (!match || this.#workflowTitles.has(thread.id)) return [];
      return [{thread,source,graphId:match[1],taskId:match[2],rootThreadId:thread.parentThreadId}];
    });
    // Native thread/list can omit the parent of Other(work_graph) workers even
    // while thread/read reports it. Recover only recognised workers, then verify
    // the graph's assigned thread before projecting a title or parent.
    const validParent = row => { try { return threadId(row.rootThreadId) !== row.thread.id; } catch { return false; } };
    const missing = candidates.filter(row => !validParent(row)).slice(0,16);
    await Promise.all(missing.map(async row => {
      const read = await this.#rpc('thread/read',{threadId:row.thread.id,includeTurns:false}).catch(()=>null);
      if (read?.thread?.id === row.thread.id && read.thread.source?.subAgent?.other === row.source) row.rootThreadId=read.thread.parentThreadId;
    }));
    const linked = candidates.filter(validParent);
    // Cap distinct parents for a large list page; verified metadata is reused.
    await Promise.all([...new Set(linked.map(row=>row.rootThreadId))].slice(0,16).map(async rootThreadId => {
      let lookup = this.#workflowLookups.get(rootThreadId);
      if (!lookup) {
        lookup = this.#rpc('workGraph/list',{rootThreadId}).catch(()=>null).finally(()=>this.#workflowLookups.delete(rootThreadId));
        this.#workflowLookups.set(rootThreadId,lookup);
      }
      const result = await lookup;
      for (const row of linked.filter(row=>row.rootThreadId===rootThreadId)) {
        const graph = result?.data?.find(graph=>graph.id===row.graphId);
        const task = graph?.tasks?.find(task=>task.id===row.taskId && task.assignedThreadId===row.thread.id);
        if (typeof task?.title==='string' && task.title.trim()) this.#workflowTitles.set(row.thread.id,{source:row.source,title:task.title.trim(),rootThreadId});
      }
    }));
  }
  #decorate(thread) {
    if (!thread || typeof thread.id !== 'string') throw new BridgeError('Elpis returned an invalid thread', 502);
    this.#known.add(thread.id);
    const recorded = this.#workflowTitles.get(thread.id);
    if (recorded?.source===thread.source?.subAgent?.other && recorded && (!thread.parentThreadId || thread.parentThreadId===recorded.rootThreadId)) {
      thread.workflowTaskTitle=recorded.title; thread.parentThreadId ??= recorded.rootThreadId;
    }
    // Elpis accepts turns for a multi-agent v2 agent only from its parent (thread_input.rs). Such a
    // chat stays writable here: a message continues its history in a fork under the same model.
    const parentOwned = thread.canAcceptDirectInput === false
      || (thread.canAcceptDirectInput == null && typeof thread.source?.subAgent?.thread_spawn?.agent_path === 'string');
    return { ...thread, desktopAccess: { writable: true, mode: parentOwned ? 'continue' : 'direct', reason: parentOwned
      ? 'Elpis takes direct messages for this agent only from its parent, so your message continues its history in a new conversation with the same model.'
      : null } };
  }
  #forget(id) { this.#forgetSubscription(id); this.#known.delete(id); this.#context.delete(id); this.#attaching.delete(id); this.#workflowTitles.delete(id); }
  async listThreads(options = {}) {
    object(options, ['cursor', 'limit', 'ancestorThreadId', 'archived', 'searchTerm']);
    if (options.searchTerm !== undefined) text(options.searchTerm, 'conversation search', 200);
    const result = await this.#rpc('thread/list', { limit: options.limit ?? 50, cursor: options.cursor, modelProviders: [],
      ...(options.archived === true ? { archived: true } : {}),
      ...(options.searchTerm ? { searchTerm: options.searchTerm.trim() } : {}),
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
      ...(options.ancestorThreadId ? { ancestorThreadId: threadId(options.ancestorThreadId) } : {}) });
    await this.#loadWorkflowTitles(result.data);
    const data = result.data.map(thread => this.#decorate(thread));
    // Follow working agents live: only subscribers receive their items, approvals and deltas.
    for (const thread of data) if (thread.status?.type === 'active' && !this.#owned.has(thread.id)) void this.#attach(thread.id).catch(() => {});
    return { ...result, data };
  }
  /** Subscribes this connection to a thread exactly as a TUI rejoins it: no model, policy, history, or workspace overrides. */
  #attach(id) {
    threadId(id);
    if (this.#owned.has(id) && !this.#attaching.has(id)) return Promise.resolve(null);
    if (this.#attaching.has(id)) return this.#attaching.get(id);
    this.#owned.add(id);
    const attempt = this.#rpc('thread/resume', { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } })
      .then(result => {
        if (result.thread?.id !== id) throw new BridgeError('Elpis resumed another conversation', 502);
        return result;
      })
      .catch(error => { this.#forgetSubscription(id); throw error; })
      .finally(() => { if (this.#attaching.get(id) === attempt) this.#attaching.delete(id); });
    this.#attaching.set(id, attempt);
    return attempt;
  }
  #forgetSubscription(id) {
    this.#owned.delete(id);
    for (const [key, approval] of this.#approvals) if (approval.ownerThreadId === id || approval.params.threadId === id) {
      this.#approvals.delete(key);
      this.emit('event', { type: 'approvalResolved', data: { id: key } });
    }
  }
  async readThread(id, options = {}) {
    threadId(id); object(options, ['cursor', 'limit']);
    const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
    if (thread.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    await this.#loadWorkflowTitles([thread]);
    const items = await this.#rpc('thread/items/list', { threadId: id, cursor: options.cursor, limit: options.limit ?? 30, sortDirection: 'desc' });
    return { thread: this.#decorate(thread), ...items };
  }
  async media(id, turn, itemId, inputIndex) {
    threadId(id); text(turn, 'turn ID', 200); text(itemId, 'item ID', 200);
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex > 100) throw new BridgeError('Invalid media index');
    const cursors = new Set(); let cursor;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await this.#rpc('thread/items/list', { threadId: id, turnId: turn, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || page.data.some(entry => entry?.turnId !== turn)) throw new BridgeError('Could not verify recorded media', 502);
      const entry = page.data.find(entry => entry.item?.id === itemId);
      if (entry) {
        if (entry.item.type !== 'userMessage' || !Array.isArray(entry.item.content)) throw new BridgeError('No recorded media here', 404);
        return recordedMedia(entry.item.content[inputIndex]);
      }
      if (page.nextCursor === null) break;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw new BridgeError('Could not verify recorded media', 502);
      cursor = page.nextCursor; cursors.add(cursor);
    }
    throw new BridgeError('Recorded media was not found', 404);
  }
  async models(options = {}) {
    object(options, ['cursor', 'limit', 'provider']);
    if (options.provider !== undefined) {
      text(options.provider, 'configured connection', 64);
      if (!/^[a-z][a-z0-9_-]*$/.test(options.provider)) throw new BridgeError('Choose an existing configured connection');
      const [read, policy] = await Promise.all([
        this.#rpc('config/read', { includeLayers: false }),
        this.#rpc('configRequirements/read', {}).catch(() => null),
      ]);
      if (policy === null) throw new BridgeError('Connection policy could not be read. Try again after reconnecting.', 503);
      const managed = policy.requirements;
      if (managed?.modelProvider && managed.modelProvider !== options.provider) throw new BridgeError('This connection is restricted by your organization', 403);
      if (options.provider !== read?.config?.model_provider) {
        const definitions = { ...(read?.config?.model_providers ?? {}), ...(managed?.modelProviders ?? {}) };
        if (!Object.hasOwn(definitions, options.provider)) throw new BridgeError('This connection needs a saved API address before Elpis can list its models. Add a connection in Settings → Models & accounts.');
        try { return await providerModels(definitions[options.provider]); }
        catch (error) { throw new BridgeError(error.message || 'Could not load models from this connection.', 502); }
      }
    }
    const { provider: _provider, ...page } = options;
    const result = await this.#rpc('model/list', { ...page, limit: options.limit ?? 100, includeHidden: false });
    for (const model of result.data) this.#models.add(model.model);
    return result;
  }
  async settings() {
    const [read, requirements, pruner] = await Promise.all([
      this.#rpc('config/read', { includeLayers: true }),
      this.#rpc('configRequirements/read', {}).catch(() => null),
      this.#rpc('pruner/read', {}).catch(error => { if ([-32601, -32600].includes(error.code)) return null; throw error; }),
    ]);
    return settingsSnapshot(read, requirements, pruner);
  }
  async saveSettings(input) {
    object(input, ['version', 'background', 'memory']);
    text(input.version, 'settings version', 200);
    const current = await this.settings();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const edits = [];
    const nullableModel = value => value === null ? null : text(value, 'model ID', 200).trim();
    if (input.background !== undefined) {
      object(input.background, ['model', 'provider']);
      if ('model' in input.background) edits.push({ keyPath: 'background_model', value: nullableModel(input.background.model), mergeStrategy: 'replace' });
      if ('provider' in input.background) {
        const provider = input.background.provider;
        if (provider !== null && !current.providers.some(item => item.id === provider)) throw new BridgeError('Choose a configured provider');
        edits.push({ keyPath: 'background_provider', value: provider, mergeStrategy: 'replace' });
      }
    }
    if (input.memory !== undefined) {
      object(input.memory, ['generate', 'use', 'extractionModel', 'consolidationModel']);
      for (const [field, key] of Object.entries({ generate: 'generate_memories', use: 'use_memories', extractionModel: 'extract_model', consolidationModel: 'consolidation_model' })) {
        if (!(field in input.memory)) continue;
        const value = input.memory[field];
        if (['generate', 'use'].includes(field) && typeof value !== 'boolean') throw new BridgeError('Memory choices must be enabled or disabled');
        edits.push({ keyPath: `memories.${key}`, value: ['generate', 'use'].includes(field) ? value : nullableModel(value), mergeStrategy: 'replace' });
      }
    }
    if (!edits.length) throw new BridgeError('No settings were changed');
    await this.#rpc('config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: false });
    return this.settings();
  }
  async savePruner(input) {
    object(input, ['version', 'model', 'provider']);
    text(input.version, 'pruning settings version', 200);
    const current = await this.settings();
    const override = current.smartPrune.explicitOverride;
    if (!override.available) throw new BridgeError(override.reason, 409);
    if (override.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    if (input.model !== null || input.provider !== null) {
      text(input.model, 'pruning model ID', 200); text(input.provider, 'pruning provider ID', 200);
      if (!current.providers.some(item => item.id === input.provider)) throw new BridgeError('Choose a configured provider');
    }
    await this.#rpc('pruner/write', { expectedVersion: input.version, model: input.model, provider: input.provider });
    return this.settings();
  }
  async providers() {
    const [account, limits, read, models] = await Promise.all([
      this.#rpc('account/read', { refreshToken: false }).catch(error => ({ error: error.message })),
      this.#rpc('account/rateLimits/read', {}).catch(error => ({ error: error.message })),
      this.#rpc('config/read', { includeLayers: false }),
      this.#rpc('model/list', { limit: 100, includeHidden: false }).catch(() => ({ data: [] })),
    ]);
    return providersSnapshot({ account, limits, config: read?.config, models: models.data });
  }
  async providerSettings() {
    const [read, requirements] = await Promise.all([
      this.#rpc('config/read', { includeLayers: true }),
      this.#rpc('configRequirements/read', {}).catch(() => null),
    ]);
    return providerSettingsSnapshot(read, requirements);
  }
  async saveProvider(input) {
    const current = await this.providerSettings();
    const edits = providerEdits(input, current);
    privateConfigFile(current.configPath);
    try { await this.#rpc('config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); }
    catch (error) {
      if (error.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('Provider settings could not be saved. Refresh settings before retrying.', error.status ?? 502);
    }
    return this.providerSettings();
  }
  async signIn(body) {
    object(body, ['action']);
    if (body.action === 'signOut') { await this.#rpc('account/logout', {}); return { signedOut: true }; }
    if (body.action !== 'chatgpt') throw new BridgeError('Choose ChatGPT sign-in or sign-out');
    const result = await this.#rpc('account/login/start', { type: 'chatgpt' });
    if (typeof result?.authUrl !== 'string' || !/^https:\/\//.test(result.authUrl)) throw new BridgeError('Elpis did not return a sign-in page', 502);
    return { authUrl: result.authUrl, loginId: string(result.loginId) };
  }
  async mcp() { return mcpSnapshot(await this.#rpc('config/read', { includeLayers: true })); }
  // Private subprocess configuration. HTTP responses expose only the selected route, never this object.
  async transcriptionDefinition() {
    const read = await this.#rpc('config/read', { includeLayers: false });
    return read.config?.mcp_servers?.whispertype ?? null;
  }
  // Internal CLI environment only; credentials never travel to the renderer.
  async ragEnvironment() {
    const read = await this.#rpc('config/read', { includeLayers: false });
    const env = read.config?.mcp_servers?.rag?.env ?? {};
    return Object.fromEntries(['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'RAG_MCP_CONFIG'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  }
  /** Adds, removes, enables or configures one MCP server through the native versioned config writer. */
  async saveMcp(input) {
    object(input, ['version', 'action', 'name', 'command', 'args', 'enabled', 'backend', 'model', 'env']);
    text(input.version, 'MCP settings version', 200);
    if (typeof input.name !== 'string' || !MCP_NAME.test(input.name)) throw new BridgeError('Use letters, numbers, - or _ for the server name');
    const current = await this.mcp();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const exists = current.servers.some(server => server.name === input.name);
    const key = `mcp_servers.${input.name}`;
    let edits;
    if (input.action === 'add') {
      if (exists) throw new BridgeError('A server with this name already exists', 409);
      const command = text(input.command, 'command', 4096).trim();
      const args = input.args === undefined ? [] : input.args;
      if (!Array.isArray(args) || args.length > 64) throw new BridgeError('Give at most 64 arguments');
      edits = [{ keyPath: key, value: { command, args: args.map(arg => text(arg, 'argument', 4096)) }, mergeStrategy: 'replace' }];
    } else if (!exists) throw new BridgeError('Unknown MCP server', 409);
    else if (input.action === 'remove') edits = [{ keyPath: key, value: null, mergeStrategy: 'replace' }];
    else if (input.action === 'enable') {
      if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose enabled or disabled');
      edits = [{ keyPath: `${key}.enabled`, value: input.enabled, mergeStrategy: 'replace' }];
    } else if (input.action === 'credentials') {
      if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || !Object.keys(input.env).length || Object.keys(input.env).length > 16) throw new BridgeError('Invalid credential fields');
      edits = [];
      for (const [name, value] of Object.entries(input.env)) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) || (value !== null && (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)))) throw new BridgeError('Invalid credential');
        if (typeof value === 'string' && (!value.trim() || /^[*•●]+$/.test(value.trim()))) continue;
        edits.push({ keyPath: `${key}.env.${name}`, value, mergeStrategy: 'replace' });
      }
    } else if (input.action === 'whispertype' && input.name === 'whispertype') {
      if (!['openrouter', 'codex', 'local'].includes(input.backend)) throw new BridgeError('Choose OpenRouter, Codex sign-in or local transcription');
      edits = [{ keyPath: `${key}.env.WHISPERTYPE_BACKEND`, value: input.backend, mergeStrategy: 'replace' }];
      if (input.model !== undefined) {
        if (input.model !== null && !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(input.model)) throw new BridgeError('Give an OpenRouter model ID such as openai/gpt-4o-mini-transcribe');
        edits.push({ keyPath: `${key}.env.WHISPERTYPE_CLOUD_MODEL`, value: input.model, mergeStrategy: 'replace' });
      }
    } else throw new BridgeError('Unsupported MCP change');
    if (!edits.length) return current;
    if (input.action === 'credentials') {
      privateConfigFile(current.configPath);
    }
    try { await this.#rpc('config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); }
    catch (error) {
      // Native TOML errors can contain submitted values. Keep safe status semantics only.
      if (error.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('MCP settings could not be saved. Refresh settings before retrying.', error.status ?? 502);
    }
    let reloadRequested = true;
    await this.#rpc('config/mcpServer/reload', undefined).catch(() => { reloadRequested = false; });
    return { ...await this.mcp(), reloadRequested };
  }
  async context(id) {
    threadId(id);
    const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    this.#decorate(thread);
    const snapshot = this.#context.get(id) ?? {};
    return {
      threadId: id, tokenUsage: snapshot.tokenUsage ?? null, smartPrune: snapshot.smartPrune ?? null,
      availability: { tokenUsage: snapshot.tokenUsage ? 'live' : 'unavailable', smartPrune: snapshot.smartPrune ? 'live' : 'unavailable' },
      reason: 'Only events received by this app connection are available; reading a chat does not resume it or subscribe to previous context snapshots.',
    };
  }
  #model(model) {
    if (model === undefined) return;
    if (!this.#models.has(model)) throw new BridgeError('Select a model returned by the current Elpis model list');
    return model;
  }
  async #providerModel(model, provider) {
    if (model !== undefined && provider) {
      const current = await this.providerSettings();
      if (current.providers.some(entry => entry.id === provider && entry.editable)) {
        if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) throw new BridgeError('Give a model ID supported by this API provider');
        if (/^(claude|agy|antigravity)\//i.test(model)) throw new BridgeError('Subscription model routes cannot be used with an API provider');
        return model;
      }
    }
    return this.#model(model);
  }
  async workflows(id) {
    threadId(id);
    const current=await this.#rpc('thread/read',{threadId:id,includeTurns:false});
    if(current.thread?.id!==id)throw new BridgeError('Elpis returned a different thread',502);
    this.#decorate(current.thread);
    return this.#rpc('workGraph/list', {rootThreadId:id});
  }
  async runWorkflow(body) {
    object(body, ['rootThreadId','name','tasks','maxConcurrency','maxRuntimeSeconds']);
    const id=threadId(body.rootThreadId);
    const params={rootThreadId:id,name:text(body.name,'workflow name',256),tasks:[]};
    if(!Array.isArray(body.tasks)||body.tasks.length<1||body.tasks.length>256)throw new BridgeError('A workflow must contain 1–256 tasks');
    for(const task of body.tasks){
      object(task,['id','kind','title','instruction','dependsOn','environmentId','writeScopes','acceptanceCriteria','provider','model']);
      if(!['explore','implement','verify','fix'].includes(task.kind))throw new BridgeError('Unknown task role');
      const next={id:text(task.id,'task ID',100),kind:task.kind,title:text(task.title,'task title',256),instruction:text(task.instruction,'task instructions')};
      for(const key of ['dependsOn','writeScopes','acceptanceCriteria']){
        if(!Array.isArray(task[key])||task[key].length>256)throw new BridgeError(`Invalid ${key}`);
        next[key]=task[key].map(value=>text(value,key,4096));
      }
      if(task.environmentId!==undefined)next.environmentId=text(task.environmentId,'environment ID',256);
      if(task.provider!==undefined){
        next.provider=text(task.provider,'task provider',100);
        if(!/^[A-Za-z0-9_.-]+$/.test(next.provider)||/^(claude|agy|antigravity)$/i.test(next.provider))throw new BridgeError('Workflow tasks require a native provider');
        if(task.model===undefined)throw new BridgeError('A task provider requires an explicit model');
      }
      if(task.model!==undefined){
        next.model=text(task.model,'task model',200);
        if(!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(next.model)||/^(claude|agy|antigravity)\//i.test(next.model))throw new BridgeError('Workflow tasks require a native model ID');
      }
      params.tasks.push(next);
    }
    for(const key of ['maxConcurrency','maxRuntimeSeconds'])if(body[key]!==undefined){
      if(!Number.isSafeInteger(body[key])||body[key]<1||(key==='maxConcurrency'&&body[key]>32))throw new BridgeError(`Invalid ${key}`);
      params[key]=body[key];
    }
    return this.#mutate(id,async()=>{
      const current=await this.#current(id);
      if(current.desktopAccess.mode==='continue')throw new BridgeError('Run workflows from a root conversation; this agent takes turns only from its parent',409);
      if(current.status?.type==='active')throw new BridgeError('Wait for the current turn to finish before running a workflow',409);
      return this.#rpc(params.tasks.some(task=>task.provider!==undefined||task.model!==undefined)?'workGraph/runWithProviders':'workGraph/run',params);
    });
  }
  async createThread(body) {
    object(body, ['cwd', 'model', 'provider', 'name', 'instructions']);
    const name = body.name === undefined ? undefined : text(body.name, 'agent name', 120).trim();
    const instructions = body.instructions === undefined ? undefined : text(body.instructions, 'agent instructions', 32000);
    if (body.cwd !== undefined && !path.isAbsolute(text(body.cwd, 'working directory', 4096))) throw new BridgeError('Working directory must be absolute');
    let differentProvider = false;
    if (body.provider !== undefined) {
      text(body.provider, 'provider', 200);
      const settings = await this.settings();
      if (!settings.providers.some(provider => provider.id === body.provider)) throw new BridgeError('Choose an existing configured provider');
      if (settings.managed.modelProvider && settings.managed.modelProvider !== body.provider) throw new BridgeError('This provider is restricted by managed settings', 403);
      differentProvider = body.provider !== settings.main.provider;
    }
    if (differentProvider) text(body.model, 'model for this provider', 200);
    const model = await this.#providerModel(body.model, body.provider);
    const result = await this.#rpc('thread/start', { ...(body.cwd ? { cwd: body.cwd } : {}), ...(model ? { model } : {}),
      ...(body.provider ? { modelProvider: body.provider } : {}), ...(instructions ? { developerInstructions: instructions } : {}) });
    threadId(result.thread?.id);
    this.#owned.add(result.thread.id);
    if (name) { await this.#rpc('thread/name/set', { threadId: result.thread.id, name }); result.thread.name = name; }
    return { ...result, thread: this.#decorate(result.thread) };
  }
  /** Deletes a chat and its agents; chats forked from that subtree (continued agents) go first, since Elpis keeps history a fork uses. */
  async deleteThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      const removed = [];
      try { await this.#rpc('thread/delete', { threadId: id }); }
      catch (error) {
        if (!/forked history still references it/.test(error.message)) throw error;
        const listAll = options => scanDeletionThreads(page => this.listThreads({ ...options, ...page })).catch(() => {
          throw new BridgeError('Elpis could not read the complete conversation list. No related chats were deleted.', 502);
        });
        const subtree = new Set([id, ...(await listAll({ ancestorThreadId: id })).map(thread => thread.id)]), forks = [];
        // thread/list leaves forkedFromId unset for stored rows; thread/read reports it.
        for (const thread of await listAll({})) {
          if (subtree.has(thread.id)) continue;
          let source = thread.forkedFromId;
          if (source == null) {
            const read = await this.#rpc('thread/read', { threadId: thread.id, includeTurns: false });
            if (read?.thread?.id !== thread.id) throw new BridgeError('Elpis could not verify a conversation reference. No related chats were deleted.', 502);
            source = read.thread.forkedFromId;
          }
          if (source != null) threadId(source);
          if (source && subtree.has(source)) forks.push(thread.id);
        }
        if (!forks.length) throw error;
        for (const fork of forks) { await this.#rpc('thread/delete', { threadId: fork }); removed.push(fork); this.#forget(fork); }
        await this.#rpc('thread/delete', { threadId: id });
      }
      this.#forget(id);
      return { deleted: true, alsoDeleted: removed };
    });
  }
  /** Renames a chat in Elpis; every client shows the stored name. */
  async renameThread(id, body) {
    object(body, ['name']); const name = text(body.name, 'name', 120).trim();
    if (!name) throw new BridgeError('Enter a name');
    return this.#mutate(id, async () => {
      await this.#rpc('thread/name/set', { threadId: threadId(id), name });
      return { thread: { ...(await this.#current(id)), name } };
    });
  }
  /** Archives a chat and, natively, the agents it spawned; Elpis announces each with thread/archived. */
  async archiveThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      await this.#rpc('thread/archive', { threadId: threadId(id) });
      this.#forget(id);
      return { archived: true };
    });
  }
  async unarchiveThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      const result = await this.#rpc('thread/unarchive', { threadId: threadId(id) });
      if (result.thread?.id !== id) throw new BridgeError('Elpis restored another thread', 502);
      return { thread: this.#decorate(result.thread) };
    });
  }
  /** Edit-and-resend and regenerate: Elpis drops the given turn and every later one (thread/revert), then the new text starts a turn. */
  async revert(id, body) {
    object(body, ['beforeTurnId', 'text', 'model', 'effort']);
    const beforeTurnId = text(body.beforeTurnId, 'turn ID', 200);
    const input = [{ type: 'text', text: ragMessage(text(body.text, 'message')), text_elements: [] }];
    const effort = this.#effort(body.effort);
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Elpis takes turns for this agent only from its parent, so its earlier messages cannot be replaced here.', 409);
      if (thread.status?.type === 'active') throw new BridgeError('Stop the running turn before replacing an earlier message.', 409);
      const model = await this.#providerModel(body.model, thread.modelProvider);
      const entries = [], cursors = new Set(); let cursor, complete = false;
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = await this.#rpc('thread/items/list', { threadId: id, turnId: beforeTurnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data) || page.data.some(entry => entry?.turnId !== beforeTurnId)) throw new BridgeError('Elpis could not verify the original input for this turn. Nothing was replaced.', 409);
        entries.push(...page.data);
        if (page.nextCursor === null) { complete = true; break; }
        if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw new BridgeError('Elpis could not read the complete turn. Nothing was replaced.', 409);
        cursor = page.nextCursor; cursors.add(cursor);
      }
      if (!complete) throw new BridgeError('This turn is too large to verify for replacement in this app. Nothing was replaced.', 409);
      const eligibility = replacementEligibility(entries, beforeTurnId, { historyComplete: true });
      if (!eligibility.allowed) throw new BridgeError(eligibility.reason, 409);
      await this.#rpc('thread/revert', { threadId: id, beforeTurnId });
      try { return await this.#rpc('turn/start', { threadId: id, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }); }
      catch (error) {
        return { rewound: true, beforeTurnId, sendError: `Conversation was rewound, but its replacement message was not confirmed: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  }
  /** Opens a chat live in this app: subscribes it and reports the turn it is running, if any. */
  async resume(id, body) {
    object(body, []);
    const result = await this.#attach(id);
    if (result) {
      const active = (result.initialTurnsPage?.data ?? result.thread.turns ?? []).find(turn => turn.status === 'inProgress');
      return { thread: this.#decorate({ ...result.thread, model: result.model ?? result.thread.model, reasoningEffort: result.reasoningEffort ?? result.thread.reasoningEffort }), activeTurnId: active?.id ?? null };
    }
    const [{ thread }, turns] = await Promise.all([this.#rpc('thread/read', { threadId: id, includeTurns: false }),
      this.#rpc('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }).catch(() => ({ data: [] }))]);
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return { thread: this.#decorate(thread), activeTurnId: turns.data?.find(turn => turn.status === 'inProgress')?.id ?? null };
  }
  async #current(id) {
    await this.#attach(id);
    const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return this.#decorate(thread);
  }
  #effort(value) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !EFFORT.test(value)) throw new BridgeError('Choose a reasoning effort offered by the model');
    return value;
  }
  async send(id, body) {
    object(body, ['text', 'model', 'effort', 'continueAs', 'attachments']);
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, body.attachments);
    const effort = this.#effort(body.effort);
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      const model = await this.#providerModel(body.model, thread.modelProvider);
      const overrides = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      if (thread.desktopAccess.mode === 'continue') {
        // The agent's own thread refuses direct turns; a fork carries its whole history and recorded model.
        const name = text(body.continueAs, 'continued conversation name', 200).trim();
        const fork = await this.#rpc('thread/fork', { threadId: id, model: model ?? thread.model ?? undefined, modelProvider: thread.modelProvider });
        threadId(fork.thread?.id); this.#owned.add(fork.thread.id);
        const continued = { thread: this.#decorate(fork.thread), continuedFrom: id };
        try { await this.#rpc('thread/name/set', { threadId: fork.thread.id, name }); }
        catch (error) {
          return { ...continued, sendError: `Conversation created, but its name could not be confirmed: ${error instanceof Error ? error.message : String(error)} Your message was not sent.` };
        }
        continued.thread.name = name;
        try {
          const started = await this.#rpc('turn/start', { threadId: fork.thread.id, input, ...overrides });
          return { ...started, ...continued };
        } catch (error) {
          // The fork is acknowledged even when the first send fails or its outcome is unknown.
          // Return it so the app can inspect that conversation instead of creating another fork.
          return { ...continued, sendError: `Conversation created, but its first message was not confirmed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (thread.status?.type === 'active') throw new BridgeError('This conversation is running. Use Steer with its active turn ID.', 409);
      return this.#rpc('turn/start', { threadId: id, input, ...overrides });
    });
  }
  async steer(id, body) {
    object(body, ['text', 'expectedTurnId', 'attachments']);
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, body.attachments);
    const params = { threadId: id, expectedTurnId: text(body.expectedTurnId, 'turn ID', 200), input };
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Wait for this agent to finish; a message then continues it in a new conversation.', 409);
      return this.#rpc('turn/steer', params);
    });
  }
  /** Stops the given turn, or the agent's running turn when the caller has not seen its start. */
  async interrupt(id, body) {
    object(body, ['turnId']);
    return this.#mutate(id, async () => {
      await this.#attach(id);
      let turnId = body.turnId === undefined ? null : text(body.turnId, 'turn ID', 200);
      turnId ??= (await this.#rpc('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(turn => turn.status === 'inProgress')?.id;
      if (!turnId) throw new BridgeError('This agent is not running', 409);
      return this.#rpc('turn/interrupt', { threadId: id, turnId });
    });
  }
  async #mutate(id, run) {
    threadId(id);
    if (this.#mutating.has(id)) throw new BridgeError('Another operation on this conversation is pending', 409);
    this.#mutating.add(id);
    try { return await run(); } finally { this.#mutating.delete(id); }
  }
  answerApproval(id, body) {
    const pending = this.#approvals.get(id);
    if (!pending) throw new BridgeError('Approval is no longer pending', 409);
    let result;
    if (pending.method === 'item/tool/requestUserInput') {
      object(body, ['answers']); const questions = pending.params.questions ?? [];
      object(body.answers, questions.map(q => q.id));
      result = { answers: Object.fromEntries(questions.map(q => {
        const answers = body.answers[q.id];
        if (!Array.isArray(answers) || !answers.length || answers.length > 20) throw new BridgeError('Answer each pending question');
        return [q.id, { answers: answers.map(a => text(a, 'answer', 4096)) }];
      })) };
    } else {
      object(body, ['decision']);
      // Amendments ("always allow this prefix/host") are objects; only an exact offered one is accepted.
      const offered = pending.params.availableDecisions;
      const isOffered = offered ? offered.some(item => JSON.stringify(item) === JSON.stringify(body.decision)) : DECISIONS.includes(body.decision);
      if (typeof body.decision === 'string' ? !DECISIONS.includes(body.decision) : !body.decision || typeof body.decision !== 'object') throw new BridgeError('Unsupported approval decision');
      if (!isOffered) throw new BridgeError('Decision is not offered for this request');
      result = { decision: body.decision };
    }
    this.#socket.send(JSON.stringify({ id: pending.wireId, result })); this.#approvals.delete(id);
    this.emit('event', { type: 'approvalResolved', data: { id } }); return { resolved: true };
  }
}
