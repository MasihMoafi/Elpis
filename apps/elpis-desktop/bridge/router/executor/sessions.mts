// Ported from dsh-superagent (MIT), src/app/sessions.ts (worker delivery and persistence)
import { z } from 'zod';
import type { SubprocessRuntime } from '../infra/types.mts';
import type { Jobs, Subagents } from './background.mts';
import { object, runtimeOf, type OpenOptions, type Runtime, type RuntimeAdapter, type ToolBinding, type WorkerSession } from './adapters.mts';
import type { Agent, Context, RuntimeEvents } from './runtime.mts';
import type { ExecutorStore } from './store.mts';
import { RoleModelSchema } from './settings.mts';
import { initializeRoleModel } from './role-models.mts';
import type { Effects } from './effects.mts';
import { RuntimeBackground } from './runtime-background.mts';
import { key, liveTicket } from '../core/index.mts';
import { KV } from '../sources/kv.mts';
import type { Tool } from '../app/tools/tool.mts';
import type { Prompts, PromptVersion } from '../app/prompts.mts';
import type { TranscriptEvent } from '../app/host.mts';
import { RetryHealth } from '../app/retry-health.mts';
import type { HealthEntry } from '../infra/health.mts';
import { ToolRuntime } from './tool-runtime.mts';

const MessageSchema = z.object({ id: z.string(), text: z.string(), mode: z.enum(['queue', 'steer', 'inject']), state: z.enum(['queued', 'sending', 'sent']), read: z.boolean().default(false), accepted: z.boolean().default(false) })
const RecordSchema = z.object({ runtime: z.enum(['elpis', 'codex', 'claude', 'gemini']), threadId: z.string().nullable(), creating: z.boolean().default(false), model: RoleModelSchema.nullable(), messages: z.array(MessageSchema).default([]), resultId: z.string().optional() })
type SessionRecord = z.infer<typeof RecordSchema>
type Mode = 'queue' | 'steer' | { inject: string }
export interface SessionOptions {
  store: ExecutorStore
  adapters: RuntimeAdapter[]
  subprocess: SubprocessRuntime
  effects?: Pick<Effects, 'handle' | 'enqueue' | 'pending' | 'idle'>
  modelHealth?: HealthEntry
  stateDir?: string
  mainSessionId?: string
  parentThreadId?: string
  jobs?: Jobs
  subagents?: Subagents
  instructions?: (sessionId: string) => string
  relay?: (id: string, text: string) => Promise<void>
  tools?: (sessionId: string) => Tool[]
  prompts?: Prompts
  environment?: (sessionId: string) => Record<string, string | undefined>
  onError?: (error: unknown) => void
}
class WorkerAgent implements Agent {
  readonly id: string
  status: Agent['status'] = 'idle'
  activeTurn: string | null = null
  lastText = ''
  readonly record: SessionRecord
  private readonly owner: Sessions
  private readonly idle = new Set<() => void>()
  cancellation: Promise<void> = Promise.resolve()
  readonly inbox: Agent['inbox']
  readonly session: Agent['session']
  constructor(id: string, record: SessionRecord, owner: Sessions) {
    this.id = id; this.record = record; this.owner = owner
    this.inbox = { remove: id => { record.messages = record.messages.filter(message => message.id !== id || message.state === 'sent'); owner.save(this) } }
    this.session = { snapshotEvents: () => this.lastText ? [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: this.lastText }] } } }] : [] }
  }
  state(turn: string | null): void {
    const old = this.status
    this.activeTurn = turn; this.status = turn ? 'running' : 'idle'
    if (!turn) { for (const resolve of this.idle) resolve(); this.idle.clear() }
    if (old !== this.status) this.owner.emit('agent/status', { agent: this, status: this.status })
  }
  cancel(_reason: { kind: 'user' }, options: { keepInbox: boolean }): void {
    this.cancellation = this.cancellation.catch(() => {}).then(() => this.owner.cancel(this, options.keepInbox))
    // Event listeners report the failure; consume the fire-and-forget cancellation rejection here too.
    void this.cancellation.catch(error => this.owner.emit('agent/error', { agent: this, error }))
  }
  async whenIdle(): Promise<void> { await this.cancellation; if (this.status !== 'idle') await new Promise<void>(resolve => this.idle.add(resolve)) }
}

