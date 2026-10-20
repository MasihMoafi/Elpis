import { fastServiceTier } from '../lib/service-tier.mjs';
import { EventEmitter } from 'node:events';
import { isAgentRun, AGENT_RUN_NOTICE } from '../lib/agent-runs.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ragMessage } from './rag-command.mjs';
import { acceptsPastedKey, BUILT_IN_KEY_PROVIDERS, configHome, providerDefinition, providerSettingsSnapshot, providerEdits, privateConfigFile } from './provider-settings.mjs';
import { saveProviderKey, savedProviderKey, savedProviderKeyIds } from './provider-keys.mjs';
import { settingsSnapshot, tokenUsageSnapshot, contextLedger, restoredTokenUsage, rolloutShares, contextSwitchesSnapshot, CONTEXT_SWITCH_KEYS, smartPruneSnapshot, providersSnapshot, mcpSnapshot, optionEdits, hooksSnapshot } from './elpis-features.mjs';
import { replacementEligibility } from '../lib/turn-replacement.ts';
import { providerModels } from './provider-models.mjs';
import { attachmentInput, recordedMedia } from './attachments.mjs';
import { pluginsSnapshot, skillsSnapshot } from './customize.mjs';
import { SkillTrash, skillRoots } from './skill-trash.mjs';
import { createGithubConnector } from './github-connector.mjs';
import { scanDeletionThreads } from '../lib/thread-deletion.ts';
import { changedFiles, createChatWorktree, currentBranch, discardFile, fileDiff, isChatWorktreePath, releaseChatWorktree, restoreChatWorktree, reviewChoices, undoChatWorktree, workingDiff, NOT_A_REPOSITORY } from './git.mjs';
import { recordedChanges } from './recorded-changes.mjs';
import { elicitationResponse, grantedPermissions, permissionsResponse } from '../lib/approvals.ts';
import { RewindSnapshots } from './rewind-snapshots.mjs';
import { createWorkflowRuns } from './workflow-acp.mjs';
import { RewindHistory } from './rewind-history.mjs';
const string = value => typeof value === 'string' ? value : null;
/** Every kind of conversation the window lists, agents included. */
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const CHAT_SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'unknown'];

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

/** The Elpis home the runtime uses: its config, sessions and logs. */
export const elpisHome = (env = process.env) => path.resolve(env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'));
// Mirrors shared-runtime.mjs's path derivation, but never creates directories or starts a runtime.
export function existingSocket(explicit, env = process.env) {
  const provided = explicit || env.ELPIS_APP_BRIDGE_SOCKET || env.ELPIS_BRIDGE_SOCKET;
  let candidates;
  if (provided) candidates = [provided.replace(/^unix:\/\//, '')];
  else {
    let home = elpisHome(env);
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
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval']);
// Account changes have no thread; every app window may show them.
const LISTED = new Set(['thread/started', 'thread/status/changed', 'thread/name/updated']);
const ACCOUNT_NOTIFICATIONS = new Set(['account/updated', 'account/login/completed', 'account/rateLimits/updated']);
// Native refusals the person can act on (a fork still referencing a chat, a busy agent) are shown as Elpis wrote them.
const READ_RPCS = new Set(['initialize','thread/list','thread/read','thread/items/list','thread/turns/list','model/list','account/read','account/rateLimits/read','config/read','configRequirements/read','pruner/read','workGraph/list','hooks/list']);
const readRpc = (method, params) => READ_RPCS.has(method) || (method === 'thread/resume' && Object.keys(params || {}).every(key => ['threadId','excludeTurns','initialTurnsPage'].includes(key)));
/** The ChatGPT app's three permission modes, plus Elpis's Bypass permissions, as Elpis approval and
 * sandbox settings. Bypass is the engine's built-in `:bypass-permissions` profile: Full access plus no
 * refusals (codex-rs/protocol/src/models.rs bypass_permissions_active); a profile id replaces the sandbox. */
const BYPASS_PROFILE = ':bypass-permissions';
const PERMISSIONS = {
  ask: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  auto: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  full: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
  bypass: { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: BYPASS_PROFILE },
};
function permissionMode(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !Object.hasOwn(PERMISSIONS, value)) throw new BridgeError('Choose a permission mode: ask, auto, full or bypass');
  return value;
}
/** Plan mode or the default mode for a turn, as the terminal's Shift+Tab switches them; the
 * engine keeps the mode for later turns, so it is sent only when it changes. */
function collaborationMode(value, model, effort) {
  if (value === undefined) return {};
  if (value !== 'plan' && value !== 'default') throw new BridgeError('Choose a chat mode: plan or default');
  if (!model) throw new BridgeError('Choose a model before switching Plan mode', 409);
  return { collaborationMode: { mode: value, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } } };
}
/** One of the terminal's /review targets (codex-rs/app-server-protocol review.rs), checked field by field. */
function reviewTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('Unknown review target');
  switch (value.type) {
    case 'uncommittedChanges': object(value, ['type']); return { type: value.type };
    case 'baseBranch': {
      object(value, ['type', 'branch']);
      const branch = text(value.branch, 'branch name', 255);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(branch)) throw new BridgeError('Invalid branch name');
      return { type: value.type, branch };
    }
    case 'commit': {
      object(value, ['type', 'sha', 'title']);
      if (typeof value.sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value.sha)) throw new BridgeError('Invalid commit');
      return { type: value.type, sha: value.sha, ...(value.title === undefined ? {} : { title: text(value.title, 'commit title', 500) }) };
    }
    case 'custom': object(value, ['type', 'instructions']); return { type: value.type, instructions: text(value.instructions, 'review instructions', 32000) };
    default: throw new BridgeError('Unknown review target');
  }
}
const permissionSetting = (mode, key) => {
  const { approvalPolicy, approvalsReviewer, permissions } = PERMISSIONS[mode];
  return { approvalPolicy, approvalsReviewer, ...(permissions ? { permissions } : { [key]: PERMISSIONS[mode][key] }) };
};
const threadPermissions = mode => mode ? permissionSetting(mode, 'sandbox') : {};
const turnPermissions = mode => mode ? permissionSetting(mode, 'sandboxPolicy') : {};
/** The mode a chat runs in, read back from its approval, sandbox and profile settings: a resume
 * result (`sandbox`) or the engine's thread/settings/updated (`sandboxPolicy`). */
