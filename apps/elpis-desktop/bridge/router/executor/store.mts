// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/store.ts.
import { RouterStore } from "../infra/store.mts";
/** Native runtime identities share the router's transaction, database and profile lock. */
export class ExecutorStore extends RouterStore {
  constructor(home: string) {
    super(home);
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS executor_session (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    } catch (error) {
      this.close();
      throw error;
    }
  }
  session(id: string): unknown {
    const row = this.db.prepare("SELECT value FROM executor_session WHERE id=?").get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveSession(id: string, value: object): void {
    this.db
      .prepare("INSERT INTO executor_session VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(id, JSON.stringify(value));
  }
}
