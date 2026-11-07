// Ported from dsh-superagent (MIT), src/sources/kind.ts
/** SourceKind plugin contract: configuration schema, UI form fields, policy integration, channel adapter, and thread context reader. */
type Agent = unknown
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.mts'
import type { Deployment } from '../infra/types.mts'
import type { Commands } from '../infra/commands.mts'
import type { SourceContext, SourceHost } from './host.mts'

export interface Localized { zh: string; en: string }
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

export interface VariableSpec { key: string; description: Localized }
export interface EnvironmentInput<C> { deployment: Deployment; config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[]
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: Localized
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  unnamed?: { person: Localized; bot: Localized }
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  images?(text: string): string[]
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string
  title: Localized
  description: Localized
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Health entry names owned by this kind under `health[...]`; no other kind or core loop may report them. */
  health: string[]
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>
  /** Maps a search query to candidate Thread keys (such as `github:12`) and Trigger search terms (such as a Feishu `om_` ID). */
  find?(query: string): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string | undefined }[] }>
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
