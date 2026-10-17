import type { Approval, Thread } from './api';

/** What each state is called wherever a chat's state is shown. */
export const stateLabels = { working: 'Working', idle: 'Idle', error: 'Error', waiting: 'Needs input', unread: 'Unread response', unknown: 'Status unavailable' } as const;

/** `unread`: chats with a reply nobody has opened yet (lib/attention.ts); it shows only when nothing more urgent does, as in Claude. */
export function agentState(thread: Thread, pending: ReadonlySet<string> = new Set(), unread: ReadonlySet<string> = new Set()): 'working' | 'waiting' | 'idle' | 'error' | 'unread' | 'unknown' {
  if (pending.has(thread.id) || thread.status?.activeFlags?.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) return 'waiting';
  if (thread.status?.type === 'active') return 'working';
  if (thread.status?.type === 'systemError') return 'error';
  if (unread.has(thread.id)) return 'unread';
  if (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded') return 'idle';
  return 'unknown';
}

/** The line under a chat's name in the sidebar when it waits for you, in the words of Claude's sidebar: what it needs
 * approved (a command cut to 60 characters), a question, or a plan to review. */
export function attentionLine(approval: Approval | undefined, planReady: boolean): string | null {
  if (!approval) return planReady ? 'Plan ready for review' : null;
  const params = approval.params, cut = (text: string) => { const chars = Array.from(text.replace(/\s+/g, ' ').trim()); return chars.length > 60 ? `${chars.slice(0, 59).join('').trimEnd()}…` : chars.join(''); };
  const tool = typeof params._meta?.tool_title === 'string' ? params._meta.tool_title : typeof params._meta?.tool_name === 'string' ? params._meta.tool_name : '';
  const asks = approval.method === 'item/tool/requestUserInput' || (approval.method === 'mcpServer/elicitation/request' && !!params.requestedSchema && Object.keys(params.requestedSchema.properties).length > 0);
  if (asks) return 'Waiting for your answer';
  const what = approval.method === 'item/commandExecution/requestApproval' ? params.command ?? ''
    : approval.method === 'item/fileChange/requestApproval' ? 'Edit'
    : approval.method === 'mcpServer/elicitation/request' && tool ? params.serverName ? `${params.serverName}: ${tool}` : tool : '';
  return what.trim() ? `Needs your approval · ${cut(what)}` : 'Awaiting input';
}

/** A refreshed head page does not invalidate previously loaded pages or resurrect removed chats. */
export function mergeListedThreads(current: Thread[], incoming: Thread[], hidden: ReadonlySet<string> = new Set(), prepend = false): Thread[] {
  const updates = new Map(incoming.map(thread => [thread.id, thread]));
  const order = [...new Set((prepend ? [...incoming, ...current] : [...current, ...incoming]).map(thread => thread.id))];
  const known = new Map(current.map(thread => [thread.id, thread]));
  return order.filter(id => !hidden.has(id)).map(id => ({ ...known.get(id), ...updates.get(id), id }));
}
