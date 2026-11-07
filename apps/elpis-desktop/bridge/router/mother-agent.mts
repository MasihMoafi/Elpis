/** Desktop lifecycle and the opt-in Mother chat. One controller serializes settings changes and startup. */
import { attachmentInput } from '../attachments.mts'
import { randomUUID } from 'node:crypto'
import type { DesktopClient } from '../client.mts'
import { BridgeError, object } from '../validate.mts'
import { existingSocket } from '../client-paths.mts'
import { profileEnvironment } from '../profile-env.mts'
import { MotherApp } from './app.mts'
import { MotherSettingsFile, type MotherSettings } from './settings.mts'
import { runtimeAdapters, type RuntimeAdapter } from './executor/adapters.mts'
import { readSettings, type RoleModel } from './executor/settings.mts'
import { createElpisChatTransport } from './sources/elpis-chat-transport.mts'
import { modelCatalog } from './model.mts'
import { subprocess } from './subprocess.mts'
import type { ListedThread, ThreadListOptions } from '../client-thread-list.mts'
import { handleMotherHttp } from './app/http.mts'
import type { IncomingMessage, ServerResponse } from 'node:http'

interface Options { client: DesktopClient; home: string; socketPath?: string; adapters?: () => Promise<RuntimeAdapter[]> }
export class MotherAgent {
  private readonly file: MotherSettingsFile
  private readonly options: Options
  private app: MotherApp | undefined
  private active = false
  private queue: Promise<unknown> = Promise.resolve()
  private error: string | undefined
  private closed = false
  private roles: { dispatch: RoleModel; worker: RoleModel } | undefined
  constructor(options: Options) { this.options = options; this.file = new MotherSettingsFile(options.home) }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next
  }
  snapshot(): MotherSettings { const snapshot = this.file.snapshot(), settings = this.app?.store.settings() ?? readSettings(this.options.home)
    return { ...snapshot, ...(settings ? { roles: { dispatch: settings.eval.model, worker: settings.executor.model } } : {}),
      ...(this.error ? { error: this.error } : {}), ...(this.app ? { health: this.app.health } : {}) } }
  owns(id: string): boolean { return this.file.read().threadId === id }
  decorate<T extends { id: string }>(thread: T): T & { motherAgent?: boolean } {
    const config = this.file.read()
    if (config.threadId !== thread.id) return thread
    const model = this.app?.store.settings().eval.model ?? readSettings(this.options.home).eval.model ?? this.roles?.dispatch ?? config.roles.dispatch
    return { ...thread, name: 'Mother agent', motherAgent: true, ...(model ? { model: model.model, modelProvider: model.provider } : {}) }
  }
  /** Native lists omit chats without a native preview; Mother owns her history in the bridge. */
  async list(threads: ListedThread[], query: ThreadListOptions): Promise<ListedThread[]> {
    const id = this.file.read().threadId
    const rows = threads.map(thread => this.decorate(thread))
    if (!id || query.archived || query.cursor || query.ancestorThreadId || rows.some(thread => thread.id === id)) return rows
    if (typeof query.searchTerm === 'string' && !'mother agent'.includes(query.searchTerm.toLowerCase())) return rows
    try { rows.unshift(this.decorate(await this.options.client.readThreadMetadata(id))) }
    catch { /* A deleted or unavailable Mother chat remains visible as a startup error in Settings. */ }
    return rows
  }
  /** Called once at bridge startup and again on reconnection; disabled settings start no runtime. */
  start(): Promise<void> {
    return this.serialized(async () => { try { await this.reconcile() } catch (error) { this.error = error instanceof Error ? error.message : 'Mother agent could not start' } })
  }
  save(input: unknown): Promise<MotherSettings> {
    return this.serialized(async () => {
      if (this.closed) throw new BridgeError('Mother agent is stopping', 409)
      this.file.change(input)
      if (input && typeof input === 'object' && 'roles' in input) {
        const app = this.passive()
        const config = this.file.read(), current = app.store.settings()
        app.store.saveSettings({ ...current, eval: { ...current.eval, model: config.roles.dispatch }, executor: { ...current.executor, model: config.roles.worker } })
        this.file.write({ ...config, roles: { dispatch: null, worker: null } })
      }
      await this.stop()
      this.error = undefined
      try { await this.reconcile() } catch (error) { this.error = error instanceof Error ? error.message : 'Mother agent could not start' }
      this.options.client.emit('event', { type: 'message', data: { method: 'thread/name/updated', params: { threadId: this.file.read().threadId, name: 'Mother agent' } } })
      return this.snapshot()
    })
  }
  private async reconcile(): Promise<void> {
    let config = this.file.read()
    if (this.closed || !config.enabled || this.active || !this.options.client.connected) return
    await this.stop()
    const { client, home } = this.options, settings = await client.settings()
    const inherited = settings.background.model ? settings.background : settings.main
    const fallback: RoleModel = { provider: inherited.provider ?? settings.main.provider ?? '', model: inherited.model ?? '' }
    if ((!config.roles.dispatch || !config.roles.worker) && (!fallback.provider || !fallback.model)) throw new Error('Choose a model in Settings → Configuration before enabling Mother agent.')
    this.roles = { dispatch: config.roles.dispatch ?? fallback, worker: config.roles.worker ?? fallback }
    if (!config.threadId) {
      if (config.creating) throw new Error('Mother chat creation was interrupted. Bind the existing chat in router/mother.json before enabling it again.')
      await client.models()
      this.file.write({ ...config, creating: true })
      const created = await client.createThread({ model: this.roles.dispatch.model, provider: this.roles.dispatch.provider })
      config = this.file.write({ ...config, creating: false, threadId: created.thread.id })
    }
    const threadId = config.threadId
    if (!threadId) throw new Error('Mother agent has no chat')
    await client.readThreadMetadata(threadId)
    await client.renameThread(threadId, { name: 'Mother agent' })
    const adapters = await (this.options.adapters?.() ?? runtimeAdapters({ url: `ws+unix://${existingSocket(this.options.socketPath, profileEnvironment(home))}:/` }))
    let app: MotherApp | undefined
    try {
      app = new MotherApp({ home, threadId, adapters, subprocess, transport: createElpisChatTransport(client),
        settings: () => { const value = readSettings(home); return { ...value, eval: { ...value.eval, model: this.roles!.dispatch }, executor: { ...value.executor, model: this.roles!.worker } } },
        models: modelCatalog(client) })
      const current = app.store.settings()
      if (!current.eval.model || !current.executor.model) app.store.saveSettings({ ...current,
        eval: { ...current.eval, model: current.eval.model ?? this.roles.dispatch },
        executor: { ...current.executor, model: current.executor.model ?? this.roles.worker } })
      if (config.roles.dispatch || config.roles.worker) this.file.write({ ...config, roles: { dispatch: null, worker: null } })
      await app.start(); this.app = app; this.active = true; this.error = undefined
    } catch (error) { if (app) await app.close(); else for (const adapter of adapters) adapter.close(); throw error }
  }
  async send(id: string, raw: unknown) {
    if (this.closed || !this.file.read().enabled) throw new BridgeError('Turn Mother agent on in Settings → Configuration to send a goal.', 409)
    if (!this.owns(id)) throw new BridgeError('This is not the Mother agent chat', 409)
    await this.start()
    const app = this.app
    if (!app) throw new BridgeError(this.error ?? 'Mother agent is unavailable', 503)
    const input = object(raw, ['text', 'model', 'effort', 'mode', 'attachments', 'mentions', 'expectedTurnId']) as Record<string, unknown>
    const content = attachmentInput(input.text, input.attachments, input.mentions)
    const message = content.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'mention' ? [`${block.name}: ${block.path}`] : []).join('\n') || '[Image attachment]'
    const entry = await this.options.client.appendUser(id, { id: randomUUID(), text: message, content })
    // Intake is durable before acknowledgement; the pass loop performs inference in the background.
    void app.pump().catch(error => { this.error = error instanceof Error ? error.message : 'Mother agent routing failed' })
    return { turn: { id: entry.turnId }, routed: true }
  }
  /** The panel can configure a disabled Mother without starting a session, worker, poll or model call. */
  private passive(): MotherApp {
    if (!this.app) {
      const config = this.file.read(), initial = readSettings(this.options.home)
      this.app = new MotherApp({ home: this.options.home, threadId: config.threadId ?? '', adapters: [], subprocess,
        settings: () => ({ ...initial, eval: { ...initial.eval, model: config.roles.dispatch ?? initial.eval.model }, executor: { ...initial.executor, model: config.roles.worker ?? initial.executor.model } }),
        transport: createElpisChatTransport(this.options.client), models: modelCatalog(this.options.client) })
    }
    return this.app
  }
  async handle(request: IncomingMessage, response: ServerResponse, port: string): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) throw new BridgeError('Mother is stopping', 409)
      await handleMotherHttp(this.passive().http(), request, response, Number(port))
    })
  }

  private async stop(): Promise<void> { const app = this.app; this.app = undefined; this.active = false; await app?.close() }
  close(): Promise<void> { this.closed = true; return this.serialized(() => this.stop()) }
}
