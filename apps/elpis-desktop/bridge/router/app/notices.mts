// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/notices.ts.
/** Formats background notices and steering relays delivered to the main Session via the effect queue. */
import { randomUUID } from "node:crypto";
import { followupOwners, key, liveTicket, type DomainEvent, type Ticket, type WorkerReport } from "../core/index.mts";
import { triggerMessage } from "../executor/messages.mts";
import type { SourceRegistry } from "../sources/registry.mts";
import { repliedTo } from "./links.mts";
import type { Store } from "./store.mts";
import { ticketCard } from "./cards.mts";

/**
 * A background notice tuple for the main Session: `[name, value, summary]`, where `name` is the coalescing key in
 * `Effects` (a newer notice with the same `name` overwrites an unsent waiting one, rather than permanently deduplicating future notices).
 */
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string];
/** Builds a notice for a saved prompt configuration revision, coalescing under `'prompts'`. */
export const promptsNotice = (revision: number): Notice => [
  "prompts",
  { prompt_config_saved: revision, effect: "next-request", read: `prompts/${revision}` },
  `Prompt configuration saved (revision ${revision})`,
];
/**
 * Builds a notice for a saved settings block with the changed dot-separated paths (coalescing per block under
 * `settings:<block>`), or for the whole settings on legacy saves that recorded no block.
 */
export const settingsNotice = (block?: string, changed: string[] = []): Notice =>
  block
    ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `Settings saved: ${block}`]
    : ["settings", { settings_saved: true, read: "settings" }, "Settings saved"];
/** Returns up to 20 dot-separated paths where two values differ (e.g. `eval.mode` or `policy.rules.1.enabled`). */
export function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [path];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name];
  return keys
    .flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name))
    .slice(0, 20);
}
/** Strips the latest report preview from a ticket card when the relay already carries or does not need the summary. */
function brief(ticket: Ticket) {
  const { preview: _preview, ...card } = ticketCard(ticket);
  return card;
}
/** Creates a one-off receipt notice with a unique `name` key so repeated occurrences of the same event are each delivered instead of coalescing. */
export const receiptNotice = (value: Record<string, unknown>, summary: string): Notice => [
  key("receipt", randomUUID()),
  value,
  summary,
];
/** Builds a notice that a person removed a thread's subscriptions at `at`; a later removal of the same thread replaces an unsent waiting notice. */
export const subscriptionNotice = (thread: string, at?: string): Notice => [
  `subscription:${thread}`,
  { subscription_changes: [{ thread, removed: true }], ...(at ? { at } : {}) },
  `Removed the subscriptions on thread ${thread}`,
];

/**
 * Converts an unsolicited domain event into a main-Session notice (`ticket.ended`, `trigger.requeued`, or
 * `thread.unsubscribed` by a person or executor); returns `undefined` for events that require no notice.
 */
export function eventNotice(
  event: DomainEvent,
  ticket: (id: string) => Ticket | undefined = () => undefined,
): Notice | undefined {
  const { at } = event;
  if (event.type === "ticket.ended") {
    const { ticketId, by, outcome, reason = outcome } = event.data;
    const ended = ticket(ticketId);
    return receiptNotice(
      ended ? { ticket_ended: brief(ended) } : { ticket_ended: ticketId, by, outcome, reason, at },
      `Ticket ${ticketId} ended (${reason})`,
    );
  }
  if (event.type === "trigger.requeued") {
    const id = event.data.triggerId;
    return receiptNotice(
      { trigger_requeued: id, read: `trigger/${id}`, at },
      `Trigger ${id} queued for a fresh assessment`,
    );
  }
  if (event.type === "thread.unsubscribed" && event.data.by === "person")
    return subscriptionNotice(event.data.threadKey, at);
  if (event.type === "thread.unsubscribed") {
    const { ticketId, threadKey: thread, reason } = event.data;
    const note =
      "Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they " +
      "point at it explicitly.";
    return receiptNotice(
      { thread_unrelated: { ticket_id: ticketId, thread, reason }, at, note },
      `Ticket ${ticketId} no longer follows thread ${thread}: ${reason}`,
    );
  }
  return undefined;
}

