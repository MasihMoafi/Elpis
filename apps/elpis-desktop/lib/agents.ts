import type { Thread } from './api';

/** What each state is called wherever a chat's state is shown. */
export const stateLabels = { working: 'Working', idle: 'Idle', error: 'Error', waiting: 'Needs input', unknown: 'Status unavailable' } as const;

export function agentState(thread: Thread, pending: ReadonlySet<string> = new Set()): 'working' | 'waiting' | 'idle' | 'error' | 'unknown' {
  if (pending.has(thread.id) || thread.status?.activeFlags?.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) return 'waiting';
  if (thread.status?.type === 'active') return 'working';
  if (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded') return 'idle';
  return thread.status?.type === 'systemError' ? 'error' : 'unknown';
}

/** A refreshed head page does not invalidate previously loaded pages or resurrect removed chats. */
export function mergeListedThreads(current: Thread[], incoming: Thread[], hidden: ReadonlySet<string> = new Set(), prepend = false): Thread[] {
  const updates = new Map(incoming.map(thread => [thread.id, thread]));
  const order = [...new Set((prepend ? [...incoming, ...current] : [...current, ...incoming]).map(thread => thread.id))];
  const known = new Map(current.map(thread => [thread.id, thread]));
  return order.filter(id => !hidden.has(id)).map(id => ({ ...known.get(id), ...updates.get(id), id }));
}