function modeOf(result) {
  if (!result?.approvalPolicy) return null;
  if (result.activePermissionProfile?.id === BYPASS_PROFILE && result.approvalPolicy === 'never') return 'bypass';
  if ((result.sandbox ?? result.sandboxPolicy)?.type === 'dangerFullAccess' && result.approvalPolicy === 'never') return 'full';
  return result.approvalsReviewer === 'auto_review' || result.approvalsReviewer === 'guardian_subagent' ? 'auto' : 'ask';
}
/** The cursor of a page cut from whole turns (see #itemsPage); the engine's own cursors never start with it. */
const WHOLE_TURNS = 'whole-turns:';
const EXPLAINED = new Set(['thread/settings/update', 'account/read', 'account/rateLimits/read', 'thread/delete', 'thread/fork', 'thread/start', 'thread/resume', 'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/revert', 'thread/compact/start', 'review/start', 'turn/start', 'turn/steer', 'turn/interrupt', 'config/batchWrite', 'account/login/start', 'account/logout', 'claudeSubscription/write', 'hooks/list', 'memory/reset']);
/** What a module with a conversation of its own (the canvas planner, bridge/canvas-plan.mjs) may ask of the engine; see `sideRpc`. */
const SIDE_RPCS = new Set(['thread/start', 'turn/start', 'turn/interrupt', 'thread/unsubscribe', 'thread/delete']);
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];
const EFFORT = /^[a-z]{2,16}$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class DesktopClient extends EventEmitter {
  #socket; #pending = new Map(); #owned = new Set(); #known = new Set(); #models = new Set();
  #approvals = new Map(); #mutating = new Set(); #closed = false; #ready = false; #attaching = new Map();
  #context = new Map(); #restored = new Map(); #shares = new Map(); #side = new Set();
  #sideChats = new Map();
  #workflowTitles = new Map(); #workflowLookups = new Map();
  #workflowRuns; #acpApprovals = new Map();
  #checkingApprovals = new Map();
  #settingsWaiters = new Map();
  #reportAttempts; #reportRetryMs;
  #disposed = false; #reconnecting = false; #retryTimer; #openSocket; #retryDelay; #retryAttempt = 0;
  #settingsConfirmMs;
  #browserConfig;
  #rewindSnapshots; #rewindHistory; #githubConnector; #skillTrash;
  constructor(socket, { timeoutMs = 30000, openSocket, reconnectDelayMs = 500, settingsConfirmMs = 3000, browserConfig, rewindHome = path.join(elpisHome(), 'desktop-rewind'), githubConnector = createGithubConnector({ home: elpisHome() }), skillTrashOptions, workflowOptions, reportAttempts = 4, reportRetryMs = 2000 } = {}) {
    super(); this.#socket = socket; this.timeoutMs = timeoutMs; this.#settingsConfirmMs = settingsConfirmMs;
    this.#reportAttempts = reportAttempts; this.#reportRetryMs = reportRetryMs;
    this.#browserConfig = browserConfig;
    this.#githubConnector = githubConnector;
    this.#skillTrash = new SkillTrash(skillTrashOptions);
    this.#rewindSnapshots = new RewindSnapshots(rewindHome);
    this.#rewindHistory = new RewindHistory(rewindHome, async (method, params) => {
      const result = await this.#rpc(method, params);
      if (method === 'thread/archive') this.#forgetSubscription(params.threadId);
      return result;
    });
    this.#openSocket = openSocket; this.#retryDelay = reconnectDelayMs;
    this.#workflowRuns = createWorkflowRuns({ stateDir: path.join(elpisHome(), 'desktop-workflows'),
      onPermission: (record, task, request, signal) => this.#workflowPermission(record, task, request, signal),
      onSession: (_record, _task, id) => { this.#known.add(id); }, onEnd: record => this.#workflowEnded(record), ...workflowOptions });
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
  hasLocalActivity() { return this.#mutating.size > 0 || this.#workflowRuns.busy(); }
  #browserOptions(id) { return this.#browserConfig ? { config: this.#browserConfig.forSession ? this.#browserConfig.forSession(id) : this.#browserConfig } : {}; }
  get pendingApprovals() { return [...this.#approvals.values()].map(({ wireId, ...visible }) => visible); }
  #disconnect() {
    if (this.#closed) return;
    this.#closed = true; this.#ready = false;
    this.#socket.terminate?.();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError(pending.reading ? 'Elpis connection closed while reading. Reload the view after reconnecting.' : 'Elpis connection closed; the request outcome is unknown. Check the conversation before retrying.', 503)); }
    this.#workflowRuns.close();
    this.#pending.clear(); this.#approvals.clear(); this.#checkingApprovals.clear();
    this.#owned.clear(); this.#attaching.clear(); this.#context.clear(); this.#models.clear();
    for (const id of this.#sideChats.keys()) this.emit('event', { type: 'sideChat', data: { method: 'thread/closed', params: { threadId: id } } });
    this.#sideChats.clear(); this.#side.clear();
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
  /** For a module that runs a short conversation of its own: only the requests in SIDE_RPCS, only on conversations it started
   * here, which are always ephemeral. Their notifications go to 'side' listeners and never to the app, so no chat appears;
   * the conversation is forgotten once the engine closes it. */
  async sideRpc(method, params = {}) {
    if (!SIDE_RPCS.has(method)) throw new BridgeError('Unsupported request');
    if (method !== 'thread/start' && !this.#side.has(params.threadId)) throw new BridgeError('Not a conversation of this module');
    const result = await this.#rpc(method, method === 'thread/start' ? { ...params, ephemeral: true } : params);
    if (method === 'thread/start' && typeof result?.thread?.id === 'string') this.#side.add(result.thread.id);
    return result;
  }
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
        const contextFiles = pending.method === 'thread/contextFiles/list' || pending.method === 'thread/contextFiles/set';
        const unsupported = (workflow || contextFiles) && /unknown (method|variant)/i.test(message.error.message ?? '');
        // An operation Elpis does not support (-32601) says which one; the bare code would not.
        const detail = (workflow || EXPLAINED.has(pending.method) || message.error.code === -32601) && typeof message.error.message === 'string' ? message.error.message.slice(0,1000) : `Elpis rejected the operation (${message.error.code ?? 'unknown'}). No automatic retry was made.`;
        const error = new BridgeError(conflict ? 'Settings changed in another client. Reload settings before saving again.' : unsupported ? contextFiles ? 'Update and restart Elpis to view and change context files.' : 'Update and restart Elpis to run workflows from this app.' : detail, conflict || message.error.data?.reason === 'threadBusy' ? 409 : unsupported ? 503 : workflow ? 400 : 502);
        error.code = message.error.code; error.engineMessage = typeof message.error.message === 'string' ? message.error.message : '';
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
    // The engine can announce an ephemeral fork before its RPC acknowledgement reaches us.
    if (message.method === 'thread/started' && message.params?.thread?.ephemeral === true) this.#side.add(id);
    if (this.#side.has(id)) {
      const chat = this.#sideChats.get(id);
      if (chat) {
        if (message.method === 'turn/started') chat.turnId = message.params?.turn?.id;
        if (message.method === 'turn/completed') { chat.turnId = null; chat.starting = false; }
        this.emit('event', { type: 'sideChat', data: message });
      }
      this.emit('side', message);
      if (message.method === 'thread/closed' || message.method === 'thread/deleted') { this.#side.delete(id); this.#sideChats.delete(id); }
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
    if (message.method === 'thread/settings/updated') {
      for (const resolve of this.#settingsWaiters.get(id) ?? []) resolve(message.params.threadSettings);
      // The app reads the applied permission mode from here rather than from what it asked for.
      message.params = { ...message.params, permissions: modeOf(message.params?.threadSettings) };
    }
    // Chat-level news (a chat started, renamed, or changed state) is listed anyway; item streams stay scoped.
    const tracked = this.#known.has(id) || this.#owned.has(id) || LISTED.has(message.method);
    if (message.method === 'thread/deleted' && tracked) this.#forget(id);
    if (NOTIFICATIONS.has(message.method) && tracked) {
      if (message.method === 'thread/tokenUsage/updated' || message.method === 'thread/smartPrune/updated') {
        const key = message.method === 'thread/tokenUsage/updated' ? 'tokenUsage' : 'smartPrune';
        const value = key === 'tokenUsage' ? tokenUsageSnapshot(message.params?.[key]) : smartPruneSnapshot(message.params?.[key]);
        // As in the TUI, an update without category shares (a replay after resume) keeps the last known ones.
        const shares = this.#context.get(id)?.tokenUsage?.contextAttribution;
        if (key === 'tokenUsage' && value && !value.contextAttribution && shares) value.contextAttribution = shares;
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
    const background = isAgentRun(thread);
    const parentOwned = background || thread.canAcceptDirectInput === false
      || (thread.canAcceptDirectInput == null && typeof thread.source?.subAgent?.thread_spawn?.agent_path === 'string');
    return { ...thread, desktopAccess: { writable: !parentOwned, mode: parentOwned ? 'continue' : 'direct',
      canContinue: parentOwned && ['idle', 'notLoaded'].includes(thread.status?.type), reason: parentOwned ? AGENT_RUN_NOTICE : null } };
  }
  #forget(id) { this.#browserConfig?.close?.(id); this.#forgetSubscription(id); this.#known.delete(id); this.#context.delete(id); this.#attaching.delete(id); this.#workflowTitles.delete(id); }
  async listThreads(options = {}) {
    object(options, ['cursor', 'limit', 'ancestorThreadId', 'archived', 'searchTerm', 'includeAgentRuns']);
    if (options.includeAgentRuns !== undefined && typeof options.includeAgentRuns !== 'boolean') throw new BridgeError('includeAgentRuns must be true or false');
    const includeAgentRuns = options.includeAgentRuns === true || !!options.ancestorThreadId;
    if (options.searchTerm !== undefined) text(options.searchTerm, 'conversation search', 200);
    const result = await this.#rpc('thread/list', { limit: options.limit ?? 50, cursor: options.cursor, modelProviders: [],
      ...(options.archived === true ? { archived: true } : {}),
      ...(options.searchTerm ? { searchTerm: options.searchTerm.trim() } : {}),
      sourceKinds: includeAgentRuns ? SOURCE_KINDS : CHAT_SOURCE_KINDS,
      ...(options.ancestorThreadId ? { ancestorThreadId: threadId(options.ancestorThreadId) } : {}) });
    // A native fork has no first_user_message of its own until another turn. Keep the current rewind checkpoint
    // discoverable across desktop restarts without inventing a user message just to make the engine list it.
    if (!options.cursor && !options.ancestorThreadId && !options.archived) {
      for (const id of await this.#rewindHistory.currentIds()) {
        if (result.data.some(thread => thread.id === id)) continue;
        const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false }).catch(() => ({}));
        if (!thread || thread.path?.includes('/archived_sessions/')) continue;
        if (options.searchTerm && !`${thread.name ?? ''} ${thread.preview ?? ''}`.toLowerCase().includes(options.searchTerm.trim().toLowerCase())) continue;
        result.data.unshift(thread);
      }
    }
    await this.#loadWorkflowTitles(result.data);
    // Auto-review's reviewer works in threads of its own; they are not the user's chats.
    const data = result.data.filter(thread => thread.source?.subAgent?.other !== 'guardian' && (includeAgentRuns || !isAgentRun(thread))).map(thread => this.#decorate(thread));
    // Follow working agents live: only subscribers receive their items, approvals and deltas.
    for (const thread of data) if (thread.status?.type === 'active' && !this.#owned.has(thread.id)) void this.#attach(thread.id).catch(() => {});
    return { ...result, data };
  }
  /** Rejoins without model, policy, history or workspace changes. Desktop MCP follows cold resumes;
   * the engine preserves the configuration of threads still loaded by another client. */
  #attach(id) {
    threadId(id);
    if (this.#owned.has(id) && !this.#attaching.has(id)) return Promise.resolve(null);
    if (this.#attaching.has(id)) return this.#attaching.get(id);
    const browserOptions = this.#browserOptions(id);
    this.#owned.add(id);
    const attempt = this.#rpc('thread/resume', { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' }, ...browserOptions })
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
    const items = await this.#itemsPage({ threadId: id, cursor: options.cursor, limit: options.limit ?? 30, sortDirection: 'desc' });
    return { thread: this.#decorate(thread), ...items };
  }
  async readPrompts(id) {
    threadId(id);
    const prompts = new Map(), cursors = new Set();
    let cursor;
    do {
      const page = await this.readThread(id, cursor ? { cursor, limit: 100 } : { limit: 100 });
      for (const { turnId, item } of page.data) {
        if (item?.type !== 'userMessage' || typeof turnId !== 'string') continue;
        const text = Array.isArray(item.content) ? item.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
        prompts.set(turnId, Array.from(text.trim()).slice(0, 200).join(''));
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new BridgeError('Repeated history cursor', 502);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { data: [...prompts].reverse().map(([turnId, text]) => ({ turnId, text })) };
  }
  /** One page of a chat's items. A chat Elpis keeps only as whole turns (older history, or a new chat before its
   * first message is recorded) has no item pages: the engine answers -32601, and the TUI then reads whole turns
   * (its LegacyOnly history). So does this: the page is cut from thread/read's turns, behind a cursor of its own. */
  async #itemsPage(params) {
    const own = typeof params.cursor === 'string' && params.cursor.startsWith(WHOLE_TURNS);
    if (!own) {
      try { return await this.#rpc('thread/items/list', params); }
      catch (error) { if (error.code !== -32601) throw error; }
    }
    const start = own ? Number(params.cursor.slice(WHOLE_TURNS.length)) : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new BridgeError('Invalid cursor');
    let turns;
    try { turns = (await this.#rpc('thread/read', { threadId: params.threadId, includeTurns: true })).thread?.turns ?? []; }
    catch (error) { if (/is not materialized yet/.test(error.engineMessage ?? '')) turns = []; else throw error; }
    const entries = turns.filter(turn => !params.turnId || turn.id === params.turnId)
      .flatMap(turn => (Array.isArray(turn.items) ? turn.items : []).map(item => ({ turnId: turn.id, item })));
    if (params.sortDirection === 'desc') entries.reverse();
    const end = start + (params.limit ?? 30);
    return { data: entries.slice(start, end), nextCursor: end < entries.length ? `${WHOLE_TURNS}${end}` : null, backwardsCursor: null };
  }
  async media(id, turn, itemId, inputIndex) {
    threadId(id); text(turn, 'turn ID', 200); text(itemId, 'item ID', 200);
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex > 100) throw new BridgeError('Invalid media index');
    const cursors = new Set(); let cursor;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await this.#itemsPage({ threadId: id, turnId: turn, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || page.data.some(entry => entry?.turnId !== turn)) throw new BridgeError('Could not verify recorded media', 502);
      const entry = page.data.find(entry => entry.item?.id === itemId);
      if (entry) {
        // An image the agent viewed is its one picture.
        if (entry.item.type === 'imageView' && inputIndex === 0 && typeof entry.item.path === 'string') return recordedMedia({ type: 'localImage', path: entry.item.path });
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
        this.#rpc('config/read', { includeLayers: true }),
        this.#rpc('configRequirements/read', {}).catch(() => null),
      ]);
      if (policy === null) throw new BridgeError('Connection policy could not be read. Try again after reconnecting.', 503);
      const managed = policy.requirements;
      if (managed?.modelProvider && managed.modelProvider !== options.provider) throw new BridgeError('This connection is restricted by your organization', 403);
      // config/read reflects current defaults; model/list retains the engine's startup
      // catalog. An explicit API connection always lists its own endpoint.
      if (options.provider !== 'openai' || options.provider !== read?.config?.model_provider) {
        const definitions = { ...BUILT_IN_KEY_PROVIDERS, ...(read?.config?.model_providers ?? {}), ...(managed?.modelProviders ?? {}) };
        if (!Object.hasOwn(definitions, options.provider)) throw new BridgeError('This connection needs a saved API address before Elpis can list its models. Add a connection in Settings → Models & accounts.');
        try { return await providerModels(definitions[options.provider], { savedKey: savedProviderKey(configHome(read), options.provider) }); }
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
    return settingsSnapshot(read, requirements, pruner, savedProviderKeyIds(configHome(read)));
  }
  async saveSettings(input) {
    object(input, ['version', 'main', 'background', 'memory', 'options']);
    text(input.version, 'settings version', 200);
    const current = await this.settings();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const edits = [];
    const nullableModel = value => value === null ? null : text(value, 'model ID', 200).trim();
    // The main model (what new chats start with, in this app and the TUI) and the background model, each a model and
    // the provider it runs on; the main model can't be cleared, and a provider pinned by requirements can't change.
    const modelChoice = (choice, modelKey, providerKey, main) => {
      object(choice, ['model', 'provider']);
      if ('model' in choice) {
        if (main && choice.model === null) throw new BridgeError('Choose a main model');
        edits.push({ keyPath: modelKey, value: nullableModel(choice.model), mergeStrategy: 'replace' });
      }
      if ('provider' in choice) {
        const provider = choice.provider;
        if (provider !== null && !current.providers.some(item => item.id === provider)) throw new BridgeError('Choose a configured provider');
        if (main && current.managed.modelProvider && provider !== current.managed.modelProvider) throw new BridgeError('Your requirements pin the main provider', 403);
        edits.push({ keyPath: providerKey, value: provider, mergeStrategy: 'replace' });
      }
    };
    if (input.main !== undefined) modelChoice(input.main, 'model', 'model_provider', true);
    if (input.background !== undefined) modelChoice(input.background, 'background_model', 'background_provider', false);
    if (input.memory !== undefined) {
      object(input.memory, ['enabled', 'generate', 'use', 'skipExternalContext', 'extractionModel', 'consolidationModel']);
      const switches = ['enabled', 'generate', 'use', 'skipExternalContext'];
      for (const [field, key] of Object.entries({ enabled: 'features.memories', generate: 'memories.generate_memories', use: 'memories.use_memories', skipExternalContext: 'memories.disable_on_external_context', extractionModel: 'memories.extract_model', consolidationModel: 'memories.consolidation_model' })) {
        if (!(field in input.memory)) continue;
        const value = input.memory[field];
        if (switches.includes(field) && typeof value !== 'boolean') throw new BridgeError('Memory choices must be enabled or disabled');
        edits.push({ keyPath: key, value: switches.includes(field) ? value : nullableModel(value), mergeStrategy: 'replace' });
      }
    }
    if (input.options !== undefined) {
      try { edits.push(...optionEdits(input.options, current.managed, current.permissionProfiles)); }
      catch (error) { throw new BridgeError(error.message, /managed/.test(error.message) ? 403 : 400); }
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
    const [account, limits, read, models, anthropic] = await Promise.all([
      this.#rpc('account/read', { refreshToken: false }).catch(error => ({ error: error.message })),
      this.#rpc('account/rateLimits/read', {}).catch(error => ({ error: error.message })),
      this.#rpc('config/read', { includeLayers: false }),
      this.#rpc('model/list', { limit: 100, includeHidden: false }).catch(() => null),
      // Elpis's own Anthropic sign-out; a bridge that predates it has none.
      this.#rpc('claudeSubscription/read', {}).catch(() => null),
    ]);
    return providersSnapshot({ account, limits, config: read?.config, models: Array.isArray(models?.data) ? models.data : null, anthropic });
  }
  async providerSettings() {
    const [read, requirements] = await Promise.all([
      this.#rpc('config/read', { includeLayers: true }),
      this.#rpc('configRequirements/read', {}).catch(() => null),
    ]);
    return providerSettingsSnapshot(read, requirements, process.env, savedProviderKeyIds(configHome(read)));
  }
  /** Saves a pasted API key to the Elpis home's private key file; the key is never sent back. */
  async saveProviderKey(input) {
    object(input, ['provider', 'key']);
    const [read, requirements] = await Promise.all([this.#rpc('config/read', { includeLayers: true }), this.#rpc('configRequirements/read', {}).catch(() => null)]);
    const id = typeof input.provider === 'string' ? input.provider : '';
    if (requirements === null || requirements?.requirements?.modelProviders?.[id] || !acceptsPastedKey(id, providerDefinition(read, id))) throw new BridgeError('This connection does not take an API key here.', 403);
    saveProviderKey(configHome(read), id, input.key);
    return this.providerSettings();
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
    if (body.action === 'anthropicSignOut' || body.action === 'anthropicSignIn') return this.#anthropicSignedOut(body.action === 'anthropicSignOut');
    if (body.action !== 'chatgpt') throw new BridgeError('Choose a ChatGPT or Anthropic sign-in or sign-out');
    const result = await this.#rpc('account/login/start', { type: 'chatgpt' });
    if (typeof result?.authUrl !== 'string' || !/^https:\/\//.test(result.authUrl)) throw new BridgeError('Elpis did not return a sign-in page', 502);
    return { authUrl: result.authUrl, loginId: string(result.loginId) };
  }
  /** Elpis's own Anthropic sign-out, kept by the Elpis bridge for the terminal and every window: only Elpis stops using
   * the Claude subscription. Claude Code's login and the ChatGPT account are not touched. Every window reloads its
   * models and usage as it does when the ChatGPT account changes. */
  async #anthropicSignedOut(signedOut) {
    let answer;
    try { answer = await this.#rpc('claudeSubscription/write', { signedOut }); }
    catch (error) {
      if (/unknown (method|variant)|method not found/i.test(error.message)) throw new BridgeError('Update and restart Elpis to sign out of Anthropic from this app.', 503);
      throw error;
    }
    this.emit('event', { type: 'account', data: { method: 'claudeSubscription/write' } });
    return { anthropicSignedOut: answer?.signedOut === true };
  }
  async mcp() { return mcpSnapshot(await this.#rpc('config/read', { includeLayers: true })); }
  /** Claude's Customize page: the skills found for a project, the installed plugins and the connectors (gh and MCP).
   * A part the engine can't give says why, and the others still show. */
  async customize(cwd) {
    if (cwd != null) { text(cwd, 'project folder', 4096); if (!path.isAbsolute(cwd)) throw new BridgeError('Choose a project folder'); }
    const cwds = cwd ? [cwd] : [], why = error => ({ error: error instanceof Error ? error.message : 'Unavailable' });
    const [skills, plugins, connectors, github] = await Promise.all([
      this.#rpc('skills/list', { cwds, forceReload: true }).then(skillsSnapshot, why),
      this.#rpc('plugin/installed', cwd ? { cwds } : {}).then(pluginsSnapshot, why),
      this.mcp().then(snapshot => ({ data: snapshot.servers.map(({ name, enabled, transport }) => ({ name, enabled, transport })) }), why),
      this.#githubConnector.snapshot().then(data => ({ data }), why),
    ]);
    return { skills, plugins, connectors: { data: [...(github.data ? [github.data] : []), ...(connectors.data ?? [])],
      ...((connectors.error || github.error) ? { error: [github.error, connectors.error].filter(Boolean).join(' ') } : {}) } };
  }
  async setGithubConnector(input) {
    object(input, ['enabled', 'cwd']);
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    if (input.cwd != null) { text(input.cwd, 'project folder', 4096); if (!path.isAbsolute(input.cwd)) throw new BridgeError('Choose a project folder'); }
    await this.#githubConnector.setEnabled(input.enabled);
    return this.customize(input.cwd);
  }
  /** Turns one listed skill on or off (native skills/config/write), then lists again. */
  async setSkill(input) {
    object(input, ['path', 'enabled', 'cwd']); text(input.path, 'skill', 4096);
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    if (!(await this.customize(input.cwd)).skills.data?.some(skill => skill.path === input.path)) throw new BridgeError('That skill is not listed', 404);
    await this.#rpc('skills/config/write', { path: input.path, enabled: input.enabled });
    return this.customize(input.cwd);
  }
  async deleteSkill(input) {
    object(input, ['path', 'cwd']); text(input.path, 'skill', 4096);
    const snapshot = await this.customize(input.cwd);
    if (!snapshot.skills.data) throw new BridgeError(snapshot.skills.error || 'Skills could not be listed');
    const read = await this.#rpc('config/read', { includeLayers: true, ...(input.cwd ? { cwd: input.cwd } : {}) });
    let deleted;
    try { deleted = await this.#skillTrash.delete(input.path, snapshot.skills.data, skillRoots(read, input.cwd)); }
    catch (error) { throw new BridgeError(error.message); }
    return { ...await this.customize(input.cwd), deleted };
  }
  async undoSkillDelete(input) {
    object(input, ['token', 'cwd']); text(input.token, 'Undo token', 128);
    if (input.cwd != null) { text(input.cwd, 'project folder', 4096); if (!path.isAbsolute(input.cwd)) throw new BridgeError('Choose a project folder'); }
    try { await this.#skillTrash.undo(input.token); }
    catch (error) { throw new BridgeError(error.message); }
    return this.customize(input.cwd);
  }
  async hooks() {
    const [list, read] = await Promise.all([this.#rpc('hooks/list', {}), this.#rpc('config/read', { includeLayers: true })]);
    return hooksSnapshot(list, read);
  }
  /** Enables, disables or trusts one discovered hook through native `hooks.state`, as the Elpis terminal does. */
  async saveHook(input) {
    object(input, ['version', 'key', 'enabled', 'trust']);
    text(input.version, 'hooks version', 200); text(input.key, 'hook', 1000);
    if ((input.enabled === undefined) === (input.trust === undefined)) throw new BridgeError('Choose enable, disable or trust');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new BridgeError('Choose enabled or disabled');
    if (input.trust !== undefined && input.trust !== true) throw new BridgeError('Trust must be confirmed');
    const current = await this.hooks();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const hook = current.hooks.find(item => item.key === input.key);
    if (!hook) throw new BridgeError('This hook is no longer configured. Reload hooks.', 409);
    if (hook.managed) throw new BridgeError('Managed hooks cannot be changed here', 403);
    if (input.trust && !hook.currentHash) throw new BridgeError('Elpis did not report this hook’s current version', 502);
    const state = input.trust ? { trusted_hash: hook.currentHash } : { enabled: input.enabled };
    await this.#rpc('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: { [hook.key]: state }, mergeStrategy: 'upsert' }], expectedVersion: input.version, reloadUserConfig: true });
    return this.hooks();
  }
  async resetMemories(body) {
    object(body, []);
    await this.#rpc('memory/reset', undefined);
    return { reset: true };
  }
  // Private subprocess configuration. HTTP responses expose only the selected route, never this object.
  async transcriptionDefinition() {
    const read = await this.#rpc('config/read', { includeLayers: false });
    return read.config?.mcp_servers?.whispertype ?? null;
  }
  /** What dictation needs besides that definition, read privately and never sent to the renderer: whether Elpis is signed in to
   * ChatGPT with a sign-in file WhisperType can read (`<home>/auth.json`; only its existence is checked), the Elpis home, and the
   * Gemini API key it holds. The key is used only for Google's own address; a Google Gemini connection pointed elsewhere gets none. */
  async transcriptionEnvironment() {
    const [read, account] = await Promise.all([this.#rpc('config/read', { includeLayers: true }), this.#rpc('account/read', { refreshToken: false }).catch(() => null)]);
    const home = configHome(read), gemini = providerDefinition(read, 'google-gemini');
    const official = gemini?.base_url === BUILT_IN_KEY_PROVIDERS['google-gemini'].base_url;
    const key = official ? savedProviderKey(home, 'google-gemini') || (typeof gemini.env_key === 'string' ? process.env[gemini.env_key] : '') || '' : '';
    return { chatgpt: account?.account?.type === 'chatgpt' && !!home && fs.existsSync(path.join(home, 'auth.json')), home, geminiKey: key.trim() || null };
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
      // null is Automatic: no explicit backend, so the bridge picks the ChatGPT sign-in or Local (see bridge/transcription.mjs).
      if (input.backend !== null && !['openrouter', 'codex', 'local'].includes(input.backend)) throw new BridgeError('Choose OpenRouter, Codex sign-in or local transcription');
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
  /** Context sources and admission use the same engine functions as the TUI Ledger. */
  async contextFiles(id) {
    threadId(id);
    return this.#rpc('thread/contextFiles/list', { threadId: id });
  }
  async setContextFile(id, input) {
    threadId(id); object(input, ['path', 'included']);
    text(input.path, 'context file path');
    if (typeof input.included !== 'boolean') throw new BridgeError('Choose included or excluded');
    return this.#rpc('thread/contextFiles/set', { threadId: id, path: input.path, included: input.included });
  }
  async context(id) {
    threadId(id);
    const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    const { desktopAccess } = this.#decorate(thread);
    const snapshot = this.#context.get(id) ?? {};
    // Before this connection has live usage, the last usage the chat's rollout recorded (what a cold resume restores).
    const restored = snapshot.tokenUsage ? null : await this.#restoredUsage(thread.path);
    const tokenUsage = snapshot.tokenUsage ?? restored;
    // The TUI has the shares only once its own process has seen a request; for a chat this app has not seen run, the saved transcript stands in.
    const saved = tokenUsage && !tokenUsage.contextAttribution ? await this.#savedShares(thread.path) : null;
    return {
      threadId: id, tokenUsage, smartPrune: snapshot.smartPrune ?? null, ledger: contextLedger(tokenUsage, saved),
      // The ledger's Compact session, as the terminal's /compact: only a chat that is idle and takes turns here.
      compact: thread.status?.type === 'active' ? { available: false, reason: 'Available when Elpis finishes this turn' }
        : desktopAccess.mode === 'continue' ? { available: false, reason: 'Only this agent\'s parent can compact it' } : { available: true },
      availability: { tokenUsage: snapshot.tokenUsage ? 'live' : restored ? 'restored' : 'unavailable', smartPrune: snapshot.smartPrune ? 'live' : 'unavailable' },
      reason: 'Live usage comes from events this app connection receives; before them, the last usage the chat\'s rollout recorded. Until the engine reports its category shares for a request, they are estimated from the chat\'s saved transcript.',
    };
  }
  async #savedShares(file) {
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return null;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = this.#shares.get(file);
    if (cached?.key === key) return cached.value;
    const value = await rolloutShares(file);
    this.#shares.set(file, { key, value });
    return value;
  }
  async #restoredUsage(file) {
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return null;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = this.#restored.get(file);
    if (cached?.key === key) return cached.value;
    const value = await restoredTokenUsage(file);
    this.#restored.set(file, { key, value });
    return value;
  }
  /** The Context Ledger's Smart Prune, Subagents and RAG switches (elpis-features.mjs `contextSwitchesSnapshot`). */
  async contextSwitches() { return contextSwitchesSnapshot(await this.#rpc('config/read', { includeLayers: true })); }
  /** Writes the switches as the TUI ledger does: one config key each, reloaded so open chats use it from their next turn. */
  async saveContextSwitches(input) {
    object(input, ['version', ...Object.keys(CONTEXT_SWITCH_KEYS)]);
    text(input.version, 'settings version', 200);
    const current = await this.contextSwitches();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const edits = [];
    for (const [field, keyPath] of Object.entries(CONTEXT_SWITCH_KEYS)) {
      if (!(field in input)) continue;
      if (typeof input[field] !== 'boolean') throw new BridgeError('Turn each switch on or off');
      if (field === 'rag' && current.rag === null) throw new BridgeError('No rag MCP server is configured. Add one in Settings → MCP servers.', 409);
      edits.push({ keyPath, value: input[field], mergeStrategy: 'replace' });
    }
    if (!edits.length) throw new BridgeError('No switch was changed');
    try { await this.#rpc('config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); }
    catch (error) {
      if (error.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('The switch could not be saved. Refresh and try again.', error.status ?? 502);
    }
    if ('rag' in input) await this.#rpc('config/mcpServer/reload', undefined).catch(() => {});
    return this.contextSwitches();
  }
  #model(model) {
    if (model === undefined) return;
    if (!this.#models.has(model)) throw new BridgeError('Select a model returned by the current Elpis model list');
    return model;
  }
  async #providerModel(model, provider) {
    if (model !== undefined && provider) {
      const current = await this.providerSettings();
      // A custom connection, or the engine's gateway route (e.g. the Anthropic credits), whose models it lists itself.
      if (current.providers.some(entry => entry.id === provider && (entry.editable || entry.gateway))) {
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
    const native = await this.#rpc('workGraph/list', {rootThreadId:id});
    return { data: [...(native.data ?? []), ...await this.#workflowRuns.list(id)] };
  }
  /** One stage's tasks, checked as the scheduler takes them. */
  #workflowTasks(tasks) {
    if(!Array.isArray(tasks)||tasks.length<1||tasks.length>256)throw new BridgeError('A workflow must contain 1–256 tasks');
    return tasks.map(task=>{
      object(task,['id','kind','title','instruction','dependsOn','environmentId','writeScopes','acceptanceCriteria','provider','model','reasoningEffort','feedbackFrom']);
      if(!['explore','implement','verify','fix'].includes(task.kind))throw new BridgeError('Unknown task role');
      const next={id:text(task.id,'task ID',100),kind:task.kind,title:text(task.title,'task title',256),instruction:text(task.instruction,'task instructions')};
      for(const key of ['dependsOn','writeScopes','acceptanceCriteria']){
        if(!Array.isArray(task[key])||task[key].length>256)throw new BridgeError(`Invalid ${key}`);
        next[key]=task[key].map(value=>text(value,key,4096));
      }
      if(task.feedbackFrom!==undefined){
        if(!Array.isArray(task.feedbackFrom)||task.feedbackFrom.length>256)throw new BridgeError('Invalid feedback dependencies');
        next.feedbackFrom=task.feedbackFrom.map(value=>text(value,'feedback dependency',100));
      }
      if(task.environmentId!==undefined)throw new BridgeError('ACP workflows currently run in the selected local project; environment IDs are not supported');
      if(task.provider!==undefined){
        next.provider=text(task.provider,'task provider',100);
        if(!/^[A-Za-z0-9_.-]+$/.test(next.provider))throw new BridgeError('Invalid ACP provider');
        if(task.model===undefined)throw new BridgeError('A task provider requires an explicit model');
      }
      if(task.model!==undefined){
        next.model=text(task.model,'task model',200);
        if(!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(next.model))throw new BridgeError('Invalid ACP model ID');
      }
      if(task.reasoningEffort!==undefined)next.reasoningEffort=this.#effort(task.reasoningEffort);
      return next;
    });
  }
  /** A stage's limits: how many agents at once, how long, and whether writers work in worktrees. */
  #workflowLimits(body,params){
    for(const key of ['maxConcurrency','maxRuntimeSeconds'])if(body[key]!==undefined){
      if(!Number.isSafeInteger(body[key])||body[key]<1||(key==='maxConcurrency'&&body[key]>32)||(key==='maxRuntimeSeconds'&&body[key]>2147483))throw new BridgeError(`Invalid ${key}`);
      params[key]=body[key];
    }
    // 'worktree': each implement/fix task works in its own git worktree, merged after the run.
    if(body.isolation!==undefined){
      if(body.isolation!=='worktree')throw new BridgeError('Workflow isolation must be "worktree" or absent');
      params.isolation=body.isolation;
    }
    return params;
  }
  /** `next`: the stage that runs after this one has succeeded (the Father's part), in its own chat (`thread`). The bridge
   * starts it and delivers its report here (#workflowEnded), so the run goes on with the Workflows screen closed. */
  async runWorkflow(body) {
    object(body, ['rootThreadId','name','tasks','maxConcurrency','maxRuntimeSeconds','isolation','roundLimit','next']);
    const id=threadId(body.rootThreadId);
    const params=this.#workflowLimits(body,{rootThreadId:id,name:text(body.name,'workflow name',256),tasks:this.#workflowTasks(body.tasks)});
    if(body.roundLimit!==undefined)params.roundLimit=body.roundLimit;
    if(body.next!==undefined){
      object(body.next,['name','tasks','thread','maxConcurrency','isolation']);
      object(body.next.thread,['name','instructions','model','provider']);
      const thread={name:text(body.next.thread.name,'chat name',120),instructions:text(body.next.thread.instructions,'chat instructions',32000),
        ...(body.next.thread.model!==undefined?{model:text(body.next.thread.model,'model',200)}:{}),...(body.next.thread.provider!==undefined?{provider:text(body.next.thread.provider,'provider',200)}:{})};
      params.next=this.#workflowLimits(body.next,{name:text(body.next.name,'workflow name',256),tasks:this.#workflowTasks(body.next.tasks),thread,status:'waiting'});
    }
    return this.#mutate(id,async()=>{
      const current=await this.#current(id);
      if(current.desktopAccess.mode==='continue')throw new BridgeError('Run workflows from a root conversation; this agent takes turns only from its parent',409);
      if(current.status?.type==='active')throw new BridgeError('Wait for the current turn to finish before running a workflow',409);
      return this.#workflowRuns.start(params,current);
    });
  }
  /** A run has ended. A stage that succeeded starts its `next` in a new chat; one that failed or stopped never does. A
   * run started that way (`report`) sends its report to the chat it came from. */
  async #workflowEnded(record) {
    const from=record.report?.from??record.id;
    try{
      if(record.report){
        const lines=[`Report from the Father · ${record.rootThreadId}`,`Work graph: ${record.id}`,`Status: ${record.status}`,record.error,
          ...record.tasks.map(task=>`${task.title}: ${task.status}\n${JSON.stringify(task.result??{failure:task.failureReason??null})}`),
          "This is the Father's completed run report. Acknowledge it briefly without tools, edits, or another run."].filter(Boolean);
        // A refused delivery is tried again a few times; the reason stays on her record if it never goes through.
        for(let attempt=1;;attempt++){
          try{await this.send(record.report.to,{text:lines.join('\n\n')});break;}
          catch(error){
            if(attempt>=this.#reportAttempts){await this.#workflowRuns.note(from,{status:record.status,reported:false,error:`Father report not delivered: ${String(error?.message??error).slice(0,300)}`});return;}
            await new Promise(resolve=>setTimeout(resolve,this.#reportRetryMs*attempt));
          }
        }
        await this.#workflowRuns.note(from,{status:record.status,reported:true,error:null});
        return;
      }
      const next=record.next;
      if(!next||next.threadId||next.status!=='waiting')return;
      if(record.status!=='succeeded'){await this.#workflowRuns.note(from,{status:'cancelled'});return;}
      const mother=await this.#current(record.rootThreadId);
      const created=await this.createThread({...(mother.cwd?{cwd:mother.cwd}:{}),agents:true,name:next.thread.name,instructions:next.thread.instructions,
        ...(next.thread.model?{model:next.thread.model}:{}),...(next.thread.provider?{provider:next.thread.provider}:{})});
      const {thread:_thread,status:_status,...stage}=next;
      const run=await this.#workflowRuns.start({...stage,rootThreadId:created.thread.id,report:{to:record.rootThreadId,from:record.id}},created.thread);
      await this.#workflowRuns.note(from,{threadId:created.thread.id,graphId:run.graphId,status:'running'});
    }catch(error){await this.#workflowRuns.note(from,{status:'failed',error:String(error?.message??error).slice(0,500)}).catch(()=>{});}
  }
  /** `agents`: the chat runs the agents canvas's graph, so the multi-agent runtime is on for it alone; the Ledger's
   * SUBAGENTS switch (features.multi_agent) keeps deciding whether a model may delegate in every other chat. */
  async createThread(body) {
    object(body, ['cwd', 'model', 'provider', 'name', 'instructions', 'permissions', 'worktree', 'agents']);
    if (body.worktree !== undefined && typeof body.worktree !== 'boolean') throw new BridgeError('worktree must be true or false');
    if (body.agents !== undefined && typeof body.agents !== 'boolean') throw new BridgeError('agents must be true or false');
    if (body.worktree && body.cwd === undefined) throw new BridgeError('A worktree needs the project\'s folder');
    const permissions = permissionMode(body.permissions);
    const name = body.name === undefined ? undefined : text(body.name, 'agent name', 120).trim();
    const ownInstructions = body.instructions === undefined ? undefined : text(body.instructions, 'agent instructions', 32000);
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
    const instructions = [ownInstructions, await this.#githubConnector.instructions()].filter(Boolean).join('\n\n');
    // Claude's "Start with worktree": the chat works in its own worktree on a new branch; if it does not start, the
    // worktree goes again.
    const made = body.worktree ? await createChatWorktree(body.cwd) : null, cwd = made?.cwd ?? body.cwd;
    const browserSession = `pending-${randomUUID()}`;
    const config = { ...this.#browserOptions(browserSession).config, ...(body.agents ? { 'features.multi_agent': true } : {}) };
    let result;
    try {
      result = await this.#rpc('thread/start', { ...(cwd ? { cwd } : {}), ...(model ? { model } : {}),
        ...(body.provider ? { modelProvider: body.provider } : {}), ...(instructions ? { developerInstructions: instructions } : {}), ...threadPermissions(permissions),
        ...(Object.keys(config).length ? { config } : {}) });
      threadId(result.thread?.id);
    } catch (error) { this.#browserConfig?.close?.(browserSession); if (made) await undoChatWorktree(made); throw error; }
    this.#browserConfig?.bind?.(browserSession, result.thread.id);
    this.#owned.add(result.thread.id);
    if (name) { await this.#rpc('thread/name/set', { threadId: result.thread.id, name }); result.thread.name = name; }
    return { ...result, thread: this.#decorate(result.thread), ...(made ? { worktree: { path: made.root, branch: made.branch } } : {}) };
  }
  /** After a chat is archived or deleted: its worktree, when it has one that no open chat still works in, is removed if
   * nothing in it is uncommitted, and kept otherwise (bridge/git.mjs releaseChatWorktree). */
  async #releaseWorktree(cwd) {
    if (!isChatWorktreePath(cwd)) return null;
    const inUse = await this.#rpc('thread/list', { cwd, limit: 1, modelProviders: [], sourceKinds: SOURCE_KINDS }).then(result => result.data?.length > 0, () => true);
    return inUse ? null : releaseChatWorktree(cwd);
  }
  /** Deletes a chat and its agents; chats forked from that subtree (continued agents) go first, since Elpis keeps history a fork uses. */
  async deleteThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      const removed = [], cwd = await this.#folderOf(id).catch(() => null);
      try { await this.#rpc('thread/delete', { threadId: id }); }
      catch (error) {
        if (!/forked history still references it/.test(error.message)) throw error;
        const listAll = options => scanDeletionThreads(page => this.listThreads({ ...options, ...page, includeAgentRuns: true })).catch(() => {
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
      const worktree = await this.#releaseWorktree(cwd);
      return { deleted: true, alsoDeleted: removed, ...(worktree ? { worktree } : {}) };
    });
  }
  /** The composer's `!` deliberately uses the engine's user shell command, not a model turn. */
  async shellCommand(id, body) {
    object(body, ['command']);
    const command = text(body.command, 'shell command');
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('This agent accepts direct input only from its parent.', 409);
      return this.#rpc('thread/shellCommand', { threadId: id, command });
    });
  }
  /** A side question inherits the current history but is never materialized as a saved session. */
  async createSideChat(id, body) {
    object(body, []);
    const thread = await this.#current(id);
    const result = await this.#rpc('thread/fork', { threadId: id, ephemeral: true, excludeTurns: true,
      ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
      approvalPolicy: 'never', sandbox: 'read-only' });
    const sideId = threadId(result.thread?.id);
    this.#side.add(sideId);
    if (result.thread.ephemeral !== true) {
      try { await this.sideRpc('thread/delete', { threadId: sideId }); }
      finally { await this.sideRpc('thread/unsubscribe', { threadId: sideId }).catch(() => {}); }
      throw new BridgeError('The runtime did not create an ephemeral side chat. Update Elpis and try again.', 502);
    }
    this.#sideChats.set(sideId, { turnId: null, starting: false, pending: null, closing: false });
    return { threadId: sideId };
  }
  async sendSideChat(id, body) {
    object(body, ['text']);
    const prompt = text(body.text, 'side question'), chat = this.#sideChats.get(threadId(id));
    if (!chat) throw new BridgeError('Side chat is no longer available.', 404);
    if (chat.starting || chat.pending || chat.turnId || chat.closing) throw new BridgeError('A side reply is already running or closing.', 409);
    chat.starting = true;
    try {
      chat.pending = this.sideRpc('turn/start', { threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      const result = await chat.pending;
      // Completion can arrive before the acknowledgement; do not revive an already completed turn.
      if (chat.starting) chat.turnId = result.turn?.id;
      return result;
    } finally { chat.starting = false; chat.pending = null; }
  }
  async closeSideChat(id, body) {
    object(body, []);
    const chat = this.#sideChats.get(threadId(id));
    if (!chat) throw new BridgeError('Side chat is no longer available.', 404);
    chat.closing = true;
    if (chat.pending) await chat.pending.catch(() => {});
    try { if (chat.turnId) await this.sideRpc('turn/interrupt', { threadId: id, turnId: chat.turnId }); }
    finally { await this.sideRpc('thread/unsubscribe', { threadId: id }); }
    this.#sideChats.delete(id);
    return { closed: true };
  }
  /** Renames a chat in Elpis; every client shows the stored name. */
  /** ChatGPT's "Fork chat from here": a new chat with this one's history through `lastTurnId`. */
  async forkThread(id, body) {
    object(body, ['lastTurnId']);
    const lastTurnId = body.lastTurnId === undefined ? undefined : text(body.lastTurnId, 'turn ID', 200);
    const thread = await this.#current(id);
    if (isAgentRun(thread) && !thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
    return this.#forkChat(thread, lastTurnId);
  }
  async #forkChat(thread, lastTurnId, suffix = 'fork') {
    const browserSession = `pending-${randomUUID()}`;
    const fork = await this.#rpc('thread/fork', { threadId: thread.id, ...(lastTurnId ? { lastTurnId } : {}), ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}), ...this.#browserOptions(browserSession) }).catch(error => { this.#browserConfig?.close?.(browserSession); throw error; });
    threadId(fork.thread?.id); this.#browserConfig?.bind?.(browserSession, fork.thread.id); this.#owned.add(fork.thread.id);
    const name = `${(thread.name?.trim() || String(thread.preview ?? '').split('\n')[0].trim() || 'Chat').slice(0, 110)} (${suffix})`;
    try { await this.#rpc('thread/name/set', { threadId: fork.thread.id, name }); fork.thread.name = name; } catch { /* The fork stands; it keeps its default title. */ }
    return { thread: this.#decorate(fork.thread) };
  }
  /** Explicitly continue a finished agent history in a user-owned chat, without starting a turn. */
  async continueThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      // A completed child can be read and forked even if its parent is not loaded; attaching it would fail.
      const result = await this.#rpc('thread/read', { threadId: threadId(id), includeTurns: false });
      if (result.thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
      const thread = this.#decorate(result.thread);
      if (thread.desktopAccess.writable) throw new BridgeError('This is already a normal chat.', 409);
      if (!thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
      return this.#forkChat(thread, undefined, 'continued');
    });
  }
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
      const cwd = await this.#folderOf(threadId(id)).catch(() => null);
      await this.#rpc('thread/archive', { threadId: id });
      await this.#rewindHistory.hide(id, true);
      this.#forget(id);
      const worktree = await this.#releaseWorktree(cwd);
      return { archived: true, ...(worktree ? { worktree } : {}) };
    });
  }
  async unarchiveThread(id, body) {
    object(body, []);
    return this.#mutate(id, async () => {
      const result = await this.#rpc('thread/unarchive', { threadId: threadId(id) });
      if (result.thread?.id !== id) throw new BridgeError('Elpis restored another thread', 502);
      await this.#rewindHistory.hide(id, false);
      const worktree = isChatWorktreePath(result.thread.cwd) ? await restoreChatWorktree(result.thread.cwd) : null;
      return { thread: this.#decorate(result.thread), ...(worktree ? { worktree } : {}) };
    });
  }
  /** Edit-and-resend and regenerate: Elpis drops the given turn and every later one (thread/revert), then the new text starts a turn.
   * Without `text` it is Rewind to here: the turns are dropped and nothing else happens. */
  async revert(id, body) {
    const rewind = body?.text === undefined && body?.model === undefined && body?.effort === undefined;
    object(body, rewind ? ['beforeTurnId'] : ['beforeTurnId', 'text', 'model', 'effort']);
    const beforeTurnId = text(body.beforeTurnId, 'turn ID', 200);
    const input = rewind ? [] : [{ type: 'text', text: ragMessage(text(body.text, 'message')), text_elements: [] }];
    const effort = this.#effort(body.effort);
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Elpis takes turns for this agent only from its parent, so its earlier messages cannot be replaced here.', 409);
      if (thread.status?.type === 'active') throw new BridgeError('Stop the running turn before replacing an earlier message.', 409);
      if (rewind) { await this.#rpc('thread/revert', { threadId: id, beforeTurnId }); return { rewound: true, beforeTurnId }; }
      const model = await this.#providerModel(body.model, thread.modelProvider);
      const entries = [], cursors = new Set(); let cursor, complete = false;
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
  /** Brings a chat back; a worktree removed when it was archived is put back on its branch. */
        const page = await this.#itemsPage({ threadId: id, turnId: beforeTurnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
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
      try { return await this.#startTurn(thread, { threadId: id, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }); }
      catch (error) {
        return { rewound: true, beforeTurnId, sendError: `Conversation was rewound, but its replacement message was not confirmed: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  }
  /** Claude's restore scopes. File checkpoints are bridge-owned; native forks keep Undo/Redo lossless. */
  async rewind(id, body) {
    object(body, ['action', 'beforeTurnId', 'mode', 'version']);
    if (!['preview', 'status', 'restore', 'undo', 'redo'].includes(body.action)) throw new BridgeError('Choose a rewind action.');
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Only this agent’s parent can rewind its conversation.', 409);
      if (thread.status?.type === 'active') throw new BridgeError('Rewind is unavailable while Elpis is working.', 409);
      try {
        if (body.action === 'status') return await this.#rewindHistory.status(id);
        if (body.action === 'undo' || body.action === 'redo') {
          const result = await this.#rewindHistory.toggle(id, body.action); await this.#attach(result.thread.id);
          return { ...result, thread: this.#decorate(result.thread) };
        }
        const turn = text(body.beforeTurnId, 'turn ID', 200);
        if (body.action === 'preview') return await this.#rewindSnapshots.preview(id, turn, thread.cwd);
        if (!['both', 'conversation', 'code'].includes(body.mode)) throw new BridgeError('Choose what to restore.');
        const files = async forkId => {
          if (body.mode !== 'conversation') await this.#rewindSnapshots.restore(id, turn, thread.cwd, text(body.version, 'file preview version', 64));
          if (forkId) await this.#rewindSnapshots.inherit(id, forkId);
        };
        if (body.mode === 'code') { await files(); return { rewound: true, mode: body.mode }; }
        const result = await this.#rewindHistory.restore(thread, turn, files); this.#owned.add(result.thread.id);
        return { ...result, thread: this.#decorate(result.thread), rewound: true, mode: body.mode };
      } catch (error) { throw error instanceof BridgeError ? error : new BridgeError(error.message, 409); }
    });
  }
  async #startTurn(thread, params) {
    // Snapshot before turn/start can execute tools. Non-Git or oversized folders still support conversation rewind.
    const pending = `pending-${randomUUID()}`; let snapshot = false;
    try { await this.#rewindSnapshots.capture(thread.id, pending, thread.cwd); snapshot = true; } catch { /* Preview reports unavailable. */ }
    const result = await this.#rpc('turn/start', params);
    await this.#rewindHistory.invalidate(thread.id);
    if (snapshot && result.turn?.id) await this.#rewindSnapshots.alias(thread.id, pending, result.turn.id).catch(() => {});
    return result;
  }
  /** Opens a chat live in this app: subscribes it and reports the turn it is running, if any. */
  async resume(id, body) {
    object(body, []);
    const result = await this.#attach(id);
    if (result) {
      const active = (result.initialTurnsPage?.data ?? result.thread.turns ?? []).find(turn => turn.status === 'inProgress');
      return { thread: this.#decorate({ ...result.thread, model: result.model ?? result.thread.model, serviceTier: result.serviceTier ?? null, reasoningEffort: result.reasoningEffort ?? result.thread.reasoningEffort }), activeTurnId: active?.id ?? null, permissions: modeOf(result), planMode: result.collaborationMode?.mode === 'plan' };
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
    object(body, ['text', 'model', 'effort', 'continueAs', 'attachments', 'mentions', 'permissions', 'mode']);
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, body.attachments, body.mentions);
    const effort = this.#effort(body.effort), permissions = permissionMode(body.permissions);
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (!thread.desktopAccess.writable && !body.continueAs) throw new BridgeError(`${AGENT_RUN_NOTICE}. Choose Continue here after it finishes (continued conversation name required).`, 409);
      if (!thread.desktopAccess.writable && !thread.desktopAccess.canContinue) throw new BridgeError('Wait for this background run to finish before continuing here.', 409);
      const model = await this.#providerModel(body.model, thread.modelProvider);
      const overrides = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...turnPermissions(permissions), ...collaborationMode(body.mode, model ?? thread.model, effort ?? thread.reasoningEffort) };
      if (thread.desktopAccess.mode === 'continue') {
        // The agent's own thread refuses direct turns; a fork carries its whole history and recorded model.
        const name = text(body.continueAs, 'continued conversation name', 200).trim();
        const browserSession = `pending-${randomUUID()}`;
        const fork = await this.#rpc('thread/fork', { threadId: id, model: model ?? thread.model ?? undefined, modelProvider: thread.modelProvider, ...this.#browserOptions(browserSession) }).catch(error => { this.#browserConfig?.close?.(browserSession); throw error; });
        threadId(fork.thread?.id); this.#browserConfig?.bind?.(browserSession, fork.thread.id); this.#owned.add(fork.thread.id);
        const continued = { thread: this.#decorate(fork.thread), continuedFrom: id };
        try { await this.#rpc('thread/name/set', { threadId: fork.thread.id, name }); }
        catch (error) {
          return { ...continued, sendError: `Conversation created, but its name could not be confirmed: ${error instanceof Error ? error.message : String(error)} Your message was not sent.` };
        }
        continued.thread.name = name;
        try {
          const started = await this.#startTurn(fork.thread, { threadId: fork.thread.id, input, ...overrides });
          return { ...started, ...continued };
        } catch (error) {
          // The fork is acknowledged even when the first send fails or its outcome is unknown.
          // Return it so the app can inspect that conversation instead of creating another fork.
          return { ...continued, sendError: `Conversation created, but its first message was not confirmed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (thread.status?.type === 'active') throw new BridgeError('This conversation is running. Use Steer with its active turn ID.', 409);
      return this.#startTurn(thread, { threadId: id, input, ...overrides });
    });
  }
  /** Changes a chat's permission mode now, as the terminal's /permissions does: the engine applies it to
   * the running turn and later ones, and a bridged (Claude, Antigravity) chat follows the engine's
   * thread/settings/updated. Returns the mode the engine reports, never the one asked for. */
  /** Change the current chat's speed through the engine; this never starts a model turn. */
  async setServiceTier(id, body) {
    object(body, ['enabled']);
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new BridgeError('Choose Fast on or off');
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (!thread.desktopAccess.writable) throw new BridgeError("Only this agent's parent can change its speed.", 409);
      const current = await this.#rpc('thread/resume', { threadId: id, excludeTurns: true });
      if (current.modelProvider !== 'openai') throw new BridgeError('/fast is available for OpenAI models.', 409);
      const enabled = body.enabled ?? !['fast', 'priority'].includes(current.serviceTier);
      let fastTier;
      if (enabled) {
        const models = await this.models();
        const model = models.data?.find(model => model.model === current.model);
        fastTier = fastServiceTier(model);
        if (!fastTier) throw new BridgeError(`${current.model} does not offer Fast on this account.`, 409);
      }
      const serviceTier = enabled ? fastTier : 'default';
      await this.#rpc('thread/settings/update', { threadId: id, serviceTier });
      const applied = await this.#rpc('thread/resume', { threadId: id, excludeTurns: true });
      if (applied.serviceTier !== serviceTier) throw new BridgeError('Elpis did not apply the requested speed. Try again.', 409);
      return { serviceTier };
    });
  }
  async setPermissions(id, body) {
    object(body, ['permissions']);
    const mode = permissionMode(body.permissions);
    if (!mode) throw new BridgeError('Choose a permission mode: ask, auto, full or bypass');
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError("Only this agent's parent can change its permissions.", 409);
      let resolveApplied;
      const applied = new Promise(resolve => { resolveApplied = resolve; });
      const waiters = this.#settingsWaiters.get(id) ?? new Set();
      waiters.add(resolveApplied); this.#settingsWaiters.set(id, waiters);
      let timer;
      try {
        await this.#rpc('thread/settings/update', { threadId: id, ...permissionSetting(mode, 'sandboxPolicy') });
        // The engine publishes settings only when they change; an unchanged mode is read back instead.
        const settings = await Promise.race([applied, new Promise(resolve => { timer = setTimeout(resolve, this.#settingsConfirmMs, null); })])
          ?? await this.#rpc('thread/resume', { threadId: id, excludeTurns: true });
        const now = modeOf(settings);
        if (now !== mode) throw new BridgeError(`Elpis did not apply ${mode} permissions to this chat; it is in ${now ?? 'an unknown'} mode.`, 409);
        if (now === 'full' || now === 'bypass') this.#allowWaiting(id);
        return { permissions: now };
      } finally {
        clearTimeout(timer); waiters.delete(resolveApplied);
        if (!waiters.size) this.#settingsWaiters.delete(id);
      }
    });
  }
  /** Moves a chat to another folder: its next turns run there (the engine's thread/settings/update `cwd`); earlier turns
   * keep the folder they ran in. Only an idle chat moves, and only to a folder that exists. Returns the folder the engine
   * reports. */
  async setFolder(id, body) {
    object(body, ['cwd']);
    if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd)) throw new BridgeError('Choose a folder by its full path');
    let cwd;
    try { cwd = await fs.promises.realpath(body.cwd); if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error('not a folder'); }
    catch { throw new BridgeError('That folder does not exist'); }
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.status?.type === 'active') throw new BridgeError('Wait for this turn to finish, then change the folder.', 409);
      await this.#rpc('thread/settings/update', { threadId: id, cwd });
      const { thread: now } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
      if (now?.cwd !== cwd) throw new BridgeError(`Elpis did not move this chat to ${cwd}.`, 409);
      return { cwd };
    });
  }
  /** Full access and Bypass permissions never ask, so what this chat was already asking when the person chose one
   * is answered as the new mode would have: allowed, once. Questions (forms, request_user_input) still wait for
   * the person, as do other chats' requests; "Approve for me" leaves requests already put to the person to them. */
  #allowWaiting(id) {
    for (const [key, pending] of [...this.#approvals]) {
      if (pending.params?.threadId !== id) continue;
      let body;
      if (pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval') body = { decision: 'accept' };
      else if (pending.method === 'mcpServer/elicitation/request' && pending.params._meta?.codex_approval_kind === 'mcp_tool_call') body = { action: 'accept', content: null, _meta: null };
      else if (pending.method === 'item/permissions/requestApproval') body = { permissions: grantedPermissions(pending.params.permissions ?? {}), scope: 'turn' };
      else continue;
      // Only a decision the request offers is sent (answerApproval checks); anything else stays on its card.
      try { this.answerApproval(key, body); } catch {}
    }
  }
  async steer(id, body) {
    object(body, ['text', 'expectedTurnId', 'attachments', 'mentions']);
    const input = attachmentInput(typeof body.text === 'string' && body.text.trim() ? ragMessage(text(body.text, 'message')) : body.text, body.attachments, body.mentions);
    const params = { threadId: id, expectedTurnId: text(body.expectedTurnId, 'turn ID', 200), input };
    return this.#mutate(id, async () => {
      const thread = await this.#current(id);
      if (thread.desktopAccess.mode === 'continue') throw new BridgeError('Wait for this agent to finish; a message then continues it in a new conversation.', 409);
      try { return await this.#rpc('turn/steer', params); }
      catch (error) {
        // The turn the app saw has ended or another replaced it: the message joins the running
        // turn, or starts a new one, as in the terminal, instead of failing.
        if (error.code !== -32600 || !/^(no active turn to steer|expected active turn id)/.test(error.engineMessage)) throw error;
        const running = (await this.#rpc('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(turn => turn.status === 'inProgress')?.id;
        if (running && running !== params.expectedTurnId) return this.#rpc('turn/steer', { ...params, expectedTurnId: running });
        if (running) throw error;
        return this.#startTurn(thread, { threadId: id, input });
      }
    });
  }
  /** Stops the given turn, or the agent's running turn when the caller has not seen its start. */
  async interrupt(id, body) {
    object(body, ['turnId']);
    threadId(id);
    if(this.#workflowRuns.cancel(id))return { interrupted: true };
    return this.#mutate(id, async () => {
      await this.#attach(id);
      let turnId = body.turnId === undefined ? null : text(body.turnId, 'turn ID', 200);
      turnId ??= (await this.#rpc('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data?.find(turn => turn.status === 'inProgress')?.id;
      if (!turnId) throw new BridgeError('This agent is not running', 409);
      return this.#rpc('turn/interrupt', { threadId: id, turnId });
    });
  }
  /** The chat, once it may take a command that runs its model: idle, and writable here (agents answer only to their parent). */
  async #idleChat(id, action, gerund) {
    const thread = await this.#current(id);
    if (thread.desktopAccess.mode === 'continue') throw new BridgeError(`Only this agent's parent can ${action} it.`, 409);
    if (thread.status?.type === 'active') throw new BridgeError(`Wait for the current turn to finish before ${gerund}.`, 409);
    return thread;
  }
  /** The terminal's /compact: the engine summarizes the chat's history now; `instructions` guides the summary. */
  async compact(id, body) {
    object(body, ['instructions']);
    const instructions = body.instructions === undefined ? undefined : text(body.instructions, 'compaction instructions', 32000).trim();
    return this.#mutate(id, async () => {
      await this.#idleChat(id, 'compact', 'compacting');
      return this.#rpc('thread/compact/start', { threadId: id, ...(instructions ? { instructions } : {}) });
    });
  }
  /** The terminal's /review: an inline review turn of one of its four targets. */
  async review(id, body) {
    object(body, ['target']);
    const target = reviewTarget(body.target);
    return this.#mutate(id, async () => {
      await this.#idleChat(id, 'review', 'starting a review');
      return this.#rpc('review/start', { threadId: id, target, delivery: 'inline' });
    });
  }
  /** Read-only Git facts about the chat's folder: `review` is the /review presets (branches, commits), `diff` the /diff text,
   * `changes` the review surface's file list, `file` one of those files' diff (`file` names it) and `branch` the branch
   * checked out, for the chat's branch chip. */
  async git(id, view, file) {
    threadId(id);
    if (!['review', 'diff', 'changes', 'file', 'branch'].includes(view)) throw new BridgeError('Choose a Git view: review, diff, changes, file or branch');
    const cwd = await this.#folderOf(id);
    try { return await (view === 'review' ? reviewChoices(cwd) : view === 'changes' ? changedFiles(cwd) : view === 'file' ? fileDiff(cwd, file) : view === 'branch' ? currentBranch(cwd) : workingDiff(cwd)); }
    catch (error) {
      // Outside Git, the changes are the edits this chat recorded (bridge/recorded-changes.mjs); /review needs Git.
      if (error.message !== NOT_A_REPOSITORY || !['changes', 'file', 'diff'].includes(view)) throw error;
      const recorded = recordedChanges(cwd, await this.#chatItems(id));
      return view === 'changes' ? recorded.changes : view === 'file' ? recorded.file(file) : recorded.diff();
    }
  }
  /** Every item of a chat, oldest first, at most 50 pages of 200. */
  async #chatItems(id) {
    const items = [], seen = new Set(); let cursor;
    for (let page = 0; page < 50; page++) {
      const result = await this.#itemsPage({ threadId: id, limit: 200, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      items.push(...(Array.isArray(result?.data) ? result.data : []).map(entry => entry?.item).filter(Boolean));
      cursor = result?.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return items;
  }
  /** The review surface's only write: throw one changed file away (the window asks first). */
  async discardChange(id, body) {
    threadId(id); object(body, ['action', 'path']);
    if (body.action !== 'discard') throw new BridgeError('Choose a Git action: discard');
    return discardFile(await this.#folderOf(id), body.path);
  }
  async #folderOf(id) {
    const { thread } = await this.#rpc('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError('Elpis returned another thread', 502);
    return thread.cwd;
  }
  async #mutate(id, run) {
    threadId(id);
    if (this.#mutating.has(id)) throw new BridgeError('Another operation on this conversation is pending', 409);
    this.#mutating.add(id);
    try { return await run(); } finally { this.#mutating.delete(id); }
  }
  #workflowPermission(record, task, request, signal) {
    const choices = new Map();
    for (const option of request.options ?? []) {
      const decision = { allow_once: 'accept', allow_always: 'acceptForSession', reject_once: 'decline', reject_always: 'decline' }[option.kind];
      if (decision && !choices.has(decision)) choices.set(decision, option.optionId);
    }
    const id = randomUUID(), approval = { id, wireId: `acp-${id}`, method: 'item/commandExecution/requestApproval', supported: true,
      params: { threadId: record.rootThreadId, turnId: record.id, command: request.toolCall?.title || task.title, availableDecisions: [...choices.keys()] } };
    return new Promise(resolve => {
      const finish = option => { signal.removeEventListener('abort', abort); resolve(option); };
      const abort = () => { this.#approvals.delete(id); this.#acpApprovals.delete(id); this.emit('event', { type: 'approvalResolved', data: { id } }); finish(null); };
      this.#approvals.set(id, approval); this.#acpApprovals.set(id, { choices, resolve: finish });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      const { wireId, ...visible } = approval; this.emit('event', { type: 'approval', data: visible });
    });
  }
  answerApproval(id, body) {
    const pending = this.#approvals.get(id);
    if (!pending) throw new BridgeError('Approval is no longer pending', 409);
    let result;
    if (pending.method === 'mcpServer/elicitation/request' || pending.method === 'item/permissions/requestApproval') {
      try { result = pending.method === 'mcpServer/elicitation/request' ? elicitationResponse(pending.params, body) : permissionsResponse(pending.params.permissions, body); }
      catch (error) { throw new BridgeError(error.message); }
    } else if (pending.method === 'item/tool/requestUserInput') {
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
    const acp = this.#acpApprovals.get(id);
    if(acp){ acp.resolve(acp.choices.get(result.decision) ?? null); this.#acpApprovals.delete(id); }
    else this.#socket.send(JSON.stringify({ id: pending.wireId, result }));
    this.#approvals.delete(id);
    this.emit('event', { type: 'approvalResolved', data: { id } }); return { resolved: true };
  }
  /** "Deny, and tell Elpis what to do instead": the instruction joins the waiting turn (turn/steer), then the command or
   * edit is declined, so the turn goes on with both. Nothing is sent unless the request offers a decline, and the card
   * stays when the turn cannot take the instruction. */
  async denyInstead(id, body) {
    const pending = this.#approvals.get(id);
    if (!pending) throw new BridgeError('Approval is no longer pending', 409);
    if (pending.method !== 'item/commandExecution/requestApproval' && pending.method !== 'item/fileChange/requestApproval') throw new BridgeError('Only a command or edit approval can be denied with an instruction');
    object(body, ['text']);
    const instruction = typeof body.text === 'string' ? body.text.trim() : '';
    if (!instruction) throw new BridgeError('Write what Elpis should do instead');
    const offered = pending.params.availableDecisions;
    if (offered && !offered.includes('decline')) throw new BridgeError('Decision is not offered for this request');
    await this.steer(pending.params.threadId, { text: instruction, expectedTurnId: pending.params.turnId });
    return this.answerApproval(id, { decision: 'decline' });
  }
}
