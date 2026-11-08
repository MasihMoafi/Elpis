import { currentDrain } from "./handover.mts";
import { wireId,wireObject } from "./bridge-wire.mts";
import type { BridgeClient,RequestId } from "./bridge-types.mts";
import type { BridgeEnvironment } from "./bridge-server.mts";

type Dependencies = Pick<BridgeEnvironment, "deletedThreads" | "providerOwners" | "forwarded" | "subscriptions" | "sendClient" | "viewers" | "flushApprovals" | "decorateThread"> & { ws: BridgeClient; openingReplies: Set<RequestId> };
const wireThread = (value: unknown): value is Record<string, unknown> & { id: string } => wireObject(value) && typeof value.id === "string";

/** Route decorated engine output to the subscribed clients. */
export function installClientWire({ ws, openingReplies, deletedThreads, providerOwners, forwarded, subscriptions, sendClient, viewers, flushApprovals, decorateThread }: Dependencies) {
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
    if (wireThread(resultThread)) decorateThread(resultThread);
    if (wireThread(params?.thread)) decorateThread(params.thread);
    if (Array.isArray(result?.data)) for (const t of result.data) if (wireThread(t)) decorateThread(t);
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
}
