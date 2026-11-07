import { createProviderEdits } from "./bridge-edits.mts";
import { createUsageTracker } from "./bridge-usage.mts";
import { createProviderSteering } from "./bridge-steering.mts";
import { createClientPermissions } from "./bridge-client-permissions.mts";
import { createEngineMessageHandler } from "./bridge-engine-messages.mts";
import { createClientRouter } from "./bridge-client-router.mts";
import { createThreadLifecycle } from "./bridge-lifecycle.mts";
import { createWorkflowRequests } from "./bridge-workflows.mts";
import { createProviderCatalog } from "./bridge-catalog.mts";
import { wireId,wireObject } from "./bridge-wire.mts";
import { createHelperPermissions } from "./bridge-helper-permissions.mts";
import { createProviderTurn } from "./bridge-turn.mts";
import { createLaneBuilder } from "./bridge-lane.mts";
import { createThreadList,processAlive } from "./bridge-thread-list.mts";
import type { ThreadListRequest } from "./bridge-thread-list.mts";
import { createProviderQueue } from "./bridge-queue.mts";
import { createProviderHistory } from "./bridge-history.mts";
import { inputSummary,clipTurn,jsonIn } from "./bridge-transcript.mts";
import { Acp,lineReader } from "./bridge-acp.mts";
import type { BridgeError,RequestId,BridgeClient,BridgeMessage,NoticeParams,ResumeResult,HelperScope,ProviderOwner,StartPick,LiveSession,BridgeContext,PromptInput,McpConfig,TranscriptTurn,ContextFile,ForkLink,SavedSession,SavedHelper,Store,ProviderAgent,EngineThread,AccessSettings,BridgeResponses,ChildThread,Steer,HistoryRequest,HistoryOptions,ThreadParams,ThreadRequest,ProviderTurn,Ceiling } from "./bridge-types.mts";
import type WebSocket from "ws";
import { createEngine } from "./shared-runtime.mts";
import { currentDrain,drainProxy,trackRequests } from "./handover.mts";
import { setSignedOut } from "./anthropic-signout.mts";
import { recordedClaudeEnd } from "./claude-turn-record.mts";
import { execFile } from "node:child_process";
import { join,basename } from "node:path";
import { randomUUID } from "node:crypto";
import { acpErrorInfo } from './acp-errors.mts';
import type { BridgeEnvironment } from "./bridge-server.mts";

/** Own the protocol state for one client and its backing engine. */
export function attachBridgeConnection(socket: WebSocket, environment: BridgeEnvironment) {
  const state = createConnectionState(socket, environment);
  if (state) state.activate(createClientRouter(state.router), createEngineMessageHandler(state.engineMessages));
}

