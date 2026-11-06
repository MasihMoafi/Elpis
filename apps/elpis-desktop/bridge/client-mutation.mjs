import { BridgeError, threadId } from './validate.mjs';

/**
 * @template T
 * @param {import('./client-state.mjs').ClientState} clientState
 * @param {unknown} id
 * @param {() => T | Promise<T>} run
 * @param {boolean} [wait]
 * @returns {Promise<Awaited<T>>}
 */
export async function internal_mutate(clientState, id, run, wait = false) {
    threadId(id);
    if (clientState.mutating.has(id)) {
      if (!wait) throw new BridgeError('Another operation on this conversation is pending', 409);
      await new Promise(resolve => {
        const waiting = clientState.mutationWaiters.get(id) ?? [];
        waiting.push(resolve); clientState.mutationWaiters.set(id, waiting);
      });
    } else clientState.mutating.add(id);
    try { return await run(); } finally {
      const waiting = clientState.mutationWaiters.get(id), next = waiting?.shift();
      if (!waiting?.length) clientState.mutationWaiters.delete(id);
      if (next) next(); else clientState.mutating.delete(id);
    }
  }
