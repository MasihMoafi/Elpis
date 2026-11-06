'use strict';
const { PREFERENCES_KEY }: typeof import('./preferences.cts') = require('./preferences.cts');
type ThreadPage = { data: { id: string; status?: { type?: string } }[]; nextCursor?: string | null };
type Event = { type: string; data: { connected?: boolean; method?: string; params?: { threadId?: string; thread?: { id?: string }; status?: { type?: string } } } };
type Client = { listThreads: (input: { limit: number; includeAgentRuns: boolean; cursor?: string }) => Promise<ThreadPage>; on: (name: string, listener: (event: Event) => void) => unknown; off: (name: string, listener: (event: Event) => void) => unknown };
type Store = { read: () => Record<string, string | undefined>; subscribe: (listener: (change: { key: string }) => void) => () => void };

/** One blocker for all running chats, including agent and side-chat turns. No idle timer. */
function createSleepBlockerImpl({ powerSaveBlocker, client, store, onError = console.warn }: { powerSaveBlocker: { start: (type: 'prevent-app-suspension') => number; stop: (id: number) => unknown }; client: Client; store: Store; onError?: (message: string) => void }) {
  const active = new Set<string>();
  const revisions = new Map<string, number>();
  let blocker: number | undefined, disposed = false, connection = 0, request = 0;
  const enabled = () => {
    try { return JSON.parse(store.read()[PREFERENCES_KEY] || '{}').preventSleep === true; } catch { return false; }
  };
  let preference = enabled();
  function sync() {
    const wanted = !disposed && enabled() && active.size > 0;
    try {
      if (wanted && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
      else if (!wanted && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
    } catch (error) { onError(`Could not change sleep prevention: ${(error as Error).message}`); }
  }
  async function refresh() {
    const at = new Map(revisions), epoch = connection, id = ++request;
    try {
      const running = new Set<string>(); let cursor: string | null | undefined;
      const seen = new Set<string | null | undefined>();
      do {
        const page = await client.listThreads({ limit: 100, includeAgentRuns: true, ...(cursor ? { cursor } : {}) });
        for (const thread of page.data) if (thread.status?.type === 'active') running.add(thread.id);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw Error('Repeated chat cursor');
        seen.add(cursor);
      } while (cursor);
      if (!disposed && epoch === connection && id === request) {
        for (const thread of new Set([...active, ...running])) {
          if (at.get(thread) !== revisions.get(thread)) continue;
          if (running.has(thread)) active.add(thread); else active.delete(thread);
        }
        sync();
      }
    } catch (error) { if (!disposed) onError(`Could not read working chats for sleep prevention: ${(error as Error).message}`); }
  }
  function observe(event: Event) {
    if (event.type === 'connection') {
      connection++;
      if (!event.data.connected) { active.clear(); sync(); } else void refresh();
      return;
    }
    if (!['message', 'sideChat'].includes(event.type)) return;
    const { method, params = {} } = event.data;
    const id = params.threadId ?? params.thread?.id;
    if (!id) return;
    if (method === 'turn/started' || (method === 'thread/status/changed' && params.status?.type === 'active')) active.add(id);
    else if (['turn/completed', 'thread/closed', 'thread/deleted', 'thread/archived'].includes(method as string) || (method === 'thread/status/changed' && params.status?.type !== 'active')) active.delete(id);
    else return;
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
    sync();
  }
  client.on('event', observe);
  const off = store.subscribe(change => {
    if (change.key !== PREFERENCES_KEY) return;
    const next = enabled();
    if (next === preference) return;
    preference = next; sync(); if (next) void refresh();
  });
  void refresh();
  return { dispose() { disposed = true; client.off('event', observe); off(); active.clear(); sync(); } };
}
export declare const createSleepBlocker: typeof createSleepBlockerImpl;
module.exports = { createSleepBlocker: createSleepBlockerImpl };
