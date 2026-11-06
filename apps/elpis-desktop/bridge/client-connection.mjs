import { BridgeError, threadId } from './validate.mts';
import { randomUUID } from 'node:crypto';
import { smartPruneSnapshot, tokenUsageSnapshot } from './elpis-features.mjs';
import { ACCOUNT_NOTIFICATIONS, APPROVALS, ARCHIVED_SESSION, DOWNLOADS, EXPLAINED, LISTED, NOTIFICATIONS, SIDE_RPCS, readRpc } from './client-protocol.mjs';
import { modeOf } from './client-permissions.mjs';
import { internal_decorate, internal_forget, internal_learnSpawn } from './client-thread-list.mjs';

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function internal_bind(clientState, socket) {
    socket.on('message', data => { if (socket === clientState.socket) internal_receive.call(this, clientState, data); });
    socket.on('close', (code, reason) => { if (socket === clientState.socket) { if (!clientState.closed && typeof code === 'number' && code !== 1000) console.warn('Elpis runtime socket closed', code, String(reason || '').slice(0, 200)); internal_disconnect.call(this, clientState); } });
    socket.on('error', error => { if (socket === clientState.socket) { if (!clientState.closed) console.warn('Elpis runtime socket error', error?.code || '', String(error?.message || '').slice(0, 200)); internal_disconnect.call(this, clientState); } });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_initialize(clientState) {
    await internal_rpc.call(this, clientState, 'initialize', { clientInfo: { name: 'elpis-desktop', title: 'Elpis', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    clientState.socket.send(JSON.stringify({ method: 'initialized', params: {} })); clientState.ready = true;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_connected(clientState) { return clientState.ready && !clientState.closed; }

/** Why the last connection attempt failed, while it is not connected. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_connectionError(clientState) { return this.connected ? null : clientState.connectionError; }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_hasLocalActivity(clientState) { return clientState.mutating.size > 0 || clientState.workflowRuns.busy(); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function internal_browserOptions(clientState, id) {
    const config = clientState.browserConfig ? (clientState.browserConfig.forSession ? clientState.browserConfig.forSession(id) : clientState.browserConfig) : {};
    return Object.keys(config).length ? { config } : {};
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_pendingApprovals(clientState) { return [...clientState.approvals.values()].map(({ wireId: _wireId, ...visible }) => visible); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
function internal_disconnect(clientState) {
    if (clientState.closed) return;
    clientState.closed = true; clientState.ready = false;
    clientState.socket.terminate?.();
    for (const pending of clientState.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError(pending.reading ? 'Elpis connection closed while reading. Reload the view after reconnecting.' : 'Elpis connection closed; the request outcome is unknown. Check the conversation before retrying.', 503)); }
    clientState.workflowRuns.close(); clientState.cloudroom.close();
    clientState.pending.clear(); clientState.approvals.clear(); clientState.checkingApprovals.clear();
    clientState.owned.clear(); clientState.historyOnly.clear(); clientState.attaching.clear(); clientState.context.clear(); clientState.models.clear(); clientState.turnRevisions.clear();
    clientState.catalog = null;
    for (const id of clientState.sideChats.keys()) this.emit('event', { type: 'sideChat', data: { method: 'thread/closed', params: { threadId: id } } });
    clientState.sideChats.clear(); clientState.side.clear();
    this.emit('event', { type: 'connection', data: { connected: false } });
    internal_scheduleReconnect.call(this, clientState);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
function internal_scheduleReconnect(clientState) {
    if (clientState.disposed || !clientState.openSocket || clientState.retryTimer || clientState.reconnecting) return;
    clientState.retryTimer = setTimeout(() => { clientState.retryTimer = undefined; void internal_reconnect.call(this, clientState); }, Math.min(5000, clientState.retryDelay * 2 ** Math.min(clientState.retryAttempt++, 4)));
    clientState.retryTimer.unref?.();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function internal_reconnect(clientState) {
    if (clientState.disposed) return;
    clientState.reconnecting = true;
    try {
      // Both callers configure openSocket before scheduling a reconnect.
      const openSocket = /** @type {NonNullable<import('./client-state.mjs').ClientState['openSocket']>} */ (clientState.openSocket);
      const socket = await openSocket();
      if (clientState.disposed) { socket.close(); return; }
      clientState.socket = socket; clientState.closed = false; internal_bind.call(this, clientState, socket);
      await this.initialize();
      if (!this.connected) return;
      clientState.retryAttempt = 0; clientState.connectionError = null;
      this.emit('event', { type: 'connection', data: { connected: true } });
    } catch (error) {
      const reason = String(error?.message || error);
      if (reason !== clientState.connectionError) console.warn('Elpis runtime connection failed:', reason.slice(0, 300));
      clientState.connectionError = reason;
      internal_disconnect.call(this, clientState);
    } finally {
      clientState.reconnecting = false;
      if (clientState.closed) internal_scheduleReconnect.call(this, clientState);
    }
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_close(clientState) { clientState.disposed = true; clearTimeout(clientState.retryTimer); internal_disconnect.call(this, clientState); clientState.socket.close(); }

/** For a module that runs a short conversation of its own: only the requests in SIDE_RPCS, only on conversations it started
   * here, which are always ephemeral. Their notifications go to 'side' listeners and never to the app, so no chat appears;
   * the conversation is forgotten once the engine closes it. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_sideRpc(clientState, method, params = {}) {
    if (!SIDE_RPCS.has(method)) throw new BridgeError('Unsupported request');
    if (!['thread/start', 'config/read'].includes(method) && !clientState.side.has(params.threadId)) throw new BridgeError('Not a conversation of this module');
    const result = await internal_rpc.call(this, clientState, method, method === 'thread/start' ? { ...params, ephemeral: true } : params);
    if (method === 'thread/start' && typeof result?.thread?.id === 'string') clientState.side.add(result.thread.id);
    return result;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {string} method @param {unknown} [params] */
export function internal_rpc(clientState, method, params) {
    if (clientState.closed) return Promise.reject(new BridgeError('Elpis is disconnected', 503));
    const id = `desktop-${randomUUID()}`, reading = readRpc(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clientState.pending.delete(id); reject(new BridgeError(reading ? 'Elpis timed out while reading. Reload the view to try again.' : 'Elpis request timed out; its outcome is unknown. Refresh before retrying.', 504));
      }, DOWNLOADS.has(method) ? Math.max(this.timeoutMs, 600000) : this.timeoutMs);
      clientState.pending.set(id, { resolve, reject, timer, method, reading });
      try { clientState.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); clientState.pending.delete(id); reject(new BridgeError('Could not send request to Elpis', 503)); }
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
function internal_receive(clientState, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = clientState.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); clientState.pending.delete(message.id);
      if (message.error) {
        const conflict = message.error.data?.config_write_error_code === 'configVersionConflict' || message.error.data?.reason === 'staleVersion';
        const workflow = pending.method === 'workGraph/run' || pending.method === 'workGraph/runWithProviders' || pending.method.startsWith('workflowRun/');
        const contextFiles = pending.method === 'thread/contextFiles/list' || pending.method === 'thread/contextFiles/set';
        const unsupported = (workflow || contextFiles) && /unknown (method|variant)/i.test(message.error.message ?? '');
        // An operation Elpis does not support (-32601) says which one; the bare code would not.
        const detail = ARCHIVED_SESSION.test(message.error.message ?? '') ? 'This chat is archived. Unarchive it, or send a message in it, to continue.' : (workflow || pending.method.startsWith('thread/goal/') || EXPLAINED.has(pending.method) || message.error.code === -32601) && typeof message.error.message === 'string' ? message.error.message.slice(0,1000) : `Elpis rejected the operation (${message.error.code ?? 'unknown'}). No automatic retry was made.`;
        const error = new BridgeError(conflict ? 'Settings changed in another client. Reload settings before saving again.' : unsupported ? contextFiles ? 'Update and restart Elpis to view and change context files.' : 'Update and restart Elpis to run workflows from this app.' : detail, conflict || message.error.data?.reason === 'threadBusy' ? 409 : unsupported ? 503 : workflow ? 400 : 502);
        error.code = message.error.code; error.engineMessage = typeof message.error.message === 'string' ? message.error.message : '';
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    const id = message.params?.threadId ?? message.params?.thread?.id;
    if (id && ['turn/started', 'turn/completed', 'thread/status/changed'].includes(message.method)) clientState.turnRevisions.set(id, (clientState.turnRevisions.get(id) ?? 0) + 1);
    if (message.id !== undefined) {
      if (clientState.owned.has(id)) internal_admitApproval.call(this, clientState, message, {ownerThreadId:id});
      else if (!clientState.checkingApprovals.has(message.id)) {
        const check = {};
        clientState.checkingApprovals.set(message.id, check);
        void internal_approvalOwner.call(this, clientState, id).then(owner => {
          if (clientState.checkingApprovals.get(message.id) !== check) return;
          clientState.checkingApprovals.delete(message.id);
          if (owner && clientState.owned.has(owner.ownerThreadId) && !clientState.closed) internal_admitApproval.call(this, clientState, message, owner);
        }).catch(() => {
          if (clientState.checkingApprovals.get(message.id) === check) clientState.checkingApprovals.delete(message.id);
          // Without verified ancestry this may belong to another client's work.
        });
      }
      return;
    }
    // The engine can announce an ephemeral fork before its RPC acknowledgement reaches us.
    if (message.method === 'thread/started' && message.params?.thread?.ephemeral === true) clientState.side.add(id);
    if (clientState.side.has(id)) {
      const chat = clientState.sideChats.get(id);
      if (chat) {
        if (message.method === 'turn/started') chat.turnId = message.params?.turn?.id;
        if (message.method === 'turn/completed') { chat.turnId = null; chat.starting = false; }
        this.emit('event', { type: 'sideChat', data: message });
      }
      this.emit('side', message);
      if (message.method === 'thread/closed' || message.method === 'thread/deleted') { clientState.side.delete(id); clientState.sideChats.delete(id); }
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      clientState.checkingApprovals.delete(message.params?.requestId);
      for (const [key, pending] of clientState.approvals) if (pending.wireId === message.params?.requestId) {
        clientState.approvals.delete(key);
        this.emit('event', {type:'approvalResolved',data:{id:key}});
      }
    }
    // Workflows that run until they finish (SPEC WR7): every change of a run, for the app's view of runs.
    if (message.method === 'workflowRun/updated') { this.emit('event', { type: 'workflowRun', data: message.params }); return; }
    if (ACCOUNT_NOTIFICATIONS.has(message.method)) {
      if (message.method !== 'account/rateLimits/updated') clientState.catalog = null;
      this.emit('event', { type: 'account', data: { method: message.method } }); return;
    }
    if (message.method === 'thread/settings/updated') {
      for (const resolve of clientState.settingsWaiters.get(id) ?? []) resolve(message.params.threadSettings);
      // The app reads the applied permission mode from here rather than from what it asked for.
      message.params = { ...message.params, permissions: modeOf(message.params?.threadSettings) };
    }
    if (message.method === 'item/completed' && id) void internal_learnSpawn.call(this, clientState, id, message.params.item);
    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (id && turnId && message.method === 'turn/started') {
      const model = message.params?.turn?.model;
      if (typeof model === 'string' && model.trim()) clientState.liveTurnModels.set(`${id}:${turnId}`, model);
    }
    if (id && turnId && message.method?.startsWith('item/')) {
      const model = clientState.liveTurnModels.get(`${id}:${turnId}`);
      if (model) message.params = { ...message.params, model };
    }
    // Chat-level news (a chat started, renamed, or changed state) is listed anyway; item streams stay scoped.
    const tracked = clientState.known.has(id) || clientState.owned.has(id) || LISTED.has(message.method);
    if (message.method === 'thread/deleted' && tracked) internal_forget.call(this, clientState, id);
    if (NOTIFICATIONS.has(message.method) && tracked) {
      if (message.method === 'thread/tokenUsage/updated' || message.method === 'thread/smartPrune/updated') {
        const key = message.method === 'thread/tokenUsage/updated' ? 'tokenUsage' : 'smartPrune';
        const value = key === 'tokenUsage' ? tokenUsageSnapshot(message.params?.[key]) : smartPruneSnapshot(message.params?.[key]);
        // As in the TUI, an update without category shares (a replay after resume) keeps the last known ones.
        const shares = clientState.context.get(id)?.tokenUsage?.contextAttribution;
        if (key === 'tokenUsage' && value && !value.contextAttribution && shares) value.contextAttribution = shares;
        clientState.context.set(id, { ...clientState.context.get(id), [key]: value });
        this.emit('event', { type: 'message', data: { method: message.method, params: { threadId: id, [key]: value } } });
        return;
      }
      this.emit('event', { type: 'message', data: { method: message.method, params: message.params } });
    }
    if (message.method === 'turn/completed' && id && turnId) clientState.liveTurnModels.delete(`${id}:${turnId}`);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_approvalOwner(clientState, id) {
    const seen = new Set();
    let current = id, requester;
    while (current && !seen.has(current) && seen.size < 256) {
      threadId(current);
      if (clientState.owned.has(current)) return {ownerThreadId:current,...(requester ? {thread:requester} : {})};
      seen.add(current);
      const {thread} = await internal_rpc.call(this, clientState, 'thread/read', {threadId:current,includeTurns:false});
      if (thread?.id !== current) return null;
      const decorated = internal_decorate.call(this, clientState, thread);
      if (current === id) requester = decorated;
      current = thread.parentThreadId;
    }
    return null;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
function internal_admitApproval(clientState, message, owner) {
    if ([...clientState.approvals.values()].some(pending => pending.wireId === message.id)) return;
    if (!APPROVALS.has(message.method)) {
      clientState.socket.send(JSON.stringify({id:message.id,error:{code:-32601,message:'This desktop client does not support this approval type'}}));
      this.emit('event', {type:'unsupportedApproval',data:{method:message.method,threadId:message.params?.threadId}});
      return;
    }
    const approval = {id:randomUUID(),wireId:message.id,method:message.method,params:message.params,supported:true,...owner};
    clientState.approvals.set(approval.id,approval);
    const {wireId: _wireId,...visible} = approval;
    this.emit('event',{type:'approval',data:visible});
  }
