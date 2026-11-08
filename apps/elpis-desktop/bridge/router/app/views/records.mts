// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/views/records.ts.
/** Shared view projections for triggers, tickets, threads, decisions, and channel links. */
import { z } from "zod";
import {
  canRetry,
  followupOwners,
  latestReport,
  liveTicket,
  settled,
  threadKey,
  ticketStage,
  type ActorRef,
  type ChannelRef,
  type Decision,
  type DecisionKind,
  type Thread,
  type ThreadFacts,
  type Ticket,
  type TicketStage,
  type Trigger,
} from "../../core/index.mts";
import { allowedSender, listedBot } from "../../policy.mts";
import type { ChannelLink, Localized } from "../../sources/kind.mts";
import type { SourceRegistry } from "../../sources/registry.mts";
import { workerSessionId } from "../../executor/dsh.mts";
import type { Store } from "../store.mts";
import { attribute, markdown, plain, preview, readable } from "./text.mts";

export type LinkTarget = (channel: ChannelRef) => ChannelLink;
export interface ViewHost {
  store: Store;
  sources: SourceRegistry;
  links: LinkTarget;
}
export const page = <T,>(items: T[], offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit),
  total: items.length,
  next_offset: offset + limit < items.length ? offset + limit : null,
});
const DAY = 86_400_000;
export const dayAgo = () => new Date(Date.now() - DAY).toISOString();
export const newestFirst = (a: Ticket, b: Ticket) => b.updatedAt.localeCompare(a.updatedAt);

/** Sender projection for the UI; automated notices have an empty `id` and no `name`. */
export interface ActorView {
  source: string;
  id: string;
  name?: Localized;
}
/** The tickets whose worker decides a person's follow-up (see `followupOwners`). */
export type Owners = (trigger: Trigger) => string[];
/**
 * The owners of follow-ups as one request reads them: the rows of a page share their tickets and Threads, so each is read
 * once however many rows it decides.
 */
export function ownersOf(store: Pick<Store, "tickets" | "threads" | "triggers">): Owners {
  const once = <T,>(read: (id: string) => T) => {
    const seen = new Map<string, T>();
    return (id: string) => {
      if (!seen.has(id)) seen.set(id, read(id));
      return seen.get(id) as T;
    };
  };
  const records = {
    tickets: { get: once(id => store.tickets.get(id)) },
    threads: { get: once(key => store.threads.get(key)) },
    triggers: store.triggers,
  };
  return trigger => followupOwners(trigger, records);
}
/** One request's reads, each read once: the Threads each Ticket subscribes to, the rules by id, and the senders' names. */
export interface Snapshot extends ViewHost {
  threadsOf(ticketId: string): Thread[];
  /** Current rule name, falling back to `id` once a rule has been removed. */
  rule(id: string): { id: string; name: string };
  /** Resolves sender display name from policy allowlists/bot lists, falling back to the Source kind's unnamed label or raw id. */
  actor(actor: ActorRef, human?: boolean): ActorView;
  /** The owners of follow-ups (see `ownersOf`). */
  owners: Owners;
}
export function snapshot(host: ViewHost): Snapshot {
  const { store, sources } = host;
  let subscribed: Map<string, Thread[]> | undefined;
  const threadsOf = (ticketId: string) => {
    if (!subscribed) {
      subscribed = new Map();
      for (const thread of store.read.subscribedThreads())
        for (const id of thread.subscriptions) subscribed.set(id, [...(subscribed.get(id) ?? []), thread]);
    }
    return subscribed.get(ticketId) ?? [];
  };
  const settings = store.settings();
  const rules = new Map(settings.policy.rules.map(rule => [rule.id, rule.name]));
  const named = (name: string) => ({ zh: name, en: name });
  const actor = ({ source, id }: ActorRef, human?: boolean): ActorView => {
    if (!id) return { source, id };
    const entry = allowedSender(settings, { source, id }) ?? listedBot(settings, { source, id });
    if (entry) return { source, id, name: named(entry.name || entry.id) };
    const unnamed = sources.kind(source)?.policy?.unnamed;
    return { source, id, name: unnamed ? (human === false ? unnamed.bot : unnamed.person) : named(id) };
  };
  return { ...host, threadsOf, rule: id => ({ id, name: rules.get(id) ?? id }), actor, owners: ownersOf(store) };
}

/**
 * The Triggers of a Thread's queue that wait for an Eval: a person's follow-up a ticket still decides, which an older
 * version queued, leaves the queue with the next Eval without one.
 */
export const awaitingEval = (
  { store, owners }: { store: Pick<Store, "triggers">; owners: Owners },
  thread: Thread,
): string[] =>
  thread.pending.filter(id => {
    const trigger = store.triggers.get(id);
    return !trigger || !owners(trigger).length;
  });
/**
 * A trigger with where it went: queued for Eval, the Decision that consumed it, the Tickets it fanned out to, `delivered`
 * when it is a person's follow-up that a ticket's worker decides without an Eval, and the Tickets that handed it back for
 * a new Eval, with why; `requeue` when a person may send it to Eval, which is where no Eval reached a judgement: its Source
 * filtered it, its Eval was unavailable, a ticket's worker still decides it, or it reached a ticket and nothing decided it,
 * such as a message a worker neither acknowledged, answered nor handed back, or one only a stop was decided on.
 */
