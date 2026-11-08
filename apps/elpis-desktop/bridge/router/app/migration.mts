import { migrateSourceRecords } from './legacy-sources.mts';
import { migrateSettingsRecords, migratePrompts } from './legacy-settings.mts';
export { migrateSettings } from './legacy-settings.mts'
import { basisOf, ticketOf, pullEnd, withoutCopies, SENTENCES, reasonsOf } from './legacy-tickets.mts';
export { basisOf, ticketOf, withoutCopies, reasonsOf } from './legacy-tickets.mts'
import { step } from './legacy-values.mts';
import type { Stored } from './legacy-values.mts';
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
/**
 * Migrates a schema 10 database to schema 11 in a single transaction so runtime readers never convert legacy shapes.
 * Databases older than schema 10 are rejected: this version cannot migrate them.
 */

import { isoTime, type Decision, type Thread, type TriggerDisposition } from '../core/index.mts';

import { SettingsSchema, policyVersion } from '../policy.mts';

import type { EffectKind, EffectPayloads } from '../executor/effects.mts';
import { promptsNotice, settingsNotice, subscriptionNotice } from './notices.mts';
import type { SettingsVersion, Store } from './store.mts';
import { Versions } from './versions.mts';
import { KV } from '../sources/kv.mts';

export const SCHEMA_VERSION = 11
/** The oldest database schema version this build can open and migrate directly. */
export const OLDEST_SCHEMA = 10
/** Returns an error message explaining why `version` cannot be opened: older schemas need a new state directory. */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`
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
