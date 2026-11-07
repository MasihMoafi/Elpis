// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/views/tickets.ts.
/** Ticket list, ticket detail, mandate basis formatting, and executor load views. */
import { liveTicket, threadKey, ticketStage, type AcceptMode, type AdmissionCell, type MandateBasis, type Ticket,
  type TicketStage } from '../../core/index.mts'
import { workerSessionId } from '../../executor/dsh.mts'
import type { Store } from '../store.mts'
import { channelLink, decisionView, newestFirst, page, snapshot, threadSummary, ticketLine, type Snapshot,
  type ViewHost } from './records.mts'
import { markdown, preview } from './text.mts'

export type BasisFact =
  | { name: 'addressed'; value: 'mention' | 'direct' } | { name: 'followup' } | { name: 'admission'; value: AdmissionCell } | { name: 'observation' }
  | { name: 'mode'; value: AcceptMode } | { name: 'rules'; value: { id: string; name: string }[] } | { name: 'sender'; value: string }
  | { name: 'legacyAuthority'; value: string } | { name: 'bot' }
/**
 * Extracts displayable mandate admission facts in reading order (omitting the receiving scope, which is stored
 * only for re-validation), marking pre-scope records that only have `authority` as `legacy`.
 */
export function basisFacts(basis: MandateBasis, rule: Snapshot['rule']): { facts: BasisFact[]; legacy: boolean } {
  const facts: BasisFact[] = []
  if (basis.sender) facts.push({ name: 'sender', value: basis.sender })
  if (basis.via === 'bot') facts.push({ name: 'bot' })
  if (basis.via !== 'followup' && basis.addressed) facts.push({ name: 'addressed', value: basis.addressed })
  // Imported bases already record their follow-up in `authority`.
  if (basis.via === 'followup' && !basis.authority) facts.push({ name: 'followup' })
  if (basis.via === 'admission') facts.push({ name: 'admission', value: basis.cell })
  const observation = basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot' ? basis.observation : undefined
  // Listed bot messages are inferred candidates regardless of where received, so only the accept mode is shown from `observation`.
  if (observation && basis.via !== 'bot') facts.push({ name: 'observation' })
  if (observation?.mode) facts.push({ name: 'mode', value: observation.mode })
  if (basis.rules?.length) facts.push({ name: 'rules', value: basis.rules.map(rule) })
  const authority = basis.via === 'followup' || basis.via === 'listed' ? basis.authority : undefined
  if (authority) facts.push({ name: 'legacyAuthority', value: authority })
  return { facts, legacy: authority !== undefined }
}
export function ticketList(host: ViewHost, stage: 'open' | TicketStage['stage'], offset: number, limit: number) {
  const view = snapshot(host)
  const { store } = view
  const shown = (ticket: Ticket) => stage === 'open' ? liveTicket(ticket) : ticketStage(ticket).stage === stage
  const tickets = (stage === 'ended' ? store.tickets.list() : store.tickets.open()).filter(shown).sort(newestFirst)
  const result = page(tickets, offset, limit)
  return { ...result, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
export type TicketListView = ReturnType<typeof ticketList>
export function ticketRow(view: Snapshot, ticket: Ticket) {
  const line = ticketLine(view, ticket)
  const channel = ticket.channels[0]
  const reply = line.stage === 'person' && channel ? channelLink(view, channel) : undefined
  return { ...line, ...reply ? { reply } : {} }
}
/** Executor slot utilization: `running` worker Sessions in an active turn (which occupy slots and are interrupted by a restart), and tickets `queued` for a slot. */
export interface ExecutorLoad { running: number; queued: number }
export function executorLoad(store: Store, running: number): ExecutorLoad {
  const queued = (ticket: Ticket) => { const stage = ticketStage(ticket); return stage.stage === 'working' && stage.action === 'queued' }
  return { running, queued: store.tickets.open().filter(queued).length }
}
export function ticketDetail(host: ViewHost, id: string) {
  const { store } = host
  const ticket = store.tickets.get(id)
  if (!ticket) return undefined
  const view = snapshot(host)
  const { stage } = ticketStage(ticket)
  const decision = store.decisions.get(ticket.decisionId)
  const input = (value: Ticket['inputs'][number]) => {
    const trigger = value.kind === 'trigger' ? store.triggers.get(value.triggerId) : undefined
    const handback = trigger && store.triggers.disposition(trigger.id)?.handbacks?.find(item => item.ticketId === id)
    const shown = trigger && { id: trigger.id, actor: view.actor(trigger.actor, trigger.human), human: trigger.human,
      preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!),
      ...handback ? { handback: { reason: handback.reason, at: handback.at } } : {} }
    const text = (value.kind === 'text' || value.kind === 'note') && value.text ? { text: markdown(value.text) } : {}
    return { ...value, ...text, delivered: !ticket.undelivered.includes(value.id), ...shown ? { trigger: shown } : {} }
  }
  // Pass `human = false` for bot-originated mandates so the Source kind still labels the actor as a bot if removed from the policy list.
  const human = ticket.mandate.basis.via !== 'bot'
  return { ...ticketLine(view, ticket), mandate: { ...ticket.mandate, actor: view.actor(ticket.mandate.actor, human) },
    basis: basisFacts(ticket.mandate.basis, view.rule), paused: store.settings().paused,
    channels: ticket.channels.map(channel => channelLink(view, channel)),
    decision: decision ? decisionView(view, decision) : undefined,
    // Every started Assignment ran in the ticket's one worker Session. A running assignment whose worker reported a non-progress state has finished its turn unless a human response resumed the ticket.
    assignments: ticket.assignments.map(assignment => ({ ...assignment, ...assignment.startedAt ? { ref: workerSessionId(ticket.id) } : {},
      ...assignment.state === 'running' && assignment.report && assignment.report.state !== 'progress' && stage !== 'working'
        ? { turnEndedAt: assignment.report.at } : {} })),
    inputs: ticket.inputs.slice().reverse().map(input),
    // Threads followed for context only (e.g., related issues) grant no authority and are marked with `context: true`.
    threads: view.threadsOf(id).map(thread => ({ ...threadSummary(view, thread),
      ...thread.context?.includes(id) ? { context: true as const } : {} })) }
}
export type TicketDetailView = NonNullable<ReturnType<typeof ticketDetail>>
