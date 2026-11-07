import { addSubscriptionModels } from "./bridge-model-list.mts";
import { listField } from "./bridge-thread-list.mts";
import type { ThreadListRequest } from "./bridge-thread-list.mts";
import type { BridgeError,ResumeResult,HelperScope,McpConfig,TranscriptTurn,SavedHelper,EngineThread,Ceiling } from "./bridge-types.mts";
import { defaultPermissionSettings,permissionSettingsAllowed } from './permission-policy.mts';

import type { EngineMessageDependencies } from "./bridge-connection.mts";

/** Reconcile native-engine replies and notifications with bridge state. */
export function createEngineMessageHandler({ AGENTS, TOOL_APPROVALS, addSubscriptionLimits, adoptHelper, agentOf, announceLimits, archivingThreads, authorityOf, automaticThreads, blockedAutomaticThreads, catalogFor, chatAccess, chatBack, checkIdle, claimProvider, claudeEffort, claudeModel, connectionId, deletingThreads, engine, engineCall, engineReqs, engineTurns, explicitChatChoices, failHelper, forkParent, fullFor, helperConns, helperScope, helperThreads, loadStore, log, markHelpers, missingThreadUntil, nameModel, noteAccess, notePlan, notify, now, openHelper, openingEnvironment, openingMcp, ownModel, pendingAdopt, pendingArchive, pendingChildList, pendingConfigRead, pendingDelegation, pendingHelperMark, pendingHelperTurns, pendingHelpers, pendingItemsList, pendingLimitsRead, pendingModelList, pendingNativeRoutes, pendingResume, pendingStart, pendingThreadList, pendingTurnsList, permissionChoices, permissionRefreshes, permissionWrites, providerOwners, queues, relayToTui, relayed, replayPlan, restrictHelper, resumeHistory, resumeOptions, resumeResults, sessions, settleRelay, shareHelper, signedOutModel, smartPrune, startingProviders, stopIfReduced, storeChain, storedChildren, subscriptions, threadCwd, threadEnvironment, threadMcp, threadPolicy, threadSeen, toOthers, toTui, unlistedClaudeThreads, updateStore, ws }: EngineMessageDependencies) {
  return async (line: string) => {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed && !parsed.method && permissionRefreshes.delete(parsed.id) && !parsed.error) {
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
          const ceiling = ({ ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' } as Record<string, Ceiling>)[settings.permissions as string];
          if (ceiling) { helper.ceiling = ceiling; scopes.push([tid, helper]); }
        }
        if (scopes.length) {
          await updateStore(store => { for (const [tid, helper] of scopes) if (store._delegations?.[tid]) store._delegations[tid].ceiling = helper.ceiling; });
          const applied = await Promise.all(scopes.flatMap(([tid, helper]) => [...helper.owners].map(apply => apply(tid))));
          if (applied.some(ok => !ok)) throw new Error('An automatic agent could not apply the new default permissions.');
        }
      } catch (error) { parsed = { id: parsed.id, error: { code: -32603, message: `The default was saved, but an open chat could not be updated: ${(error as BridgeError).message ?? error}` } }; }
      line = JSON.stringify(parsed);
    }
    if (parsed && !parsed.method && permissionWrites.has(parsed.id)) {
      const write = permissionWrites.get(parsed.id) as { threadId?: string; settings: { permissions?: string; inherit?: boolean; automatic?: boolean }; ephemeral?: boolean }; permissionWrites.delete(parsed.id);
      if (!parsed.error) {
        try {
          const tid = write.threadId ?? parsed.result?.thread?.id;
          blockedAutomaticThreads.delete(tid);
          if (!write.settings.inherit && !write.settings.automatic) explicitChatChoices.add(tid);
          if (write.ephemeral) { if (write.settings.automatic) automaticThreads.add(tid); }
          else await permissionChoices.write(tid, write.settings);
        }
        catch { parsed = { id: parsed.id, error: { code: -32603, message: 'The permission choice could not be saved. Choose it again before restarting.' } }; line = JSON.stringify(parsed); }
      }
    }
    if (parsed && !parsed.method && pendingHelperTurns.has(parsed.id)) {
      const tid = pendingHelperTurns.get(parsed.id) as string;
      pendingHelperTurns.delete(parsed.id);
      if (parsed.result?.turn?.status === "inProgress") engineTurns.set(tid, parsed.result.turn.id);
      checkIdle();
    }
    const th = parsed?.result?.thread ?? parsed?.params?.thread;
    if (th?.id && th?.cwd) { threadCwd.set(th.id, th.cwd); threadSeen.set(th.id, { ...th, turns: [] }); }
    if (parsed?.method === 'thread/started' && th?.id && (th.parentThreadId || th.source?.subAgent)) {
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
        notify('warning', { threadId: th.id, message: (error as BridgeError).message ?? String(error) });
      }
    }
    if (parsed?.method === 'turn/started' && blockedAutomaticThreads.has(parsed.params?.threadId)) {
      void engineCall('turn/interrupt', { threadId: parsed.params.threadId, turnId: parsed.params.turn.id }).catch(error => log(`automatic agent interrupt: ${error.message ?? error}`));
    }
    if (parsed?.id !== undefined && TOOL_APPROVALS.has(parsed.method)) {
      const tid = parsed.params.threadId;
      const own = await permissionChoices.read(tid);
      if (threadPolicy.get(tid) === 'never' || ((automaticThreads.has(tid) || helperScope.has(tid)) && (!own || own.inherit || own.automatic))) {
        engine.stdin.write(JSON.stringify({ id: parsed.id, result: { decision: !blockedAutomaticThreads.has(parsed.params.threadId) && fullFor(parsed.params.threadId) ? 'accept' : 'decline' } }) + '\n');
        return;
      }
      if (relayToTui(parsed, reply => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + '\n'), ws, true)) return;
    }
    if (th?.id && parsed?.result?.approvalPolicy) { noteAccess(th.id, parsed.result); resumeResults.set(th.id, { ...parsed.result, thread: { ...th } }); }
    if (parsed?.method === "thread/name/updated") {
      const { threadId, threadName } = parsed.params;
      if (threadSeen.has(threadId)) (threadSeen.get(threadId) as EngineThread).name = threadName;
      if (resumeResults.has(threadId)) (resumeResults.get(threadId) as ResumeResult).thread.name = threadName;
    }
    if (parsed?.method === "turn/started" && parsed.params?.turn?.id) engineTurns.set(parsed.params.threadId, parsed.params.turn.id);
    if (parsed?.method === "turn/completed") { engineTurns.delete(parsed.params?.threadId); checkIdle(); }
    const helperId = parsed?.params?.threadId;
    const helperOwner = providerOwners.get(helperId);
    const helper = helperOwner?.nativeHelper && helperOwner.ws === ws ? helperScope.get(helperId) : null;
    if (helper) {
      const turn = parsed.params?.turn;
      if (parsed.method === "turn/started" && turn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = restrictHelper;
      } else if (parsed.method === "turn/completed" && turn?.id === helper.lastTurn?.id) {
        helper.lastTurn = { ...turn, items: [], itemsView: "notLoaded" };
        helper.activeOwner = null;
      } else if (parsed.method === "thread/status/changed") {
        if (parsed.params.status?.type === "active") helper.activeOwner = restrictHelper;
        else if (["idle", "notLoaded"].includes(parsed.params.status?.type) && helper.activeOwner === restrictHelper) helper.activeOwner = null;
      }
    }
    // An unsubscribed native thread no longer sends its turn/completed here. The engine
    // broadcasts thread/closed after its work stops and its unsubscribed runtime unloads.
    if (parsed?.method === "thread/closed") engineTurns.delete(parsed.params?.threadId);
    if (parsed?.method === "thread/status/changed" && ["idle", "notLoaded"].includes(parsed.params?.status?.type)) engineTurns.delete(parsed.params.threadId);
    if (parsed?.method === 'serverRequest/resolved' && parsed.params?.requestId !== undefined) {
      for (const [id, relay] of relayed) if (relay.origin === ws && relay.upstreamId === parsed.params.requestId) settleRelay(id);
    }
    if (parsed?.method === "thread/settings/updated") {
      const tid = parsed.params?.threadId;
      const previousAuthority = authorityOf(tid);
      noteAccess(tid, parsed.params?.threadSettings);
      stopIfReduced(tid, previousAuthority);
    }
    shareHelper(parsed);
    notePlan(parsed);
    if (parsed?.method === "thread/unarchived" && parsed.params?.threadId) chatBack(parsed.params.threadId);
    if (parsed?.method === "thread/smartPrune/updated" && parsed.params?.threadId) smartPrune.set(parsed.params.threadId, !!parsed.params.smartPrune?.enabled);
    if (parsed?.method && parsed.id !== undefined && ((helperConns.has(ws) && helperThreads.has(parsed.params?.threadId)) || providerOwners.get(parsed.params?.threadId)?.ws === ws)
      && relayToTui(parsed, (reply) => engine.stdin.write(JSON.stringify({ id: parsed.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }) + "\n"), ws)) return;
    if (parsed && pendingNativeRoutes.has(parsed.id)) {
      const route = pendingNativeRoutes.get(parsed.id) as { threadId: string; model: string; effort?: string | null };
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
    if (parsed && engineReqs.has(parsed.id) && !parsed.method) {
      const p = engineReqs.get(parsed.id) as { resolve: (result: unknown) => void; reject: (error: unknown) => void }; engineReqs.delete(parsed.id);
      if (parsed.error) p.reject(parsed.error); else p.resolve(parsed.result);
      return;
    }
    // A timed-out internal read may still answer later; it is never a client reply.
    if (!parsed?.method && typeof parsed?.id === "string" && parsed.id.startsWith("acp-bridge-engine-")) return;
    // A chat only the bridge knows (a helper whose one turn failed, so the engine never saved
    // it) archives by leaving the bridge's records.
    if (parsed && pendingArchive.has(parsed.id)) {
      const threadId = pendingArchive.get(parsed.id) as string; pendingArchive.delete(parsed.id);
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
    if (parsed && pendingLimitsRead.delete(parsed.id)) { await addSubscriptionLimits(parsed); helpersMarked = true; }
    if (parsed && pendingHelperMark.has(parsed.id)) {
      pendingHelperMark.delete(parsed.id);
      helpersMarked = await markHelpers(parsed.result, pendingChildList.get(parsed.id)).catch((e) => { log(`helpers: ${e.message ?? e}`); return false; });
    }
        if (parsed.id != null && pendingTurnsList.has(parsed.id)) pendingTurnsList.delete(parsed.id);
        if (parsed.id != null && pendingItemsList.has(parsed.id)) pendingItemsList.delete(parsed.id);

    if (parsed && pendingChildList.has(parsed.id)) {
      const ancestor = pendingChildList.get(parsed.id); pendingChildList.delete(parsed.id);
      const data = parsed.result?.data;
      if (Array.isArray(data)) {
        const kids = await storedChildren(new Set(ancestor ? [ancestor] : data)).catch(() => new Map());
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
    if (parsed && pendingThreadList.has(parsed.id)) {
      const req = pendingThreadList.get(parsed.id) as ThreadListRequest; pendingThreadList.delete(parsed.id);
      if (Array.isArray(parsed.result?.data)) {
        let added;
        try { added = await unlistedClaudeThreads(req, parsed.result); }
        catch (e) {
          log(`thread/list: ${(e as BridgeError).message ?? JSON.stringify(e)}`);
          ws.send(JSON.stringify({ id: parsed.id, error: Number.isInteger((e as BridgeError).code) ? e : { code: -32603, message: (e as BridgeError).message ?? String(e) } }));
          return;
        }
        if (added.length) {
          // Each goes before the first engine thread that sorts after it; the engine's own order stays.
          const field = listField(req);
          const value = (t: EngineThread) => t[field] ?? t.updatedAt ?? 0;
          for (const t of added.sort((a, b) => value(b) - value(a))) {
            const at = parsed.result.data.findIndex((d: EngineThread) => value(d) < value(t));
            parsed.result.data.splice(at < 0 ? parsed.result.data.length : at, 0, t);
          }
          log(`thread/list: +${added.length} Claude-only chats`);
          ws.send(JSON.stringify(parsed));
          return;
        }
      }
    }
    if (parsed && pendingConfigRead.has(parsed.id)) {
      pendingConfigRead.delete(parsed.id);
      const def = (await loadStore())._default;
      if (def?.model && !signedOutModel(def.model) && parsed.result?.config) {
        parsed.result.config = { ...parsed.result.config, model: def.model, model_reasoning_effort: def.effort ?? null };
        ws.send(JSON.stringify(parsed));
        return;
      }
    }
    if (parsed && pendingDelegation.has(parsed.id)) {
      // A helper started by a chat's delegate tool: remember who started it, for the agent console.
      const d = pendingDelegation.get(parsed.id) as SavedHelper & { sandbox: Ceiling }; pendingDelegation.delete(parsed.id); pendingHelpers.delete(d);
      const tid = parsed.result?.thread?.id;
      if (tid) {
        // Every connection uses this helper's resolved scope.
        if (openHelper(tid, d, d.ceiling).ceiling !== d.sandbox) restrictHelper(tid);
        const { ceiling } = helperScope.get(tid) as HelperScope;
        const run = d.workflowRunId ? { workflowRunId: d.workflowRunId, workflowAgentId: d.workflowAgentId } : {};
        updateStore((st) => { st._delegations = { ...st._delegations, [tid]: { parentThreadId: d.parentThreadId, model: d.model, startedAt: Math.floor(now() / 1000), requested: d.requested, ceiling, ...run } }; });
        log(`helper thread ${tid} (${d.model}) started by ${d.parentThreadId}`);
        helperThreads.add(tid);
        toOthers({ method: "thread/started", params: { thread: { ...parsed.result.thread, parentThreadId: d.parentThreadId, ...run, turns: [] } }, emittedAtMs: now() });
      }
    }
    if (parsed && openingMcp.has(parsed.id)) {
      const tid = parsed.result?.thread?.id;
      if (tid) threadMcp.set(tid, openingMcp.get(parsed.id) as McpConfig);
      openingMcp.delete(parsed.id);
    }
    if (parsed && openingEnvironment.has(parsed.id)) {
      const tid = parsed.result?.thread?.id;
      if (tid) threadEnvironment.set(tid, openingEnvironment.get(parsed.id) as Record<string, string>);
      openingEnvironment.delete(parsed.id);
    }
    if (parsed && pendingStart.has(parsed.id)) {
      const pick = pendingStart.get(parsed.id); pendingStart.delete(parsed.id);
      const tid = parsed.result?.thread?.id;
      const starting = startingProviders.get(`${connectionId}:${parsed.id}`);
      startingProviders.delete(`${connectionId}:${parsed.id}`);
      if (tid && pick?.model) {
        claudeModel.set(tid, pick.model);
        if (pick.effort) claudeEffort.set(tid, pick.effort);
        if (pick.forkOf) {
          // A fork with its own copy of the kept turns no longer reads them from its source.
          // An ephemeral side chat is never stored, so it keeps reading its source.
          const copied = pick.forkTurns && !parsed.result.thread?.ephemeral;
          const forkOf = copied ? { ...pick.forkOf, copied: true } : pick.forkOf;
          if (copied) await updateStore((st) => { st[tid] = { ...st[tid], forkOf, turns: [...(pick.forkTurns as TranscriptTurn[]), ...(st[tid]?.turns ?? [])] }; });
          else if (!parsed.result.thread?.ephemeral) updateStore((st) => { st[tid] = { ...st[tid], forkOf }; });
          forkParent.set(tid, forkOf);
        }
        nameModel(parsed.result, pick.model, pick.effort);
        claimProvider(tid, parsed.result);
        announceLimits(agentOf(pick.model), (method: string, params) => ws.send(JSON.stringify({ method, params })));
        if (!parsed.result.thread.ephemeral) await updateStore((st) => { st[tid] = { ...st[tid], model: pick.model, effort: pick.effort ?? null }; });
        starting?.resolve();
        log(`new thread ${tid} -> ${pick.model}`);
        ws.send(JSON.stringify(parsed));
        return;
      }
      starting?.resolve();
    }
    let reopened = null;
    if (parsed?.error && pendingResume.has(parsed.id)) {
      const tid = pendingResume.get(parsed.id) as string; pendingResume.delete(parsed.id); resumeOptions.delete(parsed.id);
      if (providerOwners.get(tid)?.ws === ws && !resumeResults.has(tid)) providerOwners.delete(tid);
    }
    if (parsed && pendingAdopt.has(parsed.id) && !parsed.result?.thread?.id) { pendingHelpers.delete(pendingAdopt.get(parsed.id) as SavedHelper); pendingAdopt.delete(parsed.id); }
    if (parsed && pendingResume.has(parsed.id) && parsed.result?.thread?.id) {
      const requestedResume = resumeOptions.get(parsed.id) ?? {};
      resumeOptions.delete(parsed.id);
      pendingResume.delete(parsed.id);
      reopened = parsed.result.thread.id;
      missingThreadUntil.delete(reopened as string);
      await storeChain();
      const saved = (await loadStore())[parsed.result.thread.id];
      const helper = pendingAdopt.get(parsed.id);
      pendingAdopt.delete(parsed.id); pendingHelpers.delete(helper as SavedHelper);
      if (helper && !(await adoptHelper(reopened as string, helper, !!saved?.model))) {
        ws.send(JSON.stringify({ id: parsed.id, error: { code: -32600, message: "The helper was not reopened: its chat's restricted permissions could not be applied." } }));
        if (helperConns.has(ws)) failHelper(reopened as string, "its chat's restricted permissions could not be applied");
        return;
      }
      if (saved?.model || saved?.providerHistory) {
        if (saved.model) claudeModel.set(parsed.result.thread.id, saved.model);
        if (saved.effort) claudeEffort.set(parsed.result.thread.id, saved.effort);
        if (saved.model) { nameModel(parsed.result, saved.model, saved.effort); claimProvider(parsed.result.thread.id, parsed.result); }
        try { parsed.result = await resumeHistory(parsed.result, parsed.result.thread.id, await loadStore(), requestedResume); }
        catch (error) { toTui({ id: parsed.id, error: Number.isInteger((error as BridgeError).code) ? error : { code: -32603, message: (error as BridgeError).message } }); return; }
        log(`resume ${parsed.result.thread.id} -> ${saved.model}`);
        ws.send(JSON.stringify(parsed));
        if (saved.model) announceLimits(agentOf(saved.model), (method: string, params) => ws.send(JSON.stringify({ method, params })));
        replayPlan(parsed.result.thread.id);
        return;
      }
    }
    if (parsed?.method === "thread/settings/updated" && claudeModel.has(parsed.params?.threadId) && ![...pendingNativeRoutes.values()].some(route => route.threadId === parsed.params.threadId)) {
      const tid = parsed.params.threadId;
      parsed.params.threadSettings = { ...parsed.params.threadSettings, model: claudeModel.get(tid), effort: claudeEffort.get(tid) ?? parsed.params.threadSettings?.effort ?? null };
      ws.send(JSON.stringify(parsed));
      return;
    }
    if (parsed && pendingModelList.has(parsed.id) && Array.isArray(parsed.result?.data)) {
      pendingModelList.delete(parsed.id);
      await addSubscriptionModels(parsed.result.data, AGENTS, catalogFor, log);
      ws.send(JSON.stringify(parsed));
      return;
    }
    const lifecycleNotification = (parsed?.method === "thread/deleted" && deletingThreads.has(parsed.params?.threadId))
      || (parsed?.method === "thread/archived" && archivingThreads.has(parsed.params?.threadId));
    if (!lifecycleNotification) ws.send(helpersMarked ? JSON.stringify(parsed) : line);
    if (reopened) replayPlan(reopened);
  };

}
