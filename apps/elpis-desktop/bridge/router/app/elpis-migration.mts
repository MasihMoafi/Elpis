/** Preserve databases written by the first Elpis router port when adopting the full reference schema. */
import type { DatabaseSync } from "node:sqlite";
export function migrateElpisLayout(db: DatabaseSync): void {
  const columns = (table: string) =>
    db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map(row => String(row.name));
  if (!columns("thread").includes("id")) return;
  db.exec("SAVEPOINT elpis_layout");
  try {
    db.exec(`ALTER TABLE thread RENAME COLUMN id TO key;
      ALTER TABLE trigger ADD COLUMN at TEXT NOT NULL DEFAULT '';
      UPDATE trigger SET at = json_extract(value, '$.at');
      ALTER TABLE decision ADD COLUMN thread TEXT NOT NULL DEFAULT '';
      UPDATE decision SET thread = json_extract(value, '$.threadKey');`);
    if (columns("source_state").length) db.exec("INSERT OR IGNORE INTO kv SELECT id, value FROM source_state");
    db.exec("CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (columns("reply_receipt").length) db.exec("INSERT OR IGNORE INTO outbox SELECT id, value FROM reply_receipt");
    db.exec("RELEASE elpis_layout");
  } catch (error) {
    db.exec("ROLLBACK TO elpis_layout; RELEASE elpis_layout");
    throw error;
  }
}
