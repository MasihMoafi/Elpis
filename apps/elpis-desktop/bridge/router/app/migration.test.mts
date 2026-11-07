// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/migration.spec.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, it } from 'node:test'
import { expect } from 'expect'
import { SCHEMA_VERSION, Store } from './store.mts'
import { KV } from '../sources/kv.mts'
import { basisOf, reasonsOf, withoutCopies } from './migration.mts'
import { Prompts, composePrompt, defaultPrompts } from './prompts.mts'
import { masterPrompt } from './context.mts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-migration-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** Seed a SQLite database in the schema 10 layout (including the legacy `outbox.sent` column and `inbox` table). */
function schema10(path: string, records: Record<string, unknown>, rows: { ticket?: object[]; decision?: object[]; thread?: object[]; trigger?: object[] } = {}): void {
  new Store(path).close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE outbox; CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)')
  const set = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  set('schema', 10)
  for (const [name, value] of Object.entries(records)) set(name, value)
  for (const ticket of rows.ticket ?? []) db.prepare('INSERT INTO ticket VALUES (?,?)').run((ticket as { id: string }).id, JSON.stringify(ticket))
  for (const decision of rows.decision ?? []) {
    const { id, threadKey } = decision as { id: string; threadKey: string }
    db.prepare('INSERT INTO decision VALUES (?,?,?)').run(id, threadKey, JSON.stringify(decision))
  }
  for (const thread of rows.thread ?? []) db.prepare('INSERT INTO thread VALUES (?,?)').run((thread as { key: string }).key, JSON.stringify(thread))
  for (const trigger of rows.trigger ?? []) {
    const { id, at } = trigger as { id: string; at: string }
    db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(id, JSON.stringify(trigger), at)
  }
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
}
const actor = { source: 'feishu', id: 'ou_alice' }
const mandate = (basis: object) => ({ strength: 'explicit', policyVersion: 'v1', basis, actor, scope: 'small' })

it('refuses a database older than schema 10 and asks for a new state directory', () => {
  const path = join(directory, 'db.sqlite')
  new Store(path).close()
  const schema = (version: number) => { const db = new DatabaseSync(path); db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version)); db.close() }
  schema(9)
  expect(() => new Store(path)).toThrow(/schema 9 predates schema 10, which this version cannot migrate; start with a new state directory/)
})

