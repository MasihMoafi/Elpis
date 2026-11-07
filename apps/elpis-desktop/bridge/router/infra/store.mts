// Ported from dsh-superagent (MIT), src/app/store.ts and src/app/runtime.ts
import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { elpisHome } from '../../client-paths.mts'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from '../core/index.mts'

const require = createRequire(import.meta.url)
const { lockSync } = require('proper-lockfile') as { lockSync(path: string, options: { stale: number; onCompromised: (error: Error) => void }): () => void }
type Table = 'trigger' | 'disposition' | 'thread' | 'ticket' | 'decision'

/** Domain-only SQLite repositories. The host holds the directory lock until close. */
export class RouterStore implements Repositories {
  private readonly db: DatabaseSync
  private readonly release: () => void
  private depth = 0
  constructor(home = elpisHome(), onCompromised: (error: Error) => void = error => { throw error }) {
    const dir = join(home, 'router')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.release = lockSync(dir, { stale: 30_000, onCompromised })
    let db: DatabaseSync | undefined
    try {
      const file = join(dir, 'orchestrator.sqlite')
      db = new DatabaseSync(file)
      chmodSync(file, 0o600)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS thread (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
      this.db = db
    } catch (error) { db?.close(); this.release(); throw error }
  }
  close(): void { try { this.db.close() } finally { this.release() } }
  atomic<T>(work: () => T): T {
    const name = `router_atomic_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const value = work(); this.db.exec(`RELEASE ${name}`); return value }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
  }
  private get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  private save(table: Table, id: string, value: object): void {
    this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value))
  }
  private list<T>(table: Table, newest = false): T[] {
    return this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid ${newest ? 'DESC' : 'ASC'}`).all().map(row => JSON.parse(String(row.value)) as T)
  }
  readonly triggers = {
    get: (id: string) => this.get<Trigger>('trigger', id),
    save: (value: Trigger) => this.save('trigger', value.id, value),
    disposition: (id: string) => this.get<TriggerDisposition>('disposition', id),
    saveDisposition: (id: string, value: TriggerDisposition) => this.save('disposition', id, value),
  }
  readonly threads = {
    get: (id: string) => this.get<Thread>('thread', id),
    save: (value: Thread) => this.save('thread', value.key, value),
    list: () => this.list<Thread>('thread'),
    active: () => this.threads.list().filter(value => value.pending.length > 0 || value.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => this.get<Ticket>('ticket', id),
    save: (value: Ticket) => this.save('ticket', value.id, value),
    list: () => this.list<Ticket>('ticket', true),
    open: () => this.tickets.list().filter(value => !value.ended),
    active: () => this.tickets.list().filter(value => value.undelivered.length > 0 || ['pending', 'running'].includes(value.assignments.at(-1)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => this.get<Decision>('decision', id),
    save: (value: Decision) => this.save('decision', value.id, value),
    byThread: (key: string) => this.list<Decision>('decision').filter(value => value.threadKey === key),
  }
}
