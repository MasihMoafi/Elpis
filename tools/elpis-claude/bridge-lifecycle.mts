import type { BridgeClient,BridgeContext,BridgeError,BridgeMessage,HelperScope,NoticeParams,ProviderOwner,ProviderTurn,QueueEntry,RequestId,SavedSession,Steer,Store,ThreadRequest } from "./bridge-types.mts";

type Dependencies = {
  pendingSteers: Map<string, Map<string, Steer>>; activeTurns: Map<string, ProviderTurn>;
  cancelWaitingClaudeSteers: (threadId: string, ids: string[]) => string[];
  contexts: Set<BridgeContext>; storeChain: () => Promise<void>; loadStore: () => Promise<Store>;
  archivingThreads: Set<string>; deletingThreads: Set<string>; deletedThreads: Set<string>;
  updateStore: (update: (store: Store) => void) => Promise<boolean>;
  toTui: (message: BridgeMessage) => void; notify: (method: string, params: NoticeParams) => void;
  claudeModel: Map<string, string>; pendingArchive: Map<RequestId, string | undefined>;
  queueOf: (threadId: string) => QueueEntry[]; pendingHelpers: Set<{ parentThreadId: string }>;
  providerOwners: Map<string, ProviderOwner>; chatAccess: Map<string, { policy: string | undefined; profile: string | undefined }>;
  helperScope: Map<string, HelperScope>; helperThreads: Set<string>; subscriptions: Map<BridgeClient, Set<string>>;
};

