import { addSubscriptionModels } from "./bridge-model-list.mts";
import { listField } from "./bridge-thread-list.mts";
import type { ResumeResult,HelperScope,EngineThread,Ceiling } from "./bridge-types.mts";
import { defaultPermissionSettings,permissionSettingsAllowed } from './permission-policy.mts';
import { isEngineMessage,isEngineThread,validEngineReply } from "./bridge-engine-protocol.mts";
import type { EngineResult } from "./bridge-engine-protocol.mts";
import { wireId,wireObject } from "./bridge-wire.mts";

import type { EngineMessageDependencies } from "./bridge-connection.mts";

const threadData = (value: unknown): value is (EngineThread | string)[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === "string" || isEngineThread(item));
const threadPage = (value: EngineResult | null | undefined): value is EngineResult & { data: EngineThread[]; nextCursor?: string | null } =>
  !!value && Array.isArray(value.data) && value.data.every(isEngineThread)
  && (value.nextCursor === undefined || value.nextCursor === null || typeof value.nextCursor === "string");
const resultWithThread = (value: EngineResult | null | undefined): value is EngineResult & ResumeResult => !!value?.thread;
const errorMessage = (value: unknown) => wireObject(value) && typeof value.message === "string" ? value.message : String(value);
const rpcError = (value: unknown) => wireObject(value) && typeof value.code === "number" && Number.isInteger(value.code);

