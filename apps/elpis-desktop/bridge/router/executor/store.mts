// Ported from dsh-superagent (MIT), src/app/store.ts (executor effects and session records)
import { RouterStore } from '../infra/store.mts'
import { readSettings, type Settings } from './settings.mts'

/** Shares the core transaction and lock: queued work cannot survive a rolled-back domain command. */
export class ExecutorStore extends RouterStore {
  private readonly read: () => Settings
  constructor(home: string, settings: () => Settings = () => readSettings(home)) {
    super(home)
    this.read = settings
    try { this.db.exec(`CREATE TABLE IF NOT EXISTS effect (
      kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL, since TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS executor_session (id TEXT PRIMARY KEY, value TEXT NOT NULL);`) }
    catch (error) { this.close(); throw error }
  }
  settings(): Settings { return this.read() }
  session(id: string): unknown { const row = this.db.prepare('SELECT value FROM executor_session WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined }
  saveSession(id: string, value: object): void { this.db.prepare('INSERT INTO executor_session VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) }
}
