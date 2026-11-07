/** Composition of the executor's ports; the router application supplies its one Engine and policy. */
import type { EngineForExecutor, WorkerReport } from '../core/index.mts'
import type { SubprocessRuntime } from '../infra/types.mts'
import { HealthBoard } from '../infra/health.mts'
import type { RuntimeAdapter } from './adapters.mts'
import { DshExecutor, mandateInstructions, ticketOfSession, type ExecutorHost } from './dsh.mts'
import { Effects } from './effects.mts'
import { reportRelay } from '../app/notices.mts'
import { Sessions } from './sessions.mts'
import type { ExecutorStore } from './store.mts'
import type { Tool } from '../app/tools/tool.mts'
import type { Prompts } from '../app/prompts.mts'

interface Options {
  store: ExecutorStore
  stateDir: string
  engine: () => EngineForExecutor
  subprocess: SubprocessRuntime
  adapters: RuntimeAdapter[]
  paused: () => boolean
  parentThreadId?: string
  mainSessionId?: string
  health?: HealthBoard
  environment?: ExecutorHost['environment']
  sourceLink?: ExecutorHost['sourceLink']
  repliedTo?: ExecutorHost['repliedTo']
  instructions?: (sessionId: string) => string
  relay?: (id: string, text: string) => Promise<void>
  tools?: (sessionId: string) => Tool[]
  prompts?: Prompts
  sessionEnvironment?: (sessionId: string) => Record<string, string>
  processEnvironment?: () => Record<string, string>
}
export class ExecutorService {
  readonly executor: DshExecutor
  readonly sessions: Sessions
  readonly effects: Effects
  readonly health: HealthBoard
  private readonly options: Options
  private readonly lifetime = new AbortController()
  private closing = false
  private started = false
  constructor(options: Options) {
    this.options = options; this.health = options.health ?? new HealthBoard()
    this.effects = new Effects(options.store, this.health)
    const workerHealth = this.health.claim('worker')
    this.sessions = new Sessions({ store: options.store, stateDir: options.stateDir, adapters: options.adapters, subprocess: options.subprocess, effects: this.effects,
      modelHealth: this.health.claim('models'),
      ...(options.tools ? { tools: options.tools } : {}), ...(options.prompts ? { prompts: options.prompts } : {}),
      ...(options.sessionEnvironment ? { environment: options.sessionEnvironment } : {}),
      ...(options.relay ? { relay: options.relay } : {}),
      ...(options.mainSessionId ? { mainSessionId: options.mainSessionId } : {}), ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      instructions: id => {
        const ticketId = ticketOfSession(id), ticket = ticketId ? options.store.tickets.get(ticketId) : undefined
        return [options.instructions?.(id), ticket ? mandateInstructions(ticket.mandate) : ''].filter(Boolean).join('\n\n')
      }, onError: error => workerHealth.set({ state: 'error', detail: String(error) }) })
    this.executor = new DshExecutor({ store: options.store, effects: this.effects, context: this.sessions, sessions: this.sessions, health: workerHealth,
      get engine() { return options.engine() }, machine: { stateDir: options.stateDir }, lifetime: this.lifetime.signal,
      ...(options.processEnvironment ? { processEnvironment: options.processEnvironment } : {}),
      closing: () => this.closing, paused: options.paused, environment: options.environment ?? (ticket => [
        { key: 'DSH_SUPERAGENT_DIR', value: ticket.execution?.directory ?? '', description: { en: 'Ticket directory', zh: '目录' }, owner: 'executor' },
        { key: 'DSH_SUPERAGENT_NAME', value: ticket.execution?.name ?? '', description: { en: 'Ticket name', zh: '名称' }, owner: 'executor' },
        { key: 'DSH_SUPERAGENT_TICKET', value: ticket.id, description: { en: 'Ticket id', zh: 'ID' }, owner: 'executor' },
      ]), sourceLink: options.sourceLink ?? (() => Promise.resolve({})), repliedTo: options.repliedTo ?? (() => undefined) })
  }
  /** Install hooks before reattaching, then recover Assignments before draining durable work. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true; this.executor.install()
    await this.sessions.recover(); this.executor.resume(); this.effects.start()
  }
  /** Called by the router's pass loop; no extra background service is started here. */
  async pump(): Promise<void> { this.effects.kick(); await this.effects.idle() }
  report(sessionId: string, report: WorkerReport): void {
    const ticketId = ticketOfSession(sessionId)
    if (!ticketId || !this.sessions.agents.has(sessionId)) throw new Error('Only an attached worker can report its own Assignment')
    this.options.store.atomic(() => {
      const ticket = this.options.engine().report(ticketId, report), relay = reportRelay(ticket, report)
      if (relay) this.sessions.relay(relay.id, relay.text)
    })
  }
  async shutdown(): Promise<void> {
    this.closing = true
    try { await this.executor.shutdown() }
    finally { this.executor.dispose(); this.lifetime.abort(); this.sessions.dispose(); await Promise.all([this.effects.drain(), this.sessions.drained()]) }
  }
}