export function triggerView(view: Snapshot, trigger: Trigger, threadDecisions?: Decision[]) {
  const { store } = view;
  const disposition = store.triggers.disposition(trigger.id);
  const home = store.threads.get(threadKey(trigger.threads[0]!));
  const decision = disposition?.decisionId
    ? store.decisions.get(disposition.decisionId)
    : (threadDecisions ?? (home ? store.decisions.byThread(home.key) : []))
        .filter(item => item.triggerIds.includes(trigger.id))
        .at(-1);
  const delivered = view.owners(trigger).length > 0;
  const queued = !!home?.pending.includes(trigger.id) && !delivered;
  const evaluating = !!home?.evaluating?.triggerIds.includes(trigger.id);
  const decided = !!disposition?.acked?.length || (!!decision && settled(decision));
  const unjudged =
    !!disposition?.filtered ||
    decision?.kind === "unavailable" ||
    delivered ||
    (!!disposition?.fanout.length && !decided) ||
    (!!decision && !decided);
  const requeue = trigger.human && !queued && !evaluating && unjudged;
  return {
    id: trigger.id,
    source: trigger.source,
    actor: view.actor(trigger.actor, trigger.human),
    human: trigger.human,
    at: trigger.at,
    text: plain(readable(trigger.text), true),
    preview: preview(trigger.text),
    url: trigger.url,
    threads: trigger.threads.map(threadKey),
    actions: { requeue },
    disposition: {
      queued,
      evaluating,
      delivered,
      filtered: disposition?.filtered,
      fanout: disposition?.fanout ?? [],
      handbacks: (disposition?.handbacks ?? []).map(item => ({
        ...item,
        title: store.tickets.get(item.ticketId)?.title ?? item.ticketId,
      })),
      decision: decision
        ? { id: decision.id, outcome: outcomeOf(decision), reason: decision.reason, ticketId: decision.ticketId }
        : undefined,
    },
  };
}
export type TriggerView = ReturnType<typeof triggerView>;
/** Single-line summary of why a ticket in the `person` stage is waiting on human action (omitted once answered and back with the Executor). */
function ticketNote(ticket: Ticket, stage: TicketStage): { text: string; error: boolean } | undefined {
  if (stage.stage !== "person") return undefined;
  if (stage.action === "answer" && ticket.attention) return { text: preview(ticket.attention.question), error: false };
  if (stage.action === "delivery" && ticket.delivery) return { text: preview(ticket.delivery.error), error: true };
  const summary = latestReport(ticket)?.summary;
  if ((stage.action !== "blocked" && stage.action !== "failed") || !summary) return undefined;
  return { text: preview(summary.split("\n")[0]!), error: stage.action === "failed" };
}
export function ticketSummary(ticket: Ticket) {
  const stage = ticketStage(ticket);
  const note = ticketNote(ticket, stage);
  const state = liveTicket(ticket) ? ("open" as const) : ("ended" as const);
  return {
    id: ticket.id,
    title: ticket.title,
    state,
    ...stage,
    ...(note ? { note } : {}),
    actions: { retry: canRetry(ticket), stop: liveTicket(ticket) },
    strength: ticket.mandate.strength,
    ended: ticket.ended,
    attention: ticket.attention && { ...ticket.attention, question: markdown(ticket.attention.question) },
    assignments: ticket.assignments.length,
    inputs: ticket.inputs.length,
    undelivered: ticket.undelivered.length,
    // Every started Assignment of a Ticket runs in its one shared worker Session.
    deliveryError: attribute(ticket.delivery?.error),
    sessionId: ticket.assignments.some(item => item.startedAt) ? workerSessionId(ticket.id) : "",
    directory: attribute(ticket.execution?.directory),
    summary: latestReport(ticket)?.summary ?? "",
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}
export type TicketSummaryView = ReturnType<typeof ticketSummary>;
function threadUrl(store: Store, thread: Thread): string | undefined {
  return attribute(thread.meta.url) ?? store.read.firstTrigger(thread.key)?.url;
}
export function threadFacts(store: Store, thread: Thread) {
  const url = threadUrl(store, thread);
  return {
    key: thread.key,
    source: thread.ref.source,
    title: threadTitle(store, thread),
    ...(url ? { url } : {}),
    facts: (thread.meta.facts ?? {}) as ThreadFacts,
  };
}
export type ThreadFactsView = ReturnType<typeof threadFacts>;
export const ticketLine = (view: Snapshot, ticket: Ticket) => ({
  ...ticketSummary(ticket),
  threads: view.threadsOf(ticket.id).map(thread => threadFacts(view.store, thread)),
});
export function threadTitle(store: Pick<Store, "read">, thread: Thread): string {
  const label = attribute(thread.meta.label);
  if (label) return label;
  // Prefer the first human trigger over automated triggers when deriving a fallback thread title.
  const first = store.read.firstTrigger(thread.key, true) ?? store.read.firstTrigger(thread.key);
  return first ? preview(first.text, 80) : thread.key;
}
function latestOnThread(view: Snapshot, thread: Thread) {
  const trigger = view.store.read.threadTriggers(thread.key, 1)[0];
  if (!trigger) return undefined;
  return {
    actor: view.actor(trigger.actor, trigger.human),
    human: trigger.human,
    at: trigger.at,
    preview: preview(trigger.text, 120),
  };
}
/** Thread lifecycle stage in priority order: poll error, evaluating, queued, subscribed by open ticket, dormant (ended tickets only), or unsubscribed. */
export type ThreadStage = "error" | "evaluating" | "queued" | "subscribed" | "dormant" | "unsubscribed";
function threadStage(thread: Thread, pending: number, tickets: { state: string }[]): ThreadStage {
  if (attribute(thread.meta.pollError)) return "error";
  if (thread.evaluating) return "evaluating";
  if (pending) return "queued";
  if (tickets.some(ticket => ticket.state === "open")) return "subscribed";
  return tickets.length ? "dormant" : "unsubscribed";
}
export function threadSummary(view: Snapshot, thread: Thread) {
  const { store } = view;
  const tickets = thread.subscriptions.map(id => {
    const ticket = store.tickets.get(id);
    return { id, title: ticket?.title ?? id, state: !ticket ? "unknown" : liveTicket(ticket) ? "open" : "ended" };
  });
  const pending = awaitingEval(view, thread).length;
  return {
    key: thread.key,
    source: thread.ref.source,
    title: threadTitle(store, thread),
    stage: threadStage(thread, pending, tickets),
    latest: latestOnThread(view, thread),
    lastAt: thread.lastAt ?? thread.createdAt,
    createdAt: thread.createdAt,
    subscriptions: thread.subscriptions.length,
    tickets,
    evaluating: thread.evaluating
      ? {
          id: thread.evaluating.id,
          strength: thread.evaluating.strength,
          triggers: thread.evaluating.triggerIds.length,
          startedAt: thread.evaluating.startedAt,
          deadline: thread.evaluating.deadline,
        }
      : undefined,
    pending,
    pollError: attribute(thread.meta.pollError),
    url: threadUrl(store, thread),
    facts: (thread.meta.facts ?? {}) as ThreadFacts,
  };
}
export type ThreadSummaryView = ReturnType<typeof threadSummary>;
/** Resolves a channel link, preferring the specific trigger URL when the source link references a trigger. */
export function channelLink({ store, links }: ViewHost, channel: ChannelRef) {
  const { url, label, triggerId } = links(channel);
  return { source: channel.source, url: (triggerId && store.triggers.get(triggerId)?.url) || url, label };
}
/** Parses stored assessment audit metadata, tolerating fields omitted or shaped differently by older versions. */
const AuditSchema = z
  .object({
    would_accept: z.boolean().optional().catch(undefined),
    rule_assessments: z
      .array(z.object({ rule_id: z.string(), matched: z.boolean(), reason: z.string() }))
      .optional()
      .catch(undefined),
    matches: z
      .array(z.object({ rule_id: z.string(), reason: z.string() }))
      .optional()
      .catch(undefined),
    direction: z
      .object({
        implementation_requested: z.boolean(),
        target_basis: z.string(),
        requires_design_decision: z.boolean(),
        evidence: z.string(),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});
/** Decision kind, or `wouldAccept` for an ignore decision that observe mode would have accepted. */
export type DecisionOutcome = DecisionKind | "wouldAccept";
const outcomeOf = (decision: Decision): DecisionOutcome =>
  decision.kind === "ignore" && AuditSchema.parse(decision.audit ?? {}).would_accept ? "wouldAccept" : decision.kind;
export function decisionView(view: Snapshot, decision: Decision) {
  const { store } = view;
  const thread = store.threads.get(decision.threadKey);
  const texts = decision.triggerIds.flatMap(id => {
    const trigger = store.triggers.get(id);
    return trigger ? [preview(trigger.text)] : [];
  });
  const audit = AuditSchema.parse(decision.audit ?? {});
  // Fall back to `matches` for assessments recorded by older versions.
  const judged = audit.rule_assessments ?? audit.matches?.map(match => ({ ...match, matched: true })) ?? [];
  return {
    id: decision.id,
    kind: decision.kind,
    outcome: outcomeOf(decision),
    reason: decision.reason,
    at: decision.at,
    strength: decision.strength,
    ticketId: decision.ticketId,
    triggerIds: decision.triggerIds,
    thread: decision.threadKey,
    rules: judged.map(rule => ({ ...view.rule(rule.rule_id), matched: rule.matched, reason: rule.reason })),
    ...(audit.direction ? { direction: audit.direction } : {}),
    ...(thread ? { threadTitle: threadTitle(store, thread) } : {}),
    preview: texts.join(" / "),
    ticketTitle: decision.ticketId ? store.tickets.get(decision.ticketId)?.title : undefined,
  };
}
export type DecisionView = ReturnType<typeof decisionView>;
