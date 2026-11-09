import { key } from "./ids.mts";
import { liveTicket, readUntil } from "./model.mts";
import type {
  Evaluation,
  Mandate,
  Ticket,
  TicketEndBy,
  TicketInput,
  TicketOutcome,
  Trigger,
  TriggerDisposition,
} from "./model.mts";
import type { AssessmentOutcome } from "./ports.mts";
import type { Tickets } from "./tickets.mts";

import type { ChannelRef } from "./model.mts";

/**
 * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
 * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
 * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
 */
export function runCreate(
  this: Tickets,
  id: string,
  decisionId: string,
  mandate: Mandate,
  evaluation: Pick<Evaluation, "triggerIds" | "primary">,
  outcome: Extract<AssessmentOutcome, { kind: "accept" }>,
  at: string,
): void {
  const { triggerIds } = evaluation;
  // Fall back to the last trigger for Evals recorded before `primary` existed.
  const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!);
  const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds };
  let ticket: Ticket = {
    id,
    title: outcome.title,
    decisionId,
    mandate,
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    origin,
  };
  for (const triggerId of triggerIds) {
    const channel = this.repo.triggers.get(triggerId)?.channel;
    if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel);
  }
  ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket;
  const assignment = this.newAssignment(ticket);
  this.repo.tickets.save(ticket);
  for (const triggerId of triggerIds)
    for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref);
  if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement);
  this.options.executor.start(this.require(id), assignment);
  this.emit("ticket.created", { ticketId: id, decisionId, strength: mandate.strength });
}

/**
 * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
 * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
 * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
 */
export function runAttach(this: Tickets, ticketId: string, trigger: Trigger, note?: string): void {
  for (const ref of trigger.threads) this.subscribe(ticketId, ref);
  // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
  const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() };
  const { context, requeued, ...disposition } = current;
  const followed = context?.filter(id => id !== ticketId);
  this.repo.triggers.saveDisposition(trigger.id, {
    ...disposition,
    fanout: [...new Set([...disposition.fanout, ticketId])],
    ...(followed?.length ? { context: followed } : {}),
  });
  const ticket = this.require(ticketId);
  const id = key("input", ticketId, "trigger", trigger.id);
  const existing = ticket.inputs.find(input => input.id === id);
  const at = this.now();
  const input = (inputId: string): TicketInput => ({
    id: inputId,
    kind: "trigger",
    triggerId: trigger.id,
    at,
    ...(note ? { note } : {}),
    ...(trigger.human ? { human: true } : {}),
  });
  if (existing?.kind !== "trigger") this.addInput(ticket, input(id));
  else if (note && ticket.undelivered.includes(id)) {
    existing.note = note;
    ticket.updatedAt = at;
    this.repo.tickets.save(ticket);
  }
  // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
  // its worker had it, so the worker gets it again.
  else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
    this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "attached", at)));
  }
  // The worker has the message already, so the note comes with it again.
  else if (note) this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "note", note)));
}

/**
 * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
 * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
 * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
 * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
 */
export function runWake(this: Tickets, ticketId: string): void {
  const ticket = this.repo.tickets.get(ticketId);
  if (!ticket || liveTicket(ticket) || ticket.ended?.by === "human" || !ticket.undelivered.length) return;
  const policy = this.policy();
  if (policy.paused) return;
  if (!policy.revalidate(ticket.mandate)) {
    this.refuse(ticket);
    return;
  }
  // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
  const first = ticket.undelivered
    .map(id => ticket.inputs.find(input => input.id === id))
    .find(input => input?.kind === "trigger" && input.human);
  if (first?.kind !== "trigger") return;
  const at = this.now();
  delete ticket.ended;
  ticket.updatedAt = at;
  const assignment = this.newAssignment(ticket);
  // Prepend the resumed marker so it is delivered ahead of the waiting messages.
  const resumed: TicketInput = {
    id: key("input", ticket.id, "resumed", first.triggerId),
    kind: "resumed",
    triggerId: first.triggerId,
    at,
  };
  ticket.inputs.push(resumed);
  ticket.undelivered.unshift(resumed.id);
  this.repo.tickets.save(ticket);
  this.options.executor.start(ticket, assignment);
  this.emit("ticket.resumed", { ticketId, triggerId: first.triggerId });
}

/**
 * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
 * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
 * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
 * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
 * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
 */
export function runEnd(
  this: Tickets,
  ticketId: string,
  by: TicketEndBy,
  outcome: TicketOutcome,
  at = this.now(),
  reason?: string,
): void {
  const ticket = this.require(ticketId);
  if (!liveTicket(ticket)) return;
  const stopping = ticket.assignments.filter(assignment => assignment.state !== "ended");
  const why = reason && reason !== outcome ? { reason } : {};
  const until = readUntil(ticket);
  const waiting = this.triggersOf(ticket, ticket.undelivered);
  const left = this.untaken(
    ticket,
    ticket.inputs.flatMap(input =>
      input.kind === "trigger" && (!readBefore(input, until) || ticket.undelivered.includes(input.id))
        ? [input.id]
        : [],
    ),
  );
  // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
  ticket.ended = { at, by, outcome, ...why };
  ticket.undelivered = [];
  ticket.updatedAt = this.now();
  delete ticket.attention;
  delete ticket.delivery;
  // The Assignments the end stops end with it; the ticket's end says why.
  for (const assignment of stopping) {
    assignment.state = "ended";
    assignment.endedAt = at;
  }
  this.repo.tickets.save(ticket);
  this.letGo(ticketId, waiting, left);
  this.emit("ticket.ended", { ticketId, by, outcome, ...why });
  for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome);
}

export const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
export const readBefore = (input: Extract<TicketInput, { kind: "trigger" }>, until: string): boolean =>
  input.readAt === undefined
    ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until
    : !!input.readAt && input.readAt < until;
