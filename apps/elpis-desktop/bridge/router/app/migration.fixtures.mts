import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach } from "node:test";
import { Store } from "./store.mts";

export let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orchestrator-migration-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Seed a SQLite database in the schema 10 layout (including the legacy `outbox.sent` column and `inbox` table). */
export function schema10(
  path: string,
  records: Record<string, unknown>,
  rows: { ticket?: object[]; decision?: object[]; thread?: object[]; trigger?: object[] } = {},
): void {
  new Store(path).close();
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE outbox; CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)",
  );
  const set = (name: string, value: unknown) =>
    db
      .prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(name, JSON.stringify(value));
  set("schema", 10);
  for (const [name, value] of Object.entries(records)) set(name, value);
  for (const ticket of rows.ticket ?? [])
    db.prepare("INSERT INTO ticket VALUES (?,?)").run((ticket as { id: string }).id, JSON.stringify(ticket));
  for (const decision of rows.decision ?? []) {
    const { id, threadKey } = decision as { id: string; threadKey: string };
    db.prepare("INSERT INTO decision VALUES (?,?,?)").run(id, threadKey, JSON.stringify(decision));
  }
  for (const thread of rows.thread ?? [])
    db.prepare("INSERT INTO thread VALUES (?,?)").run((thread as { key: string }).key, JSON.stringify(thread));
  for (const trigger of rows.trigger ?? []) {
    const { id, at } = trigger as { id: string; at: string };
    db.prepare("INSERT INTO trigger VALUES (?,?,?)").run(id, JSON.stringify(trigger), at);
  }
  db.exec("CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.close();
}

export const actor = { source: "feishu", id: "ou_alice" };

export const mandate = (basis: object) => ({ strength: "explicit", policyVersion: "v1", basis, actor, scope: "small" });

/** Build a pre-team-sections prompt version where fixed and built-in guides were stored inside the config object. */
export const legacyPrompts = (revision: number, guides: Record<string, string> = {}) => ({
  [`prompt-version:${revision}`]: {
    revision,
    previousRevision: revision ? revision - 1 : null,
    savedAt: "",
    source: "web",
    config: {
      shared: "Legacy shared rule.",
      orchestrator: "Legacy orchestrator: only route.",
      worker: "Legacy worker.",
      guides: {
        replies: "Legacy replies.",
        dispatch: "Accept any screenshot.",
        work: "Legacy work. Enable auto-merge once it changes fewer than 350 lines (additions plus deletions); and so on.",
        feishu: "Legacy Feishu skill.",
        identities: "Alice is @alice.",
        ...guides,
      },
    },
  },
  "prompt-revision": revision,
  "prompt-settings-text": 1,
});

export const opened = (records: Record<string, unknown>) => {
  const path = join(directory, `db-${Math.random()}.sqlite`);
  schema10(path, records);
  return new Store(path);
};

/**
 * Create a raw SQLite database matching the exact table DDL of the last schema 10 release (before working-set columns
 * and the `effect` table were added, and with leftover schema 6 `inbox` and `task` tables).
 */
export function lastSchema10(path: string): void {
  const db = new DatabaseSync(path);
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
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const kv = (name: string, value: unknown) =>
    db.prepare("INSERT INTO kv VALUES (?,?)").run(name, JSON.stringify(value));
  kv("schema", 10);
  kv("master-id", "orchestrator-1");
  kv("settings", { executor: { maxWorkers: 2 } });
  kv("relay-queue", [{ id: "report:old", text: '{"kind":"worker_report"}' }]);
  const trigger = {
    id: "trig-1",
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_team:om_1" }],
    actor,
    human: true,
    at: "2026-10-01T00:00:00Z",
    text: "fix it",
    meta: {},
  };
  db.prepare("INSERT INTO trigger VALUES (?,?,?)").run(trigger.id, JSON.stringify(trigger), trigger.at);
  db.prepare("INSERT INTO trigger_thread VALUES (?,?,?,1)").run("feishu:oc_team:om_1", trigger.id, trigger.at);
  const thread = {
    key: "feishu:oc_team:om_1",
    ref: trigger.threads[0],
    createdAt: trigger.at,
    subscriptions: ["t1"],
    correlated: [],
    pending: [],
    meta: {},
  };
  db.prepare("INSERT INTO thread VALUES (?,?)").run(thread.key, JSON.stringify(thread));
  const ticket = {
    id: "t1",
    title: "Fix",
    decisionId: "d1",
    channels: [],
    state: "open",
    summary: "",
    createdAt: trigger.at,
    updatedAt: trigger.at,
    mandate: mandate({ source: "feishu", scope: { chatId: "oc_team" }, sender: "Alice", addressed: "mention" }),
    inputs: [],
    undelivered: [],
    assignments: [{ id: "a1", state: "running", createdAt: trigger.at }],
    meta: {
      sourceTriggerId: trigger.id,
      triggerIds: [trigger.id],
      workspace: "/w/fix-1",
      name: "fix-1",
      sessionId: "worker-t1",
      assignment: "Read trigger/trig-1.",
    },
  };
  db.prepare("INSERT INTO ticket VALUES (?,?)").run(ticket.id, JSON.stringify(ticket));
  const reply = {
    id: "reply-1",
    channel: { source: "feishu", thread: thread.key, address: { chatId: "oc_team", messageId: "om_1" } },
    text: "收到",
    kind: "reply",
    attempts: 0,
    error: "",
  };
  db.prepare("INSERT INTO outbox VALUES (?,?,0)").run(reply.id, JSON.stringify(reply));
  db.prepare("INSERT INTO inbox VALUES (?,?,0)").run("left-out", '{"id":"left-out"}');
  db.close();
}

export const ticket10 = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  title: "Fix",
  decisionId: "d1",
  channels: [],
  state: "open",
  assignments: [],
  inputs: [],
  undelivered: [],
  summary: "",
  createdAt: "1",
  updatedAt: "2",
  mandate: mandate({ via: "listed" }),
  meta: { sourceTriggerId: "trig-1" },
  ...fields,
});

/** Populate `trigger_thread` rows for `triggers` as schema 10 did on save. */
export function indexed(
  path: string,
  triggers: { id: string; at: string; threads: { source: string; id: string }[] }[],
): void {
  const db = new DatabaseSync(path);
  for (const { id, at, threads } of triggers) {
    for (const thread of threads)
      db.prepare("INSERT INTO trigger_thread VALUES (?, ?, ?, 1)").run(`${thread.source}:${thread.id}`, id, at);
  }
  db.close();
}
