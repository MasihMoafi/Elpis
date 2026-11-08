// Ported from dsh-superagent (MIT), src/sources/poll.ts
/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
import { liveTicket, type Thread } from "../core/index.mts";
import type { SourceContext } from "./host.mts";

/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000;
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id));
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true;
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? "")]
    .map(Date.parse)
    .filter(Number.isFinite);
  return now - Math.max(...times) < POLL_HORIZON_MS;
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString();
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
export async function pollThreads(
  ctx: SourceContext,
  source: string,
  stopped: () => boolean,
  poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false,
): Promise<void> {
  for (const thread of ctx.threads.subscribed(source)) {
    if (stopped()) return;
    if (skip(thread) || !polled(ctx, thread)) continue;
    try {
      await poll(thread);
      ctx.threads.patch(thread.key, { pollError: undefined });
    } catch (error) {
      if (stopped()) return;
      ctx.threads.patch(thread.key, { pollError: String(error) });
    }
  }
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
