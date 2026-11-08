// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/runtime.ts.
/** Composition root. All domain commands, receipts, versions and side effects share one profile database. */
import { join } from 'node:path';
import { Engine, key, type Ticket, type Trigger } from './core/index.mts';
import { ExecutorStore } from './executor/store.mts';
import { ExecutorService } from './executor/service.mts';
import { ticketOfSession, sourceTrigger } from './executor/messages.mts';
import type { RuntimeAdapter } from './executor/adapters.mts';
import { environmentOf, ticketEnvironment } from './executor/execution-environment.mts';
import { SettingsSchema, settingsPolicy, type Settings as SettingsValue } from './policy.mts';
import { Commands } from './infra/commands.mts';
import { HealthBoard } from './infra/health.mts';
import type { SubprocessRuntime } from './infra/types.mts';
import { SourceRegistry } from './sources/registry.mts';
import { createElpisChatKind, watchElpisChat, pollElpisChat, type ElpisChatTransport } from './sources/elpis-chat.mts';
import { githubKind, watchGithub } from './sources/github.mts';
import { pullEndNotices } from './sources/github-pull.mts';
import type { SourceContext, SourceHost } from './sources/host.mts';
import { sourceContext } from './source-context.mts';
import { Outbox } from './outbox.mts';
import { machineOf, type Machine } from './deployment.mts';
import { MasterAssessor } from './app/assessment.mts';
import { Prompts } from './app/prompts.mts';
import { TextCache } from './app/cache.mts';
import { Settings } from './app/settings.mts';
import { Setup } from './app/setup.mts';
import { Passes } from './app/passes.mts';
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './app/links.mts';
import { eventNotice, followupNotice } from './app/notices.mts';
import { mainTools, type MainToolsHost } from './app/tools/main.mts';
import { executorTools, type ExecutorToolsHost } from './app/tools/executor.mts';
import type { ResourceHost } from './app/resources.mts';
import { evalsHealth } from './app/views/overview.mts';
import type { HttpHost } from './app/http.mts';
import type { AppContext, ModelCatalog } from './app/host.mts';
import { KV } from './sources/kv.mts';