/** Persistent logical worker IDs mapped to native runtime IDs. One session owns each delivery receipt. */
export class Sessions implements Context {
  readonly agents = new Map<string, WorkerAgent>()
  readonly subprocess: SubprocessRuntime
  readonly jobs?: Jobs
  readonly subagents?: Subagents
  private readonly options: SessionOptions
  private readonly listeners: { [K in keyof RuntimeEvents]: Set<(...args: RuntimeEvents[K]) => void> } = {
    'agent/result': new Set(),
    'agent/status': new Set(), 'agent/inbox/claimed': new Set(), 'session/event': new Set(), 'agent/error': new Set(),
  }
  private readonly ensuring = new Map<string, Promise<WorkerAgent>>()
  private readonly sending = new Map<string, Promise<void>>()
  private readonly subscriptions = new Map<string, () => void>()
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly retries = new RetryHealth()
  private retrySeq = 0
  private readonly retryTurns = new Map<string, { id: string; ordinal: number; attempts: number }>()
  private readonly pendingWork = new Set<Promise<unknown>>()
  private readonly backgroundWork: RuntimeBackground
  private readonly toolRuntime: ToolRuntime | undefined
  constructor(options: SessionOptions) {
    this.options = options; this.subprocess = options.subprocess
    this.toolRuntime = options.tools && options.stateDir ? new ToolRuntime(options.store, options.stateDir) : undefined
    this.backgroundWork = new RuntimeBackground(id => {
      const agent = this.agents.get(id)
      return agent?.record.threadId ? { adapter: this.adapter(agent.record.runtime), threadId: agent.record.threadId } : undefined
    }, error => options.onError?.(error))
    this.jobs = options.jobs ?? this.backgroundWork.jobs
    this.subagents = options.subagents ?? this.backgroundWork.subagents
    options.effects?.handle('relay', async (payload, key) => {
      if (options.relay) { await options.relay(key, payload.text); return }
      if (!options.mainSessionId) throw new Error('The router main session is not bound')
      await this.prompt(options.mainSessionId, key, payload.text, 'steer')
    }, { ordered: true })
    options.effects?.handle('notice', async (payload, name) => {
      if (!options.mainSessionId) throw new Error('The router main session is not bound')
      const text = JSON.stringify(payload.value)
      await this.prompt(options.mainSessionId, `notice:${name}:${key(text)}`, text, { inject: payload.summary })
    }, { ordered: true })
    this.on('agent/status', ({ agent, status }) => { if (status === 'idle') { this.retries.clear(agent.id); this.updateModelHealth() } })
    this.updateModelHealth()
  }
  on<K extends keyof RuntimeEvents>(name: K, listener: (...args: RuntimeEvents[K]) => void): () => void { this.listeners[name].add(listener); return () => { this.listeners[name].delete(listener) } }
  emit<K extends keyof RuntimeEvents>(name: K, ...args: RuntimeEvents[K]): void { if (!this.disposed) for (const listener of this.listeners[name]) listener(...args) }
  private adapter(runtime: Runtime): RuntimeAdapter {
    const adapter = this.options.adapters.find(item => item.runtime === runtime)
    if (!adapter) throw new Error(`The ${runtime} runtime is unavailable`)
    return adapter
  }
  save(agent: WorkerAgent): void { this.options.store.saveSession(agent.id, agent.record) }
  async refresh(id: string): Promise<void> { await this.backgroundWork.refresh(id) }
  /** Bind a discovered existing session without creating a worker or replacing its selected model. */
  async adopt(sessionId: string, runtime: Runtime, threadId: string): Promise<Agent> {
    const old = this.options.store.session(sessionId)
    const record = old ? RecordSchema.parse(old) : null
    if (record?.threadId && (record.threadId !== threadId || record.runtime !== runtime)) throw new Error('The logical session already belongs to another runtime session')
    this.options.store.saveSession(sessionId, { runtime, threadId, creating: false, model: record?.model ?? null, messages: record?.messages ?? [] })
    return this.ensure(sessionId, '', sessionId, 'worker')
  }
  ensure(sessionId: string, directory: string, title: string, role: 'worker' | 'orchestrator'): Promise<WorkerAgent> {
    if (this.disposed) return Promise.reject(new Error('The session manager is stopped'))
    const active = this.ensuring.get(sessionId)
    if (active) return active
    const existing = this.agents.get(sessionId)
    if (existing) return Promise.resolve(existing)
    const work = this.open(sessionId, directory, title, role).finally(() => { this.ensuring.delete(sessionId) })
    this.ensuring.set(sessionId, work)
    return work
  }
  private async open(id: string, cwd: string, title: string, role: 'worker' | 'orchestrator'): Promise<WorkerAgent> {
    const stored = this.options.store.session(id)
    const model = role === 'worker' ? this.options.store.settings().executor.model : this.options.store.settings().eval.model
    const record: SessionRecord = stored === undefined ? { runtime: runtimeOf(model), threadId: null, creating: false, model, messages: [] } satisfies SessionRecord : RecordSchema.parse(stored)
    if (!record.threadId && !record.creating) { record.model = model; record.runtime = runtimeOf(model) }
    const adapter = this.adapter(record.runtime)
    const tools = this.options.tools?.(id)
    const mcp = tools && (record.runtime === 'claude' || record.runtime === 'gemini')
      ? await this.toolRuntime?.transport(id, tools, role) : undefined
    let remote: WorkerSession
    if (record.threadId) {
      if (mcp) await adapter.configure?.(record.threadId, mcp, this.options.environment?.(id))
      remote = await adapter.read(record.threadId)
    }
    else {
      // A start with an unknown outcome may have created a paid worker. Never start another automatically.
      if (record.creating) throw new Error('Session creation outcome is unknown; bind the existing runtime session before retrying')
      record.creating = true; this.options.store.saveSession(id, record)
      const instructions = this.options.instructions?.(id)
      const options: OpenOptions = { cwd, name: title, model: record.model, role,
        ...(mcp ? { mcp } : {}),
        ...(this.options.environment ? { environment: this.options.environment(id) } : {}),
        ...(this.options.parentThreadId ? { parentThreadId: this.options.parentThreadId } : {}), ...(instructions ? { instructions } : {}), ...(tools ? { tools } : {}) }
      try { remote = await initializeRoleModel(adapter, options, record.model) }
      catch (error) { if (object(error).creationUnknown === false) { record.creating = false; this.options.store.saveSession(id, record) }; throw error }
      record.threadId = remote.threadId; record.creating = false; this.options.store.saveSession(id, record)
    }
    if (this.disposed) throw new Error('The session manager stopped while attaching a worker')
    const agent = new WorkerAgent(id, record, this)
    this.agents.set(id, agent)
    if (this.options.tools) {
      if (!adapter.bind) throw new Error('This runtime cannot serve Mother tools')
      const binding: ToolBinding = { tools: () => this.options.tools!(id), instructions: () => this.instructions(id),
        mcp: async () => {
          if (!this.toolRuntime) throw new Error('This session cannot reconnect Mother tools')
          const config = await this.toolRuntime.transport(id, binding.tools(), role)
          this.toolRuntime.bind(id, binding); return config
        },
        ...(this.options.environment ? { environment: () => this.options.environment!(id) } : {}),
        signal: this.lifetime.signal, authorize: () => {
          if (this.disposed) throw new Error('Mother is stopping')
          const ticketId = id.startsWith('worker-') ? id.slice('worker-'.length) : undefined
          const ticket = ticketId ? this.options.store.tickets.get(ticketId) : undefined
          if (ticketId && (!ticket || !liveTicket(ticket))) throw new Error('Ticket ended; its tools are unavailable')
        } }
      this.toolRuntime?.bind(id, binding)
      adapter.bind(remote.threadId, binding)
    }
    this.reconcile(agent, remote)
    this.subscriptions.set(id, adapter.subscribe(remote.threadId, message => this.receive(agent, message)))
    return agent
  }
  promptedId(id: string): string { return `router:${id}` }
  async holds(sessionId: string, id: string): Promise<boolean> {
    const agent = this.agents.get(sessionId)
    if (!agent?.record.threadId) return false
    this.reconcile(agent, await this.adapter(agent.record.runtime).read(agent.record.threadId))
    return agent.record.messages.some(message => message.id === this.promptedId(id))
  }
  /** Queue before sending; the effect and its receipt share the same durable store as the Assignment. */
  async prompt(sessionId: string, id: string, text: string, mode: Mode, authorize?: () => void, accepted?: () => void): Promise<void> {
    const agent = this.agents.get(sessionId)
    if (!agent) throw new Error(`Session ${sessionId} is not attached`)
    await agent.cancellation
    if (this.disposed) throw new Error('The session manager is stopped')
    authorize?.()
    const messageId = this.promptedId(id)
    let message = agent.record.messages.find(item => item.id === messageId)
    if (!message) { message = { id: messageId, text, mode: typeof mode === 'object' ? 'inject' : mode, state: 'queued', read: false, accepted: false }; agent.record.messages.push(message); this.save(agent) }
    // A rejected first turn must leave its Assignment pending so the launch effect can retry it.
    let acknowledged = false
    const accept = () => { if (!acknowledged) { acknowledged = true; accepted?.() } }
    await this.flush(agent, authorize, accept, messageId)
    // A message queued behind a running turn is durably accepted, but it has not been read.
    message.accepted = true; this.save(agent); accept()
  }
  private async flush(agent: WorkerAgent, authorize?: () => void, accepted?: () => void, requestedId?: string): Promise<void> {
    const previous = this.sending.get(agent.id) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      if (this.disposed) return
      await agent.cancellation
      const threadId = agent.record.threadId
      if (!threadId) throw new Error('The runtime session is not bound')
      const adapter = this.adapter(agent.record.runtime)
      for (const message of agent.record.messages.filter(item => item.state !== 'sent' && (item.accepted || item.id === requestedId))) {
        authorize?.()
        this.reconcile(agent, await adapter.read(threadId))
        if (message.state === 'sent') continue
        if (message.state === 'sending') throw new Error(`Delivery ${message.id} has an unknown outcome; inspect runtime history before retrying`)
        if (message.mode === 'inject') continue
        if (message.mode === 'queue' && agent.activeTurn) return
        authorize?.()
        message.state = 'sending'; this.save(agent)
        try {
          const injected = agent.record.messages.filter(item => item.mode === 'inject' && item.state === 'queued')
          const text = [...injected.map(item => item.text), message.text].join('\n')
          const turn = await adapter.send(threadId, message.id, text, agent.activeTurn, injected.map(item => item.id))
          for (const item of injected) item.state = 'sent'
          message.state = 'sent'; message.accepted = true; this.save(agent)
          if (message.id === requestedId) accepted?.()
          agent.state(turn)
          // The engine's acknowledged turn carries the message in history; read it back rather than inferring consumption.
          this.reconcile(agent, await adapter.read(threadId))
        } catch (error) {
          // A protocol rejection is safe to retry. Transport loss leaves 'sending' until history resolves it.
          if (typeof object(error).code === 'number' && !object(error).connectionClosed) { message.state = 'queued'; this.save(agent) }
          throw error
        }
      }
    }).finally(() => { if (this.sending.get(agent.id) === work) this.sending.delete(agent.id) })
    this.sending.set(agent.id, work)
    await work
  }
  private reconcile(agent: WorkerAgent, remote: WorkerSession): void {
    for (const item of remote.messages) {
      let message = agent.record.messages.find(message => message.id === item.id)
      if (!message) { message = { id: item.id, text: item.text, mode: 'steer', state: 'sent', read: false, accepted: true }; agent.record.messages.push(message) }
      message.state = 'sent'; message.accepted = true
      if (!message.read) {
        message.read = true
        this.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id: message.id, source: { kind: 'dsh-superagent' } } })
      }
    }
    if (remote.result) this.result(agent, remote.result.id, remote.result.text)
    this.save(agent); agent.state(remote.activeTurn)
  }
  private result(agent: WorkerAgent, id: string, text: string): void {
    if (agent.record.resultId === id) return
    this.options.store.atomic(() => {
      this.emit('agent/result', { agent, text })
      agent.record.resultId = id; this.save(agent)
    })
  }
  private receive(agent: WorkerAgent, raw: unknown): void {
    const message = object(raw), params = object(message.params), turn = object(params.turn)
    if (message.method === 'turn/started' && typeof turn.id === 'string') {
      const previous = this.retryTurns.get(agent.id)
      if (previous?.id !== turn.id) this.retryTurns.set(agent.id, { id: turn.id, ordinal: (previous?.ordinal ?? 0) + 1, attempts: 0 })
    }
    const retry = this.retryTurns.get(agent.id)
    if (message.method === 'error' && params.willRetry === true && retry) {
      this.retries.observe(agent.id, { type: 'llm/retry', seq: ++this.retrySeq, time: Date.now(), data: { turn: retry.ordinal, step: 0,
        retryId: retry.id, provider: agent.record.model?.provider ?? '', retry: ++retry.attempts, failure: params.error } })
    }
    if (message.method === 'turn/completed' || message.method === 'item/completed' && object(params.item).type === 'agentMessage') this.retries.clear(agent.id)
    this.updateModelHealth()
    if (message.method === 'turn/started' && typeof turn.id === 'string') { agent.lastText = ''; agent.state(turn.id) }
    else if (message.method === 'item/completed') {
      const item = object(params.item)
      if (item.type === 'agentMessage' && typeof item.text === 'string') agent.lastText = item.text
      if (item.type === 'userMessage' && agent.record.threadId) {
        const text = Array.isArray(item.content) ? item.content.map(block => object(block).text).filter(value => typeof value === 'string').join('\n') : ''
        if (!text.startsWith('<elpis-router-message id="')) this.emit('agent/inbox/claimed', { agent, message: { source: { kind: 'user' } } })
        this.background(this.adapter(agent.record.runtime).read(agent.record.threadId).then(remote => this.reconcile(agent, remote)))
      }
    } else if (message.method === 'turn/completed') {
      if (agent.activeTurn && turn.id !== agent.activeTurn) return
      if (turn.status === 'failed') this.emit('agent/error', { agent, error: new Error(typeof object(turn.error).message === 'string' ? String(object(turn.error).message) : 'The worker turn failed') })
      if (turn.status === 'completed' && typeof turn.id === 'string' && agent.lastText) this.result(agent, turn.id, agent.lastText)
      agent.state(null)
      this.background(this.flush(agent))
    } else if (message.method === 'error') {
      if (params.willRetry === true) return
      const error = params.error
      this.emit('agent/error', { agent, error: Object.assign(new Error(typeof object(error).message === 'string' ? String(object(error).message) : 'The runtime disconnected'), object(error)) })
      agent.state(null)
    }
  }
  private updateModelHealth(): void {
    const retries = this.retries.list()
    this.options.modelHealth?.set(retries.length ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}`).join('; '), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed session is waiting on a model budget retry' })
  }
  private background(work: Promise<unknown>): void {
    this.pendingWork.add(work)
    void work.catch(error => this.options.onError?.(error)).finally(() => this.pendingWork.delete(work))
  }
  async cancel(agent: WorkerAgent, keepInbox: boolean): Promise<void> {
    if (!keepInbox) { agent.record.messages = agent.record.messages.filter(message => message.state === 'sent'); this.save(agent) }
    if (agent.record.threadId) {
      const adapter = this.adapter(agent.record.runtime)
      const remote = await adapter.read(agent.record.threadId)
      if (remote.activeTurn) await adapter.stop(agent.record.threadId, remote.activeTurn)
      // turn/interrupt acknowledges the cancellation; next delivery waits for the runtime to finish it.
      this.reconcile(agent, await adapter.read(agent.record.threadId))
    }
  }
  relay(id: string, text: string): void {
    if (!this.options.effects) throw new Error('Worker reports need the durable relay effect queue')
    this.options.effects.enqueue('relay', id, { text })
  }
  notify(id: string, value: Record<string, unknown>, summary: string): void {
    if (!this.options.effects) throw new Error('Notices need the durable effect queue')
    this.options.effects.enqueue('notice', id, { value, summary })
  }
  async delivery(id: string): Promise<'injected' | 'pending'> {
    await this.options.effects?.idle('notice')
    return this.options.effects?.pending('notice', id) ? 'pending' : 'injected'
  }
  private instructions(id: string): string {
    const prompts = this.options.prompts
    if (prompts) {
      const revision = prompts.current().revision, key = KV.sessions.prompts(id), revisions = this.options.store.get(key) ?? []
      if (revisions.at(-1) !== revision) this.options.store.set(key, [...revisions, revision])
    }
    return this.options.instructions?.(id) ?? ''
  }
  promptVersion(id: string): PromptVersion {
    if (!this.options.prompts) throw new Error('Prompts are not configured')
    const revision = this.options.store.get(KV.sessions.prompts(id))?.at(-1)
    return revision === undefined ? this.options.prompts.current() : this.options.prompts.version(revision)
  }
  mayRead(id: string, revision: number): boolean { return revision === this.promptVersion(id).revision || (this.options.store.get(KV.sessions.prompts(id)) ?? []).includes(revision) }
  status() {
    return { revision: this.options.prompts?.current().revision ?? 0, notificationPending: this.options.effects?.pending('notice', 'prompts') ?? false,
      sessions: [...this.agents.keys()].map(sessionId => ({ sessionId, revision: this.options.store.get(KV.sessions.prompts(sessionId))?.at(-1) ?? 0 })) }
  }
  modelRetry(id?: string | false) { const retry = id ? this.retries.get(id) : undefined; return retry ? { model_retry: retry } : {} }
  nativeId(id: string): string | undefined { return this.agents.get(id)?.record.threadId ?? RecordSchema.safeParse(this.options.store.session(id)).data?.threadId ?? undefined }
  async inspect(id: string): Promise<{ events: TranscriptEvent[] }> {
    const agent = this.agents.get(id)
    if (!agent?.record.threadId) throw new Error('This managed session is unavailable')
    const remote = await this.adapter(agent.record.runtime).read(agent.record.threadId)
    return { events: remote.transcript ?? [] }
  }
  /** Reattach saved running workers before DshExecutor.resume interrupts or recovers Assignments. */
  async recover(): Promise<void> {
    for (const ticket of this.options.store.tickets.open()) {
      const id = `worker-${ticket.id}`
      if (this.options.store.session(id)) {
        try { await this.ensure(id, ticket.execution?.directory ?? '', ticket.title, 'worker') }
        catch (error) { this.options.onError?.(error) }
      }
    }
  }
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    this.backgroundWork.dispose()
    for (const dispose of this.subscriptions.values()) dispose()
    this.subscriptions.clear(); for (const listeners of Object.values(this.listeners)) listeners.clear()
    for (const adapter of this.options.adapters) adapter.close()
  }
  async drained(): Promise<void> {
    await Promise.allSettled([...this.ensuring.values(), ...this.sending.values(), ...this.pendingWork,
      ...this.options.adapters.map(adapter => adapter.drain?.())])
    await this.toolRuntime?.close()
  }
}
