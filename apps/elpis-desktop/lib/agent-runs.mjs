/** Use the engine's recorded source; a user's own chat may also be titled "Worker".
 * @param {{source?: unknown}} thread */
export function isAgentRun(thread) {
  return thread.source === 'exec' || (typeof thread.source === 'object' && thread.source !== null && 'subAgent' in thread.source);
}
export const AGENT_RUN_NOTICE = 'Run by an agent in the background; open its parent to talk to it';
