import { Button as SharedButton } from '@/components/ui/button'
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/rows.tsx.
/** Shared list rows for Tickets, Threads, and Decisions, plus Source fact chips and automated-message run folding. */
import { useState } from 'react'
import type { DecisionRow, ThreadFacts, ThreadRow, TicketRow } from './api.ts'
import { Icon, Tag } from './controls.tsx'
import { decisionMark, threadMark, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { actorName, localized, readableMarkers, reasonLabel, valueLabel } from './text.ts'
import { ActionLink, ConfirmButton, LabelValue, SessionButton, StageMark, When } from './widgets.tsx'

export function TicketLine({ ticket, question, onChanged, context }: {
  ticket: TicketRow; question?: boolean | undefined; onChanged?: (() => Promise<void>) | undefined; context?: boolean | undefined
}) {
  const { t, call, navigate } = usePanel()
  const status = ticketMark(t, ticket)
  const after = async (request: Promise<unknown>) => { await request; await onChanged?.() }
  const note = question && ticket.note && { ...ticket.note, text: readableMarkers(t, ticket.note.text) }
  const answer = ticket.reply && ticket.stage === 'person' && ticket.action === 'answer' ? ticket.reply : undefined
  return <li className="dt-row dt-link dt-ticket" data-state={question ? status.dot : undefined}>
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><SharedButton variant="ghost" size="sm" type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</SharedButton></div>
      <div className="dt-row-meta dt-ticket-meta">
        {ticket.threads.map(thread => <ThreadChip key={thread.key} thread={thread} />)}
        {context && <ContextTag />}
        {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
        {note ? <span className={note.error ? 'dt-ticket-note dt-ticket-note-error' : 'dt-ticket-note'} title={note.text}>{note.text}</span>
          : <When at={ticket.updatedAt} />}
      </div>
      {/* Always render the actions container so every Ticket row keeps a uniform three-line height. */}
      <div className="dt-ticket-actions">{onChanged && <>
        {answer && <ActionLink href={answer.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source',
          answer.source) })}</ActionLink>}
        {ticket.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
          message={t('retryConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/retry', { id: ticket.id }))} />}
        {ticket.actions.retry && ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
        {ticket.actions.stop && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('stopConfirmTitle')}
          message={t('stopConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} />}
      </>}</div>
    </div>
  </li>
}

function ContextTag() {
  const { t } = usePanel()
  return <Tag tone="quiet" title={t('contextOnlyHint')}>{t('contextOnly')}</Tag>
}
/** Thread list row; on a Ticket page, `ticketId` omits that Ticket from fanout targets and `context` marks context-only threads. */
export function ThreadLine({ thread, ticketId, context }: { thread: ThreadRow; ticketId?: string | undefined; context?: boolean | undefined }) {
  const { t, navigate } = usePanel()
  const live = thread.tickets.filter(ticket => ticket.state === 'open' && ticket.id !== ticketId)
  const { dot, icon, label } = threadMark(t, thread)
  const reaches = live.length > 0 && `${live[0]!.title}${live.length > 1 ? t('andMore', { count: live.length - 1 }) : ''}`
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={dot} icon={icon} label={label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <SharedButton variant="ghost" size="sm" type="button" className="dt-open" title={thread.pollError} onClick={() => navigate({ page: 'trigger',
          id: thread.key })}>{readableMarkers(t, thread.title)}</SharedButton>
      </div>
      <div className="dt-row-quote dt-line">
        {thread.latest && <>{actorName(t, thread.latest.actor)}{t('labelSeparator')}{readableMarkers(t, thread.latest.preview)
          || t('empty')}</>}
      </div>
      <div className="dt-row-meta dt-line">
        <ThreadChip thread={thread} />
        {context && <ContextTag />}
        {thread.pollError ? <span className="dt-line-text dt-error-text">{thread.pollError}</span> : reaches && <LabelValue
          label={t('fanoutTo')} value={reaches} />}
        <When at={thread.lastAt} />
      </div>
    </div>
  </li>
}

export function DecisionLine({ decision }: { decision: DecisionRow }) {
  const { t, navigate } = usePanel()
  const matched = decision.rules.filter(rule => rule.matched).map(rule => rule.name)
  const mark = decisionMark(t, decision.outcome)
  const preview = readableMarkers(t, decision.preview)
  const reason = decision.reason ? reasonLabel(t, decision.reason) : ''
  const open = () => decision.ticketId ? navigate({ page: 'execution', id: decision.ticketId })
    : navigate({ page: 'trigger', id: decision.thread, query: { trigger: decision.triggerIds[0] ?? '' } })
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <SharedButton variant="ghost" size="sm" type="button" className="dt-open" title={reason || undefined} onClick={open}>
          {decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t('empty'))}
        </SharedButton>
      </div>
      <div className="dt-row-quote dt-line">{preview}</div>
      <div className="dt-row-meta dt-line">
        {reason && <span className="dt-line-text">{reason}</span>}
        {matched.length > 0 && <LabelValue label={t('ruleLabel')} value={matched.join(t('listSeparator'))} />}
        <When at={decision.at} />
      </div>
    </div>
  </li>
}

function ThreadChip({ thread }: { thread: Omit<Pick<ThreadFacts, 'source' | 'facts' | 'url' | 'title'>, 'url'> & { url?: string | undefined } }) {
  const { t } = usePanel()
  const cells = <>
    <span className="dt-chip-source">{valueLabel(t, 'source', thread.source)}</span>
    {Object.entries(thread.facts).map(([id, fact]) => <span key={id} className={fact.problem ? 'dt-chip-fact dt-chip-problem'
      : 'dt-chip-fact'}>
      {fact.label && <span className="dt-chip-label">{localized(t, fact.label)}</span>}{localized(t, fact.value)}
    </span>)}
  </>
  return thread.url ? <a className="dt-chip dt-chip-link" href={thread.url} target="_blank" rel="noopener noreferrer" title={thread.title}>
    {cells}<span className="dt-chip-open"><Icon name="external" size={11} /></span>
  </a> : <span className="dt-chip">{cells}</span>
}

type Run<I> = { item: I; earlier: I[] }
/** Group consecutive automated items from the same sender so only the newest is shown by default. */
export function automatedRuns<I>(items: I[], sender: (item: I) => string | undefined): Run<I>[] {
  const runs: Run<I>[] = []
  for (const item of items) {
    const last = runs.at(-1), from = sender(item)
    if (last && from !== undefined && sender(last.item) === from) last.earlier.push(item)
    else runs.push({ item, earlier: [] })
  }
  return runs
}
export function Earlier({ items }: { items: { id: string; at: string; preview: string }[] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return <div>
    <SharedButton variant="ghost" size="sm" type="button" className="dt-textlink" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t('collapse') : t('automatedEarlier', { count: items.length })}
    </SharedButton>
    {open && <ul className="dt-plain-list dt-hint">{items.map(item => <li key={item.id}><When
      at={item.at} /> · {readableMarkers(t, item.preview) || t('empty')}</li>)}</ul>}
  </div>
}
