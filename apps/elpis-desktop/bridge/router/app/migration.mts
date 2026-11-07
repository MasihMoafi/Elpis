// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
/**
 * Migrates a schema 10 database to schema 11 in a single transaction so runtime readers never convert legacy shapes.
 * Databases older than schema 10 are rejected: this version cannot migrate them.
 */
import { basename } from 'node:path'
import { z } from 'zod'
import { isoTime, said, type AcceptMode, type AdmissionCell, type ChannelRef, type Decision, type Execution, type Follow, type MandateBasis,
  type Reason, type Thread, type Ticket, type TicketInput, type TriggerDisposition } from '../core/index.mts'
// Legacy Feishu URLs are retained as data; Elpis does not run that transport.
const feishuChatLink = (brand: string, chat: string) => `https://${brand === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chat)}`
import { POLL_HORIZON_MS } from '../sources/poll.mts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../policy.mts'
import { autoMergeThreshold, teamDefaults } from './context.mts'
import { PromptConfigSchema, type PromptConfig, type PromptVersion } from './prompts.mts'
import type { EffectKind, EffectPayloads } from '../executor/effects.mts'
import { promptsNotice, settingsNotice, subscriptionNotice } from './notices.mts'
import type { SettingsVersion, Store } from './store.mts'
import { Versions } from './versions.mts'
import { KV, type Key } from '../sources/kv.mts'