export interface MotherAppOptions {
  home: string; threadId: string; settings: () => SettingsValue; adapters: RuntimeAdapter[]; subprocess: SubprocessRuntime
  transport: ElpisChatTransport; models?: () => Promise<ModelCatalog>
}
export class MotherApp implements SourceHost {
  readonly store: ExecutorStore
  readonly engine: Engine
  readonly workers: ExecutorService
  readonly sources: SourceRegistry
  readonly setup: Setup
  readonly settings: Settings
  readonly prompts: Prompts
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly passes: Passes
  readonly machine: Machine
  readonly masterId: string
  readonly ready = Promise.resolve()
  private readonly options: MotherAppOptions
  private readonly lifetime = new AbortController()
  private readonly commands: Commands
  private readonly board = new HealthBoard()
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stops: (() => void)[] = []
  private readonly loops: Promise<void>[] = []
  private readonly contexts = new Map<string, SourceContext>()
  private closing = false
  private stopped: Promise<void> | undefined
  private quiet = 0
  private started = false
  constructor(options: MotherAppOptions) {
    this.options = options
    const store = this.store = new ExecutorStore(options.home)
    try {
      if (!store.settingsHistory(1).length) {
        const initial = SettingsSchema.parse(options.settings())
        store.saveSettings({ ...initial, sources: { github: { enabled: false, config: {} }, ...initial.sources,
          'elpis-chat': { enabled: true, config: { threadId: options.threadId } } },
          policy: { ...initial.policy, sources: { ...initial.policy.sources, 'elpis-chat': { allowed: [{ id: 'local-user' }] } } } })
      } else {
        const current = store.settings(), chat = current.sources['elpis-chat']
        if (chat?.config.threadId !== options.threadId) store.saveSettings({ ...current, sources: { ...current.sources,
          'elpis-chat': { enabled: true, config: { ...chat?.config, threadId: options.threadId } } } })
      }
      const sources = this.sources = new SourceRegistry(() => store.settings(), this.board)
      this.stops.push(sources.register(githubKind), sources.register(createElpisChatKind(options.transport)))
      this.machine = machineOf(join(options.home, 'router'), () => store.get(KV.runtime.machine)?.value ?? {})
      const runtime = this
      this.setup = new Setup({ machine: this.machine, subprocess: options.subprocess, lifetime: this.lifetime.signal,
        restart: () => { void this.setup.run(store.settings()).then(() => this.passes.request()) } })
      this.commands = new Commands(() => this.setup.deployment, {}, this.lifetime.signal)
      const prompts = this.prompts = new Prompts(store, () => this.machine.promptMaxChars.get(),
        () => environmentOf({ deployment: this.setup.deployment, sources, settings: store.settings() }), () => true)
      this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(this.machine.stateDir)}`
      store.set(KV.runtime.masterId, this.masterId)
      const links: LinkHost = { store, sources, commands: this.commands, links: this.sourceLinks, lifetime: this.lifetime.signal }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const workers = this.workers = new ExecutorService({ store, stateDir: this.machine.stateDir, engine: () => this.engine,
        subprocess: options.subprocess, adapters: options.adapters, health: this.board, parentThreadId: options.threadId,
        mainSessionId: this.masterId, paused: () => this.paused(), prompts,
        processEnvironment: () => this.setup.workerEnvironment(), sessionEnvironment: id => {
          const ticketId = ticketOfSession(id), ticket = ticketId ? store.tickets.get(ticketId) : undefined
          return { ...this.setup.workerEnvironment(), ...(ticket ? Object.fromEntries(this.environment(ticket).map(value => [value.key, value.value])) : {}) }
        },
        instructions: id => {
          const ticketId = ticketOfSession(id), ticket = ticketId ? store.tickets.get(ticketId) : undefined
          const version = prompts.current()
          return [prompts.compose(version.config, ticketId ? 'worker' : 'orchestrator', ticket ? this.environment(ticket) : undefined),
            ...prompts.skills(version.config).map(([name, text]) => `## Skill: mother-${name}\n${text}`)].join('\n\n')
        },
        tools: id => { const ticketId = ticketOfSession(id), ticket = ticketId ? store.tickets.get(ticketId) : undefined
          if (ticketId && !ticket) throw new Error('Worker has no ticket')
          return ticket ? executorTools(tools, ticket) : mainTools(tools, { id }) },
        environment: ticket => this.environment(ticket), sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      const sessions = workers.sessions
      const context: AppContext = { logger: { warn: () => {} }, sessionController: {
        inspect: id => sessions.inspect(id), modelCatalog: options.models ?? (() => Promise.resolve({ default: null, groups: [], failures: [] })) } }
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands: this.commands, masterId: this.masterId,
        context, chat: options.transport, repliesTo: trigger => sources.repliesTo(trigger), sourceLink: link,
        promptVersion: id => sessions.promptVersion(id), mayRead: (id, revision) => sessions.mayRead(id, revision) }
      this.settings = new Settings({ store, sources, context, sessions, lifetime: this.lifetime.signal, health: this.board,
        engine: { policyChanged: (...args) => this.engine.policyChanged(...args) }, setup: this.setup, sourceHost: this,
        requestPass: () => this.passes.request() })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands: this.commands,
        get deployment() { return runtime.setup.deployment }, effects: workers.effects, settings: () => store.settings(),
        paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(this.masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects: workers.effects, sources, commands: this.commands, paused: () => this.paused() })
      this.engine = new Engine({ repo: store, policy: () => ({ ...settingsPolicy(store.settings(), sources), paused: this.paused() }),
        scope: sources, assessor: this.assessor, executor: workers.executor, outbox,
        prepareTicket: (ticket, outcome) => workers.executor.prepare(ticket, outcome), emit: event => {
          const notice = !this.quiet && eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          if (!this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')) {
            const followup = followupNotice(store, sources, event.data.triggerId)
            if (followup) sessions.relay(followup.id, followup.text)
          }
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended) for (const message of pullEndNotices(ended, store.triggers.get(ended.origin.triggerId)?.text ?? '', this.setup.deployment.repository)) outbox.send(message)
        } })
      const evals = this.board.claim('evals'), status = this.board.claim('runtime')
      this.passes = new Passes({ engine: { receive: trigger => this.engine.receive(trigger), evaluateDue: () => {
        this.engine.evaluateDue(); evals.set(evalsHealth(store)) } }, effects: workers.effects, health: status,
        lifetime: this.lifetime.signal, configured: () => true, closing: () => this.closing })
      const tools: MainToolsHost & ExecutorToolsHost = { store, engine: this.engine, context, prompts, sessions, settings: this.settings, resources, assessor: this.assessor,
        get github() { return runtime.context(githubKind) }, sendReplies: () => outbox.sent(), requestPass: () => this.passes.request(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
    } catch (error) { for (const stop of this.stops.reverse()) stop(); store.close(); throw error }
  }
  private paused(): boolean { return this.closing || this.store.settings().paused }
  private environment(ticket: Ticket) { const trigger = sourceTrigger(this, ticket)
    return ticketEnvironment({ deployment: this.setup.deployment, sources: this.sources, settings: this.store.settings(), ticket, ...(trigger ? { trigger } : {}) }) }
  context(kind: { kind: string; health: readonly string[] }): SourceContext {
    const cached = this.contexts.get(kind.kind)
    if (cached) return cached
    const runtime = this
    const context = sourceContext({ store: this.store, engine: this.engine, sources: this.sources, commands: this.commands,
      get deployment() { return runtime.setup.deployment }, ready: this.ready, outbox: this.outbox,
      configured: () => !this.closing && (kind.kind !== 'github' || this.setup.githubReady()),
      get setupProblem() { return runtime.setup.problem }, receive: trigger => this.passes.receive(trigger) }, kind)
    this.contexts.set(kind.kind, context)
    return context
  }
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.setup.run(this.store.settings())
      await this.workers.sessions.ensure(this.masterId, this.machine.stateDir, 'Elpis', 'orchestrator')
      await this.workers.start()
      this.loops.push(watchElpisChat(this.context({ kind: 'elpis-chat', health: ['elpis-chat'] }), this.options.transport, this.lifetime.signal),
        watchGithub(this.context(githubKind), this.lifetime.signal))
      this.passes.start(); this.passes.request()
    } catch (error) { await this.close(); throw error }
  }
  async pump(): Promise<void> {
    if (this.closing) return
    await pollElpisChat(this.context({ kind: 'elpis-chat', health: ['elpis-chat'] }), this.options.transport, this.lifetime.signal)
    await this.passes.pump(); await this.passes.idle()
  }
  get health() { return this.board.all }
  http(): HttpHost {
    return { store: this.store, sources: this.sources, prompts: this.prompts, sessions: this.workers.sessions, settings: this.settings,
      engine: this.engine, executor: this.workers.executor, health: this.health, machine: this.machine, masterId: this.masterId,
      ready: this.ready, deployment: this.setup.deployment, setupProblem: this.setup.problem, sourceLinks: this.sourceLinks,
      configured: () => true, links: () => channel => this.sources.link(channel, this.setup.deployment),
      ticketEnvironment: ticket => this.environment(ticket), checkSetup: () => this.setup.check(), requestPass: () => this.passes.request(),
      models: this.options.models ?? (() => Promise.resolve({ default: null, groups: [], failures: [] })) }
  }
  close(): Promise<void> { return this.stopped ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closing = true; this.lifetime.abort(); this.assessor.stop()
    try {
      const main = this.workers.sessions.agents.get(this.masterId)
      main?.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([this.passes.stop(), ...this.loops, main?.whenIdle()])
      await this.workers.shutdown()
    } finally { for (const stop of this.stops.reverse()) stop(); this.store.close() }
  }
}
