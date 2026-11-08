/** Desktop lifecycle and the opt-in Elpis chat. One controller serializes settings changes and startup. */
import { attachmentInput } from '../attachments.mts';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DesktopClient } from '../client.mts';
import { BridgeError, object } from '../validate.mts';
import { elpisHome, existingSocket } from '../client-paths.mts';
import { profileEnvironment } from '../profile-env.mts';
import { MotherApp } from './app.mts';
import { MotherChangeSchema, MotherSettingsFile, type MotherSettings } from './settings.mts';
import { storedSettingsVersion } from './app/store.mts';
import { runtimeAdapters, type RuntimeAdapter } from './executor/adapters.mts';
import { readSettings, type RoleModel } from './executor/settings.mts';
import { createElpisChatTransport } from './sources/elpis-chat-transport.mts';
import { modelCatalog } from './model.mts';
import { subprocess } from './subprocess.mts';
import type { ListedThread, ThreadListOptions } from '../client-thread-list.mts';
import { handleMotherHttp } from './app/http.mts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Health } from './sources/host.mts';

interface Options { client: DesktopClient; home: string; socketPath?: string; adapters?: () => Promise<RuntimeAdapter[]> }
export class MotherAgent {
  private readonly file: MotherSettingsFile
  private readonly options: Options
  private app: MotherApp | undefined
  private active = false
  private queue: Promise<unknown> = Promise.resolve()
  private error: string | undefined
  private closed = false
  private archived = false
  private roles: { dispatch: RoleModel; worker: RoleModel } | undefined
  constructor(options: Options) { this.options = options; this.file = new MotherSettingsFile(options.home) }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next
  }
  snapshot(): MotherSettings { const snapshot = this.file.snapshot(), settings = this.app?.store.settings() ?? readSettings(this.options.home)
    const revision = this.app?.store.settingsHistory(1)[0]?.revision ?? storedSettingsVersion(join(this.options.home, 'router', 'orchestrator.sqlite'))?.revision ?? 0
    const version = createHash('sha256').update(JSON.stringify([snapshot.version, revision])).digest('hex')
    return { ...snapshot, version, ...(settings ? { roles: { dispatch: settings.eval.model, worker: settings.executor.model } } : {}),
      ...(this.error ? { error: this.error } : {}), health: this.health() } }
  private health(): Record<string, Health> {
    const config = this.file.read()
    const runtime: Health = this.closed ? { state: 'paused', detail: 'Elpis is stopped' }
      : !config.enabled ? { state: 'paused', detail: 'Elpis is off' }
      : !this.options.client.connected ? { state: 'error', detail: 'Elpis is disconnected from the runtime' }
      : this.error ? { state: 'error', detail: this.error }
      : this.archived ? { state: 'paused', detail: 'The Elpis chat is archived' }
      : !this.active ? { state: 'paused', detail: 'Elpis is stopped' }
      : this.app?.store.settings().paused ? { state: 'paused', detail: 'Processing is paused' }
      : this.app?.health.runtime ?? { state: 'ready', detail: 'Elpis is running' }
    return { ...Object.fromEntries(Object.entries(this.app?.health ?? {}).map(([name, entry]) =>
      [name, !this.active && entry.state === 'starting' ? runtime : entry])), runtime }
  }
  owns(id: string): boolean { return this.file.read().threadId === id }
  decorate<T extends { id: string }>(thread: T): T & { motherAgent?: boolean } {
    const config = this.file.read()
    if (config.threadId !== thread.id) return thread
    const model = this.app?.store.settings().eval.model ?? readSettings(this.options.home).eval.model ?? this.roles?.dispatch ?? config.roles.dispatch
    return { ...thread, name: 'Elpis', motherAgent: true, ...(model ? { model: model.model, modelProvider: model.provider } : {}) }
  }
  /** Native lists omit chats without a native preview; Elpis owns her history in the bridge. */
  async list(threads: ListedThread[], query: ThreadListOptions, excluded: (id: string) => boolean = () => false): Promise<ListedThread[]> {
    const id = this.file.read().threadId
    // Every router session runs in the router's state folder, current and replaced ones alike. The sidebar shows one Elpis.
    const routerDirectory = join(this.options.home, 'router')
    const rows = threads.filter(thread => thread.cwd !== routerDirectory && !excluded(thread.id)).map(thread => this.decorate(thread))
    if (!id || excluded(id) || query.archived || query.cursor || query.ancestorThreadId || rows.some(thread => thread.id === id)) return rows
    if (typeof query.searchTerm === 'string' && !'elpis'.includes(query.searchTerm.toLowerCase())) return rows
    try { const thread = await this.options.client.readThreadMetadata(id); if (!thread.archived) rows.unshift(this.decorate(thread)) }
    catch { /* A deleted or unavailable Elpis chat remains visible as a startup error in Settings. */ }
    return rows
  }
  /** Called once at bridge startup and again on reconnection; disabled settings start no runtime. */
  start(): Promise<void> {
    return this.serialized(async () => { try { await this.reconcile() } catch (error) { this.error = error instanceof Error ? error.message : 'Elpis could not start' } })
  }
  save(input: unknown): Promise<MotherSettings> {
    return this.serialized(async () => {
      if (this.closed) throw new BridgeError('Elpis is stopping', 409)
      const data = MotherChangeSchema.parse(input)
      if (data.version !== this.snapshot().version) throw new BridgeError('Elpis settings changed elsewhere. Reload before saving.', 409)
      const before = this.file.read(), roles = data.roles
      if (roles) {
        const app = this.passive()
        app.store.atomic(() => {
          const current = app.store.settings()
          const settings = { ...current, eval: { ...current.eval, model: roles.dispatch }, executor: { ...current.executor, model: roles.worker } }
          for (const block of ['eval', 'executor'] as const) app.store.saveSettings(settings,
            { source: 'panel', block, policyVersion: '', policyChanged: false, notified: [] })
          this.file.write({ ...before, enabled: data.enabled ?? before.enabled, roles: { dispatch: null, worker: null } })
        })
      } else this.file.write({ ...before, enabled: data.enabled ?? before.enabled })
      await this.stop()
      this.error = undefined
      try { await this.reconcile() } catch (error) { this.error = error instanceof Error ? error.message : 'Elpis could not start' }
      this.options.client.emit('event', { type: 'message', data: { method: 'thread/name/updated', params: { threadId: this.file.read().threadId, name: 'Elpis' } } })
      return this.snapshot()
    })
  }
  private async reconcile(): Promise<void> {
    let config = this.file.read()
    if (this.closed || !config.enabled || !this.options.client.connected) return
    const { client, home } = this.options, settings = await client.settings()
    // The router decides what every worker does, so it follows the main model, never the cheap background one.
    const inherited = settings.main
    const fallback: RoleModel = { provider: inherited.provider ?? settings.main.provider ?? '', model: inherited.model ?? '' }
    const saved = this.app?.store.settings() ?? readSettings(home)
    const roles = { dispatch: saved.eval.model ?? config.roles.dispatch ?? fallback, worker: saved.executor.model ?? config.roles.worker ?? fallback }
    if (Object.values(roles).some(role => !role.provider || !role.model)) {
      await this.stop(); throw new Error('Choose a model in Settings → Configuration before enabling Elpis.')
    }
    if (this.active && JSON.stringify(this.roles?.dispatch) === JSON.stringify(roles.dispatch)) { this.roles = roles; return }
    await this.stop(); this.roles = roles
    if (!config.threadId) {
      if (config.creating) throw new Error('Elpis chat creation was interrupted. Bind the existing chat in router/mother.json before enabling it again.')
      await client.models()
      this.file.write({ ...config, creating: true })
      const created = await client.createThread({ model: this.roles.dispatch.model, provider: this.roles.dispatch.provider })
      config = this.file.write({ ...config, creating: false, threadId: created.thread.id })
    }
    const threadId = config.threadId
    if (!threadId) throw new Error('Elpis has no chat')
    this.archived = !!(await client.readThreadMetadata(threadId)).archived
    if (this.archived) return
    await client.renameThread(threadId, { name: 'Elpis' })
    const env = profileEnvironment(home, resolve(home) === elpisHome() ? process.env : {})
    const adapters = await (this.options.adapters?.() ?? runtimeAdapters({ url: `ws+unix://${existingSocket(this.options.socketPath, env)}:/` }))
    let app: MotherApp | undefined
    try {
      app = new MotherApp({ home, threadId, adapters, subprocess, transport: createElpisChatTransport(client),
        settings: () => { const value = readSettings(home); return { ...value, eval: { ...value.eval, model: this.roles!.dispatch }, executor: { ...value.executor, model: this.roles!.worker } } },
        models: modelCatalog(client), routerModelChanged: () => { void this.start() } })
      const current = app.store.settings()
      if (!current.eval.model || !current.executor.model) app.store.saveSettings({ ...current,
        eval: { ...current.eval, model: current.eval.model ?? this.roles.dispatch },
        executor: { ...current.executor, model: current.executor.model ?? this.roles.worker } })
      if (config.roles.dispatch || config.roles.worker) this.file.write({ ...config, roles: { dispatch: null, worker: null } })
      await app.start(); this.app = app; this.active = true; this.error = undefined
    } catch (error) { if (app) await app.close(); else for (const adapter of adapters) adapter.close(); throw error }
  }
  /** Sidebar lifecycle stops sessions while retaining tickets, receipts and work history. */
  mutate<T>(id: string, operation: string, work: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const owned = this.owns(id), lifecycle = ['archiveThread', 'unarchiveThread', 'deleteThread'].includes(operation)
      if (owned && lifecycle) await this.stop()
      let result: T
      try { result = await work() }
      catch (error) {
        if (owned && lifecycle) {
          try { await this.reconcile() }
          catch (restart) { this.error = restart instanceof Error ? restart.message : 'Elpis could not restart' }
        }
        throw error
      }
      if (owned && operation === 'deleteThread' && !(result && typeof result === 'object' && 'archived' in result && result.archived)) {
        this.file.write({ ...this.file.read(), threadId: null, creating: false })
      }
      if (owned && operation === 'unarchiveThread') await this.reconcile()
      return result
    })
  }
  async send(id: string, raw: unknown) {
    if (this.closed || !this.file.read().enabled) throw new BridgeError('Turn Elpis on in Settings → Configuration to send a goal.', 409)
    if (!this.owns(id)) throw new BridgeError('This is not the Elpis chat', 409)
    await this.start()
    const app = this.app
    if (!app) throw new BridgeError(this.error ?? 'Elpis is unavailable', 503)
    const input = object(raw, ['text', 'model', 'effort', 'mode', 'attachments', 'mentions', 'expectedTurnId']) as Record<string, unknown>
    const content = attachmentInput(input.text, input.attachments, input.mentions)
    const message = content.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'mention' ? [`${block.name}: ${block.path}`] : []).join('\n') || '[Image attachment]'
    const entry = await this.options.client.appendUser(id, { id: randomUUID(), text: message, content })
    // Intake is durable before acknowledgement; the pass loop performs inference in the background.
    void app.pump().catch(error => { this.error = error instanceof Error ? error.message : 'Elpis routing failed' })
    return { turn: { id: entry.turnId }, routed: true }
  }
  /** The panel can configure a disabled Elpis without starting a session, worker, poll or model call. */
  private passive(): MotherApp {
    if (!this.app) {
      const config = this.file.read(), initial = readSettings(this.options.home)
      this.app = new MotherApp({ home: this.options.home, threadId: config.threadId ?? '', adapters: [], subprocess,
        settings: () => ({ ...initial, eval: { ...initial.eval, model: config.roles.dispatch ?? initial.eval.model }, executor: { ...initial.executor, model: config.roles.worker ?? initial.executor.model } }),
        transport: createElpisChatTransport(this.options.client), models: modelCatalog(this.options.client),
        routerModelChanged: () => { void this.start() } })
    }
    return this.app
  }
  async handle(request: IncomingMessage, response: ServerResponse, port: string): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) throw new BridgeError('Elpis is stopping', 409)
      await handleMotherHttp({ ...this.passive().http(), health: this.health(),
        configured: () => this.active && this.options.client.connected }, request, response, Number(port))
    })
  }

  private async stop(): Promise<void> { const app = this.app; this.app = undefined; this.active = false; await app?.close() }
  close(): Promise<void> { this.closed = true; return this.serialized(() => this.stop()) }
}