export const SCHEMA_VERSION = 11
/** The oldest database schema version this build can open and migrate directly. */
export const OLDEST_SCHEMA = 10
/** Returns an error message explaining why `version` cannot be opened: older schemas need a new state directory. */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`

type Stored = Record<string, unknown>
const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** Runs one migration step, prefixing any thrown error with the name of the record that failed. */
function step<T>(record: string, work: () => T): T {
  try { return work() } catch (error) { throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
/** Rewrite all schema 10 records into their schema 11 shapes in place. */
export function migrateTo11(store: Store): void {
  step('the settings', () => { migrateSettingsRecords(store) })
  step('the prompt versions', () => { migratePrompts(store) })
  const answers = new Map<string, string[]>()
  for (const name of store.keys('answer-ready:')) {
    const [, ticketId, triggerId] = name.split(':')
    if (store.get(name) === true && ticketId && triggerId) answers.set(ticketId, [...answers.get(ticketId) ?? [], triggerId])
  }
  const human = (triggerId: string) => store.triggers.get(triggerId)?.human === true
  const closed = (number: number) => pullEnd(store.get<unknown>(`github-ended:${number}`))
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(ticketOf(JSON.parse(String(row.value)) as Stored, answers, human, closed)) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM decision WHERE json_type(value, '$.mandate') = 'object'").all()) {
    step(`decision ${String(row.id)}`, () => {
      const decision = JSON.parse(String(row.value)) as Decision
      store.decisions.save({ ...decision, mandate: { ...decision.mandate!, basis: basisOf(decision.mandate!.basis as unknown) } })
    })
  }
  for (const thread of store.threads.list()) {
    const evaluating = thread.evaluating
    if (evaluating) step(`thread ${thread.key}`, () => { store.threads.save({ ...thread, evaluating: { ...evaluating, basis: basisOf(evaluating.basis as unknown) } }) })
  }
  step('the Threads\' activity times', () => { backfillThreadTimes(store) })
  // Worker-readable input keys are now prefixed with `ticket/` instead of `task/`; keep any key already written under `ticket/`.
  for (const name of store.keys('task/')) {
    const renamed = `ticket/${name.slice('task/'.length)}`
    if (store.get(renamed) === undefined) store.set(renamed, store.get(name))
    store.delete(name)
  }
  for (const name of DEAD_KEYS.flatMap(prefix => prefix.endsWith(':') ? store.keys(prefix) : [prefix])) store.delete(name)
  // Source read pages, prompt previews, and Feishu message links are now cached in memory instead of SQLite.
  store.db.exec(`DELETE FROM kv WHERE key LIKE 'feishu-read:%' OR key LIKE 'github-read:%' OR key LIKE 'feishu-source-link:%'
    OR key LIKE '%:prompt-preview/%'`)
  queueEarlierWork(store)
  // Convert dropped-message prose reasons into reason codes localized by the panel.
  store.db.exec(`UPDATE outbox SET value = json_set(value, '$.dropped.reason', CASE value ->> '$.dropped.reason'
    WHEN 'The conversation can no longer receive messages' THEN 'channelGone'
    WHEN 'The Source no longer listens to this conversation' THEN 'channelIgnored'
    ELSE value ->> '$.dropped.reason' END) WHERE value -> '$.dropped' IS NOT NULL`)
  step('the outbox', () => { outboxReceipts(store) })
  step('the current settings', () => { settingsAsVersions(store) })
  // Sessions persist the prompt revisions each Session worked under in `KV.sessions.prompts` (`session-prompts:`), which authorizes reads; drop the old `prompt-version-read:` markers.
  store.db.exec("DELETE FROM kv WHERE key LIKE 'prompt-version-read:%'")
  // Schema 6 tables stay in place: schema 7 imported them, but did not import every row.
  step('the Sources\' records', () => { migrateSourceRecords(store) })
  // Worker Sessions now render inputs directly from the ticket record, so standalone input body keys are obsolete.
  step('the Inputs\' bodies', () => { store.db.exec("DELETE FROM kv WHERE key LIKE 'ticket/%/input/%'") })
  step('the pull request ends', () => { dropPullEnds(store) })
  step('the dismissed problems', () => { moveDismissals(store) })
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(withoutCopies(JSON.parse(String(row.value)) as Stored)) })
  }
  step('the reasons', () => { reasonsAsCodes(store) })
  step('the Triggers\' times', () => { triggerTimes(store) })
}
/**
 * Normalize trigger and thread timestamps to fixed-width millisecond ISO strings so lexicographical text order matches
 * chronological order (GitHub wrote whole seconds like `…:00Z`, which sorted after `…:00.001Z`).
 */
function triggerTimes(store: Store): void {
  for (const row of store.db.prepare('SELECT id, at FROM trigger').all()) {
    const at = isoTime(String(row.at))
    if (at !== row.at) store.db.prepare("UPDATE trigger SET at = ?, value = json_set(value, '$.at', ?) WHERE id = ?").run(at, at, String(row.id))
  }
  store.db.exec(`UPDATE trigger_thread SET at = (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)
    WHERE at <> (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)`)
  for (const thread of store.threads.list()) {
    const createdAt = isoTime(thread.createdAt), lastAt = thread.lastAt === undefined ? undefined : isoTime(thread.lastAt)
    if (createdAt === thread.createdAt && lastAt === thread.lastAt) continue
    store.threads.save({ ...thread, createdAt, ...lastAt === undefined ? {} : { lastAt } })
  }
}
/**
 * Obsolete KV keys and prefixes (ending in `:`) from removed `github-issue` eligibility checks, earlier migrations,
 * and pre-schema-11 maintenance and subscription tracking.
 */
const DEAD_KEYS = ['github-object-state:', 'github-issue-eligibility:', 'github-auto-merge:',
  'source-labels-at:', 'legacy-migrated-at', 'thread-times-backfilled', 'settings-before-9', 'answer-ready:', 'prompt-sections', 'prompt-settings-text',
  'prompt-vocabulary', 'subscriptions', 'subscriptions-initialized', 'subscription-seen:', 'subscription-initialized:', 'subscription-since:',
  'observation-since:', 'task-threads:', 'maintenance-recovery:', 'maintenance-progress-report-recovery:', 'maintenance-thread-followup:',
  'master-recovery:', 'github-issue-candidates']

/**
 * Move legacy main-session queues into the unified effect queue in order (relays to steer, then notices for removed
 * subscriptions, saved prompts, and saved settings), then delete the legacy keys.
 */
function queueEarlierWork(store: Store): void {
  const queue = effectQueue(store)
  const { relays, unsubscribed, prompts, settings } = KV.queues
  for (const { id, text } of store.get(relays) ?? []) queue('relay', id, { text })
  const prompt = store.get(prompts), saved = store.get(settings)
  const notices = [...(store.get(unsubscribed) ?? []).map(thread => subscriptionNotice(thread)),
    ...prompt == null ? [] : [promptsNotice(prompt)], ...saved == null ? [] : [settingsNotice()]]
  for (const [name, value, summary] of notices) queue('notice', name, { value, summary })
  for (const name of [relays, unsubscribed, prompts, settings]) store.delete(name)
}

/**
 * Insert effects directly into the database during migration before `Effects` exists, preserving prior failure counts;
 * unlike `Effects.enqueue` (which upserts payload, increments generation, and resets attempts), `INSERT OR IGNORE` leaves an already-queued row for that `kind` and `key` untouched.
 */
function effectQueue(store: Store) {
  let seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  return <K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K], failed = { attempts: 0, error: '' }) =>
    store.db.prepare('INSERT OR IGNORE INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, key, JSON.stringify(payload), ++seq, failed.attempts, failed.error, Date.now(), new Date().toISOString())
}
/**
 * Convert outbox rows into status receipts (`pending`, `sent`, or `dropped`) and enqueue pending messages as `reply`
 * effects in row order, moving their prior `attempts` and `error` onto the effect.
 */
function outboxReceipts(store: Store): void {
  const columns = store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => String(row.name))
  if (!columns.includes('sent')) return
  const queue = effectQueue(store)
  for (const row of store.db.prepare('SELECT id, value, sent FROM outbox ORDER BY rowid').all()) {
    const { attempts, error, nextAttemptAt: _next, ...message } = JSON.parse(String(row.value)) as Stored
    const status = message.dropped ? 'dropped' : row.sent ? 'sent' : 'pending'
    store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(JSON.stringify({ ...message, status }), String(row.id))
    if (status === 'pending') queue('reply', String(row.id), {}, { attempts: Number(attempts ?? 0) || 0, error: typeof error === 'string' ? error : '' })
  }
  store.db.exec('DROP INDEX IF EXISTS outbox_waiting; ALTER TABLE outbox DROP COLUMN sent')
}

/**
 * Ensure the latest settings revision snapshot holds the current settings (saving a new revision if missing or if earlier
 * migration steps stripped a removed Source), then delete the standalone `settings` key.
 */
function settingsAsVersions(store: Store): void {
  const current = store.get<unknown>('settings')
  if (current === undefined) return
  const versions = new Versions<SettingsVersion>(store, KV.settings.revision, KV.settings.version)
  const newest = Math.max(versions.revision(), ...versions.list().map(version => version.revision))
  if (newest) store.set(KV.settings.revision, newest)
  if (JSON.stringify(versions.current()?.settings) !== JSON.stringify(current)) {
    const settings = SettingsSchema.parse(current)
    versions.save(revision => ({ revision, savedAt: new Date().toISOString(), source: 'internal', policyVersion: policyVersion(settings),
      policyChanged: false, notified: [], settings }))
  }
  store.delete('settings')
}

/** Settings save origin names recorded by versions before schema 11, mapped to current `SettingsOrigin` values. */
const ORIGINS: Readonly<Record<string, SettingsOrigin>> = { web: 'panel', 'orchestrator-tool': 'tool', 'policy-sync': 'sync', 'member-sync': 'sync' }
/** Source kinds removed from dsh-superagent; the unified `github` Source now ingests Issues via notifications. */
const REMOVED_SOURCES: readonly string[] = ['github-issue']
/**
 * Upgrade current and historical settings records to the schema 11 structure: strip removed source kinds from active
 * settings while keeping them in historical revisions and mapping historical origin names.
 */
function migrateSettingsRecords(store: Store): void {
  const stored = store.get<unknown>('settings')
  if (stored !== undefined) {
    const settings = SettingsSchema.parse(migrateSettings(stored))
    store.set('settings', { ...settings, sources: Object.fromEntries(Object.entries(settings.sources).filter(([id]) => !REMOVED_SOURCES.includes(id))) })
  }
  // Preserve unparseable historical revisions as-is so a corrupt history entry does not block startup.
  for (const name of store.keys('settings-version:')) {
    const version = store.get<{ source: string; settings: unknown }>(name)!
    const settings = SettingsSchema.safeParse(migrateSettings(version.settings))
    store.set(name, { ...version, source: ORIGINS[version.source] ?? version.source, ...settings.success ? { settings: settings.data } : {} })
  }
}
interface Member { name?: string; feishuId?: string; github?: string }
/**
 * Convert legacy flat settings (chat lists in Policy, top-level pause flag) or pre-schema-11 domain settings into current domain blocks:
 * strips fields replaced by rule instructions and prompts (Executor reviewers and branch prefix, rule `visual` flag, `autoMergeLineLimit`, Source `authority`, GitHub `mergeCli`), extracts `paused` to the top level, and splits cross-source `members` into per-source `policy.sources` entries.
 */
export function migrateSettings(value: unknown): unknown {
  if (!isObject(value)) return value
  if (!('members' in value || 'allowedChats' in value || 'admission' in value)) return withoutRemovedFields(value)
  const old = value as { models?: { orchestrator?: unknown; worker?: unknown }; paused?: boolean; allowedChats?: string[]; members?: unknown[];
    allowDirectMessages?: boolean; pollSeconds?: number; maxWorkers?: number; admission?: { mode?: string; chats?: string[]; timeoutSeconds?: number; rules?: unknown[] } }
  const chats = new Map<string, 'mentions' | 'all'>()
  for (const chatId of old.allowedChats ?? []) chats.set(chatId, 'mentions')
  // Observed chats were active only when admission was enabled.
  if (old.admission?.mode !== 'off') for (const chatId of old.admission?.chats ?? []) chats.set(chatId, 'all')
  const feishu = { chats: [...chats].map(([chatId, listen]) => ({ chatId, listen })), directMessages: old.allowDirectMessages ?? true }
  return withoutRemovedFields({
    sources: { feishu: { enabled: true, config: feishu }, github: { enabled: true, config: { pollSeconds: old.pollSeconds ?? 60 } } },
    policy: { ...(old.members ? { members: old.members } : {}), ...(old.admission?.rules ? { rules: old.admission.rules } : {}) },
    eval: { ...(old.admission?.mode ? { mode: old.admission.mode } : {}), ...(old.admission?.timeoutSeconds ? { timeoutSeconds: old.admission.timeoutSeconds } : {}),
      model: old.models?.orchestrator ?? null },
    executor: { model: old.models?.worker ?? null, ...(old.maxWorkers ? { maxWorkers: old.maxWorkers } : {}), paused: old.paused ?? false },
  })
}
function withoutRemovedFields(value: Stored): Stored {
  const { executor, policy, sources, ...rest } = value as { executor?: Stored; policy?: Stored; sources?: Record<string, Stored> }
  // `paused` is now a top-level setting rather than a field on `executor`.
  const { reviewer: _reviewer, visualReviewer: _visualReviewer, branchPrefix: _branchPrefix, paused, ...kept } = executor ?? {}
  const { members, memberChat, autoMergeLineLimit: _limit, rules: storedRules, ...policyRest } = policy ?? {}
  const rules = Array.isArray(storedRules) ? storedRules.map((rule: unknown) => { if (!isObject(rule)) return rule; const { visual: _visual, ...fields } = rule; return fields })
    : storedRules
  const people = Array.isArray(members) ? members as Member[] : undefined
  const parts = people ? {
    feishu: { allowed: people.filter(member => member.feishuId).map(member => ({ id: member.feishuId!, ...(member.name ? { name: member.name } : {}) })),
      ...(memberChat ? { syncChat: memberChat } : {}) },
    github: { allowed: people.filter(member => member.github).map(member => ({ id: member.github! })) },
  } : undefined
  // The GitHub Source no longer configures a dedicated merge account; auto-merge policy now lives in prompts.
  const withoutMerge = (id: string, config: unknown) => { if (id !== 'github' || !isObject(config)) return config; const { mergeCli: _mergeCli, ...fields } = config; return fields }
  const instances = sources ? Object.fromEntries(Object.entries(sources).map(([id, instance]) => {
    const { authority: _authority, ...fields } = instance
    return [id, 'config' in fields ? { ...fields, config: withoutMerge(id, fields.config) } : fields]
  })) : undefined
  // Rewrite environment variable prefixes from the project's earlier names in `prepare` commands.
  if (typeof kept.prepare === 'string') kept.prepare = kept.prepare.replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  return { ...rest, ...(typeof paused === 'boolean' ? { paused } : {}), ...(executor ? { executor: kept } : {}),
    ...(instances ? { sources: instances } : {}),
    ...(policy ? { policy: { ...policyRest, ...(rules ? { rules } : {}), ...(parts ? { sources: parts } : {}) } } : {}) }
}

/** Prompt configuration shape saved before team sections existed, when all sections (including fixed ones) were editable. */
const LegacyPromptConfigSchema = z.object({ shared: z.string(), orchestrator: z.string(), worker: z.string(), guides: z.record(z.string(), z.string()) })
/** Guide names from legacy prompt configurations that are now fixed built-in prompt sections or skills. */
const LEGACY_FIXED = new Set(['cli', 'subscriptions', 'replies', 'reviews', 'dispatch', 'work', 'feishu', 'github'])
/** Tool names used in saved prompts before the domain vocabulary rename, paired with what replaces them now. */
const RENAMED_TOOLS: readonly (readonly [string, string])[] = [
  ['orchestrator_subscription_remove', 'orchestrator_thread_unsubscribe'], ['orchestrator_subscriptions', 'orchestrator_threads'],
  ['orchestrator_create_task', 'orchestrator_route (kind accept)'], ['orchestrator_send_task', 'orchestrator_route (kind attach)'],
  ['orchestrator_reopen_task', 'orchestrator_route (kind attach)'], ['orchestrator_ticket_reopen', 'orchestrator_route (kind attach)'],
  ['orchestrator_stop_task', 'orchestrator_route (kind stop)'], ['orchestrator_ignore_event', 'orchestrator_route (kind ignore)'],
  ['orchestrator_request_status', 'orchestrator_ticket_request_status'], ['orchestrator_inspect_task', 'orchestrator_ticket_inspect'],
  ['orchestrator_observations', 'orchestrator_decisions'], ['orchestrator_event_replay', 'orchestrator_trigger_requeue'],
  ['orchestrator_tasks', 'orchestrator_tickets'], ['orchestrator_assess', 'orchestrator_eval'], ['admission_read', 'orchestrator_eval_read'],
  ['admission_decide', 'orchestrator_eval_decide'],
]
/** Read-only tools replaced by `orchestrator_read <resource>`, mapped to their resource paths. */
const READ_TOOLS: Readonly<Record<string, string>> = { orchestrator_tickets: 'tickets', orchestrator_threads: 'threads', orchestrator_decisions: 'decisions',
  orchestrator_settings_read: 'settings', orchestrator_prompts_read: 'prompts', orchestrator_models: 'models', orchestrator_ticket_inspect: 'ticket/<id>' }
/**
 * Rewrites skill and variable prefixes from the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), replaces retired
 * read tools with `orchestrator_read`, and the four routing tools with `orchestrator_route` and their kind.
 */
const currentNames = (value: string): string => value.replace(/\bdsh-(?:tag|go|freelancer)-/g, 'dsh-superagent-').replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  .replace(/\borchestrator_(?:tickets|threads|decisions|settings_read|prompts_read|models|ticket_inspect)\b/g, name => `orchestrator_read ${READ_TOOLS[name]}`)
  .replace(/\borchestrator_(?:ticket_(accept|attach|stop)|trigger_(ignore))\b/g, (_name, ticket?: string, trigger?: string) =>
    `orchestrator_route (kind ${ticket ?? trigger ?? ''})`)
/** Rewrites a legacy skill body to current tool, argument, resource, section, skill, and variable names. */
function legacyText(value: string): string {
  let result = value
  for (const [from, to] of RENAMED_TOOLS) result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  return currentNames(result.replaceAll('reply_to_event_id', 'reply_to_trigger_id').replace(/\bevent_id\b/g, 'trigger_id').replace(/\btask_id\b/g, 'ticket_id')
    .replaceAll('related_tasks', 'related_tickets').replace(/(?<![\w/-])event\//g, 'trigger/').replace(/(?<![\w/-])task\//g, 'ticket/').replaceAll('<event-id>', '<trigger-id>')
    .replace(/\bguide\/([a-z][a-z0-9-]*)\b/g, (_match, name: string) => LEGACY_FIXED.has(name) ? `the ${name} section` : `skill dsh-superagent-${name}`))
}
/**
 * Upgrade a stored prompt configuration to current sections, tool names, and skill references; legacy configurations take
 * built-in team sections, keep custom guides as skills, and carry any auto-merge line threshold into `delivery`.
 */
function normalize(config: unknown): PromptConfig {
  const legacy = LegacyPromptConfigSchema.safeParse(config)
  const limit = legacy.success ? /fewer than (\d+) lines \(additions plus deletions\)/.exec(legacy.data.guides.work ?? '')?.[1] : undefined
  const current = legacy.success ? { ...teamDefaults, delivery: limit ? teamDefaults.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(Number(limit))) : teamDefaults.delivery,
    skills: Object.fromEntries(Object.entries(legacy.data.guides).filter(([name]) => !LEGACY_FIXED.has(name)).map(([name, body]) => [name, legacyText(body)])) }
    : PromptConfigSchema.parse(config)
  return { communication: currentNames(current.communication), scope: currentNames(current.scope), delivery: currentNames(current.delivery),
    skills: Object.fromEntries(Object.entries(current.skills).map(([name, body]) => [name, currentNames(body)])) }
}
/**
 * Normalize stored prompt revisions to current sections and names (recording original configs under `legacy` when saved
 * before team sections existed or unparseable) and synthesize a new revision for removed settings fields (auto-merge
 * threshold and cross-source member identities) unless an earlier migration already created it.
 */
function migratePrompts(store: Store): void {
  // Preserve original configs on legacy or unparseable revisions, falling back to the last readable config so sessions always have valid prompts.
  const versions = store.keys('prompt-version:').map(name => store.get<PromptVersion & { config: unknown }>(name)!).sort((a, b) => a.revision - b.revision)
  let readable: PromptConfig = { ...teamDefaults, skills: {} }
  for (const version of versions) {
    const legacy = LegacyPromptConfigSchema.safeParse(version.config).success
    let config: PromptConfig
    try { config = normalize(version.config) } catch { config = readable }
    const kept = legacy || config === readable ? { legacy: version.legacy ?? { config: version.config } } : {}
    store.set(`prompt-version:${version.revision}`, { ...version, config, ...kept })
    readable = config
  }
  if (store.get('prompt-settings-text') === 1) return
  const before = store.get<unknown>('settings-before-9')
  const policy = (isObject(before) ? before.policy : undefined) as { autoMergeLineLimit?: unknown; members?: unknown } | undefined
  const limit = typeof policy?.autoMergeLineLimit === 'number' ? policy.autoMergeLineLimit : 200
  const mapped = ((Array.isArray(policy?.members) ? policy.members : []) as Member[]).filter(person => person.feishuId && person.github)
  const revision = store.get<number>('prompt-revision')
  const current = revision === undefined ? undefined : store.get<PromptVersion>(`prompt-version:${revision}`)
  const config = current?.config ?? { ...teamDefaults, skills: {} }
  const delivery = config.delivery.includes(autoMergeThreshold(200)) ? config.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(limit))
    : limit === 200 ? config.delivery : `${config.delivery}\nEnable auto-merge only on a PR that changes fewer than ${limit} lines (additions plus deletions).`
  const identities = mapped.length && !config.skills.identities ? { identities: ['The same colleague may use a different account on each Source. When you mention, assign or request a review from someone you met on another Source, use their account on this one:',
    ...mapped.map(person => `- ${person.name ?? person.feishuId} (Feishu ${person.feishuId}) is @${person.github} on GitHub`)].join('\n') } : {}
  const next = { ...config, delivery, skills: { ...config.skills, ...identities } }
  if (JSON.stringify(next) === JSON.stringify(config)) return
  const previous = current?.revision ?? 0
  if (!current) store.set('prompt-version:0', { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config })
  store.set(`prompt-version:${previous + 1}`, { revision: previous + 1, previousRevision: previous, savedAt: new Date().toISOString(), source: 'settings-migration', config: next })
  store.set('prompt-revision', previous + 1)
}

const CELLS: readonly string[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
/**
 * Upgrade a legacy mandate basis object to the current tagged union shape.
 * Current bases recorded `source` and `scope`; older ones recorded a Feishu chat directly (`chatId`) or schema 6's `legacyAuthority`.
 * A basis with neither an admission table cell nor `followup` came from a listed sender (`addressed` when it recorded `addressed`, `sender`, and `source`, else `listed`), which holds while the sender remains listed.
 */
export function basisOf(stored: unknown): MandateBasis {
  // Missing or non-object bases default to a listed-sender basis (`via: 'listed'`).
  const old = isObject(stored) ? stored : {}
  if (typeof old.via === 'string') return old as Stored & MandateBasis
  // Older Feishu bases recorded `chatId` and `direct` at the top level instead of inside `scope`.
  const chat = text(old.chatId) ? { source: 'feishu', scope: { chatId: old.chatId, direct: old.direct === true } } : {}
  const received = text(old.source) ? { source: old.source as string, ...isObject(old.scope) ? { scope: old.scope } : {}, ...text(old.row) ? { row: old.row as string } : {} } : chat
  const sender = text(old.sender) ?? text(old.member)
  const common = { ...received, ...sender ? { sender } : {}, ...Array.isArray(old.rules) ? { rules: old.rules as string[] } : {} }
  const addressed = old.addressed === 'mention' || old.addressed === 'direct' ? old.addressed
    : old.direct === true ? 'direct' as const : old.mention === true ? 'mention' as const : undefined
  const mode = text(old.mode) as AcceptMode | undefined
  // Schema 6 imports recorded `legacyAuthority`.
  const authority = text(old.legacyAuthority) ? { authority: old.legacyAuthority as string } : {}
  if (old.followup === true) return { via: 'followup', ...common, ...authority }
  if (CELLS.includes(String(old.admission))) {
    return { via: 'admission', ...common, cell: old.admission as AdmissionCell, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: { mode: mode ?? 'auto' } } : {} }
  }
  if (addressed && sender && text(old.source)) return { via: 'addressed', ...common, addressed }
  // Any basis with neither a table cell nor `followup` came from a listed sender.
  return { via: 'listed', ...common, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: mode ? { mode } : {} } : {}, ...authority }
}
/**
 * Upgrade a schema 10 ticket record to schema 11: extracts `origin`, `execution`, `delivery`, and followed PR threads
 * (`follows`) from `meta` and GitHub opener channels, merges reported `answers`, marks human trigger inputs (`human: true`),
 * and converts pending `reopen` inputs into `text` inputs for the worker.
 */
export function ticketOf(old: Stored, answers = new Map<string, string[]>(), human: (triggerId: string) => boolean = () => false,
  closed: (number: number) => Follow['closed'] = () => undefined): Ticket {
  const { meta: storedMeta, ...rest } = old as Stored & Ticket & { meta?: Stored }
  const ticket = rest
  const meta = storedMeta ?? {}
  const triggerId = text(meta.sourceTriggerId) ?? ''
  const triggerIds = Array.isArray(meta.triggerIds) ? meta.triggerIds as string[] : triggerId ? [triggerId] : []
  const directory = text(meta.workspace)
  // Remaining `meta` fields are obsolete: schema 6 task states stay in the `task` table, and accept fields live on `execution` and `mandate`.
  const execution: Execution | undefined = directory ? { name: text(meta.name) ?? basename(directory), directory,
    assignment: text(meta.assignment) ?? text(meta.legacyPrompt) ?? '' } : undefined
  const inputs = ticket.inputs.map((input): TicketInput => input.kind === 'trigger' ? { ...input, ...human(input.triggerId) ? { human: true } : {} }
    : input.kind !== 'reopen' || !ticket.undelivered.includes(input.id) ? input
    : { id: input.id, kind: 'text', at: input.at, text: JSON.stringify({ resumed: true, decision_id: input.decisionId, read: `ticket/${ticket.id}/assignment`,
      note: 'This ticket ended earlier and a follow-up resumed it under the same mandate. Inspect the worktree, git history and PR state before continuing; do not repeat completed external operations.' }) })
  const reported = [...new Set([...ticket.answers ?? [], ...answers.get(ticket.id) ?? []])]
  const ended = ticket.ended && { ...ticket.ended, outcome: ticket.ended.outcome ?? outcomeOf(ticket.ended) }
  const mandate = { ...ticket.mandate, basis: basisOf(ticket.mandate.basis as unknown) }
  const delivery = ticket.delivery ?? (text(meta.deliveryError) ? { error: meta.deliveryError as string, at: ticket.updatedAt } : undefined)
  const kept = execution ?? ticket.execution
  const follows = ticket.follows ?? followsOf(meta, ticket.channels, closed)
  return { ...ticket, inputs, ...ended ? { ended } : {}, mandate, origin: ticket.origin ?? { triggerId, triggerIds },
    // A ticket stopped by a person receives no further work, so clear any undelivered inputs.
    ...ended?.by === 'human' ? { undelivered: [] } : {},
    ...kept ? { execution: kept } : {}, ...delivery ? { delivery } : {},
    channels: ticket.channels.filter(channel => !opener(channel)), ...follows.length ? { follows } : {},
    ...reported.length ? { answers: reported } : {} }
}
/** Schema 10 recorded a PR opened by the ticket as a GitHub Channel without a comment URL (`address.url`). */
const opener = (channel: ChannelRef): boolean => channel.source === 'github' && !channel.address.url && !!Number(channel.address.number)
/**
 * Reconstruct followed PR threads from legacy ticket metadata (`meta.prNumber` last, after PRs opened via GitHub opener
 * channels), marking opened PRs `own: true` and attaching recorded close outcomes.
 */
function followsOf(meta: Stored, channels: ChannelRef[], closed: (number: number) => Follow['closed']): Follow[] {
  const opened = channels.filter(opener).map(channel => Number(channel.address.number))
  const bound = typeof meta.prNumber === 'number' ? [meta.prNumber] : []
  return [...new Set([...opened.filter(number => !bound.includes(number)), ...bound])].map(number => {
    const end = closed(number)
    return { thread: `github:${number}`, own: opened.includes(number), ...end ? { closed: end } : {} }
  })
}
/** Parse a schema 10 `github-ended:<number>` record into a followed PR's `closed` state when valid. */
function pullEnd(stored: unknown): Follow['closed'] {
  if (!isObject(stored) || typeof stored.at !== 'string' || (stored.reason !== 'merged' && stored.reason !== 'closed')) return undefined
  return { at: stored.at, outcome: stored.reason }
}
/**
 * Strip redundant fields stored twice on legacy tickets: removes `state` (derived from `ended`), moves top-level `summary`
 * onto the latest Assignment as a `progress` report when no Assignment has a report, and removes `execution.session` and
 * per-Assignment `ticketId` and `ref` (derived from `ticket.id`).
 */
export function withoutCopies(old: Stored): Ticket {
  const { state, summary, ...ticket } = old as Stored & Ticket & { state?: string; summary?: unknown }
  const assignments = ticket.assignments.map(item => {
    const { ticketId: _ticket, ref: _ref, ...rest } = item as typeof item & { ticketId?: string; ref?: string }
    return rest
  })
  const latest = assignments.at(-1)
  if (latest && typeof summary === 'string' && summary && !assignments.some(item => item.report)) {
    latest.report = { state: 'progress', summary, at: ticket.updatedAt }
  }
  const { session: _session, ...execution } = (ticket.execution ?? {}) as Partial<Execution> & { session?: string }
  // An open ticket has no `ended` record; a ticket marked `ended` without one defaults to `closed`.
  const closed = { at: ticket.updatedAt, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }
  const ended = state === 'open' ? undefined : ticket.ended ?? (state === 'ended' ? closed : undefined)
  const { ended: _ended, ...rest } = ticket
  // Retain `ended.reason` only when it differs from `ended.outcome`, and drop duplicate end reasons from assignments stopped by that end.
  const { reason, ...end } = ended ?? {} as NonNullable<Ticket['ended']>
  const once = ended && { ...end, ...reason && reason !== ended.outcome ? { reason } : {} } as NonNullable<Ticket['ended']>
  for (const item of assignments) if (ended && item.endedReason === reason && item.endedAt === ended.at) delete item.endedReason
  return { ...rest, ...once ? { ended: once } : {}, assignments, ...ticket.execution ? { execution: execution as Execution } : {} }
}
/** Fixed English reason sentences written by versions before schema 11, mapped to their current reason codes. */
const SENTENCES: Readonly<Record<string, string>> = {
  'Assessment timed out': 'timeout', 'Assessment interrupted or timed out': 'timeout',
  'Assessment interrupted, timed out or ended without a decision': 'timeout',
  'Policy changed during assessment': 'policyChanged', 'Access or rule version changed': 'policyChanged',
  'No admissible trigger': 'noAdmissible', 'Explicit member request routed by the orchestrator': 'explicitRouted',
  'Explicit request from an allowed sender routed by the orchestrator': 'explicitRouted',
  'Imported from the pre-domain-model task record': 'legacyImport', 'host restarted': 'hostRestarted', 'Human asked to stop': 'humanStop',
  'Forwarded to the existing topic worker': 'forwarded', 'Sender is not an authorized human member': 'senderNotMember',
  'Retried by a person': 'retried', 'Stop target is unknown or already ended': 'stopUnknown',
  'Stop requires an explicit instruction from an authorized member': 'stopNotExplicit',
  'Implementation intent or target direction is not established, or a product/design decision is still required': 'directionUnsettled',
  'No enabled admission rule matched': 'noRuleMatched',
}
/** Parse a legacy reason string into a `Reason` when it matches a fixed sentence in `SENTENCES`, a parameterized sentence (`routed`, `startedTicket`, `observed`), or a snake_case gate/source code. */
function knownReason(text: string): Reason | undefined {
  if (SENTENCES[text]) return { code: SENTENCES[text] }
  const routed = /^Routed to ticket (\S+)$/.exec(text) ?? /^Already accepted as ticket (\S+)$/.exec(text)
  if (routed) return { code: text.startsWith('Routed') ? 'routed' : 'startedTicket', values: { ticket: routed[1]! } }
  const observed = /^Observe mode: would accept \((.*)\)$/s.exec(text)
  if (observed) return { code: 'observed', values: { text: observed[1]! } }
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? { code: text } : undefined
}
/**
 * Parse a stored Decision reason into structured `Reason` codes: splits `<triggerId>: <reason>` batches joined by `; `
 * into per-Trigger reasons, maps known sentences/codes via `knownReason`, and wraps any other free-form assessor or human
 * text with `said`.
 */
export function reasonsOf(stored: unknown): Reason[] {
  if (Array.isArray(stored)) return stored as Reason[]
  const text = typeof stored === 'string' ? stored : ''
  const parts = text.split('; ').map(part => /^([^:\s]+): (.+)$/s.exec(part))
  if (parts.every(match => match && knownReason(match[2]!))) return parts.map(match => ({ ...knownReason(match![2]!)!, triggerId: match![1]! }))
  return [knownReason(text) ?? said(text)]
}
/** Convert stored decision, disposition, and assignment end reasons from free-form strings to reason codes. */
function reasonsAsCodes(store: Store): void {
  for (const row of store.db.prepare('SELECT value FROM decision').all()) {
    const decision = JSON.parse(String(row.value)) as Decision & { reason: unknown }
    store.decisions.save({ ...decision, reason: reasonsOf(decision.reason) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM disposition WHERE json_type(value, '$.filtered') = 'text'").all()) {
    const disposition = JSON.parse(String(row.value)) as TriggerDisposition & { filtered: string }
    store.triggers.saveDisposition(String(row.id), { ...disposition, filtered: { code: SENTENCES[disposition.filtered] ?? disposition.filtered } })
  }
  for (const ticket of store.tickets.list()) {
    const ended = (reason?: string) => reason && SENTENCES[reason] === 'retried' ? 'retried' : reason && SENTENCES[reason] === 'hostRestarted' ? 'hostRestarted' : reason
    if (!ticket.assignments.some(item => item.endedReason !== ended(item.endedReason))) continue
    const assignments = ticket.assignments.map(item => item.endedReason ? { ...item, endedReason: ended(item.endedReason)! } : item)
    store.tickets.save({ ...ticket, assignments })
  }
}
/** Move `problem-dismissed:<decisionId>` KV flags onto their corresponding `Decision.dismissed` fields and delete the KV keys. */
function moveDismissals(store: Store): void {
  for (const name of store.keys('problem-dismissed:')) {
    const decision = store.decisions.get(name.slice('problem-dismissed:'.length))
    if (decision && store.get<unknown>(name) === true) store.decisions.save({ ...decision, dismissed: true })
    store.delete(name)
  }
}
/** Delete `github-ended:<number>` KV records after their close outcomes have been copied onto `Ticket.follows`. */
function dropPullEnds(store: Store): void {
  for (const name of store.keys('github-ended:')) store.delete(name)
}
/** Infer a ticket's `ended.outcome` when predating recorded outcomes (`stopped` for human stops, else matching `reason` or defaulting to `closed`). */
function outcomeOf(ended: Pick<NonNullable<Ticket['ended']>, 'by' | 'reason'>): NonNullable<Ticket['ended']>['outcome'] {
  if (ended.by === 'human') return 'stopped'
  return (['completed', 'merged', 'closed', 'dropped'] as const).find(outcome => outcome === ended.reason) ?? 'closed'
}
/** Backfill thread creation and activity timestamps from their earliest and latest triggers. */
function backfillThreadTimes(store: Store): void {
  if (store.get('thread-times-backfilled')) return
  for (const thread of store.threads.list()) {
    const first = store.read.firstTrigger(thread.key), last = store.read.threadTriggers(thread.key, 1)[0]
    if (!first || !last) continue
    const times: Pick<Thread, 'createdAt' | 'lastAt'> = { createdAt: first.at < thread.createdAt ? first.at : thread.createdAt,
      lastAt: !thread.lastAt || last.at > thread.lastAt ? last.at : thread.lastAt }
    store.threads.save({ ...thread, ...times })
  }
}

/** Upgrade stored source state (Feishu topics, direct-chat flags, thread links, GitHub cursors, and pending assessments) to schema 11. */
function migrateSourceRecords(store: Store): void {
  feishuTopics(store)
  feishuDirectAddresses(store)
  feishuThreadLinks(store)
  issueSourceRecords(store)
  githubCursors(store)
  assessmentTriggers(store)
}
/** Convert legacy Feishu topic ID arrays into maps keyed by topic ID with the chat's last recovery timestamp. */
function feishuTopics(store: Store): void {
  for (const name of store.keys(KV.feishu.topics)) {
    const topics: unknown = store.get(name)
    if (!Array.isArray(topics)) continue
    const seen = store.get(KV.feishu.history(name.slice(KV.feishu.topics.prefix.length))) ?? new Date().toISOString()
    store.set(name, Object.fromEntries(topics.map(id => [String(id), seen])))
  }
}
/**
 * Backfill `direct: 'true'` onto Feishu channel addresses from `KV.feishu.chats`, because Feishu `oc_` chat IDs do not
 * distinguish direct messages from group chats on their own.
 */
function feishuDirectAddresses(store: Store): void {
  const chats = store.get(KV.feishu.chats) ?? {}
  const direct = (channel: unknown): channel is ChannelRef => isObject(channel) && channel.source === 'feishu' && isObject(channel.address)
    && chats[String(channel.address.chatId)] === true && channel.address.direct === undefined
  const marked = (channel: ChannelRef): ChannelRef => direct(channel)
    ? { ...channel, address: { ...channel.address, direct: 'true' } } : channel
  for (const table of ['trigger', 'outbox'] as const) {
    for (const row of store.db.prepare(`SELECT id, value FROM ${table} WHERE value ->> '$.channel.source' = 'feishu'`).all()) {
      const value = JSON.parse(String(row.value)) as Stored
      if (!direct(value.channel)) continue
      const rewritten = JSON.stringify({ ...value, channel: marked(value.channel) })
      store.db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(rewritten, row.id!)
    }
  }
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    const ticket = JSON.parse(String(row.value)) as Ticket
    if (ticket.channels.some(direct)) store.tickets.save({ ...ticket, channels: ticket.channels.map(marked) })
  }
}
/** Backfill chat URLs onto Feishu threads created before threads stored their own URL, inferring the brand from existing trigger URLs. */
function feishuThreadLinks(store: Store): void {
  const lark = store.db.prepare(`SELECT 1 FROM trigger WHERE value ->> '$.source' = 'feishu'
    AND value ->> '$.url' LIKE '%larksuite.com%' LIMIT 1`).get()
  for (const thread of store.threads.list()) {
    if (thread.ref.source !== 'feishu' || typeof thread.meta.url === 'string' || store.read.firstTrigger(thread.key)?.url) continue
    const chatId = thread.ref.id.split(':')[0]
    if (chatId) store.threads.save({ ...thread, meta: { ...thread.meta, url: feishuChatLink(lark ? 'lark' : 'feishu', chatId) } })
  }
}
/**
 * Reassign triggers from the removed `github-issue` source to `github`, schedule a retry from the earliest waiting message
 * within `POLL_HORIZON_MS` on each issue that had pending messages, and delete the obsolete `github-issue` KV keys.
 */
function issueSourceRecords(store: Store): void {
  store.db.exec(`UPDATE trigger SET value = json_set(value, '$.source', 'github') WHERE value ->> '$.source' = 'github-issue'`)
  const pending = store.get('github-issue-pending' as Key<Record<string, { number: number; at: string }>>) ?? {}
  const retries = { ...store.get(KV.github.retries) }
  for (const { number, at } of Object.values(pending)) {
    if (!(Date.now() - Date.parse(at) < POLL_HORIZON_MS)) continue
    const retry = retries[number]
    retries[number] = { ...retry, since: retry && retry.since < at ? retry.since : at, pr: retry?.pr ?? false }
  }
  if (Object.keys(retries).length) store.set(KV.github.retries, retries)
  const kept = ['github-issue-pending', 'github-issues-since', 'github-issues-started-at', ...store.keys('github-issue-eligibility:')]
  for (const name of kept) store.delete(name)
}
/** Consolidate per-issue/PR notification and thread subscription cursors into a single cursor holding the later timestamp. */
function githubCursors(store: Store): void {
  for (const name of [...store.keys('github-thread:'), ...store.keys('thread-since:github:')]) {
    const at = store.get<string>(name as Key<string>)
    const cursor = KV.github.cursor(Number(name.slice(name.lastIndexOf(':') + 1)))
    const current = store.get(cursor)
    if (at && !(current && current >= at)) store.set(cursor, at)
    store.delete(name)
  }
}
/** Attach trigger IDs to pending assessment effects and re-enqueue undelivered active evaluations so their timeout deadlines start. */
function assessmentTriggers(store: Store): void {
  const triggers = new Map(store.threads.active()
    .flatMap(thread => thread.evaluating ? [[thread.evaluating.id, thread.evaluating.triggerIds[0]] as const] : []))
  for (const row of store.db.prepare("SELECT key FROM effect WHERE kind = 'assessment' AND value ->> '$.triggerId' IS NULL").all()) {
    const triggerId = triggers.get(String(row.key))
    const named = JSON.stringify({ triggerId })
    if (triggerId) store.db.prepare("UPDATE effect SET value = ? WHERE kind = 'assessment' AND key = ?").run(named, row.key!)
    else store.db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(row.key!)
  }
  // Re-enqueue active evaluations that predate delivery tracking so delivery starts their timeout deadline instead of leaving the thread stuck.
  let seq = Number(store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  for (const thread of store.threads.active()) {
    const evaluation = thread.evaluating
    if (!evaluation || evaluation.delivered || !evaluation.triggerIds[0]) continue
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('assessment', ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING`)
      .run(evaluation.id, JSON.stringify({ triggerId: evaluation.triggerIds[0] }), ++seq, Date.now(), new Date().toISOString())
  }
}
