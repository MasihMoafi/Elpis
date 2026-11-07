import { createProviderQueue } from "./bridge-queue.mts";
import { toAcpPrompt,inputSummary } from "./bridge-transcript.mts";
import { Acp } from "./bridge-acp.mts";
import type { BridgeError,BridgeMessage,NoticeParams,ContextChars,Steer,ThreadRequest,ProviderTurn } from "./bridge-types.mts";
import { randomUUID } from "node:crypto";
import type { BridgeEnvironment } from "./bridge-server.mts";

type Dependencies = Pick<BridgeEnvironment, "deletedThreads" | "deletingThreads" | "archivingThreads" | "updateStore" | "log" | "now"> & {
  activeTurns: Map<string, ProviderTurn>;
  pendingSteers: Map<string, Map<string, Steer>>;
  queueOf: ReturnType<typeof createProviderQueue>["queueOf"];
  runNext: ReturnType<typeof createProviderQueue>["runNext"];
  queues: ReturnType<typeof createProviderQueue>["queues"];
  notify: (method: string, params: NoticeParams) => void;
  toTui: (message: BridgeMessage) => void;
  addChars: (threadId: string, part: keyof ContextChars, amount: number) => void;
};

/** Deliver, queue and cancel messages sent during a provider turn. */
export function createProviderSteering({ activeTurns, pendingSteers, deletedThreads, deletingThreads, archivingThreads, queueOf, runNext, queues, notify, toTui, now, updateStore, addChars, log }: Dependencies) {
  // A message sent while Claude works joins that reply instead of stopping it. With no
  // running Claude turn, the TUI's "no active turn to steer" fallback starts a new turn.
  async function steerClaude(msg: ThreadRequest) {
    const { threadId, input = [], clientUserMessageId = null } = msg.params;
    const refuse = () => toTui({ id: msg.id, error: { code: -32600, message: "no active turn to steer" } });
    const turn = activeTurns.get(threadId);
    if (!turn || turn.cancelled) return refuse();
    let waiting = pendingSteers.get(threadId);
    if (!waiting) pendingSteers.set(threadId, waiting = new Map());
    const prior = clientUserMessageId && waiting.get(clientUserMessageId);
    if (prior) { toTui({ id: msg.id, result: { turnId: prior.turnId } }); return; }
    const steer: Steer = { cancelled: false, phase: "waiting", turnId: turn.turnId };
    if (clientUserMessageId) waiting.set(clientUserMessageId, steer);
    // Acceptance leaves the message editable until actual ACP dispatch. Waiting for
    // tool completion before replying would block the TUI's cancellation request.
    toTui({ id: msg.id, result: { turnId: turn.turnId } });
    const queueForNextTurn = () => {
      if (turn.cancelled || steer.cancelled || deletedThreads.has(threadId) || deletingThreads.has(threadId) || archivingThreads.has(threadId)) return;
      steer.phase = "queued";
      queueOf(threadId).push({ id: randomUUID(), input, clientUserMessageId, steer });
      notify("thread/queue/changed", { threadId });
      runNext(threadId);
    };
    const deliver = async () => {
      const sessionId = await turn.ready;
      if (steer.cancelled) return;
      if (!sessionId || activeTurns.get(threadId) !== turn || turn.cancelled || turn.promptEnded) {
        queueForNextTurn();
        return;
      }
      try {
        const prompt = await toAcpPrompt(input);
        // An idle notification is only a wake-up: another tool can start in the
        // same transport read, or while attachments are prepared. Check again at
        // dispatch, with no asynchronous work between the check and the ACP call.
        while (!turn.promptEnded && !turn.cancelled && !steer.cancelled && turn.toolsBusy()) await turn.whenToolsIdle();
        if (steer.cancelled) return;
        if (activeTurns.get(threadId) !== turn || turn.cancelled || turn.promptEnded) { queueForNextTurn(); return; }
        steer.phase = "dispatching";
        turn.bufferedUpdates = [];
        const text = prompt.filter(block => block.type === "text").map(block => block.text).join("\n");
        turn.inputs?.push(text);
        const r = await (turn.acp as Acp).call("_session/steering", { sessionId, prompt, _meta: { steering: { idleBehavior: "promptRequired" } } });
        if (r?.outcome === "promptRequired") { turn.inputs?.pop(); queueForNextTurn(); return; }
        waiting.delete(clientUserMessageId as string);
        if (r?._meta?.delivery === "nextTurn") {
          notify("warning", { threadId, message: "Gemini will read this message after its current reply finishes." });
        }
        turn.closeMessage();
        const item = { type: "userMessage", id: randomUUID(), clientId: clientUserMessageId, content: input };
        notify("item/started", { item, threadId, turnId: turn.turnId, startedAtMs: now() });
        notify("item/completed", { item, threadId, turnId: turn.turnId, completedAtMs: now() });
        turn.items.push(item);
        await updateStore(st => { if (st[threadId]?.active?.turnId === turn.turnId) { st[threadId].active.userItems.push(item); st[threadId].active.inputs = turn.inputs; } });
        addChars(threadId, "user", inputSummary(input).length);
        log(`steered Claude turn ${turn.turnId} (${r?.outcome ?? "ok"})`);
      } catch (e) {
        if (steer.phase === "dispatching") {
          steer.phase = "unconfirmed";
          notify("warning", { threadId, message: `Waiting message delivery is unconfirmed: ${(e as BridgeError)?.message ?? JSON.stringify(e)}. Reconnect before retrying it.` });
        } else {
          notify("warning", { threadId, message: `Could not prepare the waiting message: ${(e as BridgeError)?.message ?? JSON.stringify(e)}. Press Up to revise it.` });
        }
      } finally { turn.flushUpdates?.(); }
    };
    turn.steers = turn.steers.then(deliver);
    await turn.steers;
  }

  function cancelClaudeSteers(msg: ThreadRequest) {
    const { threadId, clientUserMessageIds = [] } = msg.params || {};
    if (!Array.isArray(clientUserMessageIds) || clientUserMessageIds.length > 100
      || clientUserMessageIds.some(id => typeof id !== "string" || id.length > 256)) {
      toTui({ id: msg.id, error: { code: -32600, message: "invalid clientUserMessageIds" } });
      return;
    }
    const cancelledClientUserMessageIds = cancelWaitingClaudeSteers(threadId, clientUserMessageIds);
    toTui({ id: msg.id, result: { cancelledClientUserMessageIds } });
  }

  function cancelWaitingClaudeSteers(threadId: string, clientUserMessageIds: string[]) {
    const cancelledClientUserMessageIds = [];
    const waiting = pendingSteers.get(threadId);
    for (const id of new Set(clientUserMessageIds)) {
      const steer = waiting?.get(id);
      if (!steer || !["waiting", "queued"].includes(steer.phase)) continue;
      steer.cancelled = true;
      (waiting as Map<string, Steer>).delete(id);
      cancelledClientUserMessageIds.push(id);
    }
    const queue = queues.get(threadId);
    if (queue?.some(entry => entry.steer?.cancelled)) {
      queues.set(threadId, queue.filter(entry => !entry.steer?.cancelled));
      notify("thread/queue/changed", { threadId });
    }
    return cancelledClientUserMessageIds;
  }

  return { steerClaude, cancelClaudeSteers, cancelWaitingClaudeSteers };
}
