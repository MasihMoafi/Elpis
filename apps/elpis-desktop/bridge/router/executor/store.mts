// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/store.ts.
import { RouterStore } from '../infra/store.mts'
import type { Settings } from './settings.mts'
/** Native runtime identities share the router's transaction, database and profile lock. */
export class ExecutorStore extends RouterStore {
  private readonly inherited: (() => Settings) | undefined
  constructor(home: string, settings?: () => Settings) {
    super(home)
    this.inherited = settings
    try { this.db.exec('CREATE TABLE IF NOT EXISTS executor_session (id TEXT PRIMARY KEY, value TEXT NOT NULL)') }
    catch (error) { this.close(); throw error }
  }
  override settings(): Settings { return this.inherited?.() ?? super.settings() }
  session(id: string): unknown { const row = this.db.prepare('SELECT value FROM executor_session WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined }
  saveSession(id: string, value: object): void { this.db.prepare('INSERT INTO executor_session VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) }
}
