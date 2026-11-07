import type { RoleModel } from './settings.mts'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { runtimeTools } from '../../runtime-paths.mts'

export type Runtime = 'elpis' | 'codex' | 'claude' | 'gemini'
export interface Connection {
  readonly ready: Promise<unknown>
  readonly closed: boolean
  readonly listeners: Set<(message: unknown) => void>
  call(method: string, params: object): Promise<unknown>
  onClose(listener: (why: string) => void): unknown
  close(): void
}
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
export function runtimeOf(model: RoleModel | null): Runtime {
  if (model?.provider === 'claude' || model?.model.startsWith('claude/')) return 'claude'
  if (['agy', 'gemini'].includes(model?.provider ?? '') || model?.model.startsWith('agy/')) return 'gemini'
  return model?.provider === 'codex' ? 'codex' : 'elpis'
}
export interface WorkerSession { threadId: string; activeTurn: string | null; model: string | null; messages: { id: string; text: string }[]; result?: { id: string; text: string } }
export interface OpenOptions { cwd: string; name: string; model: RoleModel | null; parentThreadId?: string; instructions?: string }
export interface RuntimeAdapter {
  readonly runtime: Runtime
  open(options: OpenOptions): Promise<WorkerSession>
  read(threadId: string): Promise<WorkerSession>
  send(threadId: string, id: string, text: string, activeTurn: string | null, includedIds?: readonly string[]): Promise<string>
  stop(threadId: string, turnId: string): Promise<void>
  background(threadId: string): Promise<{ jobs: { id: string; label: string }[]; children: { id: string }[] }>
  killJob(threadId: string, processId: string): Promise<void>
  subscribe(threadId: string, listener: (message: unknown) => void): () => void
  close(): void
}
/** Stable delivery IDs also live in the runtime's own history, covering a crash before the local receipt commits. */
const marker = (id: string, includedIds: readonly string[]): string => `<elpis-router-message id="${encodeURIComponent(id)}"${includedIds.length ? ` includes="${includedIds.map(encodeURIComponent).join(',')}"` : ''}>`
function messages(turns: unknown[]): WorkerSession['messages'] {
  return turns.flatMap(turn => {
    const items = object(turn).items
    if (!Array.isArray(items)) return []
    return items.flatMap(item => {
      const value = object(item)
      if (value.type !== 'userMessage' || !Array.isArray(value.content)) return []
      const text = value.content.map(block => string(object(block).text) ?? '').join('\n')
      const match = /^<elpis-router-message id="([^"]+)"(?: includes="([^"]*)")?>\n/.exec(text)
      if (!match?.[1]) return []
      // Only the host's first-line envelope is a receipt; quoted incoming text cannot forge another one.
      try { return [match[1], ...(match[2]?.split(',') ?? [])].map(id => ({ id: decodeURIComponent(id), text })) } catch { return [] }
    })
  })
}
/** The ACP bridge exposes the same app-server protocol as the native engine; it owns provider sign-in and processes. */
export class AppServerAdapter implements RuntimeAdapter {
  readonly runtime: Runtime
  private readonly connections = new Map<string, Connection>()
  private readonly disposers = new Set<() => void>()
  private readonly watchers = new Map<string, Set<(message: unknown) => void>>()
  private readonly connect: () => Connection
  constructor(runtime: Runtime, connect: () => Connection) { this.runtime = runtime; this.connect = connect }
  private async connection(threadId: string): Promise<Connection> {
    const old = this.connections.get(threadId)
    if (old && !old.closed) return old
    const conn = this.connect()
    try { await conn.ready; await conn.call('thread/resume', { threadId }); this.connections.set(threadId, conn); this.watch(conn, threadId); return conn }
    catch (error) { conn.close(); throw error }
  }
  protected route(model: RoleModel | null): { model?: string; modelProvider?: string; config?: Record<string, string> } {
    return model ? { model: model.model, modelProvider: model.provider, ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}) } : {}
  }
  async open(options: OpenOptions): Promise<WorkerSession> {
    const conn = this.connect()
    let creating = false
    try {
      await conn.ready
      // Match workflow agents: turn off user MCP servers individually; never replace the global configuration.
      const configured = object(object(await conn.call('config/read', { includeLayers: false, cwd: options.cwd })).config).mcp_servers
      const config = Object.fromEntries(Object.keys(object(configured)).map(name => [`mcp_servers.${name}.enabled`, false]))
      const route = this.route(options.model)
      creating = true
      const response = object(await conn.call('thread/start', { cwd: options.cwd, approvalPolicy: 'never', sandbox: 'workspace-write',
        ...route, config: { ...config, ...route.config }, ...(options.instructions ? { developerInstructions: options.instructions } : {}),
        ...(options.parentThreadId ? { elpisParentThreadId: options.parentThreadId } : {}) }))
      const threadId = string(object(response.thread).id)
      if (!threadId) throw new Error('The runtime did not return a session ID')
      this.connections.set(threadId, conn)
      this.watch(conn, threadId)
      // Naming is cosmetic: a failed name must not lose the created session's durable binding.
      await conn.call('thread/name/set', { threadId, name: options.name }).catch(() => {})
      return { threadId, activeTurn: null, model: string(response.model) ?? options.model?.model ?? null, messages: [] }
    } catch (error) {
      if (![...this.connections.values()].includes(conn)) conn.close()
      const failure = error instanceof Error ? error : new Error(String(object(error).message ?? error))
      throw Object.assign(failure, { creationUnknown: creating && (typeof object(error).code !== 'number' || !!object(error).connectionClosed) })
    }
  }
  async read(threadId: string): Promise<WorkerSession> {
    const conn = await this.connection(threadId)
    const response = object(await conn.call('thread/read', { threadId, includeTurns: true }))
    const thread = object(response.thread), turns: unknown[] = []
    // Always walk history, including pages older than the renderer's initial window.
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = object(await conn.call('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }))
      if (!Array.isArray(page.data)) throw new Error('The runtime did not return session history')
      for (const raw of page.data) {
        const turn = object(raw), items = Array.isArray(turn.items) ? [...turn.items] : []
        let itemCursor = string(object(turn.itemsPage).nextCursor)
        const itemSeen = new Set<string>()
        while (itemCursor) {
          if (itemSeen.has(itemCursor)) throw new Error('The runtime repeated a history page')
          itemSeen.add(itemCursor)
          const page = object(await conn.call('thread/items/list', { threadId, turnId: turn.id, cursor: itemCursor, limit: 100 }))
          if (!Array.isArray(page.data)) throw new Error('The runtime did not return message history')
          items.push(...page.data); itemCursor = string(page.nextCursor)
        }
        turns.push({ ...turn, items })
      }
      cursor = string(page.nextCursor)
      if (cursor && seen.has(cursor)) throw new Error('The runtime repeated a history page')
      if (cursor) seen.add(cursor)
    } while (cursor)
    const active = turns.find(turn => object(turn).status === 'inProgress')
    const completed = turns.find(turn => object(turn).status === 'completed')
    const items = object(completed).items
    const final = Array.isArray(items) ? items.findLast(item => object(item).type === 'agentMessage' && object(item).phase !== 'commentary') : undefined
    const text = string(object(final).text), id = string(object(completed).id)
    return { threadId, activeTurn: string(object(active).id) ?? null, model: string(thread.model) ?? string(response.model) ?? null, messages: messages(turns),
      ...(text && id ? { result: { id, text } } : {}) }
  }
  async send(threadId: string, id: string, text: string, activeTurn: string | null, includedIds: readonly string[] = []): Promise<string> {
    const conn = await this.connection(threadId)
    const input = [{ type: 'text', text: `${marker(id, includedIds)}\n${text}`, text_elements: [] }]
    const response = object(await conn.call(activeTurn ? 'turn/steer' : 'turn/start', { threadId, input, ...(activeTurn ? { expectedTurnId: activeTurn } : {}) }))
    const turn = string(object(response.turn).id) ?? string(response.turnId) ?? activeTurn
    if (!turn) throw new Error('The runtime did not acknowledge the turn')
    return turn
  }
  async stop(threadId: string, turnId: string): Promise<void> { const conn = await this.connection(threadId); await conn.call('turn/interrupt', { threadId, turnId }) }
  async background(threadId: string): Promise<{ jobs: { id: string; label: string }[]; children: { id: string }[] }> {
    const conn = await this.connection(threadId)
    const pages = async (method: string, params: object): Promise<Record<string, unknown>[]> => {
      const result: Record<string, unknown>[] = [], seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = object(await conn.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }))
        if (!Array.isArray(page.data)) throw new Error('The runtime did not return background work')
        result.push(...page.data.map(object)); cursor = string(page.nextCursor)
        if (cursor && seen.has(cursor)) throw new Error('The runtime repeated a background page')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return result
    }
    const jobs = await pages('thread/backgroundTerminals/list', { threadId })
    const children = await pages('thread/list', { ancestorThreadId: threadId })
    const liveChildren = await Promise.all(children.map(async child => {
      if (typeof child.id !== 'string') return []
      const status = object(child.status).type
      if (status === 'active') return [{ id: child.id }]
      // A descendant can have ended its turn while its own terminal still runs.
      if (status === 'idle' && (await pages('thread/backgroundTerminals/list', { threadId: child.id })).length) return [{ id: child.id }]
      return []
    }))
    return { jobs: jobs.flatMap(job => typeof job.processId === 'string' ? [{ id: job.processId, label: string(job.command) ?? '' }] : []),
      children: liveChildren.flat() }
  }
  async killJob(threadId: string, processId: string): Promise<void> {
    const conn = await this.connection(threadId)
    const result = object(await conn.call('thread/backgroundTerminals/terminate', { threadId, processId }))
    if (result.terminated !== true) throw new Error(`The runtime did not stop background process ${processId}`)
  }
  private watch(conn: Connection, threadId: string): void {
    const receive = (message: unknown) => { if (object(object(message).params).threadId === threadId) for (const listener of this.watchers.get(threadId) ?? []) listener(message) }
    const closed = (why: string) => { for (const listener of this.watchers.get(threadId) ?? []) listener({ method: 'error', params: { threadId, error: { message: why, connectionClosed: true } } }) }
    conn.listeners.add(receive)
    let live = true
    conn.onClose(why => { if (live) closed(why) })
    const dispose = () => { live = false; conn.listeners.delete(receive); this.disposers.delete(dispose) }
    this.disposers.add(dispose)
  }
  subscribe(threadId: string, listener: (message: unknown) => void): () => void {
    if (!this.connections.has(threadId)) throw new Error('Attach the session before subscribing')
    const watchers = this.watchers.get(threadId) ?? new Set()
    watchers.add(listener); this.watchers.set(threadId, watchers)
    return () => { watchers.delete(listener) }
  }
  close(): void { for (const dispose of this.disposers) dispose(); this.watchers.clear(); for (const conn of this.connections.values()) conn.close(); this.connections.clear() }
}
export class ElpisAdapter extends AppServerAdapter { constructor(connect: () => Connection) { super('elpis', connect) } }
export class CodexAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) { super('codex', connect) }
  protected override route(model: RoleModel | null) { return super.route(model?.provider === 'codex' ? { ...model, provider: 'openai' } : model) }
}
export class ClaudeAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) { super('claude', connect) }
  protected override route(model: RoleModel | null) {
    if (!model) throw new Error('Choose a Claude worker model in router settings')
    return { model: model.model.startsWith('claude/') ? model.model : `claude/${model.model}`, ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}) }
  }
}
export class GeminiAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) { super('gemini', connect) }
  protected override route(model: RoleModel | null) {
    if (!model) throw new Error('Choose a Gemini worker model in router settings')
    return { model: model.model.startsWith('agy/') ? model.model : `agy/${model.model}`, ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}) }
  }
}
export async function runtimeAdapters(options: { url: string; codexBin?: string }): Promise<RuntimeAdapter[]> {
  const source = fileURLToPath(new URL('../../../../../tools/elpis-claude/app-server-connection.mts', import.meta.url))
  const module = existsSync(source) ? source : join(runtimeTools(realpathSync(process.env.ELPIS_ENGINE_BIN ?? join(homedir(), '.local', 'bin', 'elpis-next'))), 'app-server-connection.mts')
  const { connectAppServer }: { connectAppServer: (options: { url?: string | undefined; engineBin?: string | undefined; name: string }) => Connection } =
    await import(pathToFileURL(module).href)
  const bridge = (): Connection => connectAppServer({ url: options.url, engineBin: undefined, name: 'elpis-agents' })
  const codex = (): Connection => connectAppServer({ url: undefined, engineBin: options.codexBin ?? 'codex', name: 'elpis-agents' })
  return [new ElpisAdapter(bridge), new CodexAdapter(codex), new ClaudeAdapter(bridge), new GeminiAdapter(bridge)]
}
