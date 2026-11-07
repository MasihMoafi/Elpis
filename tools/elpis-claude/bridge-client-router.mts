import { shouldMergeThreadList } from "./bridge-thread-list.mts";
import type { ResumeResult,HelperScope,ProviderOwner,EngineThread,ChildThread,ProviderTurn } from "./bridge-types.mts";
import type WebSocket from "ws";
import { SIGNED_OUT_MESSAGE } from "./anthropic-signout.mts";
import { redactSecrets } from "./log-redaction.mts";

import type { ClientRouterDependencies } from "./bridge-connection.mts";

/** Route one frontend connection's requests to its owning provider or engine. */
export function createClientRouter({ AGENTS, HOME, acps, activeTurns, answerChild, appMcpConfig, archiveProvider, archivingThreads, boundAccess, cancelClaudeSteers, cancelWaitingClaudeSteers, checkIdle, childIds, childThreads, claimProvider, claudeAccountsRequest, claudeEffort, claudeModel, claudeSubscriptionRequest, claudeTurn, context, deleteThread, deletedThreads, deletingThreads, enforceHelper, engine, engineCall, explicitChatChoices, forkProviderChat, goalRequest, helperConns, helperScope, isBridged, listProviderHistory, loadStore, loadStoreSnapshot, log, markHelpers, now, openingEnvironment, openingMcp, openingReplies, ownHelpers, pendingArchive, pendingChildList, pendingConfigRead, pendingHelperMark, pendingHelperTurns, pendingItemsList, pendingLimitsRead, pendingMirrors, pendingModelList, pendingNativeRoutes, pendingResume, pendingSteers, pendingThreadList, pendingTurnsList, permissionWrites, providerContextFiles, providerHistory, providerOwners, queueRequest, recoverClaudeTurn, relayed, rememberStart, resumeOptions, resumeResults, resumeThread, revertThread, reviewClaude, runWorkGraph, sendClient, settleRelay, signedOutModel, startThread, steerClaude, storeChain, structured, structuredClaude, subscriptions, threadCollab, threadEnvironment, threadMcp, threadSeen, toTui, updateStore, workflowRequest, workflowToolConns, ws }: ClientRouterDependencies) {
  function handleMessage(data: WebSocket.RawData | string, recovered = false) {
    const line = data.toString();
    let msg;
    try { msg = JSON.parse(line); } catch { engine.stdin.write(line + "\n"); return; }
    if (msg.id !== undefined && !msg.method && String(msg.id).startsWith("relay-")) {
      const relay = relayed.get(msg.id);
      if (relay?.clients.has(ws)) {
        settleRelay(msg.id, msg);
      }
      return;
    }
    if (msg.method === "initialize" && msg.params?.clientInfo?.name === "elpis-agents") helperConns.add(ws);
    if (msg.method === "initialize" && msg.params?.clientInfo?.name === "elpis-workflow") workflowToolConns.add(ws);
    if (context.failed && msg.method && msg.id !== undefined) { toTui({ id: msg.id, error: { code: -32603, message: "The session backend disconnected; reopen this chat." } }); return; }
    const target = msg.params?.threadId ?? msg.params?.elpisParentThreadId;
    if (msg.method && (deletingThreads.has(target) || archivingThreads.has(target) || (deletedThreads.has(target) && msg.method !== "thread/delete"))) {
      const message = deletedThreads.has(target) ? `thread not found: ${target}` : archivingThreads.has(target) ? "The chat is being archived; wait for archiving to finish." : "The chat is being deleted; wait for deletion to finish.";
      toTui({ id: msg.id, error: { code: -32600, message } }); return;
    }
    if (typeof msg.method === "string" && msg.method.startsWith("workflowRun/")) {
      workflowRequest(msg).catch((e) => toTui({ id: msg.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message ?? String(e) } }));
      return;
    }
    if (msg.method === "workGraph/run" || msg.method === "workGraph/runWithProviders") {
      runWorkGraph(msg).catch(e => toTui({ id: msg.id, error: Number.isInteger(e.code) ? e : { code: -32603, message: e.message ?? String(e) } }));
      return;
    }
    if (msg.method === "claudeSubscription/read" || msg.method === "claudeSubscription/write") { claudeSubscriptionRequest(msg); return; }
    if (msg.method === "claudeAccounts/read" || msg.method === "claudeAccounts/write") { void claudeAccountsRequest(msg); return; }
    const owner = providerOwners.get(msg.params?.threadId);
    if (msg.method === "thread/unsubscribe" && owner) {
      const tid = msg.params.threadId;
      const subscribed = subscriptions.get(ws)?.delete(tid);
      for (const [id, relay] of relayed) if (relay.threadId === tid && relay.clients.delete(ws)) {
        sendClient(ws, { method: "serverRequest/resolved", params: { threadId: relay.message.params.threadId, requestId: id } });
      }
      // The provider runtime still needs its engine subscription for confirmed permissions.
      toTui({ id: msg.id, result: { status: subscribed ? "unsubscribed" : "notSubscribed" } });
      checkIdle(); return;
    }
    if (msg.method && owner && owner.ws !== ws && (!owner.nativeHelper || ["thread/resume", "thread/read", "thread/subscribe", "thread/turns/list", "thread/items/list", "thread/settings/update", "turn/start", "turn/steer", "turn/interrupt"].includes(msg.method))) {
      owner.dispatch(msg, ws); return;
    }
    if (pendingMirrors.has(msg.params?.threadId) && ["turn/start", "thread/settings/update", "thread/fork", "thread/revert", "thread/archive", "thread/delete"].includes(msg.method)) {
      (pendingMirrors.get(msg.params.threadId) as Promise<void>).then(() => handleMessage(data, recovered));
      return;
    }
    if (!recovered && (claudeModel.has(msg.params?.threadId) || !threadSeen.has(msg.params?.threadId)) && ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list", "turn/steer"].includes(msg.method)) {
      recoverClaudeTurn(msg.params?.threadId).then(() => handleMessage(data, true), error => {
        log(`turn recovery: ${error.message}`);
        handleMessage(data, true);
      });
      return;
    }
    if (msg.method === "thread/delete") { deleteThread(msg); return; }
    if (msg.method === "thread/subscribe") openingReplies.add(msg.id);
    if (["thread/start", "thread/fork", "thread/resume"].includes(msg.method)) {
      openingReplies.add(msg.id);
      const appMcp = appMcpConfig(msg.params?.config);
      if (appMcp && msg.method === "thread/resume") threadMcp.set(msg.params.threadId, appMcp);
      else if (appMcp) openingMcp.set(msg.id, appMcp);
      const environment = msg.params?.config?.['shell_environment_policy.set'];
      if (environment && typeof environment === 'object' && !Array.isArray(environment) && Object.values(environment).every(value => typeof value === 'string')) {
        if (msg.method === 'thread/resume') threadEnvironment.set(msg.params.threadId, environment);
        else openingEnvironment.set(msg.id, environment);
      }
    }
    if (process.env.ACP_BRIDGE_DEBUG && msg.method && (process.env.ACP_BRIDGE_DEBUG === "all" || !/^thread\/(read|turns\/list|list|loaded)/.test(msg.method))) log(`tui-> ${redactSecrets(line).slice(0, 600)}`);
    if (msg.method === "thread/read" && claudeModel.has(msg.params?.threadId) && resumeResults.has(msg.params.threadId)) {
      const tid = msg.params.threadId;
      storeChain().then(loadStore).then(async (store) => {
        const history = msg.params.includeTurns ? await providerHistory(tid, store) : { turns: [], cursor: null };
        const thread = { ...(resumeResults.get(tid) as ResumeResult).thread, ...threadSeen.get(tid), turns: history.turns };
        await markHelpers({ thread });
        toTui({ id: msg.id, result: { thread } });
      }).catch((e) => toTui({ id: msg.id, error: { code: -32603, message: e.message } }));
      return;
    }
    if ((msg.method === "thread/read" || msg.method === "thread/resume" || msg.method === "thread/subscribe") && childIds.has(msg.params?.threadId)) { answerChild(msg); return; }
    if (msg.method === "thread/read" && msg.params?.includeTurns) {
      (async () => {
        await storeChain();
        const historyStore = await loadStoreSnapshot();
        const tid = msg.params.threadId;
        if (historyStore[tid]?.providerHistory) {
          const result = await engineCall("thread/read", msg.params);
          const history = await providerHistory(tid, historyStore);
          (result.thread as EngineThread).turns = history.turns;
          toTui({ id: msg.id, result });
        } else engine.stdin.write(JSON.stringify(msg) + "\n");
      })().catch(error => toTui({ id: msg.id, error: Number.isInteger(error.code) ? error : { code: -32603, message: error.message } }));
      return;
    }

    if (msg.method === "thread/loaded/list") pendingChildList.set(msg.id, null);
    if (msg.method === "thread/list" && msg.params?.ancestorThreadId && !msg.params.cursor && !msg.params.archived) pendingChildList.set(msg.id, msg.params.ancestorThreadId);
    if (msg.method === "thread/list" || msg.method === "thread/read") pendingHelperMark.add(msg.id);
    if (msg.method === "model/list") pendingModelList.add(msg.id);
    if (msg.method === "thread/resume") { pendingResume.set(msg.id, msg.params?.threadId); resumeOptions.set(msg.id, msg.params ?? {}); resumeThread(msg); return; }
    if (msg.method === "thread/archive") {
      pendingArchive.set(msg.id, msg.params?.threadId);
      if (claudeModel.has(msg.params?.threadId)) { archiveProvider(msg); return; }
    }
    if (msg.method === "config/read") pendingConfigRead.add(msg.id);
    if (msg.method === "thread/fork" && claudeModel.has(msg.params?.threadId)) {
      const src = msg.params.threadId;
      const forkOf = { threadId: src, at: Math.floor(now() / 1000), beforeTurnId: msg.params.beforeTurnId ?? null, lastTurnId: msg.params.lastTurnId ?? null };
      rememberStart(msg.id, { model: claudeModel.get(src), effort: claudeEffort.get(src) ?? null, forkOf });
      forkProviderChat(msg); return;
    }
    if (msg.method === "thread/start") { startThread(msg); return; }
    if (msg.method === "thread/revert") { revertThread(msg); return; }
    if (msg.method === "review/start" && claudeModel.has(msg.params?.threadId) && !activeTurns.has(msg.params.threadId)) { reviewClaude(msg); return; }
    if (msg.method === "thread/turns/list" || msg.method === "thread/items/list") {
      (async () => {
        await storeChain();
        const historyStore = await loadStoreSnapshot();
        const tid = msg.params?.threadId;
        if (claudeModel.has(tid) || (historyStore[tid]?.model || historyStore[tid]?.providerHistory) || (providerOwners.has(tid) && !(providerOwners.get(tid) as ProviderOwner).nativeHelper) || childIds.has(tid)) await listProviderHistory(msg, historyStore);
        else engine.stdin.write(JSON.stringify(msg) + "\n");
      })().catch(error => toTui({ id: msg.id, error: Number.isInteger(error.code) ? error : { code: -32603, message: error.message } }));
      return;
    }
    if (msg.method === "thread/turns/list" && msg.params?.threadId) pendingTurnsList.set(msg.id, msg.params);
    if (msg.method === "account/rateLimits/read") pendingLimitsRead.add(msg.id);
    if (msg.method === "thread/items/list" && msg.params?.threadId) pendingItemsList.set(msg.id, msg.params);
    const lp = msg.params ?? {};
    if (msg.method === "thread/list" && shouldMergeThreadList(lp)) pendingThreadList.set(msg.id, lp);
    if (msg.method === "thread/settings/update") {
      const p = msg.params ?? {};
      if (ownHelpers.has(p.threadId) && !explicitChatChoices.has(p.threadId) && !permissionWrites.has(msg.id)) boundAccess(p, (helperScope.get(p.threadId) as HelperScope).ceiling, "sandboxPolicy");
      const choice = permissionWrites.get(msg.id);
      if (choice?.settings.permissions && choice.settings.permissions !== p.permissions) permissionWrites.delete(msg.id);
      if (isBridged(p.model)) { claudeModel.set(p.threadId, p.model); claimProvider(p.threadId); p.model = null; log(`thread ${p.threadId} -> ${claudeModel.get(p.threadId)}`); }
      else if (typeof p.model === "string") {
        if (activeTurns.has(p.threadId)) { toTui({ id: msg.id, error: { code: -32600, message: "Wait for the active provider turn to finish before switching this conversation to a native model." } }); return; }
        pendingNativeRoutes.set(msg.id, { threadId: p.threadId, model: p.model, effort: p.effort });
      }
      // Permissions become authoritative only on thread/settings/updated. A rejected or queued
      // request must never grant the bridge permission ahead of the engine.
      if (p.collaborationMode?.mode) {
        threadCollab.set(p.threadId, p.collaborationMode.mode);
        if (!pendingNativeRoutes.has(msg.id) && claudeModel.has(p.threadId) && p.collaborationMode.settings && !isBridged(p.collaborationMode.settings.model)) p.collaborationMode.settings.model = null;
      }
      if (!pendingNativeRoutes.has(msg.id) && p.effort && claudeModel.has(p.threadId)) {
        // Saved later in the store's queue, so it keeps its own copy: p.effort is cleared below for the engine.
        const effort = p.effort;
        claudeEffort.set(p.threadId, effort);
        updateStore((st) => { st[p.threadId] = { ...st[p.threadId], effort }; });
        // A running turn takes the new effort from its next request, not only from the next turn.
        const running = activeTurns.get(p.threadId);
        if (running?.acp && running.sessionId) running.acp.call("session/set_config_option", { sessionId: running.sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
        p.effort = null;
      }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "config/batchWrite" && Array.isArray(msg.params?.edits)) {
      const modelEdit = msg.params.edits.find((e: { keyPath: string; value: string }) => e.keyPath === "model");
      const claudePick = isBridged(modelEdit?.value);
      if (modelEdit) {
        const effort = msg.params.edits.find((e: { keyPath: string; value: string }) => e.keyPath === "model_reasoning_effort")?.value;
        updateStore((st) => { if (claudePick) st._default = { model: modelEdit.value, effort: effort && effort !== "default" ? effort : null }; else delete st._default; });
      }
      if (claudePick) msg.params.edits = msg.params.edits.filter((e: { keyPath: string }) => e.keyPath !== "model" && e.keyPath !== "model_reasoning_effort");
      if (claudePick && msg.params.edits.length === 0) { toTui({ id: msg.id, result: { status: "ok", version: "elpis-claude", filePath: `${HOME}/.elpis-next/config.toml`, overriddenMetadata: null } }); return; }
      engine.stdin.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg.method === "turn/start") {
      const tid = msg.params?.threadId;
      const sendNativeTurn = () => {
        if (ownHelpers.has(tid) && msg.id !== undefined) pendingHelperTurns.set(msg.id, tid);
        engine.stdin.write(JSON.stringify(msg) + "\n");
      };
      if (ownHelpers.has(tid) && !explicitChatChoices.has(tid)) boundAccess(msg.params, (helperScope.get(tid) as HelperScope).ceiling, "sandboxPolicy");
      if (msg.params?.collaborationMode?.mode) threadCollab.set(tid, msg.params.collaborationMode.mode);
      // Its permission fields are the TUI's unconfirmed choice: a Claude turn ignores them (see
      // claudeTurn), and the engine reports what it accepts for its own turn in
      // thread/settings/updated.
      const requestedNative = typeof msg.params?.model === "string" && !isBridged(msg.params.model);
      if (requestedNative && activeTurns.has(tid)) { toTui({ id: msg.id, error: { code: -32600, message: "Wait for the active provider turn to finish before switching this conversation to a native model." } }); return; }
      if (requestedNative) {
        const go = () => {
          pendingNativeRoutes.set(msg.id, { threadId: tid, model: msg.params.model, effort: msg.params.effort });
          sendNativeTurn();
        };
        const own = ownHelpers.get(tid);
        if (own && (own.applying || own.failed)) {
          own.nativeWaiting.add(msg.id);
          enforceHelper(tid).then(ok => {
            const pending = own.nativeWaiting.delete(msg.id);
            if (!pending) return;
            if (ok && !context.failed) go();
            else toTui({ id: msg.id, error: { code: -32600, message: "The next turn was not started: its chat's restricted permissions could not be applied." } });
          });
        } else go();
        return;
      }
      // A turn on a subscription Elpis is signed out of is refused before anything changes (hidden title
      // and recap requests are refused in structuredClaude, and queued, goal, compact and review turns in claudeTurn).
      if (!String(msg.id).startsWith("temporary-structured-turn") && signedOutModel(isBridged(msg.params?.model) ? msg.params.model : claudeModel.get(tid))) {
        toTui({ id: msg.id, error: { code: -32600, message: SIGNED_OUT_MESSAGE } }); return;
      }
      if (isBridged(msg.params?.model)) {
        claudeModel.set(tid, msg.params.model);
        claimProvider(tid);
        if (msg.params.effort) claudeEffort.set(tid, msg.params.effort);
      }
      if (claudeModel.has(tid) && String(msg.id).startsWith("temporary-structured-turn")) { structuredClaude(msg); return; }
      if (claudeModel.has(tid)) {
        if (activeTurns.has(tid)) {
          toTui({ id: msg.id, error: { code: -32600, message: "thread already has an active or pending turn; steer or queue the message instead" } });
          return;
        }
        log(`subscription turn for thread ${tid} (${claudeModel.get(tid)})`);
        claudeTurn(msg);
        return;
      }
      if (isBridged(msg.params?.model)) msg.params.model = null;
      const own = ownHelpers.get(tid);
      if (own?.applying || own?.failed) {
        // An engine helper starts its next turn only once its engine has confirmed its restriction.
        own.waiting.push(msg.id);
        (own.applying ?? enforceHelper(tid)).then((ok) => { if (ok) sendNativeTurn(); });
        return;
      }
      sendNativeTurn();
      return;
    }
    if (msg.method === "thread/compact/start" && claudeModel.has(msg.params?.threadId) && !activeTurns.has(msg.params.threadId)) {
      toTui({ id: msg.id, result: {} });
      const extra = msg.params.instructions ? ` ${msg.params.instructions}` : "";
      log(`claude compact for thread ${msg.params.threadId}`);
      claudeTurn({ kind: "compact", params: { threadId: msg.params.threadId, input: [{ type: "text", text: `/compact${extra}`, text_elements: [] }] } });
      return;
    }
    if (msg.method === "turn/interrupt" && childThreads.get(msg.params?.threadId)?.cancel && !(childThreads.get(msg.params.threadId) as ChildThread).lane.done) {
      ((childThreads.get(msg.params.threadId) as ChildThread).cancel as () => void)();
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/interrupt" && structured.has(msg.params?.threadId)) {
      acps.get(AGENTS[0].key)?.send({ method: "session/cancel", params: { sessionId: structured.get(msg.params.threadId) } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (/^thread\/goal\/(set|get|clear)$/.test(msg.method) && claudeModel.has(msg.params?.threadId)) { goalRequest(msg); return; }
    if (/^thread\/contextFiles\/(list|set)$/.test(msg.method) && claudeModel.has(msg.params?.threadId)) { void providerContextFiles(msg); return; }
    if (/^thread\/queue\//.test(msg.method) && claudeModel.has(msg.params?.threadId)) { queueRequest(msg); return; }
    if (msg.method === "turn/interrupt" && activeTurns.has(msg.params?.threadId)) {
      const running = activeTurns.get(msg.params.threadId) as ProviderTurn;
      running.cancelled = true;
      running.endFollowup?.({ stopReason: "cancelled" });
      cancelWaitingClaudeSteers(msg.params.threadId, [...(pendingSteers.get(msg.params.threadId)?.keys() ?? [])]);
      if (running.sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId: running.sessionId } });
      toTui({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/steer" && claudeModel.has(msg.params?.threadId)) {
      steerClaude(msg);
      return;
    }
    if (msg.method === "turn/steer/cancel" && claudeModel.has(msg.params?.threadId)) {
      cancelClaudeSteers(msg);
      return;
    }
    engine.stdin.write(line + "\n");
    // Stopping a helper also ends the commands it left running, which would otherwise finish its work.
    if (msg.method === "turn/interrupt" && owner?.nativeHelper && owner.ws === ws) engineCall("thread/backgroundTerminals/clean", { threadId: msg.params.threadId }).catch(() => {});
  }
  return handleMessage;
}