it('writes a schema 10 database in its current shape once, so nothing reads an older shape', () => {
  const path = join(directory, 'db.sqlite')
  const ticket = {
    id: 't1', title: 'Fix', decisionId: 'd1', state: 'open', assignments: [], summary: '', createdAt: '1', updatedAt: '2',
    // In schema 10, a GitHub Channel without a comment link marked a PR that the ticket opened.
    channels: [{ source: 'github', thread: 'github:8', address: { number: '8' } }, { source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    mandate: mandate({ chatId: 'oc_team', direct: false, member: 'ou_alice', mention: true }),
    inputs: [{ id: 'i1', kind: 'reopen', decisionId: 'd2', at: '3' }, { id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' },
      { id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4' }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }], undelivered: ['i1'],
    meta: { sourceTriggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.',
      prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', branch: 'agent/fix-1', deliveryError: 'offline', recovery: 2, worktreeName: 'fix', scope: 'small' },
  }
  const imported = { ...ticket, id: 't2', state: 'ended', channels: [], inputs: [], undelivered: [], mandate: mandate({ legacyAuthority: 'thread_followup', followup: true }),
    meta: { sourceTriggerId: 'old', workspace: '/w/task-2', sessionId: 'worker-task-2', legacyPrompt: 'Read event/old' },
    ended: { at: '6', by: 'executor', reason: 'merged' } }
  // Ended with a person's message waiting, and with no execution or origin trigger.
  const waiting = { ...ticket, id: 't3', state: 'ended', channels: [], ended: { at: '6', by: 'human', reason: 'Not needed' }, inputs: [{ id: 'i5', kind: 'trigger', triggerId: 'trig-2', at: '7' }],
    undelivered: ['i5'], mandate: mandate({ chatId: 'p2p', direct: true, member: 'ou_alice' }), meta: {} }
  const bare = { ...ticket, id: 't4', channels: [], inputs: [], undelivered: [], meta: undefined }
  const reopened = { id: 'd2', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'reopen', reason: 'follow-up', at: '3', ticketId: 't1', policyVersion: 'v1' }
  const unavailable = { id: 'd3', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'unavailable', reason: 'Assessment timed out', at: '5', policyVersion: 'v1' }
  const triggers = [{ id: 'trig-2', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '4', text: 'more', meta: {} },
    { id: 'ci-1', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'ci' }, human: false, at: '5', text: 'CI', meta: {} }]
  const decision = { id: 'd1', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-1'], kind: 'accept', reason: '', at: '1', ticketId: 't1', policyVersion: 'v1',
    mandate: mandate({ legacyAuthority: 'proactive_rule', observation: true, rules: ['copy'] }) }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['x'], strength: 'inferred', actor, policyVersion: 'v1', startedAt: '', deadline: '',
    basis: { source: 'github', scope: { number: 5 }, row: 'issues', admission: 'listedUnaddressed', observation: true, mode: 'auto' } }
  const thread = { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }
  schema10(path, {
    settings: { policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'x', visual: true }] }, executor: { reviewer: 'bob', prepare: 'echo $DSH_TAG_DIR' },
      sources: { 'github-issue': { enabled: true, config: {} }, github: { enabled: true, config: { mergeCli: 'gh' } } } },
    'settings-version:1': { revision: 1, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [],
      settings: { allowedChats: ['oc_team'], members: [], sources: undefined } },
    'settings-version:2': { revision: 2, savedAt: '', source: 'orchestrator-tool', policyVersion: '', policyChanged: false, notified: [],
      settings: { sources: { 'github-issue': { enabled: true, config: {} } } } },
    'prompt-revision': 1,
    'github-ended:8': { at: '2026-09-01T00:00:00Z', reason: 'merged' },
    'problem-dismissed:d3': true,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config: { shared: 's', orchestrator: 'o', worker: 'w', guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    'prompt-settings-text': 1,
    'task/t1/input/i0': '{"text":"old input"}',
    'task/t1/input/i9': '{"text":"older copy"}', 'ticket/t1/input/i9': '{"text":"kept"}',
    'settings-version:3': { revision: 3, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings: { executor: { maxWorkers: 'many' } } },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { communication: 1 } },
    'answer-ready:t1:trig-3': true,
    'github-object-state:7': 'open', subscriptions: [], 'settings-before-9': { policy: {} }, 'thread-times-backfilled': true,
    'github-issue-pending': { 1: {} },
    // Caches of reads, which memory keeps now.
    'feishu-read:orchestrator-1:feishu/e1/thread': '{}', 'github-read:worker-t1:github/pulls/7': '{}', 'feishu-source-link:oc_team:om_1': 'https://x',
    'orchestrator-1:prompt-preview/abc': 'prompt',
  }, { ticket: [ticket, imported, waiting, bare], decision: [decision, reopened, unavailable], thread: [thread], trigger: triggers })

  const store = new Store(path)
  expect(store.get('schema')).toBe(SCHEMA_VERSION)
  const settings = store.settings()
  expect(Object.keys(settings.sources)).toEqual(['github'])
  expect(settings.sources.github!.config).not.toHaveProperty('mergeCli')
  expect(settings.policy.rules[0]).not.toHaveProperty('visual')
  expect(settings.executor).not.toHaveProperty('reviewer')
  expect(settings.executor.prepare).toBe('echo $DSH_SUPERAGENT_DIR')
  // The current settings are the newest revision, which the migration saved, since the newest saved one differs from them.
  const [current, , second, first] = store.settingsHistory()
  expect(current).toMatchObject({ revision: 4, source: 'internal', settings })
  expect(store.get('settings')).toBeUndefined()
  expect(first).toMatchObject({ source: 'panel', settings: { sources: { feishu: { config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } } })
  expect(second).toMatchObject({ source: 'tool', settings: { sources: { 'github-issue': { enabled: true } } } })
  expect(store.get('prompt-version:1')).toMatchObject({ legacy: { config: { guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    config: { skills: { release: 'Use the github section and dsh-superagent-feishu.' } } })
  // An invalid historical prompt version keeps its raw value under legacy and falls back to the preceding version's config.
  expect(store.get('prompt-version:2')).toMatchObject({ legacy: { config: { communication: 1 } }, config: store.get<{ config: object }>('prompt-version:1')!.config })
  expect(store.get('settings-version:3')).toMatchObject({ source: 'panel', settings: { executor: { maxWorkers: 'many' } } })
  const migrated = store.tickets.get('t1')!
  expect(migrated).not.toHaveProperty('meta')
  expect(store.keys('github-ended:')).toEqual([])
  expect(store.decisions.get('d3')).toMatchObject({ kind: 'unavailable', dismissed: true })
  expect(store.keys('problem-dismissed:')).toEqual([])
  expect(migrated).toMatchObject({
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'] },
    execution: { name: 'fix-1', directory: '/w/fix-1', assignment: 'Read trigger/trig-1.' },
    delivery: { error: 'offline', at: '2' },
    follows: [{ thread: 'github:8', own: true, closed: { at: '2026-09-01T00:00:00Z', outcome: 'merged' } }, { thread: 'github:7', own: false }],
    channels: [{ source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    answers: ['trig-3'],
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'oc_team', direct: false }, sender: 'ou_alice', addressed: 'mention' } },
  })
  expect(migrated.inputs[0]).toMatchObject({ id: 'i1', kind: 'text', text: expect.stringContaining('"resumed":true') })
  expect(migrated.inputs[0]).not.toMatchObject({ text: expect.stringContaining('reopen') })
  expect(migrated.inputs[1]).toEqual({ id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' })
  expect(migrated.inputs.slice(2)).toEqual([{ id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4', human: true }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }])
  expect(migrated).not.toHaveProperty('execution.recoveries')
  expect(store.tickets.get('t2')).toMatchObject({ execution: { name: 'task-2', assignment: 'Read event/old' },
    mandate: { basis: { via: 'followup', authority: 'thread_followup' } } })
  expect(store.tickets.get('t2')).not.toHaveProperty('follows')
  // An end's reason that only repeats its outcome is not kept.
  expect(store.tickets.get('t2')!.ended).toEqual({ at: '6', by: 'executor', outcome: 'merged' })
  // A ticket a person stopped keeps nothing waiting; a ticket stored without its attributes gets an origin all the same.
  expect(store.tickets.get('t4')).toMatchObject({ origin: { triggerId: '', triggerIds: [] } })
  expect(store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'stopped' }, undelivered: [], origin: { triggerId: '', triggerIds: [] },
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'p2p', direct: true }, sender: 'ou_alice', addressed: 'direct' } } })
  expect(store.tickets.get('t3')).not.toHaveProperty('execution')
  // A reason is a code; words the assessor wrote stay as written.
  expect(store.decisions.get('d2')).toEqual({ ...reopened, reason: [{ code: 'said', values: { text: 'follow-up' } }] })
  expect(store.decisions.get('d3')!.reason).toEqual([{ code: 'timeout' }])
  expect(store.decisions.get('d1')!.mandate!.basis).toEqual({ via: 'listed', rules: ['copy'], observation: {}, authority: 'proactive_rule' })
  expect(store.threads.get('github:5')!.evaluating!.basis).toEqual({ via: 'admission', source: 'github', scope: { number: 5 }, row: 'issues',
    cell: 'listedUnaddressed', observation: { mode: 'auto' } })
  // kv: an Input is rendered from its ticket as it is read, so no body stays; records nothing reads go, and so do the
  // removed Issue Source's, which the migration converted.
  expect(store.get('ticket/t1/input/i0')).toBeUndefined()
  expect(store.get('ticket/t1/input/i9')).toBeUndefined()
  expect(store.keys('task/')).toEqual([])
  for (const name of ['answer-ready:t1:trig-3', 'github-object-state:7', 'subscriptions', 'settings-before-9', 'thread-times-backfilled', 'prompt-settings-text',
    'feishu-read:orchestrator-1:feishu/e1/thread', 'github-read:worker-t1:github/pulls/7', 'feishu-source-link:oc_team:om_1', 'orchestrator-1:prompt-preview/abc']) {
    expect(store.get(name)).toBeUndefined()
  }
  expect(store.get('github-issue-pending')).toBeUndefined()
  // The schema 6 tables stay, with the rows the schema 7 import left out.
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox'").get()).toBeDefined()
  store.close()
  // Migrating the result again changes nothing.
  const db = new DatabaseSync(path)
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  again.close()
})

it('keeps each message as a receipt of what became of it, with why one was dropped by the code the panel words it by', () => {
  const path = join(directory, 'db.sqlite')
  schema10(path, {})
  const db = new DatabaseSync(path)
  const message = (id: string, sent: number, fields: object = {}) => db.prepare('INSERT INTO outbox (id, value, sent) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: id, kind: 'reply', attempts: 2,
      error: 'offline', nextAttemptAt: 1, ...fields }), sent)
  message('gone', 1, { dropped: { at: '2026-09-01T00:00:00.000Z', reason: 'The conversation can no longer receive messages' } })
  message('ignored', 1, { dropped: { at: '2026-09-02T00:00:00.000Z', reason: 'The Source no longer listens to this conversation' } })
  message('sent', 1)
  message('waiting', 0)
  db.close()
  const store = new Store(path)
  expect(store.read.droppedReplies().map(item => [item.id, item.dropped.reason])).toEqual([['ignored', 'channelIgnored'], ['gone', 'channelGone']])
  expect(['gone', 'sent', 'waiting'].map(id => store.replyStatus(id))).toEqual(['dropped', 'sent', 'pending'])
  // A receipt holds no attempts: the message that waits has a `reply` effect, which keeps the ones it had and counts on.
  expect(store.receipts.get('waiting')).toEqual({ id: 'waiting', channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: 'waiting',
    kind: 'reply', status: 'pending' })
  expect(store.db.prepare('SELECT kind, key, attempts, error FROM effect').all()).toEqual([{ kind: 'reply', key: 'waiting', attempts: 2, error: 'offline' }])
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => row.name)).not.toContain('sent')
  store.close()
})

