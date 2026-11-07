/** Desktop lifecycle and the opt-in Mother chat. One controller serializes settings changes and startup. */
import { randomUUID } from 'node:crypto'
import type { DesktopClient } from '../client.mts'
import { BridgeError, object, text } from '../validate.mts'
import { existingSocket } from '../client-paths.mts'
import { profileEnvironment } from '../profile-env.mts'
import { MotherApp } from './app.mts'
import { MotherSettingsFile, type MotherSettings } from './settings.mts'
import { runtimeAdapters, type RuntimeAdapter } from './executor/adapters.mts'
import { readSettings, type RoleModel } from './executor/settings.mts'
import { createElpisChatTransport } from './sources/elpis-chat-transport.mts'
import { dispatchModel } from './model.mts'
import { subprocess } from './subprocess.mts'
import type { DispatchModel } from './dispatch.mts'
import type { ListedThread, ThreadListOptions } from '../client-thread-list.mts'

interface Options { client: DesktopClient; home: string; socketPath?: string; adapters?: () => Promise<RuntimeAdapter[]>; dispatch?: DispatchModel }
export class MotherAgent {
  private readonly file: MotherSettingsFile
  private readonly options: Options
  private app: MotherApp | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private error: string | undefined
  private closed = false
  private roles: { dispatch: RoleModel; worker: RoleModel } | undefined
  constructor(options: Options) { this.options = options; this.file = new MotherSettingsFile(options.home) }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next
  }
  snapshot(): MotherSettings { return { ...this.file.snapshot(), ...(this.error ? { error: this.error } : {}), ...(this.app ? { health: this.app.health } : {}) } }
  owns(id: string): boolean { return this.file.read().threadId === id }
  decorate<T extends { id: string }>(thread: T): T & { motherAgent?: boolean } {
    const config = this.file.read()
    if (config.threadId !== thread.id) return thread
    const model = this.roles?.dispatch ?? config.roles.dispatch
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
      await this.stop()
      this.error = undefined
      try { await this.reconcile() } catch (error) { this.error = error instanceof Error ? error.message : 'Mother agent could not start' }
      this.options.client.emit('event', { type: 'message', data: { method: 'thread/name/updated', params: { threadId: this.file.read().threadId, name: 'Mother agent' } } })
      return this.snapshot()
    })
  }
  private async reconcile(): Promise<void> {
    let config = this.file.read()
    if (this.closed || !config.enabled || this.app || !this.options.client.connected) return
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
        dispatch: this.options.dispatch ?? dispatchModel(client, () => this.roles!.dispatch) })
      await app.start(); this.app = app; this.error = undefined
    } catch (error) { if (app) await app.close(); else for (const adapter of adapters) adapter.close(); throw error }
  }
  async send(id: string, raw: unknown) {
    if (this.closed || !this.file.read().enabled) throw new BridgeError('Turn Mother agent on in Settings → Configuration to send a goal.', 409)
    if (!this.owns(id)) throw new BridgeError('This is not the Mother agent chat', 409)
    await this.start()
    const app = this.app
    if (!app) throw new BridgeError(this.error ?? 'Mother agent is unavailable', 503)
    const input = object(raw, ['text', 'model', 'effort', 'mode', 'attachments', 'mentions', 'expectedTurnId']) as Record<string, unknown>
    if ((Array.isArray(input.attachments) && input.attachments.length) || (Array.isArray(input.mentions) && input.mentions.length)) throw new BridgeError('Send Mother agent a text goal with file paths in the message.')
    const message = text(input.text, 'goal', 100_000), entry = await this.options.client.appendUser(id, { id: randomUUID(), text: message })
    // Intake is durable before acknowledgement; the pass loop performs inference in the background.
    void app.pump().catch(error => { this.error = error instanceof Error ? error.message : 'Mother agent routing failed' })
    return { turn: { id: entry.turnId }, routed: true }
  }
  private async stop(): Promise<void> { const app = this.app; this.app = undefined; await app?.close() }
  close(): Promise<void> { this.closed = true; return this.serialized(() => this.stop()) }
}
