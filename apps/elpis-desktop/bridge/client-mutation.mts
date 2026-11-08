import { BridgeError, threadId } from "./validate.mts";
import type { ClientState } from "./client-state.mts";

export async function internal_mutate<T>(
  clientState: ClientState,
  id: unknown,
  run: () => T | Promise<T>,
  wait = false,
): Promise<Awaited<T>> {
  threadId(id);
  if (clientState.mutating.has(id)) {
    if (!wait) throw new BridgeError("Another operation on this conversation is pending", 409);
    await new Promise<void>(resolve => {
      const waiting = clientState.mutationWaiters.get(id) ?? [];
      waiting.push(resolve);
      clientState.mutationWaiters.set(id, waiting);
    });
  } else clientState.mutating.add(id);
  try {
    return await run();
  } finally {
    const waiting = clientState.mutationWaiters.get(id),
      next = waiting?.shift();
    if (!waiting?.length) clientState.mutationWaiters.delete(id);
    if (next) next();
    else clientState.mutating.delete(id);
  }
}