/** Builds a background notice when a ticket's worker subscribes to a related thread for context only. */
export const threadFollowedNotice = (ticketId: string, thread: string, reason: string): Notice =>
  receiptNotice(
    {
      thread_followed: { ticket_id: ticketId, thread, reason },
      note: "For context only: its messages reach this ticket and grant nothing.",
    },
    `Ticket ${ticketId} follows thread ${thread} for context: ${reason}`,
  );

/** Steering relay payload for the main Session: `id` is the request ID that makes delivery idempotent, and `text` is the message body. */
export interface Relay {
  id: string;
  text: string;
}
/** What a follow-up asks of the main Session: nothing but a stop the person asks for, since its ticket's worker decides it. */
const FOLLOWUP_NOTE =
  "Its ticket's worker has it and decides; act only if the person asks to stop the work " +
  "(orchestrator_route kind stop with this trigger_id).";
/**
 * Builds a steering relay for a human follow-up trigger that reached at least one live ticket (including an ended ticket
 * that resumed on the follow-up), with the trigger rendered as workers read it, the replied-to message, and the open
 * tickets it reached; returns `undefined` while no ticket's worker decides it (see `followupOwners`) or it reached no live ticket.
 */
export function followupNotice(store: Store, sources: SourceRegistry, triggerId: string): Relay | undefined {
  const trigger = store.triggers.get(triggerId);
  const disposition = store.triggers.disposition(triggerId);
  if (!trigger || !followupOwners(trigger, store).length) return undefined;
  const tickets = disposition!.fanout.flatMap(id => {
    const ticket = store.tickets.get(id);
    const context = disposition!.context?.includes(id) ? { context: true } : {};
    return ticket && liveTicket(ticket)
      ? [{ ticket_id: id, title: ticket.title, state: ticketCard(ticket).state, ...context }]
      : [];
  });
  if (!tickets.length) return undefined;
  return followupRelay(triggerMessage(trigger, {}, undefined, repliedTo({ store, sources }, trigger)), tickets);
}
/**
 * A person's message that reached tickets, as the main Session hears of it: the message as their workers read it, and the
 * tickets it reached with their state. Their workers decide it; the main Session may only stop the work on it.
 */
export function followupRelay(
  message: { trigger_id: string },
  tickets: readonly { ticket_id: string; title: string; state: string; context?: boolean }[],
): Relay {
  return {
    id: `followup:${message.trigger_id}`,
    text: JSON.stringify({ kind: "follow_up", ...message, delivered_to: tickets, note: FOLLOWUP_NOTE }),
  };
}
/** Formats a worker report relay for the main Session (truncating summaries over 600 characters behind `ticket/<id>/result`); `replyTo` names the human question trigger it answers. */
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string): Relay {
  const id = key("worker-result", ticket.id, ticket.updatedAt, text);
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text };
  const report = {
    kind: "worker_report",
    ticket: brief(ticket),
    trigger_id: ticket.origin.triggerId,
    state,
    ...(replyTo ? { answer_to: replyTo } : {}),
    ...summary,
    read: `ticket/${ticket.id}/result`,
  };
  return { id: `report:${id}`, text: JSON.stringify(report) };
}
/**
 * Converts a worker report recorded on `ticket` into a main-Session relay: a question for a person produces a
 * `worker_attention` relay, and a result, blocker, end, or answer to a question produces a `worker_report` relay, while
 * routine `progress` reports without `answers` stay internal.
 * @returns The steering `Relay`, or `undefined` when the report is not relayed to the main Session.
 */
export function reportRelay(
  ticket: Ticket,
  report: Pick<WorkerReport, "state" | "summary" | "question" | "answers">,
): Relay | undefined {
  const asked = report.question ? ticket.attention : undefined;
  if (asked) {
    return {
      id: `attention:${ticket.id}:${asked.id}`,
      text: JSON.stringify({
        kind: "worker_attention",
        ticket: brief(ticket),
        state: report.state,
        read: `ticket/${ticket.id}/result`,
      }),
    };
  }
  if (report.state === "progress" && !report.answers) return undefined;
  return resultRelay(ticket, report.state, report.summary, report.answers);
}