/** Stop, archive, or delete provider chats and their descendants across connections. */
export function createThreadLifecycle({ pendingSteers, activeTurns, cancelWaitingClaudeSteers, contexts, storeChain, loadStore, archivingThreads, deletingThreads, deletedThreads, updateStore, toTui, notify, claudeModel, pendingArchive, queueOf, pendingHelpers, providerOwners, chatAccess, helperScope, helperThreads, subscriptions }: Dependencies) {
  async function stopProvider(tid: string, action: string) {
    const running = activeTurns.get(tid);
    if (!running) return;
    running.cancelled = true;
    cancelWaitingClaudeSteers(tid, [...(pendingSteers.get(tid)?.keys() ?? [])]);
    let timer;
    try {
      const stopped = (async () => {
        const sessionId = await running.ready;
        if (sessionId) running.acp?.send({ method: "session/cancel", params: { sessionId } });
        await running.done;
      })();
      await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The provider has not stopped yet; the chat was not ${action}.`)), 10000); })]);
    } finally { clearTimeout(timer); }
  }
  async function nativeThreadLifecycle(method: string, tid: string) {
    const failures = [];
    for (const c of [...contexts]) {
      if (c.failed) continue;
      try { return { found: true, result: await c.nativeLifecycle(method, tid) }; }
      catch (e) {
        failures.push(e);
        if (!/already has an active writer|active writer|thread not found|no rollout found/i.test((e as BridgeError).message ?? "")) throw e;
      }
    }
    const missing = failures.length > 0 && failures.every(e => /thread not found|no rollout found/i.test((e as BridgeError).message ?? ""));
    if (missing) return { found: false, error: failures.at(-1) };
    throw failures.find(e => /active writer/i.test((e as BridgeError).message ?? "")) ?? failures.at(-1) ?? new Error(`no live engine can ${method} ${tid}`);
  }
  async function archiveProvider(msg: ThreadRequest) {
    const tid = msg.params.threadId;
    const ids = new Set([tid]);
    try {
      await storeChain();
      const store = await loadStore();
      let changed;
      do {
        changed = false;
        for (const [id, saved] of Object.entries(store)) {
          const parent = store._delegations?.[id]?.parentThreadId ?? (saved as SavedSession)?.parentThreadId ?? (saved as SavedSession)?.rootThreadId;
          if (!id.startsWith("_") && ids.has(parent as string) && !ids.has(id)) { ids.add(id); changed = true; }
        }
        for (const [id, helper] of Object.entries(store._delegations ?? {})) {
          if (ids.has(helper.parentThreadId) && !ids.has(id)) { ids.add(id); changed = true; }
        }
        for (const c of contexts) for (const id of c.childrenOf(ids)) {
          if (!ids.has(id)) { ids.add(id); changed = true; }
        }
      } while (changed);
      if ([...ids].some(id => archivingThreads.has(id) || deletingThreads.has(id) || deletedThreads.has(id))) throw new Error("A chat in this subtree is already being archived or deleted.");
      for (const id of ids) archivingThreads.add(id);
      await Promise.all([...contexts].flatMap(c => [...ids].map(id => c.stopProviderFor(id, "archived"))));
      const attempt = await nativeThreadLifecycle("thread/archive", tid);
      if (!attempt.found) {
        if (!store[tid] && !store._delegations?.[tid] && !claudeModel.has(tid)) throw attempt.error ?? new Error(`no rollout found for thread id ${tid}`);
        await updateStore(st => { delete st[tid]; if (st._delegations) delete st._delegations[tid]; });
        for (const id of ids) queueOf(id).splice(0);
        for (const c of contexts) c.forgetArchived(tid);
        pendingArchive.delete(msg.id);
        toTui({ id: msg.id, result: {} });
        notify("thread/archived", { threadId: tid });
        return;
      }
      for (const id of ids) queueOf(id).splice(0);
      const archived = [...ids].filter(id => id === tid || ![...contexts].some(c => c.isBridgeChild(id)));
      for (const id of archived) {
        for (const c of contexts) c.forgetArchived(id);
      }
      pendingArchive.delete(msg.id);
      toTui({ id: msg.id, result: attempt.result ?? {} });
      for (const id of archived) notify("thread/archived", { threadId: id });
    } catch (e) {
      pendingArchive.delete(msg.id);
      toTui({ id: msg.id, error: { code: Number.isInteger((e as BridgeError).code) ? (e as BridgeError).code : -32603, message: (e as BridgeError).message ?? String(e) } });
    } finally {
      for (const id of ids) archivingThreads.delete(id);
      for (const id of ids) for (const c of contexts) c.resumeQueue(id);
    }
  }
  async function deleteThread(msg: ThreadRequest) {
    const tid = msg.params.threadId;
    const ids = new Set([tid]);
    const acquired = new Set([tid]);
    deletingThreads.add(tid);
    try {
      let store;
      // Provider children are not all represented in the native spawn tree.
      const stopped = new Set();
      while (true) {
        await storeChain();
        store = await loadStore();
        let changed;
        do {
          changed = false;
          for (const [id, saved] of Object.entries(store)) {
            const parent = store._delegations?.[id]?.parentThreadId ?? (saved as SavedSession)?.parentThreadId ?? (saved as SavedSession)?.rootThreadId;
            if (!id.startsWith("_") && ids.has(parent as string) && !ids.has(id)) { ids.add(id); changed = true; }
          }
          for (const [id, helper] of Object.entries(store._delegations ?? {})) {
            if (ids.has(helper.parentThreadId) && !ids.has(id)) { ids.add(id); changed = true; }
          }
          for (const c of contexts) for (const id of c.childrenOf(ids)) {
            if (!ids.has(id)) { ids.add(id); changed = true; }
          }
        } while (changed);
        for (const id of ids) if (!acquired.has(id)) {
          if (deletingThreads.has(id)) throw new Error("A child chat is already being deleted. Retry after it finishes.");
          deletingThreads.add(id); acquired.add(id);
        }
        if ([...pendingHelpers].some(helper => ids.has(helper.parentThreadId))) throw new Error("A helper is still starting. Retry deletion once it has started.");
      // Native rollouts can still reference a parent even after provider turns were copied.
      if (Object.entries(store).some(([id, saved]) => !ids.has(id) && ids.has((saved as SavedSession)?.forkOf?.threadId as string))) throw new Error(`cannot delete thread ${tid}: forked history still references it`);
        const next = [...ids].filter(id => !stopped.has(id));
        if (!next.length) break;
        await Promise.all([...contexts].flatMap(c => next.map(id => c.stopProvider(id))));
        next.forEach(id => stopped.add(id));
        // Cancellation can finish and persist a child that did not exist in the first snapshot.
      }
      // Validate/delete the root first so a native fork conflict cannot erase its helpers.
      let nativeSubtreeDeleted = false;
      for (const id of ids) {
        const bridgeOnly = id !== tid && [...contexts].some(c => c.isBridgeChild(id));
        let nativeDeleted = nativeSubtreeDeleted && id !== tid && !bridgeOnly;
        // A thread may still have a writer in another terminal's engine. Each app-server
        // must prepare its own loaded subtree before the shared store can delete it.
        if (!nativeDeleted && !nativeSubtreeDeleted) {
          const attempt = await nativeThreadLifecycle("thread/delete", id);
          nativeDeleted = attempt.found;
          if (!nativeDeleted && id === tid && !store[id] && !store._delegations?.[id] && !deletedThreads.has(id)) {
            throw attempt.error ?? new Error(`could not delete thread ${id}`);
          }
        }
        if (id === tid && nativeDeleted) nativeSubtreeDeleted = true;
        deletedThreads.add(id);
        for (const c of contexts) c.forgetThread(id);
        providerOwners.delete(id); chatAccess.delete(id); helperScope.delete(id); helperThreads.delete(id);
        notify("thread/deleted", { threadId: id });
        for (const watched of subscriptions.values()) watched.delete(id);
      }
      if (!await updateStore(() => {})) throw new Error("The native chat was deleted, but bridge history could not be removed. Retry deletion.");
      toTui({ id: msg.id, result: {} });
    } catch (e) {
      // Persist cleanup even if native deletion stopped partway through a subtree.
      if ([...ids].some(id => deletedThreads.has(id))) await updateStore(() => {});
      toTui({ id: msg.id, error: Number.isInteger((e as BridgeError).code) ? e : { code: -32603, message: (e as BridgeError).message ?? String(e) } });
    } finally {
      for (const id of acquired) deletingThreads.delete(id);
      for (const id of acquired) for (const c of contexts) c.resumeQueue(id);
    }
  }
  return { stopProvider, archiveProvider, deleteThread };
}
