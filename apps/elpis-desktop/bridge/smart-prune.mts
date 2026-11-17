import { BridgeError, text } from "./validate.mts";
import { internal_rpc } from "./client-rpc.mts";
import type { ClientState } from "./client-state.mts";
import type { DesktopClient } from "./client.mts";

/** Both desktop views read the native projection used by the TUI. */
export function impl_smartPruneLog(this: DesktopClient, state: ClientState, cursor?: string) {
  if (cursor !== undefined) text(cursor, "Smart Prune cursor", 4096);
  return internal_rpc(this, state, "smartPrune/log/list", { limit: 50, ...(cursor ? { cursor } : {}) });
}

export async function impl_smartPruneRecord(this: DesktopClient, state: ClientState, threadId: unknown, attemptId: unknown) {
  // Legacy records can carry an older session identity; the engine scopes and validates it.
  text(threadId, "Smart Prune chat", 160);
  text(attemptId, "Smart Prune attempt", 160);
  const result = await internal_rpc(this, state, "smartPrune/log/read", { threadId, attemptId });
  if (result.record.threadId !== threadId || result.record.attemptId !== attemptId)
    throw new BridgeError("Elpis returned another Smart Prune record", 502);
  return result;
}

export async function smartPruneDetail(
  client: Pick<DesktopClient, "smartPruneRecord">,
  threadId: string | undefined,
  attemptId: string | undefined,
  callId: string | undefined,
) {
  text(callId, "Smart Prune tool output", 1000);
  const { record } = await client.smartPruneRecord(threadId, attemptId);
  const item = record.items.find(item => item.callId === callId);
  if (!item) throw new BridgeError("Smart Prune tool output not found", 404);
  if (record.estimatedSavedTokens === null)
    throw new BridgeError("Committed Smart Prune evidence is unavailable", 404);
  return { original: item.original, compact: item.compact };
}