it('changes nothing when one step fails: the database stays at schema 10 as it was', () => {
  const path = join(directory, 'db.sqlite')
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [], inputs: [], undelivered: [], summary: '', createdAt: '1',
    updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1', workspace: '/w/fix-1' } }
  // The current settings must validate; an invalid value aborts the migration transaction.
  schema10(path, { settings: { executor: { maxWorkers: 'many' } } }, { ticket: [ticket] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: the settings: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t1'").get()!.value))).toMatchObject({ meta: { workspace: '/w/fix-1' } })
  db.close()
})

it('reads every basis an earlier gate recorded in the current shape', () => {
  const scope = { chatId: 'oc_1', direct: false }
  expect(basisOf({ source: 'feishu', scope, row: 'oc_1', sender: 'Alice', addressed: 'mention' })).toEqual({ via: 'addressed', source: 'feishu', scope, row: 'oc_1',
    sender: 'Alice', addressed: 'mention' })
  expect(basisOf({ source: 'feishu', scope, followup: true, rules: ['r'] })).toEqual({ via: 'followup', source: 'feishu', scope, rules: ['r'] })
  expect(basisOf({ source: 'feishu', scope, addressed: 'direct', admission: 'unlistedAddressed' })).toEqual({ via: 'admission', source: 'feishu', scope,
    cell: 'unlistedAddressed', addressed: 'direct' })
  // Observed under an earlier gate that recorded no cell: the sender had to be on the list.
  expect(basisOf({ source: 'feishu', scope, sender: 'Alice', observation: true, mode: 'auto', rules: ['r'] })).toEqual({ via: 'listed', source: 'feishu', scope,
    sender: 'Alice', rules: ['r'], observation: { mode: 'auto' } })
  expect(basisOf({ chatId: 'oc_1', direct: true, followup: true, member: 'ou_a' })).toEqual({ via: 'followup', source: 'feishu', scope: { chatId: 'oc_1', direct: true },
    sender: 'ou_a' })
  expect(basisOf({ member: 'ou_a', mention: true })).toEqual({ via: 'listed', sender: 'ou_a', addressed: 'mention' })
  expect(basisOf({ legacyAuthority: 'explicit_mention' })).toEqual({ via: 'listed', authority: 'explicit_mention' })
  expect(basisOf({ via: 'followup' })).toEqual({ via: 'followup' })
})

/** Build a pre-team-sections prompt version where fixed and built-in guides were stored inside the config object. */
const legacyPrompts = (revision: number, guides: Record<string, string> = {}) => ({
  [`prompt-version:${revision}`]: { revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'web',
    config: { shared: 'Legacy shared rule.', orchestrator: 'Legacy orchestrator: only route.', worker: 'Legacy worker.',
      guides: { replies: 'Legacy replies.', dispatch: 'Accept any screenshot.', work: 'Legacy work. Enable auto-merge once it changes fewer than 350 lines (additions plus deletions); and so on.',
        feishu: 'Legacy Feishu skill.', identities: 'Alice is @alice.', ...guides } } },
  'prompt-revision': revision, 'prompt-settings-text': 1,
})
const opened = (records: Record<string, unknown>) => {
  const path = join(directory, `db-${Math.random()}.sqlite`)
  schema10(path, records)
  return new Store(path)
}

it('writes a prompt version saved before the team sections in them, keeping its skills and auto-merge threshold, and marks it', () => {
  const store = opened({ ...legacyPrompts(3, { notes: 'Call orchestrator_create_task with event_id, read event/<id>, follow guide/work and guide/release, load dsh-tag-github, cd "$DSH_TAG_DIR".' }) })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const { config } = prompts.version(3)
  expect(config.communication).toBe(defaultPrompts().communication)
  expect(config.delivery).toContain('it changes fewer than 350 lines (additions plus deletions);')
  expect(config.delivery).not.toContain('fewer than 200 lines')
  // Guides that are now fixed or built-in are gone; the team's own skills stay, in current names.
  expect(Object.keys(config.skills)).toEqual(['identities', 'notes'])
  expect(config.skills.notes).toBe('Call orchestrator_route (kind accept) with trigger_id, read trigger/<id>, follow the work section and skill dsh-superagent-release, load dsh-superagent-github, cd "$DSH_SUPERAGENT_DIR".')
  const prompt = composePrompt(config, 'orchestrator')
  expect(prompt).not.toContain('Legacy orchestrator')
  expect(prompt).toContain(masterPrompt)
  expect(prompts.current().revision).toBe(3)
  // Read as the built-in text, a legacy version says so instead of listing its differences.
  expect(prompts.history(0, 1).revisions.map(version => version.changed)).toEqual([['legacy']])
  store.close()
})

it('writes saved team sections and skills under current names: earlier project names, the tools that became reads and the routing tools', () => {
  const config = { ...defaultPrompts(), delivery: 'Merge with --repo $DSH_FREELANCER_GITHUB_REPOSITORY.',
    skills: { notes: 'Load dsh-freelancer-github; cd "$DSH_FREELANCER_DIR". List with orchestrator_tickets, then orchestrator_ticket_inspect.',
      routing: 'Accept with orchestrator_ticket_accept; stop with orchestrator_ticket_stop, never orchestrator_trigger_ignore.' } }
  const store = opened({ 'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config }, 'prompt-revision': 1, 'prompt-settings-text': 1 })
  const { config: current } = new Prompts(store, () => 100000, () => undefined, () => true).current()
  expect(current.delivery).toBe('Merge with --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY.')
  expect(current.skills.notes).toBe('Load dsh-superagent-github; cd "$DSH_SUPERAGENT_DIR". List with orchestrator_read tickets, then orchestrator_read ticket/<id>.')
  // The four routing tools are one.
  expect(current.skills.routing).toBe('Accept with orchestrator_route (kind accept); stop with orchestrator_route (kind stop), never orchestrator_route (kind ignore).')
  store.close()
})

it('writes the removed auto-merge threshold and member identities into the prompts as one new version, unless an earlier version did', () => {
  const before = { policy: { autoMergeLineLimit: 350, members: [{ name: 'Alice', feishuId: 'ou_alice', github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }] } }
  const store = opened({ 'settings-before-9': before })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const migrated = prompts.current()
  expect(migrated).toMatchObject({ revision: 1, previousRevision: 0, source: 'settings-migration' })
  expect(migrated.config.delivery).toContain('it changes fewer than 350 lines (additions plus deletions);')
  expect(migrated.config.skills.identities).toContain('- Alice (Feishu ou_alice) is @alice on GitHub')
  expect(migrated.config.skills.identities).not.toContain('Bob')
  expect(store.get('settings-before-9')).toBeUndefined()
  store.close()
  // The default threshold and nobody with two identities change nothing; other delivery text gains the threshold as its own sentence.
  const unchanged = opened({ 'settings-before-9': { policy: { members: [{ name: 'Bob', feishuId: 'ou_bob', github: '' }] } } })
  expect(new Prompts(unchanged, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  unchanged.close()
  const own = opened({ 'settings-before-9': { policy: { autoMergeLineLimit: 80 } }, 'prompt-revision': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config: { ...defaultPrompts(), delivery: 'Deliver PRs.' } } })
  expect(new Prompts(own, () => 100000, () => undefined, () => true).current().config.delivery)
    .toBe('Deliver PRs.\nEnable auto-merge only on a PR that changes fewer than 80 lines (additions plus deletions).')
  own.close()
  const done = opened({ 'settings-before-9': before, 'prompt-settings-text': 1 })
  expect(new Prompts(done, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  done.close()
})

it('reads a current prompt version that does not read as the one before it, keeping what it said', () => {
  const config = { ...defaultPrompts(), delivery: 'Deliver PRs.' }
  const store = opened({ 'prompt-revision': 2, 'prompt-settings-text': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { delivery: ['not text'] } } })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  expect(prompts.current()).toMatchObject({ revision: 2, config, legacy: { config: { delivery: ['not text'] } } })
  expect(prompts.history(0, 2).revisions.map(version => version.changed)).toEqual([['legacy'], []])
  store.close()
})

/**
 * Create a raw SQLite database matching the exact table DDL of the last schema 10 release (before working-set columns
 * and the `effect` table were added, and with leftover schema 6 `inbox` and `task` tables).
 */
function lastSchema10(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL, PRIMARY KEY (thread, id));
    CREATE INDEX trigger_at ON trigger(at);
    CREATE INDEX trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX decision_thread ON decision(thread);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const kv = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?)').run(name, JSON.stringify(value))
  kv('schema', 10); kv('master-id', 'orchestrator-1'); kv('settings', { executor: { maxWorkers: 2 } })
  kv('relay-queue', [{ id: 'report:old', text: '{"kind":"worker_report"}' }])
  const trigger = { id: 'trig-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '2026-10-01T00:00:00Z', text: 'fix it', meta: {} }
  db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
  db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,1)').run('feishu:oc_team:om_1', trigger.id, trigger.at)
  const thread = { key: 'feishu:oc_team:om_1', ref: trigger.threads[0], createdAt: trigger.at, subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
  db.prepare('INSERT INTO thread VALUES (?,?)').run(thread.key, JSON.stringify(thread))
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', summary: '', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: mandate({ source: 'feishu', scope: { chatId: 'oc_team' }, sender: 'Alice', addressed: 'mention' }), inputs: [], undelivered: [],
    assignments: [{ id: 'a1', state: 'running', createdAt: trigger.at }],
    meta: { sourceTriggerId: trigger.id, triggerIds: [trigger.id], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.' } }
  db.prepare('INSERT INTO ticket VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
  const reply = { id: 'reply-1', channel: { source: 'feishu', thread: thread.key, address: { chatId: 'oc_team', messageId: 'om_1' } }, text: '收到', kind: 'reply', attempts: 0, error: '' }
  db.prepare('INSERT INTO outbox VALUES (?,?,0)').run(reply.id, JSON.stringify(reply))
  db.prepare('INSERT INTO inbox VALUES (?,?,0)').run('left-out', '{"id":"left-out"}')
  db.close()
}

it('opens a database the last schema 10 build left, adds what this version keeps alongside, and migrates it', () => {
  const path = join(directory, 'db.sqlite')
  lastSchema10(path)
  const store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(store.tickets.active().map(ticket => ticket.id)).toEqual(['t1'])
  expect(store.read.subscribedThreads('feishu').map(thread => thread.key)).toEqual(['feishu:oc_team:om_1'])
  expect(store.tickets.get('t1')).toMatchObject({ origin: { triggerId: 'trig-1' }, execution: { name: 'fix-1', directory: '/w/fix-1' },
    mandate: { basis: { via: 'addressed', addressed: 'mention' } } })
  expect(store.receipts.waiting().map(item => item.id)).toEqual(['reply-1'])
  expect(store.db.prepare('SELECT kind, key, generation FROM effect ORDER BY seq').all()).toEqual([{ kind: 'relay', key: 'report:old', generation: 0 },
    { kind: 'reply', key: 'reply-1', generation: 0 }])
  expect(store.db.prepare('SELECT id FROM inbox').all()).toEqual([{ id: 'left-out' }])
  const migrated = store.tickets.get('t1')
  store.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  expect(again.db.prepare('SELECT COUNT(*) AS n FROM effect').get()).toEqual({ n: 2 })
  again.close()
})
it('writes the Sources\' records in their current shape once, so no Source converts an earlier one when it reads it', () => {
  const path = join(directory, 'db.sqlite')
  const recent = new Date(Date.now() - 3600_000).toISOString()
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['issue'], strength: 'inferred', actor, policyVersion: 'v1',
    startedAt: '',
    deadline: '', basis: { via: 'listed' } }
  schema10(path, {
    'feishu-chats': { oc_dm: true, oc_team: false }, 'feishu-history:oc_team': '2026-09-01T00:00:00.000Z',
    // Earlier versions kept a chat's topics as a list.
    'feishu-history-threads:oc_team': ['omt_old'],
    'github-thread:7': '2026-09-02T00:00:00.000Z', 'thread-since:github:7': '2026-09-03T00:00:00.000Z',
    'github-thread:8': '2026-09-04T00:00:00.000Z',
    'github-issue-pending': { a: { number: 12, at: recent }, b: { number: 13,
      at: '2026-01-01T00:00:00.000Z' } }, 'github-issues-since': 'x',
  }, {
    trigger: [{ id: 'dm', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_dm:om_1' }], actor, human: true,
      at: '2026-09-01T00:00:00Z',
      text: 'fix', channel: dm, meta: {} },
    { id: 'issue', source: 'github-issue', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Login fails', meta: { number: 12 } }],
    thread: [{ key: 'feishu:oc_team:om_9', ref: { source: 'feishu', id: 'oc_team:om_9' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} },
    { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating,
      meta: {} }],
  })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('r1', JSON.stringify({ id: 'r1', channel: dm, text: 'Done', kind: 'reply',
    attempts: 0, error: '' }))
  // Assessments queued before effects named their Trigger: one whose Eval runs, and one whose Eval ended.
  for (const [seq, evalId] of [[1, 'e1'], [2, 'e2']] as const) {
    db.prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)').run('assessment', evalId, '{}', seq, 0,
      '')
  }
  db.close()
  const store = new Store(path)
  expect(store.get(KV.feishu.topics('oc_team'))).toEqual({ omt_old: '2026-09-01T00:00:00.000Z' })
  expect(store.triggers.get('dm')!.channel!.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  expect(store.receipts.waiting()[0]!.channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  expect(store.threads.get('feishu:oc_team:om_9')!.meta.url).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_team')
  expect(store.triggers.get('issue')!.source).toBe('github')
  // The waiting mention within the polling horizon is read again; the older one is no fresh request.
  expect(store.get(KV.github.retries)).toEqual({ 12: { since: recent, pr: false } })
  expect(store.get(KV.github.cursor(7))).toBe('2026-09-03T00:00:00.000Z')
  expect(store.get(KV.github.cursor(8))).toBe('2026-09-04T00:00:00.000Z')
  for (const name of ['github-issue-pending', 'github-issues-since', 'github-thread:7', 'thread-since:github:7', 'github-thread:8']) {
    expect(store.get(name)).toBeUndefined()
  }
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key,
    JSON.parse(String(row.value))])
  expect(effects).toEqual([['e1', { triggerId: 'issue' }]])
  store.close()
})

it('keeps each fact of a ticket once: its end, its latest report, and no worker Session it can derive', () => {
  const base = { id: 't', title: 'Fix', decisionId: 'd', channels: [], inputs: [], undelivered: [], createdAt: '1', updatedAt: '2',
    mandate: mandate({ via: 'listed' }), origin: { triggerId: 'x', triggerIds: ['x'] }, execution: { name: 'fix', directory: '/w', session: 'worker-t', assignment: 'Do it.' } }
  const open = withoutCopies({ ...base, state: 'open', summary: 'Working on it',
    assignments: [{ id: 'a1', ticketId: 't', ref: 'worker-t', state: 'running', createdAt: '1' }] })
  expect(open).toEqual({ ...base, execution: { name: 'fix', directory: '/w', assignment: 'Do it.' },
    assignments: [{ id: 'a1', state: 'running', createdAt: '1', report: { state: 'progress', summary: 'Working on it', at: '2' } }] })
  // A report the ticket had stays the latest one; an ended ticket without an end record ended closed.
  const reported = { id: 'a1', ticketId: 't', ref: '', state: 'ended', createdAt: '1', report: { state: 'ready', summary: 'Done', at: '2' } }
  expect(withoutCopies({ ...base, state: 'ended', summary: 'Done', assignments: [reported] })).toMatchObject({
    ended: { at: '2', by: 'executor', outcome: 'closed' }, assignments: [{ id: 'a1', state: 'ended', report: { summary: 'Done' } }] })
})

it('reads the reasons earlier versions stored in words as codes, and keeps any other words as written', () => {
  expect(reasonsOf('Assessment timed out')).toEqual([{ code: 'timeout' }])
  expect(reasonsOf('a1: not_a_member; b2: no_mention')).toEqual([{ code: 'not_a_member', triggerId: 'a1' }, { code: 'no_mention', triggerId: 'b2' }])
  expect(reasonsOf('Routed to ticket t9')).toEqual([{ code: 'routed', values: { ticket: 't9' } }])
  expect(reasonsOf('Observe mode: would accept (a copy fix)')).toEqual([{ code: 'observed', values: { text: 'a copy fix' } }])
  // An assessor's words may hold a colon or a semicolon; they stay one reason.
  expect(reasonsOf('Not a request: chatter; nothing to do')).toEqual([{ code: 'said', values: { text: 'Not a request: chatter; nothing to do' } }])
  expect(reasonsOf([{ code: 'timeout' }])).toEqual([{ code: 'timeout' }])
})

const ticket10 = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [],
  inputs: [], undelivered: [], summary: '', createdAt: '1', updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1' }, ...fields })
/** Populate `trigger_thread` rows for `triggers` as schema 10 did on save. */
function indexed(path: string, triggers: { id: string; at: string; threads: { source: string; id: string }[] }[]): void {
  const db = new DatabaseSync(path)
  for (const { id, at, threads } of triggers) {
    for (const thread of threads) db.prepare('INSERT INTO trigger_thread VALUES (?, ?, ?, 1)').run(`${thread.source}:${thread.id}`, id, at)
  }
  db.close()
}

it('dates each Thread from its Triggers, and keeps every Trigger\'s time in the one form stored times take', () => {
  const path = join(directory, 'db.sqlite')
  const comment = (id: string, at: string) => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor, human: true, at, text: id, meta: {} })
  // GitHub wrote its times in whole seconds; a Thread a schema 10 build saved before it knew of activity times has none.
  const triggers = [comment('first', '2026-10-01T00:00:00Z'), comment('last', '2026-10-09T00:00:00.000Z')]
  schema10(path, {}, { trigger: triggers,
    thread: [{ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-10-05T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  indexed(path, triggers)
  const store = new Store(path)
  expect(store.threads.get('github:7')).toMatchObject({ createdAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-10-09T00:00:00.000Z' })
  expect(store.triggers.get('first')!.at).toBe('2026-10-01T00:00:00.000Z')
  expect(store.db.prepare("SELECT at FROM trigger WHERE id = 'first' UNION ALL SELECT at FROM trigger_thread WHERE id = 'first'").all())
    .toEqual([{ at: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:00.000Z' }])
  store.close()
})

it('names the ticket it stopped at when a ticket does not read, and leaves the database at schema 10 as it was', () => {
  const path = join(directory, 'db.sqlite')
  const { inputs: _inputs, ...broken } = ticket10('t9')
  schema10(path, {}, { ticket: [broken] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: ticket t9: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t9'").get()!.value))).toEqual(broken)
  db.close()
})

it('makes the newest saved revision the current settings when it holds them, and moves a lagging pointer to it', () => {
  const path = join(directory, 'db.sqlite')
  const version = (revision: number, settings: object) => ({ revision, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings })
  schema10(path, { settings: { executor: { maxWorkers: 4 } }, 'settings-revision': 1, 'settings-version:1': version(1, {}),
    'settings-version:2': version(2, { executor: { maxWorkers: 4 } }) })
  const store = new Store(path)
  expect(store.settingsHistory().map(item => item.revision)).toEqual([2, 1])
  expect([store.get(KV.settings.revision), store.settings().executor.maxWorkers, store.get('settings')]).toEqual([2, 4, undefined])
  store.close()
})

it('reads the reasons a Trigger\'s filter and an Assignment\'s end stored in words as codes, and keeps an end\'s reason once', () => {
  const path = join(directory, 'db.sqlite')
  const assignment = (id: string, endedReason: string) => ({ id, ticketId: 't1', ref: '', state: 'ended', createdAt: '1', endedAt: '2', endedReason })
  schema10(path, {}, { ticket: [ticket10('t1', { assignments: [assignment('a1', 'Retried by a person'), assignment('a2', 'host restarted'),
    { id: 'a3', ticketId: 't1', ref: '', state: 'running', createdAt: '2' }] })] })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO disposition VALUES (?, ?)').run('trig-1', JSON.stringify({ filtered: 'Sender is not an authorized human member', fanout: [], at: '' }))
  db.close()
  const store = new Store(path)
  expect(store.tickets.get('t1')!.assignments.map(item => item.endedReason)).toEqual(['retried', 'hostRestarted', undefined])
  expect(store.triggers.disposition('trig-1')).toMatchObject({ filtered: { code: 'senderNotMember' } })
  store.close()
  // The Assignment an end stopped does not repeat the end's reason, which the end keeps.
  const ended = withoutCopies({ ...ticket10('t2'), state: 'ended', ended: { at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '1', endedAt: '5', endedReason: 'Not needed' }] })
  expect([ended.ended, ended.assignments[0]]).toEqual([{ at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' }, { id: 'a1', state: 'ended', createdAt: '1', endedAt: '5' }])
})

it('marks a ticket\'s Channel to a direct Feishu chat as direct, and links a Thread in the Lark brand when Lark links are stored', () => {
  const path = join(directory, 'db.sqlite')
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const lark = { id: 'lark', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_2' }], actor, human: true, at: '2026-10-01T00:00:00.000Z',
    text: 'hi', url: 'https://applink.larksuite.com/client/message/link/open?token=x', meta: {} }
  schema10(path, { 'feishu-chats': { oc_dm: true } }, { ticket: [ticket10('t1', { channels: [dm] })], trigger: [lark],
    thread: [{ key: 'feishu:oc_other:om_9', ref: { source: 'feishu', id: 'oc_other:om_9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  const store = new Store(path)
  expect(store.tickets.get('t1')!.channels).toEqual([{ ...dm, address: { ...dm.address, direct: 'true' } }])
  expect(store.threads.get('feishu:oc_other:om_9')!.meta.url).toBe('https://applink.larksuite.com/client/chat/open?openChatId=oc_other')
  store.close()
})

it('delivers the candidate of an Eval in progress at the upgrade again, so its deadline starts and it can expire', () => {
  const path = join(directory, 'db.sqlite')
  const evaluating = { id: 'e9', threadKey: 'github:9', triggerIds: ['issue-9'], strength: 'explicit', actor, policyVersion: 'v1', startedAt: '1',
    deadline: '2', basis: { via: 'listed' } }
  schema10(path, {}, {
    trigger: [{ id: 'issue-9', source: 'github', threads: [{ source: 'github', id: '9' }], actor, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix it', meta: {} }],
    thread: [{ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }],
  })
  const store = new Store(path)
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key, JSON.parse(String(row.value))])
  expect(effects).toEqual([['e9', { triggerId: 'issue-9' }]])
  store.close()
})
