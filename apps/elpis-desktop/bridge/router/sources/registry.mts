// Ported from dsh-superagent (MIT), src/sources/registry.ts
/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.mts'
import type { Commands } from '../infra/commands.mts'
import { HealthBoard, type HealthEntry } from '../infra/health.mts'
import { AdmissionTableSchema, type Settings } from './settings.mts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.mts'


/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  private readonly settings: () => Settings
  private readonly board: Pick<HealthBoard, 'claim'>
  private readonly registered: (kind: SourceKind) => () => void
  constructor(settings: () => Settings, board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    registered: (kind: SourceKind) => () => void = () => () => {}) {
    this.settings = settings
    this.board = board
    this.registered = registered
  }

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as SourceKind)
    const unregistered = this.registered(kind as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).map(kind => ({ ...this.resolve(kind, settings.sources[kind.kind]), installed: true }))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kinds.has(id)).map(([id, stored]) => ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kinds.get(id)
    return kind ? this.resolve(kind, settings.sources[id]) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kinds.get(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string | undefined }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string | undefined }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kinds.get(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kinds.get(channel.source)
    if (!kind) return false
    const instance = this.resolve(kind, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const instance = this.resolve(kind, settings.sources[kind.kind])
      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kinds.get(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kinds.get(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, settings.sources[kind.kind])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kinds.get(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id: kind.kind, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
