import { randomUUID } from "node:crypto";
import type { BridgeMessage,ClaudeTurnRequest,Goal,NoticeParams,ProviderTurn,QueueEntry,Steer,Store,ThreadRequest,TurnOutcome } from "./bridge-types.mts";

type Dependencies = {
  activeTurns: Map<string, ProviderTurn>;
  deletingThreads: Set<string>;
  archivingThreads: Set<string>;
  deletedThreads: Set<string>;
  pendingSteers: Map<string, Map<string, Steer>>;
  claudeTurn: (request: ClaudeTurnRequest) => Promise<TurnOutcome>;
  notify: (method: string, params: NoticeParams) => void;
  toTui: (message: BridgeMessage) => void;
  storeChain: () => Promise<void>;
  loadStore: () => Promise<Store>;
  updateStore: (update: (store: Store) => void) => Promise<boolean>;
  now: () => number;
};

/** Drive queued messages and durable goals after the active provider turn. */
export function createProviderQueue({ activeTurns, deletingThreads, archivingThreads, deletedThreads, pendingSteers, claudeTurn, notify, toTui, storeChain, loadStore, updateStore, now }: Dependencies) {
  // A Claude chat's queued messages (elpis queue, thread/queue/*) and Claude Code's own /goal
  // (thread/goal/*): each runs as the chat's next Claude turn once the running one ends.
  const queues = new Map<string, QueueEntry[]>(); // thread id -> [{ id, input, clientUserMessageId, goal? }]
  const queueOf = (threadId: string) => { let queue = queues.get(threadId); if (!queue) { queue = []; queues.set(threadId, queue); } return queue; };
  const shown = (threadId: string) => queueOf(threadId).filter((q) => !q.goal).map(({ id, input, clientUserMessageId }) => ({ id, input, clientUserMessageId }));
  function runNext(threadId: string) {
    if (activeTurns.has(threadId) || deletingThreads.has(threadId) || archivingThreads.has(threadId) || deletedThreads.has(threadId)) return;
    const next = queueOf(threadId).shift();
    if (!next) return;
    if (!next.goal) notify("thread/queue/changed", { threadId });
    if (next.steer) {
      if (next.steer.cancelled) { runNext(threadId); return; }
      next.steer.phase = "dispatching";
      pendingSteers.get(threadId)?.delete(next.clientUserMessageId as string);
    }
    claudeTurn({ kind: next.goal ? "goal" : "queued", params: { threadId, input: next.input, clientUserMessageId: next.clientUserMessageId } }).then((r) => next.after?.(r));
  }
  function queueRequest(msg: ThreadRequest) {
    const { threadId } = msg.params;
    const q = queueOf(threadId);
    const find = (id: string | undefined) => q.findIndex((e) => e.id === id && !e.goal);
    const changed = () => notify("thread/queue/changed", { threadId });
    switch (msg.method) {
      case "thread/queue/add": {
        const entry = { id: randomUUID(), input: msg.params.input ?? [], clientUserMessageId: msg.params.clientUserMessageId };
        q.push(entry);
        toTui({ id: msg.id, result: { queuedSubmission: { id: entry.id, input: entry.input, clientUserMessageId: entry.clientUserMessageId } } });
        changed(); runNext(threadId); return;
      }
      case "thread/queue/list": toTui({ id: msg.id, result: { data: shown(threadId), nextCursor: null } }); return;
      case "thread/queue/update": {
        const i = find(msg.params.queuedSubmissionId);
        if (i < 0) { toTui({ id: msg.id, error: { code: -32600, message: "no such queued message" } }); return; }
        const entry = q[i] as QueueEntry;
        entry.input = msg.params.input ?? [];
        toTui({ id: msg.id, result: { queuedSubmission: shown(threadId).find((e) => e.id === entry.id) } }); changed(); return;
      }
      case "thread/queue/delete": {
        const i = find(msg.params.queuedSubmissionId);
        if (i >= 0) q.splice(i, 1);
        toTui({ id: msg.id, result: { deleted: i >= 0 } }); if (i >= 0) changed(); return;
      }
      case "thread/queue/reorder": {
        const order = msg.params.queuedSubmissionIds ?? [];
        q.sort((a, b) => (order.indexOf(a.id) >>> 0) - (order.indexOf(b.id) >>> 0));
        toTui({ id: msg.id, result: {} }); changed(); return;
      }
      case "thread/queue/start": {
        if (activeTurns.has(threadId)) { toTui({ id: msg.id, error: { code: -32600, message: "thread already has an active or pending turn" } }); return; }
        const i = msg.params.queuedSubmissionId ? find(msg.params.queuedSubmissionId) : q.findIndex((e) => !e.goal);
        if (i < 0) { toTui({ id: msg.id, error: { code: -32600, message: "no queued message to start" } }); return; }
        const [entry] = q.splice(i, 1) as [QueueEntry];
        changed();
        claudeTurn({ id: msg.id, kind: "queued", params: { threadId, input: entry.input } });
        return;
      }
    }
  }

  // Elpis's goal record for a Claude chat (kept in the store, so it survives a restart).
  const goals = new Map<string, Goal | null>();
  const nowSecs = () => Math.floor(now() / 1000);
  async function goalOf(threadId: string) {
    if (!goals.has(threadId)) { await storeChain(); goals.set(threadId, (await loadStore())[threadId]?.goal ?? null); }
    return goals.get(threadId);
  }
  function saveGoal(threadId: string, goal: Goal | null) {
    goals.set(threadId, goal);
    updateStore((st) => { st[threadId] = { ...st[threadId], goal }; });
  }
  function pursue(threadId: string, text: string, goal: Goal | null) {
    const entry: QueueEntry = { id: randomUUID(), goal: true, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: randomUUID() };
    if (goal) entry.after = (r) => {
      const now_ = goals.get(threadId);
      if (!now_ || now_.objective !== goal.objective || now_.status !== "active") return;
      const status = r.status === "completed" ? "complete" : r.status === "interrupted" ? "paused" : "blocked";
      const next = { ...now_, status, tokensUsed: now_.tokensUsed + r.tokens, timeUsedSeconds: now_.timeUsedSeconds + r.seconds, updatedAt: nowSecs() };
      saveGoal(threadId, next);
      notify("thread/goal/updated", { threadId, turnId: r.turnId, goal: next });
    };
    queueOf(threadId).push(entry);
    runNext(threadId);
  }
  async function goalRequest(msg: ThreadRequest) {
    const { threadId } = msg.params;
    const prev = await goalOf(threadId);
    if (msg.method === "thread/goal/get") { toTui({ id: msg.id, result: { goal: prev } }); return; }
    if (msg.method === "thread/goal/clear") {
      saveGoal(threadId, null);
      toTui({ id: msg.id, result: { cleared: !!prev } });
      if (prev) { notify("thread/goal/cleared", { threadId }); if (prev.status === "active") pursue(threadId, "/goal clear", null); }
      return;
    }
    const { objective, status = "active", tokenBudget } = msg.params;
    const text = objective?.trim() || prev?.objective;
    if (!text) { toTui({ id: msg.id, error: { code: -32600, message: "This chat has no goal to update." } }); return; }
    const fresh = !prev || text !== prev.objective;
    const goal = { threadId, objective: text, status, tokenBudget: tokenBudget === undefined ? prev?.tokenBudget ?? null : tokenBudget, tokensUsed: fresh ? 0 : prev.tokensUsed, timeUsedSeconds: fresh ? 0 : prev.timeUsedSeconds, createdAt: fresh ? nowSecs() : prev.createdAt, updatedAt: nowSecs() };
    saveGoal(threadId, goal);
    toTui({ id: msg.id, result: { goal } });
    notify("thread/goal/updated", { threadId, turnId: null, goal });
    if (status === "active") pursue(threadId, `/goal ${text}`, goal);
    else if (prev?.status === "active") pursue(threadId, "/goal clear", null);
  }

  return { queues, goals, queueOf, runNext, queueRequest, goalRequest };
}
