// Ported from dsh-superagent (MIT), src/app/notices.ts (worker result relay)
import { key, ticketStage, type Ticket, type WorkerReport } from '../core/index.mts'
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string): { id: string; text: string } {
  const id = key('worker-result', ticket.id, ticket.updatedAt, text)
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text }
  const stage = ticketStage(ticket)
  return { id: `report:${id}`, text: JSON.stringify({ kind: 'worker_report',
    ticket: { ticket_id: ticket.id, title: ticket.title, state: stage.stage === 'person' ? `person/${stage.action}` : stage.stage },
    trigger_id: ticket.origin.triggerId, state, ...replyTo ? { answer_to: replyTo } : {}, ...summary, read: `ticket/${ticket.id}/result` }) }
}
/** Keep ordinary progress internal; relay a question, result, blocker or answer once. */
export function reportRelay(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>): { id: string; text: string } | undefined {
  if (report.question && ticket.attention) return { id: `attention:${ticket.id}:${ticket.attention.id}`, text: JSON.stringify({ kind: 'worker_attention',
    ticket: { ticket_id: ticket.id, title: ticket.title, question: ticket.attention.question }, state: report.state, read: `ticket/${ticket.id}/result` }) }
  if (report.state === 'progress' && !report.answers) return undefined
  return resultRelay(ticket, report.state, report.summary, report.answers)
}