/** Reconcile native-engine replies and notifications with bridge state. */
export function createEngineMessageHandler({ AGENTS, TOOL_APPROVALS, addSubscriptionLimits, adoptHelper, agentOf, announceLimits, archivingThreads, authorityOf, automaticThreads, blockedAutomaticThreads, catalogFor, chatAccess, chatBack, checkIdle, claimProvider, claudeEffort, claudeModel, connectionId, deletingThreads, engine, engineCall, engineReqs, engineTurns, explicitChatChoices, failHelper, forkParent, fullFor, helperConns, helperScope, helperThreads, loadStore, log, markHelpers, missingThreadUntil, nameModel, noteAccess, notePlan, notify, now, openHelper, openingEnvironment, openingMcp, ownModel, pendingAdopt, pendingArchive, pendingChildList, pendingConfigRead, pendingDelegation, pendingHelperMark, pendingHelperTurns, pendingHelpers, pendingItemsList, pendingLimitsRead, pendingModelList, pendingNativeRoutes, pendingResume, pendingStart, pendingThreadList, pendingTurnsList, permissionChoices, permissionRefreshes, permissionWrites, providerOwners, queues, relayToTui, relayed, replayPlan, restrictHelper, resumeHistory, resumeOptions, resumeResults, sessions, settleRelay, shareHelper, signedOutModel, smartPrune, startingProviders, stopIfReduced, storeChain, storedChildren, subscriptions, threadCwd, threadEnvironment, threadMcp, threadPolicy, threadSeen, toOthers, toTui, unlistedClaudeThreads, updateStore, ws }: EngineMessageDependencies) {
  return async (line: string) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { ws.send(line); return; }
    if (wireObject(value) && wireId(value.id) && !value.method) {
      const pending = engineReqs.get(value.id);
      if (pending) {
        engineReqs.delete(value.id);
        if (value.error) pending.reject(value.error);
        else if (validEngineReply(pending.method, value.result)) pending.resolve(value.result);
        else pending.reject(new Error(`Invalid engine response for ${pending.method}`));
        return;
      }
    }
    if (!isEngineMessage(value)) { ws.send(line); return; }
    let parsed = value;
    if (parsed.id !== undefined && !parsed.method && permissionRefreshes.delete(parsed.id) && !parsed.error) {
      try {
        const loaded = new Set((await engineCall('thread/loaded/list', {})).data ?? []);
        for (const tid of chatAccess.keys()) {
          const choice = await permissionChoices.read(tid);
          if (!loaded.has(tid) || helperThreads.has(tid) || (choice && !choice.inherit && !choice.automatic)) continue;
          const read = await engineCall('config/read', { includeLayers: true, ...(threadCwd.get(tid) ? { cwd: threadCwd.get(tid) } : {}) });
          const settings = defaultPermissionSettings(read, choice?.automatic === true);
          if (settings) await engineCall('thread/settings/update', { threadId: tid, ...settings });
        }
        const scopes: [string, HelperScope][] = [];
        for (const [tid, helper] of helperScope) {
          const choice = await permissionChoices.read(tid);
          if (helper.requested === 'read-only' || (choice && !choice.inherit && !choice.automatic)) continue;
          const read = await engineCall('config/read', { includeLayers: true, ...(threadCwd.get(tid) ? { cwd: threadCwd.get(tid) } : {}) });
          const settings = defaultPermissionSettings(read, true);
          const ceilings: Partial<Record<string, Ceiling>> = { ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' };
          const ceiling = settings.permissions === undefined ? undefined : ceilings[settings.permissions];
          if (ceiling) { helper.ceiling = ceiling; scopes.push([tid, helper]); }
        }
        if (scopes.length) {
          await updateStore(store => { for (const [tid, helper] of scopes) if (store._delegations?.[tid]) store._delegations[tid].ceiling = helper.ceiling; });
          const applied = await Promise.all(scopes.flatMap(([tid, helper]) => [...helper.owners].map(apply => apply(tid))));
          if (applied.some(ok => !ok)) throw new Error('An automatic agent could not apply the new default permissions.');
        }
      } catch (error) { parsed = { id: parsed.id, error: { code: -32603, message: `The default was saved, but an open chat could not be updated: ${errorMessage(error)}` } }; }
      line = JSON.stringify(parsed);
    }
    const write = parsed.id === undefined ? undefined : permissionWrites.get(parsed.id);
    if (parsed.id !== undefined && !parsed.method && write) {
      permissionWrites.delete(parsed.id);
      if (!parsed.error) {
        try {
          const tid = write.threadId ?? parsed.result?.thread?.id;
          if (tid === undefined) throw new Error('Missing thread ID in permission reply');
          blockedAutomaticThreads.delete(tid);
          if (!write.settings.inherit && !write.settings.automatic) explicitChatChoices.add(tid);
          if (write.ephemeral) { if (write.settings.automatic) automaticThreads.add(tid); }
          else await permissionChoices.write(tid, write.settings);
        }
        catch { parsed = { id: parsed.id, error: { code: -32603, message: 'The permission choice could not be saved. Choose it again before restarting.' } }; line = JSON.stringify(parsed); }
      }
    }
    const pendingHelperTurn = parsed.id === undefined ? undefined : pendingHelperTurns.get(parsed.id);
    if (parsed.id !== undefined && !parsed.method && pendingHelperTurn !== undefined) {
      const tid = pendingHelperTurn;
      pendingHelperTurns.delete(parsed.id);
      if (parsed.result?.turn?.status === "inProgress") engineTurns.set(tid, parsed.result.turn.id);
      checkIdle();
    }
    const th = parsed?.result?.thread ?? parsed?.params?.thread;
    if (th?.id && th?.cwd) { threadCwd.set(th.id, th.cwd); threadSeen.set(th.id, { ...th, turns: [] }); }
    if (parsed?.method === 'thread/started' && th?.id && (th.parentThreadId || (wireObject(th.source) && th.source.subAgent))) {
      automaticThreads.add(th.id);
      try {
        const requirements = (await engineCall('configRequirements/read', {})).requirements ?? {};
        const settings = defaultPermissionSettings(await engineCall('config/read', { includeLayers: true, ...(th.cwd ? { cwd: th.cwd } : {}) }), true);
        if (!permissionSettingsAllowed(settings, requirements)) throw new Error('Managed settings forbid Full access for this automatic agent.');
        await engineCall('thread/settings/update', { threadId: th.id, ...settings });
        blockedAutomaticThreads.delete(th.id);
        await permissionChoices.write(th.id, { ...settings, automatic: true });
      } catch (error) {
        blockedAutomaticThreads.add(th.id);
        const turnId = engineTurns.get(th.id);
        if (turnId) void engineCall('turn/interrupt', { threadId: th.id, turnId }).catch(error => log(`automatic agent interrupt: ${error.message ?? error}`));
        notify('warning', { threadId: th.id, message: errorMessage(error) });
      }
    }
    if (parsed?.method === 'turn/started' && parsed.params?.threadId && parsed.params.turn && blockedAutomaticThreads.has(parsed.params.threadId)) {
      void engineCall('turn/interrupt', { threadId: parsed.params.threadId, turnId: parsed.params.turn.id }).catch(error => log(`automatic agent interrupt: ${error.message ?? error}`));
    }
    if (parsed.id !== undefined && parsed.method && parsed.params?.threadId && TOOL_APPROVALS.has(parsed.method)) {
      const tid = parsed.params.threadId;
      const own = await permissionChoices.read(tid);
      if (threadPolicy.get(tid) === 'never' || ((automaticThreads.has(tid) || helperScope.has(tid)) && (!own || own.inherit || own.automatic))) {
        engine.stdin.write(JSON.stringify({ id: parsed.id, result: { decision: !blockedAutomaticThreads.has(parsed.params.threadId) && fullFor(parsed.params.threadId) ? 'accept' : 'decline' } }) + '\n');
        return;
      }
      if (relayToTui(parsed, reply => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + '\n'), ws, true)) return;
    }
    if (th?.id && parsed?.result?.approvalPolicy) { noteAccess(th.id, parsed.result); resumeResults.set(th.id, { ...parsed.result, thread: { ...th } }); }
    if (parsed?.method === "thread/name/updated" && parsed.params?.threadId && parsed.params.threadName !== undefined) {
      const { threadId, threadName } = parsed.params;
      const seen = threadSeen.get(threadId), resumed = resumeResults.get(threadId);
      if (seen) seen.name = threadName;
      if (resumed) resumed.thread.name = threadName;
    }
    if (parsed?.method === "turn/started" && parsed.params?.threadId && parsed.params.turn?.id) engineTurns.set(parsed.params.threadId, parsed.params.turn.id);
    if (parsed?.method === "turn/completed") { if (parsed.params?.threadId) engineTurns.delete(parsed.params.threadId); checkIdle(); }
    const helperId = parsed?.params?.threadId;
    const helperOwner = helperId === undefined ? undefined : providerOwners.get(helperId);
    const helper = helperId !== undefined && helperOwner?.nativeHelper && helperOwner.ws === ws ? helperScope.get(helperId) : null;
    if (helper) {
      const turn = parsed.params?.turn;
      if (parsed.method === "turn/started" && turn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = restrictHelper;
      } else if (parsed.method === "turn/completed" && turn?.id === helper.lastTurn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = null;
      } else if (parsed.method === "thread/status/changed") {
        if (parsed.params?.status?.type === "active") helper.activeOwner = restrictHelper;
        else if ((parsed.params?.status?.type === "idle" || parsed.params?.status?.type === "notLoaded") && helper.activeOwner === restrictHelper) helper.activeOwner = null;
      }
    }
    // An unsubscribed native thread no longer sends its turn/completed here. The engine
    // broadcasts thread/closed after its work stops and its unsubscribed runtime unloads.
    if (parsed?.method === "thread/closed" && parsed.params?.threadId) engineTurns.delete(parsed.params.threadId);
    if (parsed?.method === "thread/status/changed" && parsed.params?.threadId && (parsed.params.status?.type === "idle" || parsed.params.status?.type === "notLoaded")) engineTurns.delete(parsed.params.threadId);
    if (parsed?.method === 'serverRequest/resolved' && parsed.params?.requestId !== undefined) {
      for (const [id, relay] of relayed) if (relay.origin === ws && relay.upstreamId === parsed.params.requestId) settleRelay(id);
    }
    if (parsed?.method === "thread/settings/updated" && parsed.params?.threadId) {
      const tid = parsed.params?.threadId;
      const previousAuthority = authorityOf(tid);
      noteAccess(tid, parsed.params?.threadSettings);
      stopIfReduced(tid, previousAuthority);
    }
    shareHelper(parsed);
    notePlan(parsed);
    if (parsed?.method === "thread/unarchived" && parsed.params?.threadId) chatBack(parsed.params.threadId);
    if (parsed?.method === "thread/smartPrune/updated" && parsed.params?.threadId) smartPrune.set(parsed.params.threadId, !!parsed.params.smartPrune?.enabled);
    if (parsed?.method && parsed.id !== undefined && parsed.params?.threadId && ((helperConns.has(ws) && helperThreads.has(parsed.params.threadId)) || providerOwners.get(parsed.params.threadId)?.ws === ws)
      && relayToTui(parsed, (reply) => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + "\n"), ws)) return;
    const route = parsed.id === undefined ? undefined : pendingNativeRoutes.get(parsed.id);
    if (parsed.id !== undefined && route) {
      pendingNativeRoutes.delete(parsed.id);
      if (!parsed.error) {
        claudeModel.delete(route.threadId); claudeEffort.delete(route.threadId);
        providerOwners.delete(route.threadId); resumeResults.delete(route.threadId);
        sessions.delete(route.threadId);
        await updateStore(store => {
          const record = store[route.threadId];
          if (record) { record.providerHistory = true; record.model = null; delete record.effort; record.nativeModel = route.model; }
        });
        const seen = threadSeen.get(route.threadId);
        if (seen) { seen.model = route.model; seen.reasoningEffort = route.effort ?? null; }
      }
    }
    // A timed-out internal read may still answer later; it is never a client reply.
    if (!parsed?.method && typeof parsed?.id === "string" && parsed.id.startsWith("acp-bridge-engine-")) return;
    // A chat only the bridge knows (a helper whose one turn failed, so the engine never saved
    // it) archives by leaving the bridge's records.
    if (parsed.id !== undefined && pendingArchive.has(parsed.id)) {
      const threadId = pendingArchive.get(parsed.id); pendingArchive.delete(parsed.id);
      if (threadId !== undefined) {
      if (!parsed.error) {
        providerOwners.delete(threadId); claudeModel.delete(threadId); resumeResults.delete(threadId);
        sessions.delete(threadId); threadSeen.delete(threadId); queues.delete(threadId);
        for (const watched of subscriptions.values()) watched.delete(threadId);
      }
      if (/no rollout found/.test(parsed.error?.message ?? "")) {
        await storeChain();
        const store = await loadStore();
        if (store[threadId] || store._delegations?.[threadId] || claudeModel.has(threadId)) {
          await updateStore((st) => { delete st[threadId]; if (st._delegations) delete st._delegations[threadId]; });
          log(`archived bridge-only thread ${threadId}`);
          ws.send(JSON.stringify({ id: parsed.id, result: {} }));
          notify("thread/archived", { threadId });
          return;
        }
      }
      }
    }
    let helpersMarked = false;
    // A new Claude chat's thread/started can arrive before its thread/start answer; the one
    // bridged start in flight names its model then.
    if (parsed?.method === "thread/started" && parsed.params?.thread) {
      const t = parsed.params.thread;
      missingThreadUntil.delete(t.id);
      await Promise.all([...startingProviders.values()].map((p) => p.ready));
      const starting = [...pendingStart.values()].filter((pick) => pick?.model);
      const pick = !claudeModel.has(t.id) && starting.length === 1 ? starting[0] : null;
      if (pick && t.model !== pick.model) { t.model = pick.model; t.reasoningEffort = pick.effort ?? null; helpersMarked = true; } // shown only; routing waits for the answer
      else helpersMarked = ownModel(t, await loadStore());
    }
    if (parsed.id !== undefined && pendingLimitsRead.delete(parsed.id)) { await addSubscriptionLimits(parsed); helpersMarked = true; }
    if (parsed.id !== undefined && pendingHelperMark.has(parsed.id)) {
      pendingHelperMark.delete(parsed.id);
      const result = parsed.result;
      const data = result?.data;
      if (result) helpersMarked = await markHelpers({ ...(result.thread ? { thread: result.thread } : {}), ...(threadData(data) ? { data } : {}) }, pendingChildList.get(parsed.id)).catch((e) => { log(`helpers: ${e.message ?? e}`); return false; });
    }
        if (parsed.id != null && pendingTurnsList.has(parsed.id)) pendingTurnsList.delete(parsed.id);
        if (parsed.id != null && pendingItemsList.has(parsed.id)) pendingItemsList.delete(parsed.id);

    if (parsed.id !== undefined && pendingChildList.has(parsed.id)) {
      const ancestor = pendingChildList.get(parsed.id); pendingChildList.delete(parsed.id);
      const data = parsed.result?.data;
      if (threadData(data)) {
        const kids = await storedChildren(new Set(ancestor ? [ancestor] : data.filter((d): d is string => typeof d === "string"))).catch(() => new Map());
        const have = new Set(data.map((d) => (typeof d === "string" ? d : d.id)));
        const add = [...kids].filter(([id]) => !have.has(id)).map(([id, c]) => (ancestor ? c.thread : id));
        if (add.length) {
          data.push(...add);
          log(`${ancestor ? "thread/list" : "thread/loaded/list"}: +${add.length} Claude subagent threads`);
          ws.send(JSON.stringify(parsed));
          return;
        }
      }
    }
    const threadListRequest = parsed.id === undefined ? undefined : pendingThreadList.get(parsed.id);
    if (parsed.id !== undefined && threadListRequest) {
      const req = threadListRequest; pendingThreadList.delete(parsed.id);
      if (threadPage(parsed.result)) {
        const page = parsed.result;
        let added;
        try { added = await unlistedClaudeThreads(req, page); }
        catch (e) {
          log(`thread/list: ${errorMessage(e)}`);
          ws.send(JSON.stringify({ id: parsed.id, error: rpcError(e) ? e : { code: -32603, message: errorMessage(e) } }));
          return;
        }
        if (added.length) {
          await markHelpers({ data: added });
          // Each goes before the first engine thread that sorts after it; the engine's own order stays.
          const field = listField(req);
          const value = (t: EngineThread) => t[field] ?? t.updatedAt ?? 0;
          for (const t of added.sort((a, b) => value(b) - value(a))) {
            const at = page.data.findIndex(d => value(d) < value(t));
            page.data.splice(at < 0 ? page.data.length : at, 0, t);
          }
          log(`thread/list: +${added.length} Claude-only chats`);
          ws.send(JSON.stringify(parsed));
          return;
        }
      }
    }
    if (parsed.id !== undefined && pendingConfigRead.has(parsed.id)) {
      pendingConfigRead.delete(parsed.id);
      const def = (await loadStore())._default;
      if (def?.model && !signedOutModel(def.model) && parsed.result?.config) {
        parsed.result.config = { ...parsed.result.config, model: def.model, model_reasoning_effort: def.effort ?? null };
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
    const delegation = parsed.id === undefined ? undefined : pendingDelegation.get(parsed.id);
    if (parsed.id !== undefined && delegation) {
      // A helper started by a chat's delegate tool: remember who started it, for the agent console.
      const d = delegation; pendingDelegation.delete(parsed.id); pendingHelpers.delete(d);
      const thread = parsed.result?.thread;
      if (thread) {
        const tid = thread.id;
        // Every connection uses this helper's resolved scope.
        const { ceiling } = openHelper(tid, d, d.ceiling);
        if (ceiling !== d.sandbox) restrictHelper(tid);
        const run = d.workflowRunId ? { workflowRunId: d.workflowRunId, ...(d.workflowAgentId === undefined ? {} : { workflowAgentId: d.workflowAgentId }) } : {};
        updateStore((st) => { st._delegations = { ...st._delegations, [tid]: { parentThreadId: d.parentThreadId, model: d.model, startedAt: Math.floor(now() / 1000), requested: d.requested, ceiling, ...run } }; });
        log(`helper thread ${tid} (${d.model}) started by ${d.parentThreadId}`);
        helperThreads.add(tid);
        toOthers({ method: "thread/started", params: { thread: { ...thread, parentThreadId: d.parentThreadId, ...run, turns: [] } }, emittedAtMs: now() });
      }
    }
    if (parsed.id !== undefined && openingMcp.has(parsed.id)) {
      const tid = parsed.result?.thread?.id;
      const mcp = openingMcp.get(parsed.id);
      if (tid && mcp) threadMcp.set(tid, mcp);
      openingMcp.delete(parsed.id);
    }
    if (parsed.id !== undefined && openingEnvironment.has(parsed.id)) {
      const tid = parsed.result?.thread?.id;
      const environment = openingEnvironment.get(parsed.id);
      if (tid && environment) threadEnvironment.set(tid, environment);
      openingEnvironment.delete(parsed.id);
    }
    if (parsed.id !== undefined && pendingStart.has(parsed.id)) {
      const pick = pendingStart.get(parsed.id); pendingStart.delete(parsed.id);
      const result = parsed.result;
      const starting = startingProviders.get(`${connectionId}:${parsed.id}`);
      startingProviders.delete(`${connectionId}:${parsed.id}`);
      if (resultWithThread(result) && pick?.model) {
        const tid = result.thread.id;
        claudeModel.set(tid, pick.model);
        if (pick.effort) claudeEffort.set(tid, pick.effort);
        if (pick.forkOf) {
          // A fork with its own copy of the kept turns no longer reads them from its source.
          // An ephemeral side chat is never stored, so it keeps reading its source.
          const forkTurns = pick.forkTurns;
          const copied = forkTurns && !result.thread.ephemeral;
          const forkOf = copied ? { ...pick.forkOf, copied: true } : pick.forkOf;
          if (copied) await updateStore((st) => { st[tid] = { ...st[tid], forkOf, turns: [...forkTurns, ...(st[tid]?.turns ?? [])] }; });
          else if (!result.thread.ephemeral) updateStore((st) => { st[tid] = { ...st[tid], forkOf }; });
          forkParent.set(tid, forkOf);
        }
        nameModel(result, pick.model, pick.effort);
        claimProvider(tid, result);
        announceLimits(agentOf(pick.model), (method: string, params) => ws.send(JSON.stringify({ method, params })));
        if (!result.thread.ephemeral) await updateStore((st) => { st[tid] = { ...st[tid], model: pick.model, effort: pick.effort ?? null }; });
        starting?.resolve();
        log(`new thread ${tid} -> ${pick.model}`);
        ws.send(JSON.stringify(parsed));
        return;
      }
      starting?.resolve();
    }
    let reopened = null;
    if (parsed.id !== undefined && parsed.error && pendingResume.has(parsed.id)) {
      const tid = pendingResume.get(parsed.id); pendingResume.delete(parsed.id); resumeOptions.delete(parsed.id);
      if (tid && providerOwners.get(tid)?.ws === ws && !resumeResults.has(tid)) providerOwners.delete(tid);
    }
    if (parsed.id !== undefined && pendingAdopt.has(parsed.id) && !parsed.result?.thread?.id) { const helper = pendingAdopt.get(parsed.id); if (helper) pendingHelpers.delete(helper); pendingAdopt.delete(parsed.id); }
    if (parsed.id !== undefined && pendingResume.has(parsed.id) && resultWithThread(parsed.result)) {
      const result = parsed.result;
      const requestedResume = resumeOptions.get(parsed.id) ?? {};
      resumeOptions.delete(parsed.id);
      pendingResume.delete(parsed.id);
      reopened = result.thread.id;
      missingThreadUntil.delete(reopened);
      await storeChain();
      const saved = (await loadStore())[result.thread.id];
      const helper = pendingAdopt.get(parsed.id);
      pendingAdopt.delete(parsed.id); if (helper) pendingHelpers.delete(helper);
      if (helper && !(await adoptHelper(reopened, helper, !!saved?.model))) {
        ws.send(JSON.stringify({ id: parsed.id, error: { code: -32600, message: "The helper was not reopened: its chat's restricted permissions could not be applied." } }));
        if (helperConns.has(ws)) failHelper(reopened, "its chat's restricted permissions could not be applied");
        return;
      }
      if (saved?.model || saved?.providerHistory) {
        if (saved.model) claudeModel.set(result.thread.id, saved.model);
        if (saved.effort) claudeEffort.set(result.thread.id, saved.effort);
        if (saved.model) { nameModel(result, saved.model, saved.effort); claimProvider(result.thread.id, result); }
        try { parsed.result = await resumeHistory(result, result.thread.id, await loadStore(), requestedResume); }
        catch (error) { toTui({ id: parsed.id, error: rpcError(error) ? error : { code: -32603, message: errorMessage(error) } }); return; }
        log(`resume ${result.thread.id} -> ${saved.model}`);
        ws.send(JSON.stringify(parsed));
        if (saved.model) announceLimits(agentOf(saved.model), (method: string, params) => ws.send(JSON.stringify({ method, params })));
        replayPlan(result.thread.id);
        return;
      }
    }
    if (parsed?.method === "thread/settings/updated" && parsed.params?.threadId && claudeModel.has(parsed.params.threadId) && ![...pendingNativeRoutes.values()].some(route => route.threadId === parsed.params?.threadId)) {
      const tid = parsed.params.threadId;
      parsed.params.threadSettings = { ...parsed.params.threadSettings, model: claudeModel.get(tid), effort: claudeEffort.get(tid) ?? parsed.params.threadSettings?.effort ?? null };
      ws.send(JSON.stringify(parsed));
      return;
    }
    if (parsed.id !== undefined && pendingModelList.has(parsed.id) && Array.isArray(parsed.result?.data) && parsed.result.data.every(wireObject)) {
      pendingModelList.delete(parsed.id);
      await addSubscriptionModels(parsed.result.data, AGENTS, catalogFor, log);
      ws.send(JSON.stringify(parsed));
      return;
    }
    const lifecycleNotification = (parsed?.method === "thread/deleted" && parsed.params?.threadId && deletingThreads.has(parsed.params.threadId))
      || (parsed?.method === "thread/archived" && parsed.params?.threadId && archivingThreads.has(parsed.params.threadId));
    if (!lifecycleNotification) ws.send(helpersMarked ? JSON.stringify(parsed) : line);
    if (reopened) replayPlan(reopened);
  };

}