function createConnectionState(socket: WebSocket, { HOME, permissionChoices, log, now, REVIEW_RULES, REVIEW_FORMAT, STRUCTURED_MODEL, STRUCTURED_SYSTEM, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, AUTONOMOUS_ORIGINS, REPLY_UPDATES, engineAgentsConfig, mcpServersFor, appMcpConfig, acpServersFrom, deletingThreads, archivingThreads, deletedThreads, loadStore, loadStoreSnapshot, updateStore, storeChain, STATE_DIR, claudeAccounts, claudeSignedOut, AGENTS, agentOf, signedOutModel, refuseSignedOut, acpErrorMessage, RECONNECT_MS, connectionDropped, RECONNECT_NOTE, readJson, nameModel, announceLimits, addSubscriptionLimits, smartPruneProxy, recordAccounts, clients, helperThreads, helperConns, workflowToolConns, relayed, chatAccess, TOOL_APPROVALS, automaticThreads, blockedAutomaticThreads, explicitChatChoices, helperScope, pendingHelpers, AUTHORITY, UNSANDBOXED, fullFor, lowest, helperCeiling, ceilingOf, providerOwners, subscriptions, BusyMap, forwarded, startingProviders, contexts, sendClient, viewers, relayToTui, settleRelay, cancelRelays, flushApprovals, decorateThread, stopping, checkIdle, workflows, chatBack, clearIdle }: BridgeEnvironment) {
  const ws = socket as BridgeClient;
  if (stopping) { ws.close(1012, "Session backend is stopping"); return; }
  clients.add(ws);
  clearIdle();
  subscriptions.set(ws, new Set());
  ws.sendWire = ws.send.bind(ws);
  const noteRequest = trackRequests(ws);
  const handover = drainProxy(ws, log);
  ws.send = (line) => {
    let value: unknown;
    try { value = JSON.parse(String(line)); } catch { if (ws.readyState === 1) ws.sendWire(line); return; }
    if (!wireObject(value)) { if (ws.readyState === 1) ws.sendWire(line); return; }
    let msg = value;
    let result = wireObject(msg.result) ? msg.result : undefined;
    let params = wireObject(msg.params) ? msg.params : undefined;
    let resultThread = wireObject(result?.thread) ? result.thread : undefined;
    const threadId = typeof resultThread?.id === "string" ? resultThread.id : undefined;
    if (threadId && deletedThreads.has(threadId)) {
      msg = { id: msg.id, error: { code: -32600, message: `thread not found: ${threadId}` } };
      result = undefined; params = undefined; resultThread = undefined;
    }
    if (resultThread && typeof resultThread.id === "string") decorateThread(resultThread as { id: string });
    if (wireObject(params?.thread) && typeof params.thread.id === "string") decorateThread(params.thread as { id: string });
    if (Array.isArray(result?.data)) for (const t of result.data) if (wireObject(t) && typeof t.id === "string") decorateThread(t as { id: string });
    // A chat still working in the bridge that handed over shows as working.
    const old = Array.isArray(result?.data) && currentDrain();
    if (old && Array.isArray(result?.data)) for (const t of result.data) if (wireObject(t) && typeof t.id === "string" && old.threads.has(t.id)) t.status = { type: "active", activeFlags: [] };
    const target = typeof params?.threadId === "string" ? params.threadId : undefined;
    const owner = target === undefined ? undefined : providerOwners.get(target);
    if (msg.method === "thread/status/changed" && owner && params) params.status = owner.status();
    if (msg.method === "thread/settings/updated" && owner) {
      const model = owner.model();
      if (model && params) params.threadSettings = { ...(wireObject(params.threadSettings) ? params.threadSettings : {}), model, effort: owner.effort() };
    }
    const route = !msg.method && wireId(msg.id) ? forwarded.get(msg.id) : undefined;
    const recipient = route?.client ?? ws;
    if (!msg.method && wireId(msg.id) && openingReplies.delete(msg.id) && typeof resultThread?.id === "string") subscriptions.get(recipient)?.add(resultThread.id);
    if (route && wireId(msg.id)) { forwarded.delete(msg.id); sendClient(recipient, { ...msg, id: route.id }); }
    else if (owner?.ws === ws && typeof msg.method === "string" && msg.id === undefined && !["thread/status/changed", "thread/name/updated", "thread/archived", "thread/closed", "thread/deleted", "thread/unarchived"].includes(msg.method)) {
      const recipients = new Set(viewers(target, true));
      // The delegate connection follows its helper even before subscribing. A thread/start
      // reply also subscribes it, so combine the routes before sending each event once.
      if (owner.nativeHelper) recipients.add(ws);
      for (const client of recipients) sendClient(client, msg);
    } else sendClient(recipient, msg);
    // Hydration reaches the terminal before a pending question for that chat.
    if (typeof resultThread?.id === "string") flushApprovals(recipient, resultThread.id);
  };
  const toOthers = (msg: BridgeMessage) => { const line = JSON.stringify(msg); for (const c of clients) if (c !== ws && c.readyState === 1) c.send(line); };
  const shareHelper = (msg: BridgeMessage) => { if (msg?.method === "thread/status/changed" && helperThreads.has(msg.params?.threadId as string)) toOthers(msg); };
  // A chat's latest plan, kept in the store: the engine sends plans only while a turn runs, so
  // reopening a chat (GPT or Claude) shows it again.
  const notePlan = (msg: BridgeMessage) => {
    if (msg?.method !== "turn/plan/updated" || !msg.params?.threadId) return;
    const { threadId, turnId, explanation, plan } = msg.params as { threadId: string; turnId: string; explanation?: string | null; plan: { step: string; status: string }[] };
    updateStore((st) => { st[threadId] = { ...st[threadId], plan: { turnId, explanation: explanation ?? null, plan } }; });
  };
  const replayPlan = async (threadId: string) => {
    await storeChain();
    const saved = (await loadStore())[threadId]?.plan;
    if (saved?.plan?.length) notify("turn/plan/updated", { threadId, turnId: saved.turnId, explanation: saved.explanation, plan: saved.plan });
  };
  const toTui = (msg: BridgeMessage) => { shareHelper(msg); notePlan(msg); ws.send(JSON.stringify(msg)); };
  const notify = (method: string, params: NoticeParams) => {
    const msg = { method, params, emittedAtMs: now() };
    notePlan(msg);
    // Overview changes reach every terminal; transcript events reach only subscribers.
    const all = ["thread/started", "thread/status/changed", "thread/archived", "thread/closed", "thread/deleted"].includes(method);
    const tid = params.threadId ?? params.thread?.id;
    const recipients = all ? [...clients].filter((c) => !helperConns.has(c)) : viewers(tid, true);
    if (helperConns.has(ws) && ws.readyState === 1) recipients.push(ws);
    for (const c of new Set(recipients)) sendClient(c, msg);
    checkIdle();
  };
  const engine = createEngine();
  engine.stdin.on("error", (e) => log(`engine input: ${e.message}`)); // a stopped helper's engine
  const threadCwd = new Map<string, string>();
  const threadSeen = new Map<string, EngineThread>(); // thread id -> the engine's last Thread object for it
  // Claude's subagents as Elpis child threads (what Left/Right and /subagents list): thread id ->
  // { thread, lane } while this connection drew it. Finished ones are also in the store, under
  // their own id with `parentThreadId`, so a resumed chat lists and replays them.
  const childThreads = new Map<string, ChildThread>();
  const childThread = (c: ChildThread) => ({ ...c.thread, status: c.lane && !c.lane.done ? { type: "active", activeFlags: [] } : { type: "idle" }, updatedAt: Math.floor(now() / 1000) });
  async function storedChildren(rootIds: Set<string> | null) {
    await storeChain();
    const out = new Map<string, { thread: EngineThread; rootThreadId: string | undefined; turns: TranscriptTurn[] }>();
    for (const [id, value] of Object.entries(await loadStore())) { const saved = value as SavedSession; if (saved?.thread && (!rootIds || rootIds.has(saved.rootThreadId as string))) out.set(id, { thread: saved.thread, rootThreadId: saved.rootThreadId, turns: saved.turns ?? [] }); }
    for (const [id, c] of childThreads) if (!rootIds || rootIds.has(c.rootThreadId)) out.set(id, { thread: childThread(c), rootThreadId: c.rootThreadId, turns: c.lane.done ? out.get(id)?.turns ?? [] : [c.lane.turn()] });
    return out;
  }
  // What the TUI asks about a child thread (thread/read when it lists or opens one) is answered
  // here; the engine has never heard of it. Nobody types into a subagent's thread, so a
  // thread/resume is refused and the TUI falls back to thread/read.
  const childIds = new Set<string>(); // every child thread id the bridge answers for
  loadStore().then((st) => { for (const [id, saved] of Object.entries(st)) if ((saved as SavedSession)?.parentThreadId) childIds.add(id); });
  async function answerChild(msg: { method: string; id: RequestId; params: { threadId: string; includeTurns?: boolean } }) {
    const { threadId, includeTurns } = msg.params;
    if (msg.method === "thread/resume") return toTui({ id: msg.id, error: { code: -32600, message: "this subagent's thread is read-only; it is shown from thread/read" } });
    const c = (await storedChildren(null)).get(threadId);
    if (!c) return toTui({ id: msg.id, error: { code: -32600, message: `thread not found: ${threadId}` } });
    toTui({ id: msg.id, result: { thread: { ...c.thread, turns: includeTurns ? c.turns : [] } } });
  }
  const threadPolicy = new Map<string, string>();
  const smartPrune = new Map<string, boolean>(); // thread id -> its Smart Prune switch, as the engine reports it
  const threadSandbox = new Map<string, Ceiling>();
  const pendingDelegation = new Map<RequestId, SavedHelper & { sandbox: Ceiling }>(); // thread/start id -> the chat that delegated it
  const pendingHelperTurns = new Map<RequestId, string>(); // native turn/start id -> helper awaiting its acknowledgement
  const sessions = new Map<string, LiveSession>();
  const threadMcp = new Map<string, McpConfig>(); // thread -> the app's `mcp_servers.*` overrides for it (A37)
  const threadEnvironment = new Map<string, Record<string, string>>(); // Managed shell overrides, scoped to this conversation.
  const acps = new Map<string, Acp>();
  const claudeModel = new Map<string, string>();
  const pendingSteers = new Map<string, Map<string, Steer>>();       // threadId → client message id → undelivered steer
  const claudeEffort = new Map<string, string>();
  const resumeResults = new Map<string, ResumeResult>();
  const materializedProviders = new Set<string>();
  const context: BridgeContext = {
    failed: false,
    claudeBusy: () => [...activeTurns.keys()].some((tid: string) => agentOf(claudeModel.get(tid))?.key === "claude") || structured.size > 0,
    stopProvider: (tid: string) => stopProvider(tid, "deleted"),
    stopProviderFor: (tid: string, action) => stopProvider(tid, action),
    resumeQueue: (tid: string) => { if (queues.has(tid)) runNext(tid); },
    nativeLifecycle: (method: string, tid: string) => engineCall(method, { threadId: tid }),
    isBridgeChild: (tid: string) => childThreads.has(tid),
    childrenOf: (ids) => [...childThreads].filter(([, child]) => ids.has(child.rootThreadId) || ids.has(child.thread.parentThreadId as string)).map(([id]) => id),
    forgetThread: (tid: string) => {
      cancelRelays(ws, tid);
      for (const cache of [threadCwd, threadSeen, childThreads, childIds, threadPolicy, smartPrune,
        threadSandbox, sessions, claudeModel, claudeEffort, resumeResults, sessionModel,
        threadCollab, threadAccess, lastTurnUsage, forkParent, queues, goals, ownHelpers, pendingSteers, materializedProviders]) cache.delete(tid);
    },
    forgetArchived: (tid: string) => {
      providerOwners.delete(tid); claudeModel.delete(tid); resumeResults.delete(tid);
      sessions.delete(tid); threadSeen.delete(tid); queues.delete(tid);
      for (const watched of subscriptions.values()) watched.delete(tid);
    },
    // An abandoned request is bookkeeping, not running work. Turns (including native
    // background agents) and structured tool calls still outlive their terminal, and so does a chat
    // whose helpers still run: its delegate server lives in the chat's session, which the engine
    // ends once no client holds the idle chat.
    busy: () => activeTurns.size > 0 || engineTurns.size > 0 || structured.size > 0
      || [...helperScope].some(([tid, h]) => threadSeen.has(h.parentThreadId) && providerOwners.get(tid)?.status().type === "active")
      || (ws.readyState === 1 && (pendingStart.size > 0 || pendingResume.size > 0 || engineReqs.size > 0))
      || [...forwarded.values()].some((r) => r.owner === ws),
    // The chats behind busy(): a hand-over keeps them in this bridge until they are done.
    busyThreads: () => [...activeTurns.keys(), ...engineTurns.keys(), ...structured.keys(),
      ...[...helperScope].filter(([tid, h]) => threadSeen.has(h.parentThreadId) && providerOwners.get(tid)?.status().type === "active").flatMap(([tid, h]) => [tid, h.parentThreadId]),
      ...[...relayed.values()].filter((r) => r.origin === ws).map((r) => r.threadId)],
    // Every chat this engine has loaded, idle ones too: the engine keeps each locked for writing until it unloads, which
    // an idle chat never does while this bridge stays subscribed. A newer engine cannot open such a chat (hand-over).
    loadedThreads: async () => { try { return (await engineCall("thread/loaded/list", {}, 3000)).data ?? []; } catch { return []; } },
    close: () => { cancelRelays(ws); engine.kill(); for (const a of acps.values()) a.kill(); },
    releaseIfUnused: () => {
      if (ws.readyState === 1 || context.busy() || [...relayed.values()].some((r) => r.origin === ws)
        // Let detached requests finish during the idle grace, without extending it forever.
        || pendingStart.size || pendingResume.size || pendingDelegation.size || pendingHelperTurns.size || engineReqs.size
        || [...providerOwners].some(([tid, owner]) => owner.ws === ws && viewers(tid, true).length)) return;
      context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
      releaseHelpers();
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
    },
  };
  contexts.add(context);
  const dispatchOwned = (msg: BridgeMessage & { id: RequestId }, client: BridgeClient) => {
    const id = `forward-${randomUUID()}`;
    forwarded.set(id, { client, id: msg.id, owner: ws });
    void withPermissions(JSON.stringify({ ...msg, id }));
  };
  function claimProvider(tid: string, result?: ResumeResult) {
    if (!claudeModel.has(tid)) return;
    if (result) resumeResults.set(tid, { ...result, thread: { ...result.thread } });
    const prior = providerOwners.get(tid);
    if (prior && prior.ws !== ws) return prior;
    const owner: ProviderOwner = {
      ws,
      model: () => claudeModel.get(tid),
      effort: () => claudeEffort.get(tid) ?? null,
      status: () => activeTurns.has(tid) ? { type: "active", activeFlags: [] } : { type: "idle" },
      decorate: (thread) => {
        if (claudeModel.has(tid)) {
          thread.model = claudeModel.get(tid); thread.reasoningEffort = claudeEffort.get(tid) ?? null;
          thread.status = owner.status();
        }
      },
      dispatch: dispatchOwned,
    };
    providerOwners.set(tid, owner);
  }
  function claimEngineHelper(tid: string, h: HelperScope) {
    const prior = providerOwners.get(tid);
    if (prior && prior.ws !== ws) return;
    const owner: ProviderOwner = {
      ws,
      nativeHelper: true,
      model: () => h.model ?? null,
      effort: () => null,
      status: () => h.activeOwner ? { type: "active", activeFlags: [] } : { type: "idle" },
      decorate: (thread) => { thread.status = owner.status(); },
      lastTurn: () => h.lastTurn,
      dispatch: dispatchOwned,
    };
    providerOwners.set(tid, owner);
  }
  function rememberStart(id: RequestId, pick: StartPick) {
    pendingStart.set(id, pick);
    const key = `${connectionId}:${id}`;
    let release = () => {};
    const ready = new Promise<void>((r) => { release = r; });
    const timer = setTimeout(() => { startingProviders.delete(key); release(); log("provider start notification wait expired"); }, 30000);
    startingProviders.set(key, { ready, resolve: () => { clearTimeout(timer); release(); } });
  }
  const connectionId = randomUUID();
  const sessionModel = new Map<string, string>();
  const threadCollab = new Map<string, string>();
  // thread id -> its permission profile and approvals reviewer, as the engine last confirmed
  // them; with the approval policy and Plan they pick Claude's own mode (claudeModeOf).
  const threadAccess = new Map<string, { profile: string | undefined; reviewer: string | undefined }>();
  const noteAccess = (threadId: string, s: AccessSettings | null | undefined) => {
    if (!threadId || !s) return;
    const cached = resumeResults.get(threadId);
    if (cached) {
      for (const k of ["approvalPolicy", "approvalsReviewer", "activePermissionProfile", "cwd", "collaborationMode", "serviceTier", "disabledPluginIds"]) if (s[k] !== undefined) cached[k] = s[k];
      if (s.sandboxPolicy) cached.sandbox = s.sandboxPolicy;
    }
    if (s.approvalPolicy) threadPolicy.set(threadId, s.approvalPolicy);
    const sandbox = (s.sandboxPolicy ?? s.sandbox)?.type;
    const profile = s.permissions ?? s.activePermissionProfile?.id
      ?? (sandbox && (({ readOnly: ":read-only", dangerFullAccess: ":danger-full-access" } as Record<string, string>)[sandbox] ?? ":workspace"));
    const prev = threadAccess.get(threadId);
    const access = { profile: profile ?? prev?.profile, reviewer: s.approvalsReviewer ?? prev?.reviewer };
    threadAccess.set(threadId, access);
    chatAccess.set(threadId, { policy: threadPolicy.get(threadId), profile: access.profile });
    if (threadPolicy.get(threadId) === 'never') for (const [id, relay] of relayed) {
      if (relay.origin === ws && relay.toolPermission && relay.message.params.threadId === threadId)
        settleRelay(id, { result: { decision: fullFor(threadId) ? 'accept' : 'decline' } });
    }
    for (const confirm of confirmations.get(threadId) ?? []) confirm(access.profile);
  };
  // The Claude Code mode a chat's turn runs in: Codex's permission modes, mapped to Claude's own.
  // Ask uses Accept edits, Approve for me uses Auto. Full access keeps normal
  // provider checks and answers their permission hook; only Bypass selects the
  // provider's bypass mode. A read-only helper that may not ask plans.
  const MODE_NAMES = { default: "Manual", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto", bypassPermissions: "Bypass permissions" };
  const claudeModeOf = (threadId: string, agentKey: string, ask: boolean) =>
    threadCollab.get(threadId) === "plan" ? "plan" : accessModeOf(threadId, agentKey, ask);
  // The mode of the chat's permission mode alone, which a Plan turn returns to once its plan is
  // approved.
  const accessModeOf = (threadId: string, agentKey: string, ask: boolean) => {
    const { profile, reviewer } = threadAccess.get(threadId) ?? {};
    const readOnly = (!explicitChatChoices.has(threadId) && threadSandbox.get(threadId) === "read-only") || !!profile?.includes("read-only");
    // Never asking is an approval policy, not permission to leave a restricted profile.
    // Unknown/custom profiles stay restricted unless the engine explicitly names Full Access.
    if (!ask) return readOnly ? "plan" : profile === ':bypass-permissions' ? "bypassPermissions" : "default";
    if (agentKey !== "claude" || readOnly) return "default";
    return reviewer === "auto_review" ? "auto" : "acceptEdits";
  };
  const sessionMode = new Map<string, string>();
  const { tokenSums, ctxChars, devChars, addChars, transcriptOf, lastContext, lastTurnUsage, sendUsage } = createUsageTracker({ sessions, threadCwd, claudeAccounts, notify });
  async function recoverClaudeTurn(threadId: string) {
    const running = activeTurns.get(threadId);
    if (running) { await running.recover?.(); return; }
    await storeChain();
    const saved = (await loadStore())[threadId], active = saved?.active;
    if (active && processAlive(active.pid)) return;
    // A fresh connection has no provider owner until resume. History reads also need
    // that ownership: the native carrier's unloaded status is not Claude's turn status.
    if (saved && isBridged(saved.model) && !providerOwners.has(threadId)) {
      claudeModel.set(threadId, saved.model);
      if (saved.effort) claudeEffort.set(threadId, saved.effort);
      claimProvider(threadId);
    }
    // A followup (A37) has no prompt of its own to find in Claude's record.
    if (!saved || !active?.userItems?.length || (saved.agent ?? "claude") !== "claude") return;
    const project = active.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const file = join(claudeAccounts.configDir(saved.claudeAccountId ?? "default"), "projects", project, `${saved.session}.jsonl`);
    const final = await recordedClaudeEnd(file, active.transcriptOffset ?? 0, active.inputs ?? []);
    if (!final) return;
    const completedAt = Math.floor(now() / 1000);
    const turn = { id: active.turnId, items: [...active.userItems, { type: "agentMessage", id: final.id ?? randomUUID(), text: final.text }], itemsView: "full", status: "completed", error: null,
      startedAt: active.startedAt, startedAtMs: active.startedAtMs, completedAt, durationMs: (completedAt - active.startedAt) * 1000 };
    await updateStore(st => {
      if (st[threadId]?.active?.turnId !== active.turnId) return;
      const { active: _active, ...rest } = st[threadId];
      st[threadId] = { ...rest, turns: [...(rest.turns ?? []).filter(row => row.id !== turn.id), clipTurn(turn)] };
    });
    for (const item of turn.items) notify("item/completed", { threadId, turnId: turn.id, item });
    notify("turn/completed", { threadId, turn });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
  }
  const isBridged = (m: unknown): m is string => !!agentOf(m);
  const ensureAcp = async (agent: ProviderAgent) => {
    const key = agent.key === "claude" ? `claude:${claudeAccounts.activeId()}` : agent.key;
    let a = acps.get(key);
    if (!a || a.dead) { a = new Acp(agent, log); acps.set(key, a); await a.ready; log(`${key} acp ready`); }
    return a;
  };
  const catalogFor = createProviderCatalog({ readJson, ensureAcp, now, log });
  const pendingModelList = new Set<RequestId>();
  const pendingResume = new BusyMap<RequestId, string | undefined>();
  const resumeOptions = new Map<RequestId, { excludeTurns?: boolean; initialTurnsPage?: HistoryOptions }>();
  const pendingNativeRoutes = new Map<RequestId, { threadId: string; model: string; effort?: string | null }>();
  // A Claude model picked as the default ("enter default") lives in the bridge's store, not in
  // config.toml, which plain Elpis also reads. New chats, rewinds and the next start follow it.
  const pendingConfigRead = new Set<RequestId>();
  const pendingStart = new BusyMap<RequestId, StartPick>();
  const openingMcp = new Map<RequestId, McpConfig>(); // thread/start or /fork request id -> the app's MCP overrides
  const openingEnvironment = new Map<RequestId, Record<string, string>>();
  let engineDefault = null; // asked once, after the TUI has initialized the engine
  const pendingTurnsList = new Map<RequestId, HistoryRequest>();
  const pendingItemsList = new Map<RequestId, HistoryRequest>();
  // Claude-only chats reach the engine as injected history, which never sets a thread's
  // preview, and thread/list leaves out threads without one, so /resume could not find them.
  // The bridge adds them, previewed by their first message, where they fall in the list's order.
  const pendingThreadList = new Map<RequestId, ThreadListRequest>();
  const pendingChildList = new Map<RequestId, string | null>(); // thread/loaded/list (null) or thread/list of a chat's descendants (its id)
  const pendingArchive = new Map<RequestId, string | undefined>(); // thread/archive id -> thread id
  const pendingHelperMark = new Set<RequestId>(); // thread/list and thread/read answers: helpers get their chat, bridged chats their model
  const pendingLimitsRead = new Set<RequestId>(); // account/rateLimits/read answers gain the subscriptions' limits
  // A helper started with the delegate tool is an engine thread the engine does not know as a
  // child; the bridge's record (_delegations) gives it its parent wherever the TUI reads threads.
  // The engine knows only the model it started a bridged chat with; this connection (from the
  // chat's start) or the store (from its first turn) has the real one.
  function ownModel(t: EngineThread, store: Store) {
    const model = providerOwners.get(t.id)?.model() ?? claudeModel.get(t.id) ?? store?.[t.id]?.model;
    if (!model || t.model === model) return false;
    t.model = model;
    t.reasoningEffort = (claudeModel.has(t.id) ? claudeEffort.get(t.id) : store?.[t.id]?.effort) ?? null;
    return true;
  }
  async function markHelpers(result: { thread?: EngineThread; data?: (EngineThread | string)[] }, ancestor?: string | null) {
    await storeChain();
    const store = await loadStore();
    const helpers = store._delegations ?? {};
    let changed = false;
    const markHelperTurn = (t: EngineThread) => {
      const turn = providerOwners.get(t.id)?.lastTurn?.();
      if (!turn) return false;
      const turns = Array.isArray(t.turns) ? t.turns : (t.turns = []);
      const index = turns.findIndex((listed) => listed.id === turn.id);
      if (index < 0) turns.push(turn);
      else turns[index] = { ...(turns[index] as TranscriptTurn), status: turn.status };
      return true;
    };
    for (const t of [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])]) {
      if (!t || typeof t !== "object") continue;
      const helper = helpers[t.id];
      if (helper && t.parentThreadId == null) { t.parentThreadId = helper.parentThreadId; changed = true; }
      if (helper?.workflowRunId && t.workflowRunId == null) { t.workflowRunId = helper.workflowRunId; t.workflowAgentId = helper.workflowAgentId ?? null; changed = true; }
      changed = ownModel(t, store) || changed;
      if (Array.isArray(result?.data)) changed = markHelperTurn(t) || changed;
    }
    if (ancestor && Array.isArray(result?.data)) {
      const below = new Set([ancestor]);
      for (let grew = true; grew;) { grew = false; for (const [id, d] of Object.entries(helpers)) if (below.has(d.parentThreadId) && !below.has(id)) { below.add(id); grew = true; } }
      const have = new Set(result.data.map((d) => (typeof d === "string" ? d : d.id)));
      for (const id of below) {
        if (id === ancestor || have.has(id)) continue;
        const t = (await engineCall("thread/read", { threadId: id, includeTurns: false }).catch(() => null))?.thread;
        if (t) {
          t.parentThreadId = (helpers[id] as SavedHelper).parentThreadId;
          ownModel(t, store);
          markHelperTurn(t);
          result.data.push(t);
          changed = true;
        }
      }
    }
    return changed;
  }
  const engineReqs = new BusyMap<RequestId, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();
  let engineSeq = 0;
  function engineCall<K extends keyof BridgeResponses>(method: K, params: object, timeoutMs?: number): Promise<BridgeResponses[K]>;
  function engineCall<T = unknown>(method: string, params: object, timeoutMs?: number): Promise<T>;
  function engineCall<T>(method: string, params: object, timeoutMs = 0): Promise<T> { return new Promise<T>((resolve, reject) => {
    const id = `acp-bridge-engine-${++engineSeq}`;
    const timer = timeoutMs ? setTimeout(() => {
      engineReqs.delete(id);
      // Shared EngineProxy tracks unanswered frames separately from this bridge's callbacks.
      (engine as { inflight?: Map<string, unknown> }).inflight?.delete(JSON.stringify(id));
      reject(Object.assign(new Error("Reading saved sessions timed out. Retry /resume."), { code: "ETIMEDOUT" }));
      checkIdle();
    }, timeoutMs) : null;
    engineReqs.set(id, {
      resolve: (result) => { if (timer) clearTimeout(timer); resolve(result as T); },
      reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
    });
    engine.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  }); }
  const permissionWrites = new Map<RequestId, { threadId?: string; settings: { permissions?: string; inherit?: boolean; automatic?: boolean }; ephemeral?: boolean }>();
  const permissionRefreshes = new Set<RequestId>();
  let handleMessage: (data: WebSocket.RawData | string, recovered?: boolean) => void;
  const textOf = (content: PromptInput[] | undefined) => (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  async function elpisInstructions(threadId: string, developerInstructions?: string) {
    try {
      const r = await engineCall("thread/elpisInstructions/read", { threadId });
      const parts = [];
      const developer = typeof developerInstructions === 'string' ? developerInstructions : r.developerInstructions;
      if (developer?.trim()) parts.push(developer.trim());
      if (r.agentsMd?.trim()) parts.push(`# Project and global instructions admitted by Elpis (AGENTS.md)\n\n${r.agentsMd.trim()}`);
      if (r.continuity?.trim()) parts.push(r.continuity.trim());
      return parts.join("\n\n");
    } catch (e) { throw new Error(`Could not read admitted Elpis instructions: ${(e as BridgeError).message ?? JSON.stringify(e)}`); }
  }
  async function providerContextFiles(msg: { id: RequestId; method: string; params: { threadId: string; [key: string]: unknown } }) {
    try {
      const { threadId } = msg.params;
      const result = await engineCall<{ files: ContextFile[] }>(msg.method, msg.params);
      await storeChain();
      const entry = (await loadStore())[threadId];
      const saved = entry?.contextFiles ?? [];
      const live = sessions.get(threadId), agent = agentOf(claudeModel.get(threadId));
      let files = saved, note;
      if (agent?.key === 'claude' && live && !activeTurns.has(threadId)) {
        try {
          const native = await (acps.get(agent.key) as Acp).call('_elpis/contextFiles', { sessionId: live.id }, 4000);
          const selected = entry?.contextSessionId === live.id ? saved.filter(file => file.group === 'skills') : [];
          files = [...native.files.filter(file => typeof file.path === 'string' && file.path.startsWith('/')).map(file => ({ name: basename(file.path), path: file.path, estimatedTokens: file.estimatedTokens, group: /(?:^|\/)MEMORY\.md$/.test(file.path) ? 'durableMemory' : 'instructions', included: true, selectable: false, reason: 'Loaded by Claude' })), ...selected];
          if (JSON.stringify(files) !== JSON.stringify(saved) || entry?.contextSessionId !== live.id) updateStore(st => {
            if (sessions.get(threadId) !== live) return;
            const current = st[threadId] ?? {};
            const skills = current.contextSessionId === live.id ? (current.contextFiles ?? []).filter(file => file.group === 'skills') : [];
            st[threadId] = { ...current, contextFiles: [...files.filter(file => file.group !== 'skills'), ...skills], contextSessionId: live.id };
          });
        } catch { note = 'Claude’s native context files could not be refreshed. Showing the last recorded list.'; }
      } else if (agent?.key === 'claude' && !saved.length) note = 'Claude’s native context files appear after its first turn.';
      const seen = new Set(result.files.map(file => file.path));
      toTui({ id: msg.id, result: { ...result, files: [...result.files, ...files.filter(file => { if (seen.has(file.path)) return false; seen.add(file.path); return true; })], ...(note ? { note } : {}) } });
    } catch (error) { toTui({ id: msg.id, error: { code: -32603, message: (error as BridgeError).message ?? 'Could not read context files.' } }); }
  }
  // A fork of a Claude chat (/fork, /side, /btw) starts a fresh Claude session; the parent's
  // Claude turns up to the fork point live only in the store, under the parent, so the fork
  // inherits them. The link is kept in memory, and in the store for forks that outlive the chat.
  const forkParent = new Map<string, ForkLink>();
  // The Ledger's Subagents switch is the engine's `features.multi_agent`, written with
  // config/batchWrite. Asking the engine each Claude turn (~10 ms) follows the switch,
  // /experimental and hand edits alike, as GPT turns do.
  const subagentsAllowed = (cwd: string | undefined) => engineCall("config/read", { includeLayers: false, cwd })
    .then((r) => r?.config?.features?.multi_agent !== false, (e) => { log(`subagents switch unread: ${e.message ?? JSON.stringify(e)}`); return true; });
  // The engine's own chats and helpers get the delegate tool while the Subagents switch is on (A37).
  // WR6: a chat the person talks to gets the workflow tool whatever the switch says; a helper never does.
  const withAgents = async (params: { cwd?: string; config?: Record<string, unknown> } | null | undefined, helper = false) => {
    if (!params) return;
    const tools = engineAgentsConfig(await subagentsAllowed(params.cwd), !helper);
    if (Object.keys(tools).length) params.config = { ...params.config, ...tools };
  };
  const activeTurns = new BusyMap<string, ProviderTurn>(); // thread id -> its running Claude or Antigravity turn
  const reconnects = new Map<string, NodeJS.Timeout>(); // thread id -> the timer of its retry after a dropped connection
  const pendingMirrors = new Map<string, Promise<void>>(); // native history copies do not own the provider's turn status
  const engineTurns = new BusyMap<string, string>(); // thread id -> its running engine turn
  const { unlistedClaudeThreads, missingThreadUntil } = createThreadList({ engineCall, activeTurns, ownModel, storeChain, loadStore, now, log });
  const { claudeTurnsOf, providerHistory, resumeHistory, listProviderHistory, priorTranscript } = createProviderHistory({ forkParent, engineCall, resumeResults, activeTurns, childIds, storedChildren, threadSeen, providerOwners, forwarded, ws, toTui, storeChain, loadStore, textOf, log });
  const { authorityOf, stopIfReduced, confirmations, ownHelpers, releaseHelpers, failHelper, enforceHelper, restrictHelper, openHelper, boundAccess, adoptHelper } = createHelperPermissions({ threadAccess, threadPolicy, UNSANDBOXED, AUTHORITY, accessModeOf, activeTurns, notify, engineCall, log, helperScope, engineTurns, helperConns, ws, context, engine, threadSandbox, claudeModel, lowest, isBridged, claimEngineHelper, explicitChatChoices, updateStore });
  const withPermissions = createClientPermissions({ automaticThreads, blockedAutomaticThreads, boundAccess, ceilingOf, claudeModel, engineCall, explicitChatChoices, handleMessage: data => handleMessage(data), helperConns, helperScope, loadStoreSnapshot, permissionChoices, permissionRefreshes, permissionWrites, providerOwners, toTui, updateStore, ws });
  // Reopening a helper (by a fresh delegate server, or by the TUI from the agents page) bounds its
  // permissions by its ceiling before the engine loads it, so the reopened thread and what the
  // TUI shows are already within it.
  const pendingAdopt = new Map<RequestId, SavedHelper & { stored: Ceiling }>(); // thread/resume id -> the helper it reopens
  async function resumeThread(msg: ThreadRequest) {
    const tid = msg.params?.threadId;
    await storeChain();
    const savedStore = await loadStore();
    const d = tid && savedStore._delegations?.[tid];
    const existing = providerOwners.get(tid);
    if (existing && existing.ws !== ws && !existing.nativeHelper) {
      const route = forwarded.get(msg.id); forwarded.delete(msg.id); pendingResume.delete(msg.id); resumeOptions.delete(msg.id); openingReplies.delete(msg.id);
      existing.dispatch({ ...msg, id: route?.id ?? msg.id }, route?.client ?? ws); return;
    }
    if ((claudeModel.has(tid) || existing?.nativeHelper) && resumeResults.has(tid)) {
      const params: ThreadParams = { threadId: tid };
      for (const k of ["approvalPolicy", "approvalsReviewer", "permissions", "model", "effort"] as string[]) if (msg.params[k] != null) params[k] = msg.params[k];
      if (msg.params.sandbox) params.permissions ??= { "read-only": ":read-only", "workspace-write": ":workspace", "danger-full-access": ":danger-full-access" }[msg.params.sandbox];
      if (d && !explicitChatChoices.has(tid)) boundAccess(params, ceilingOf(tid, d), "sandboxPolicy");
      try {
        if (Object.keys(params).length > 1) {
          if (isBridged(params.model)) { claudeModel.set(tid, params.model); delete params.model; }
          await engineCall("thread/settings/update", params);
        }
        let result = { ...(resumeResults.get(tid) as ResumeResult), ...(claudeModel.has(tid) && { model: claudeModel.get(tid), reasoningEffort: claudeEffort.get(tid) ?? null }) };
        result = await resumeHistory(result, tid, savedStore, msg.params ?? {});
        await markHelpers(result);
        pendingResume.delete(msg.id); resumeOptions.delete(msg.id);
        toTui({ id: msg.id, result });
        replayPlan(tid);
      } catch (e) { pendingResume.delete(msg.id); resumeOptions.delete(msg.id); toTui({ id: msg.id, error: Number.isInteger((e as BridgeError).code) ? e : { code: -32603, message: (e as BridgeError).message ?? String(e) } }); }
      return;
    }
    if (!existing && savedStore[tid]?.model) {
      claudeModel.set(tid, savedStore[tid].model);
      if (savedStore[tid].effort) claudeEffort.set(tid, savedStore[tid].effort);
      claimProvider(tid);
    }
    if (d) {
      const r = { parentThreadId: d.parentThreadId, model: d.model, requested: d.requested ?? "read-only", ceiling: ceilingOf(tid, d), stored: d.ceiling };
      pendingAdopt.set(msg.id, r);
      pendingHelpers.add(r);
      if (!explicitChatChoices.has(tid)) boundAccess(msg.params, r.ceiling, "sandbox");
    }
    if (!claudeModel.has(tid)) await withAgents(msg.params, !!d);
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }
  const askTui = (method: string, params: NoticeParams, toolPermission = false) => new Promise<{ decision?: string } | null>((resolve) => {
    if (!relayToTui({ method, params }, (reply) => resolve(reply.result as { decision?: string } | null), ws, toolPermission)) resolve(null);
  });

  const newLane = createLaneBuilder({ notify, addChars, lastContext, sendUsage, now });

  const claudeTurn = createProviderTurn({
    log, now, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, AUTONOMOUS_ORIGINS, REPLY_UPDATES, mcpServersFor, acpServersFrom,
    loadStore, storeChain, updateStore, deletedThreads, claudeAccounts, AGENTS, agentOf, refuseSignedOut,
    acpErrorMessage, RECONNECT_MS, RECONNECT_NOTE, connectionDropped, announceLimits, smartPruneProxy,
    recordAccounts, fullFor, cancelRelays, ws, toTui, notify, threadCwd, threadSeen, childThreads,
    childIds, threadPolicy, smartPrune, sessions, threadMcp, threadEnvironment, claudeModel, claudeEffort,
    materializedProviders, sessionModel, threadAccess, MODE_NAMES, claudeModeOf, accessModeOf, sessionMode,
    tokenSums, ctxChars, devChars, addChars, transcriptOf, lastTurnUsage, sendUsage, ensureAcp, catalogFor,
    engineCall, elpisInstructions, subagentsAllowed, activeTurns, reconnects, pendingMirrors, priorTranscript,
    askTui, newLane, runNext: threadId => runNext(threadId),
  });

  const { queues, goals, queueOf, runNext, queueRequest, goalRequest } = createProviderQueue({ activeTurns, deletingThreads, archivingThreads, deletedThreads, pendingSteers, claudeTurn, notify, toTui, storeChain, loadStore, updateStore, now });

  // A new chat on a Claude model: the engine keeps its own model, the TUI is told Claude.
  async function startThread(msg: { id: RequestId; params?: { elpisParentThreadId?: string; elpisRequestedScope?: string; permissions?: string; sandbox?: Ceiling; elpisWorkflow?: { runId?: string; agentId?: string | null }; approvalPolicy?: string; parentThreadId?: string; model?: string | null; config?: Record<string, unknown> & { model_reasoning_effort?: string | null }; cwd?: string } }) {
    const p = msg.params ?? {};
    const helper = !!p.elpisParentThreadId;
    if (helper) {
      // Resolve this helper's shared default or deliberately requested task scope.
      const parentThreadId = p.elpisParentThreadId as string;
      const requested = p.elpisRequestedScope ?? ([':workspace', ':danger-full-access'].includes(p.permissions as string) || ["workspace-write", "danger-full-access"].includes(p.sandbox as string) ? "workspace-write" : "read-only");
      delete p.elpisRequestedScope;
      p.sandbox = ({ ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' } as Record<string, Ceiling>)[p.permissions as string] ?? helperCeiling(requested);
      delete p.permissions;
      // A workflow's agent (WR2): linked to its run, so the lists fold it under the run.
      const run = p.elpisWorkflow && typeof p.elpisWorkflow.runId === "string" ? { workflowRunId: p.elpisWorkflow.runId, workflowAgentId: p.elpisWorkflow.agentId ?? null } : {};
      const d = { parentThreadId, model: p.model ?? null, sandbox: p.sandbox, requested, ceiling: p.sandbox, ...run };
      pendingDelegation.set(msg.id, d);
      pendingHelpers.add(d);
      // Automatic agents never put approval questions to the person. Their sandbox ceiling
      // still applies: a denied action fails instead of asking the parent chat.
      p.approvalPolicy = 'never';
      delete p.elpisParentThreadId;
      // The engine records the calling chat as this helper's parent, so every client's
      // thread list and agent tree nest it under that chat.
      p.parentThreadId = parentThreadId;
    }
    delete p.elpisWorkflow;
    let pick = null;
    if (isBridged(p.model)) pick = { model: p.model, effort: p.config?.model_reasoning_effort ?? null };
    else {
      await storeChain();
      const def = (await loadStore())._default;
      engineDefault ??= engineCall("config/read", { includeLayers: false }).then((r) => r?.config?.model ?? null, () => null);
      // A saved Claude default waits while Elpis is signed out of it: the new chat gets the engine's own model.
      // A helper keeps the model its delegate named, even the engine's default (A49: gpt-6.1-sol helpers ran on Claude).
      if (!helper && def?.model && !signedOutModel(def.model) && (p.model == null || p.model === await engineDefault)) pick = def;
    }
    if (pick) {
      rememberStart(msg.id, pick);
      p.model = null;
      if (p.config) delete p.config.model_reasoning_effort;
    } else await withAgents(msg.params, helper);
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }

  const { forkProviderChat, revertThread } = createProviderEdits({ agentOf, claudeModel, claudeAccounts, ensureAcp, threadCwd, log, storeChain, loadStoreSnapshot, claudeTurnsOf, engineCall, pendingStart, engine, startingProviders, connectionId, toTui, updateStore, sessions });
  // /review on a Claude chat: Elpis's review rules, answered by Claude, inline.
  async function reviewClaude(msg: ThreadRequest) {
    const { threadId, target = {} } = msg.params;
    const cwd = threadCwd.get(threadId) ?? process.cwd();
    let ask, hint;
    if (target.type === "baseBranch") {
      const base = await new Promise((r) => execFile("git", ["merge-base", "HEAD", target.branch as string], { cwd }, (e, out) => r(e ? null : out.trim())));
      ask = base
        ? `Review the code changes against the base branch '${target.branch}'. The merge base commit for this comparison is ${base}. Run \`git diff ${base}\` to inspect the changes relative to ${target.branch}. Provide prioritized, actionable findings.`
        : `Review the code changes against the base branch '${target.branch}'. Find the merge base with \`git merge-base HEAD ${target.branch}\`, then run \`git diff\` against it. Provide prioritized, actionable findings.`;
      hint = `changes against '${target.branch}'`;
    } else if (target.type === "commit") {
      ask = `Review the code changes introduced by commit ${target.sha}${target.title ? ` ("${target.title}")` : ""}. Provide prioritized, actionable findings.`;
      hint = `commit ${String(target.sha).slice(0, 7)}${target.title ? `: ${target.title}` : ""}`;
    } else if (target.type === "custom") {
      ask = target.instructions; hint = String(target.instructions ?? "").trim();
    } else {
      ask = "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings."; hint = "current changes";
    }
    log(`claude review for thread ${threadId}: ${hint}`);
    claudeTurn({ id: msg.id, kind: "review", reviewHint: hint, params: { threadId, input: [{ type: "text", text: `${REVIEW_RULES}\n\n${REVIEW_FORMAT}\n\n${ask}`, text_elements: [] }] } });
  }

  // Chat titles and /recap on a Claude chat: the TUI starts a hidden ephemeral thread on the
  // chat's model and asks for JSON. A one-off Claude session with no tools, no MCP servers and
  // no user settings answers it; nothing is recorded in the store or the engine.
  const structured = new BusyMap<string, string>(); // hidden thread -> its Claude session
  async function structuredClaude(msg: ThreadRequest) {
    const { threadId, input = [], outputSchema = null } = msg.params;
    const turnId = randomUUID();
    const startedAt = Math.floor(now() / 1000);
    const turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    toTui({ id: msg.id, result: { turn } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    const items = [];
    let status = "completed", error = null, sessionId = null, a = null;
    try {
      // Hidden requests always go to Claude (Haiku), whichever subscription the chat uses.
      refuseSignedOut(AGENTS[0]);
      a = await ensureAcp(AGENTS[0]);
      sessionId = (await a.call("session/new", { cwd: threadCwd.get(threadId) ?? process.cwd(), mcpServers: [], _meta: { systemPrompt: STRUCTURED_SYSTEM, claudeCode: { options: { tools: [], settingSources: [] } } } })).sessionId;
      let text = "";
      a.bySession.set(sessionId, { onUpdate: ({ update: u }) => { if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text; } });
      structured.set(threadId, sessionId);
      await a.call("session/set_config_option", { sessionId, configId: "model", value: STRUCTURED_MODEL });
      const ask = outputSchema ? `${inputSummary(input)}\n\nAnswer with only one JSON object that matches this JSON Schema:\n${JSON.stringify(outputSchema)}` : inputSummary(input);
      const r = await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: ask }] });
      if (r.stopReason === "cancelled") status = "interrupted";
      else {
        const answer = outputSchema ? jsonIn(text) : text.trim();
        if (!answer) throw new Error(`Claude did not answer with JSON: ${text.slice(0, 200)}`);
        const item = { type: "agentMessage", id: `msg_${randomUUID()}`, text: answer, phase: null, memoryCitation: null, delivery: null, questions: null };
        notify("item/started", { item, threadId, turnId, startedAtMs: now() });
        notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
        items.push(item);
      }
      log(`structured request on Claude ${STRUCTURED_MODEL} for hidden thread ${threadId}: ${status}`);
    } catch (e) {
      status = "failed";
      error = { message: acpErrorMessage(e as BridgeError), codexErrorInfo: acpErrorInfo(e as BridgeError), additionalDetails: null };
      log(`structured request error ${JSON.stringify((e as BridgeError)?.message ?? e)}`);
    }
    structured.delete(threadId);
    if (sessionId) { a?.bySession.delete(sessionId); a?.call("session/delete", { sessionId }).catch(() => {}); }
    const completedAt = Math.floor(now() / 1000);
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
  }

  const { steerClaude, cancelClaudeSteers, cancelWaitingClaudeSteers } = createProviderSteering({ activeTurns, pendingSteers, deletedThreads, deletingThreads, archivingThreads, queueOf, runNext, queues, notify, toTui, now, updateStore, addChars, log });
  const { stopProvider, archiveProvider, deleteThread } = createThreadLifecycle({ pendingSteers, activeTurns, cancelWaitingClaudeSteers, contexts, storeChain, loadStore, archivingThreads, deletingThreads, deletedThreads, updateStore, toTui, notify, claudeModel, pendingArchive, queueOf, pendingHelpers, providerOwners, chatAccess, helperScope, helperThreads, subscriptions });
  const openingReplies = new Set<RequestId>();
  const { workflowRequest, runWorkGraph } = createWorkflowRequests({ storeChain, loadStore, providerOwners, claudeModel, isBridged, activeTurns, engineCall, textOf, log, toTui, workflowToolConns, ws, claudeEffort, threadCwd, workflows, HOME, engine });
  // Elpis's own sign-out of the Claude subscription, for the desktop's Settings (the terminal reads the
  // same file). `claudeSubscription/write` {signedOut} flips the switch; both answer {signedOut}.
  function claudeSubscriptionRequest(msg: ThreadRequest) {
    try {
      if (msg.method === "claudeSubscription/write") {
        setSignedOut(STATE_DIR, msg.params?.signedOut as boolean);
        log(`Claude subscription: Elpis is ${msg.params.signedOut ? "signed out" : "signed in"}`);
        recordAccounts().catch((e) => log(`accounts: ${e.message}`));
      }
      toTui({ id: msg.id, result: { signedOut: claudeSignedOut() } });
    } catch (e) { toTui({ id: msg.id, error: { code: Number.isInteger((e as BridgeError).code) ? (e as BridgeError).code : -32603, message: (e as BridgeError).message ?? String(e) } }); }
  }
  async function claudeAccountsRequest(msg: ThreadRequest) {
    try {
      const params = msg.params ?? {};
      if (Object.keys(params).some(key => !["action", "id", "code"].includes(key))) throw Object.assign(new Error("Unsupported Claude account setting."), { code: -32602 });
      let extra: { authUrl?: string } = {};
      if (msg.method === "claudeAccounts/write") {
        if (params.action === "select") {
          if ([...contexts].some(context => context.claudeBusy())) throw Object.assign(new Error("Wait for the active Claude response to finish before switching accounts."), { code: -32600 });
          claudeAccounts.select(params.id as string); setSignedOut(STATE_DIR, false);
          await recordAccounts();
        } else if (params.action === "login") {
          const id = params.id ?? claudeAccounts.add().id;
          extra = await claudeAccounts.login(id);
        } else if (params.action === "code") {
          const login = claudeAccounts.logins.get(params.id as string);
          if (!login?.running || typeof params.code !== "string" || !/^[A-Za-z0-9_#.-]{1,4096}$/.test(params.code)) throw Object.assign(new Error("Enter the code from the Claude sign-in page."), { code: -32602 });
          login.child.stdin.write(`${params.code}\n`);
        } else throw Object.assign(new Error("Choose a Claude account action."), { code: -32602 });
      }
      toTui({ id: msg.id, result: { ...claudeAccounts.snapshot(), ...(extra.authUrl && { authUrl: extra.authUrl }) } });
    } catch (e) { toTui({ id: msg.id, error: { code: Number.isInteger((e as BridgeError).code) ? (e as BridgeError).code : -32603, message: (e as BridgeError).message ?? String(e) } }); }
  }
  const engineExited = () => {
    if (context.failed || (engine as { closing?: boolean }).closing) return;
    context.failed = true;
    const error = { code: -32603, message: "The session backend disconnected. Reopen Elpis to continue this chat." };
    for (const request of engineReqs.values()) request.reject(error);
    engineReqs.clear(); pendingHelperTurns.clear(); engineTurns.clear();
    for (const [key, start] of startingProviders) if (key.startsWith(`${connectionId}:`)) { start.resolve(); startingProviders.delete(key); }
    for (const id of new Set([...pendingStart.keys(), ...pendingResume.keys(), ...openingReplies])) toTui({ id, error });
    pendingStart.clear(); pendingResume.clear(); resumeOptions.clear(); pendingNativeRoutes.clear(); openingReplies.clear();
    for (const [id, route] of forwarded) if (route.owner === ws) { forwarded.delete(id); sendClient(route.client, { id: route.id, error }); }
    for (const [tid, owner] of providerOwners) if (owner.ws === ws) for (const client of viewers(tid)) client.close(1011, "Session backend disconnected");
    context.close(); ws.close(1011, "Session backend disconnected"); checkIdle();
  };
  engine.stdout.on("exit", engineExited);
  (engine as { once?: (event: "exit", listener: () => void) => void }).once?.("exit", engineExited);
  const router = { AGENTS, HOME, acps, activeTurns, answerChild, appMcpConfig, archiveProvider, archivingThreads, boundAccess, cancelClaudeSteers, cancelWaitingClaudeSteers, checkIdle, childIds, childThreads, claimProvider, claudeAccountsRequest, claudeEffort, claudeModel, claudeSubscriptionRequest, claudeTurn, context, deleteThread, deletedThreads, deletingThreads, enforceHelper, engine, engineCall, explicitChatChoices, forkProviderChat, goalRequest, helperConns, helperScope, isBridged, listProviderHistory, loadStore, loadStoreSnapshot, log, markHelpers, now, openingEnvironment, openingMcp, openingReplies, ownHelpers, pendingArchive, pendingChildList, pendingConfigRead, pendingHelperMark, pendingHelperTurns, pendingItemsList, pendingLimitsRead, pendingMirrors, pendingModelList, pendingNativeRoutes, pendingResume, pendingSteers, pendingThreadList, pendingTurnsList, permissionWrites, providerContextFiles, providerHistory, providerOwners, queueRequest, recoverClaudeTurn, relayed, rememberStart, resumeOptions, resumeResults, resumeThread, revertThread, reviewClaude, runWorkGraph, sendClient, settleRelay, signedOutModel, startThread, steerClaude, storeChain, structured, structuredClaude, subscriptions, threadCollab, threadEnvironment, threadMcp, threadSeen, toTui, updateStore, workflowRequest, workflowToolConns, ws };
  const engineMessages = { AGENTS, TOOL_APPROVALS, addSubscriptionLimits, adoptHelper, agentOf, announceLimits, archivingThreads, authorityOf, automaticThreads, blockedAutomaticThreads, catalogFor, chatAccess, chatBack, checkIdle, claimProvider, claudeEffort, claudeModel, connectionId, deletingThreads, engine, engineCall, engineReqs, engineTurns, explicitChatChoices, failHelper, forkParent, fullFor, helperConns, helperScope, helperThreads, loadStore, log, markHelpers, missingThreadUntil, nameModel, noteAccess, notePlan, notify, now, openHelper, openingEnvironment, openingMcp, ownModel, pendingAdopt, pendingArchive, pendingChildList, pendingConfigRead, pendingDelegation, pendingHelperMark, pendingHelperTurns, pendingHelpers, pendingItemsList, pendingLimitsRead, pendingModelList, pendingNativeRoutes, pendingResume, pendingStart, pendingThreadList, pendingTurnsList, permissionChoices, permissionRefreshes, permissionWrites, providerOwners, queues, relayToTui, relayed, replayPlan, restrictHelper, resumeHistory, resumeOptions, resumeResults, sessions, settleRelay, shareHelper, signedOutModel, smartPrune, startingProviders, stopIfReduced, storeChain, storedChildren, subscriptions, threadCwd, threadEnvironment, threadMcp, threadPolicy, threadSeen, toOthers, toTui, unlistedClaudeThreads, updateStore, ws };
  return { router, engineMessages, activate(handler: (data: WebSocket.RawData | string, recovered?: boolean) => void, engineHandler: (line: string) => void) {
    handleMessage = handler;
    lineReader(engine.stdout, engineHandler);
  ws.on("message", (data) => {
    let msg: Parameters<typeof noteRequest>[0] | undefined;
    try {
      const value: unknown = JSON.parse(String(data));
      if (wireObject(value) && (value.id === undefined || wireId(value.id))
        && (value.method === undefined || typeof value.method === "string")
        && (value.params == null || wireObject(value.params))) msg = value as Parameters<typeof noteRequest>[0];
    } catch {}
    if (msg) noteRequest(msg);
    if (!msg || !handover.take(msg)) void withPermissions(data);
  });
  ws.on("close", async () => {
    handover.close();
    clients.delete(ws); subscriptions.delete(ws);
    for (const relay of relayed.values()) relay.clients.delete(ws);
    for (const [id, route] of forwarded) if (route.client === ws) forwarded.delete(id);
    // Claude replaces its MCP process when it reloads a session. Its helper runtimes belong
    // to the bridge: releaseIfUnused keeps active turns, approvals and new subscribers alive.
    if (context.failed || (!process.env.ELPIS_SHARED_BRIDGE && !helperConns.has(ws))) {
      releaseHelpers();
      for (const d of [...pendingDelegation.values(), ...pendingAdopt.values()]) pendingHelpers.delete(d);
      await storeChain(); context.close(); contexts.delete(context);
      for (const [tid, owner] of providerOwners) if (owner.ws === ws) providerOwners.delete(tid);
    }
    checkIdle(); log("tui disconnected");
  });
  } };
}


export type ClientRouterDependencies = NonNullable<ReturnType<typeof createConnectionState>>["router"];
export type EngineMessageDependencies = NonNullable<ReturnType<typeof createConnectionState>>["engineMessages"];
