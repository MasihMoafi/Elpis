/** The Mother agent's composition root. Sources and side effects share the core's SQLite transaction. */
import { join } from 'node:path'
import { Engine, type Policy } from './core/index.mts'
import { ExecutorStore } from './executor/store.mts'
import { ExecutorService } from './executor/service.mts'
import { ticketOfSession } from './executor/dsh.mts'
import type { RuntimeAdapter } from './executor/adapters.mts'
import type { Settings } from './executor/settings.mts'
import { Commands } from './infra/commands.mts'
import { HealthBoard, type HealthEntry } from './infra/health.mts'
import type { SubprocessRuntime } from './infra/types.mts'
import { SourceRegistry } from './sources/registry.mts'
import { startElpisChat, pollElpisChat, type ElpisChatTransport } from './sources/elpis-chat.mts'
import type { SourceContext } from './sources/host.mts'
import { sourceContext } from './source-context.mts'
import { Outbox } from './outbox.mts'
import { Dispatcher, type DispatchModel } from './dispatch.mts'
import { WORKER_INSTRUCTIONS, relayReport, workerOutcome } from './worker-reports.mts'

export interface MotherAppOptions {
  home: string; threadId: string; settings: () => Settings; adapters: RuntimeAdapter[]; subprocess: SubprocessRuntime
  dispatch: DispatchModel; transport: ElpisChatTransport
}
export class MotherApp {
  readonly store: ExecutorStore
  readonly engine: Engine
  readonly workers: ExecutorService
  private readonly options: MotherAppOptions
  private readonly lifetime = new AbortController()
  private readonly chat: SourceContext
  private readonly commands: Commands
  private readonly outbox: Outbox
  private readonly status: HealthEntry
  private stopChat: (() => Promise<void>) | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private closing = false
  private stopped: Promise<void> | undefined
  private readonly pumps = new Set<Promise<void>>()
  constructor(options: MotherAppOptions) {
    this.options = options
    const stateDir = join(options.home, 'router'), store = this.store = new ExecutorStore(options.home, options.settings)
    const health = new HealthBoard()
    const sources = new SourceRegistry(() => ({ sources: { 'elpis-chat': { enabled: !this.closing, config: { threadId: options.threadId } } }, policy: { sources: {} } }), health)
    const deployment = { stateDir, repository: '', github: { cli: '', login: '', noreply: '' } }
    this.commands = new Commands(() => deployment, {}, this.lifetime.signal)
    const workers = this.workers = new ExecutorService({ store, stateDir, engine: () => this.engine, subprocess: options.subprocess, adapters: options.adapters,
      health, parentThreadId: options.threadId, paused: () => this.closing, instructions: id => {
        const ticketId = ticketOfSession(id), ticket = ticketId ? store.tickets.get(ticketId) : undefined
        return [WORKER_INSTRUCTIONS, ticket ? `Ticket ${ticket.id}. Agreed scope and acceptance: ${ticket.mandate.scope}` : ''].filter(Boolean).join('\n\n')
      },
      sourceLink: trigger => Promise.resolve({ source_text: trigger.text }),
      relay: (id, text) => { store.atomic(() => relayReport(store, this.engine, this.outbox, id, text)); return Promise.resolve() } })
    this.status = workers.health.claim('runtime')
    const outbox = this.outbox = new Outbox(store, workers.effects, sources, this.commands, () => this.closing)
    const assessor = new Dispatcher({ engine: () => this.engine, effects: workers.effects, outbox, model: options.dispatch, signal: this.lifetime.signal, paused: () => this.closing, atomic: work => store.atomic(work) })
    const policy: Policy = { version: 'mother-chat-v1', paused: false, evalTimeoutMs: 120_000,
      gate: trigger => trigger.human && trigger.source === 'elpis-chat' && trigger.meta.threadId === options.threadId
        ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'Only the selected Mother chat can originate work' },
      revalidate: mandate => mandate.strength === 'explicit', admitsInferred: () => false }
    this.engine = new Engine({ repo: store, policy: () => ({ ...policy, paused: this.closing }), scope: sources, assessor, executor: workers.executor, outbox,
      prepareTicket: (ticket, outcome) => workers.executor.prepare(ticket, outcome) })
    workers.sessions.on('agent/result', ({ agent, text }) => {
      const ticketId = ticketOfSession(agent.id), ticket = ticketId ? store.tickets.get(ticketId) : undefined
      if (this.closing || !ticket || ticket.ended) return
      try {
        store.atomic(() => {
          const outcome = workerOutcome(text)
          if (outcome.action === 'report') workers.report(agent.id, outcome.report)
          else {
            this.engine.handback(ticket.id, outcome.triggerId, outcome.reason)
            this.engine.report(ticket.id, { state: 'dropped', summary: outcome.reason })
          }
        })
      } catch (error) { workers.report(agent.id, { state: 'failed', summary: `Mother could not apply the worker's status: ${error instanceof Error ? error.message : 'invalid report'}` }) }
    })
    // startElpisChat owns registration; its context and manual intake share one cursor and poll lock.
    let chat: SourceContext | undefined
    const host = { sources, context: (kind: { kind: string; health: readonly string[] }) => chat ??= sourceContext({ store, engine: this.engine, sources, commands: this.commands, deployment, outbox, closing: () => this.closing }, kind) }
    this.stopChat = startElpisChat(host, options.transport)
    this.chat = host.context({ kind: 'elpis-chat', health: ['elpis-chat'] })
  }
  async start(): Promise<void> {
    try {
      await this.workers.start()
      const pass = () => { void this.pump().catch(error => { if (!this.closing) this.status.set({ state: 'error', detail: String(error) }) }) }
      pass(); this.timer = setInterval(pass, 2000); this.timer.unref()
    }
    catch (error) { await this.close(); throw error }
  }
  pump(): Promise<void> {
    const running = this.pass().finally(() => this.pumps.delete(running))
    this.pumps.add(running); return running
  }
  private async pass(): Promise<void> {
    if (this.closing) return
    await pollElpisChat(this.chat, this.options.transport, this.lifetime.signal)
    this.engine.evaluateDue()
    await this.workers.pump()
    if (!this.closing) this.status.set({ state: 'ready', detail: 'Mother agent is listening' })
  }
  get health() { return this.workers.health.all }
  close(): Promise<void> {
    return this.stopped ??= this.shutdown()
  }
  private async shutdown(): Promise<void> {
    this.closing = true; clearInterval(this.timer); this.lifetime.abort()
    try { await this.stopChat?.(); await this.workers.shutdown(); await Promise.allSettled([...this.pumps]) }
    finally { this.store.close() }
  }
}
