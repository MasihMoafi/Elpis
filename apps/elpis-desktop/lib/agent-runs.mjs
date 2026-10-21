/** Use the engine's recorded source; a user's own chat may also be titled "Worker".
 * @param {{source?: unknown}} thread */
export function isAgentRun(thread) {
  return thread.source === 'exec' || (typeof thread.source === 'object' && thread.source !== null && 'subAgent' in thread.source);
}
/** A listed helper can carry its lineage only in the recorded spawn source.
 * @param {{parentThreadId?: string | null, source?: unknown}} thread */
export function agentParentId(thread) {
  if (thread.parentThreadId) return thread.parentThreadId;
  const source = thread.source;
  if (!source || typeof source !== 'object' || !('subAgent' in source)) return null;
  const sub = source.subAgent;
  if (!sub || typeof sub !== 'object') return null;
  const spawn = 'thread_spawn' in sub ? sub.thread_spawn : 'threadSpawn' in sub ? sub.threadSpawn : null;
  if (!spawn || typeof spawn !== 'object') return null;
  const parent = 'parent_thread_id' in spawn ? spawn.parent_thread_id : 'parentThreadId' in spawn ? spawn.parentThreadId : null;
  return typeof parent === 'string' && parent ? parent : null;
}
export const AGENT_RUN_NOTICE = 'Run by an agent in the background; open its parent to talk to it';
