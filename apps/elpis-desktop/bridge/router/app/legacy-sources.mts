// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
import { isObject } from "./legacy-values.mts";
import type { Stored } from "./legacy-values.mts";
import { type ChannelRef, type Ticket } from "../core/index.mts";
import { POLL_HORIZON_MS } from "../sources/poll.mts";
import type { Store } from "./store.mts";
import { KV, type Key } from "../sources/kv.mts";
// Legacy Feishu URLs are retained as data; Elpis does not run that transport.
export const feishuChatLink = (brand: string, chat: string) =>
  `https://${brand === "lark" ? "applink.larksuite.com" : "applink.feishu.cn"}/client/chat/open?openChatId=${encodeURIComponent(chat)}`;
/** Upgrade stored source state (Feishu topics, direct-chat flags, thread links, GitHub cursors, and pending assessments) to schema 11. */
export function migrateSourceRecords(store: Store): void {
  feishuTopics(store);
  feishuDirectAddresses(store);
  feishuThreadLinks(store);
  issueSourceRecords(store);
  githubCursors(store);
  assessmentTriggers(store);
}
/** Convert legacy Feishu topic ID arrays into maps keyed by topic ID with the chat's last recovery timestamp. */
export function feishuTopics(store: Store): void {
  for (const name of store.keys(KV.feishu.topics)) {
    const topics: unknown = store.get(name);
    if (!Array.isArray(topics)) continue;
    const seen = store.get(KV.feishu.history(name.slice(KV.feishu.topics.prefix.length))) ?? new Date().toISOString();
    store.set(name, Object.fromEntries(topics.map(id => [String(id), seen])));
  }
}
/**
 * Backfill `direct: 'true'` onto Feishu channel addresses from `KV.feishu.chats`, because Feishu `oc_` chat IDs do not
 * distinguish direct messages from group chats on their own.
 */
export function feishuDirectAddresses(store: Store): void {
  const chats = store.get(KV.feishu.chats) ?? {};
  const direct = (channel: unknown): channel is ChannelRef =>
    isObject(channel) &&
    channel.source === "feishu" &&
    isObject(channel.address) &&
    chats[String(channel.address.chatId)] === true &&
    channel.address.direct === undefined;
  const marked = (channel: ChannelRef): ChannelRef =>
    direct(channel) ? { ...channel, address: { ...channel.address, direct: "true" } } : channel;
  for (const table of ["trigger", "outbox"] as const) {
    for (const row of store.db
      .prepare(`SELECT id, value FROM ${table} WHERE value ->> '$.channel.source' = 'feishu'`)
      .all()) {
      const value = JSON.parse(String(row.value)) as Stored;
      if (!direct(value.channel)) continue;
      const rewritten = JSON.stringify({ ...value, channel: marked(value.channel) });
      store.db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(rewritten, row.id!);
    }
  }
  for (const row of store.db.prepare("SELECT id, value FROM ticket").all()) {
    const ticket = JSON.parse(String(row.value)) as Ticket;
    if (ticket.channels.some(direct)) store.tickets.save({ ...ticket, channels: ticket.channels.map(marked) });
  }
}
/** Backfill chat URLs onto Feishu threads created before threads stored their own URL, inferring the brand from existing trigger URLs. */
export function feishuThreadLinks(store: Store): void {
  const lark = store.db
    .prepare(
      `SELECT 1 FROM trigger WHERE value ->> '$.source' = 'feishu'
    AND value ->> '$.url' LIKE '%larksuite.com%' LIMIT 1`,
    )
    .get();
  for (const thread of store.threads.list()) {
    if (
      thread.ref.source !== "feishu" ||
      typeof thread.meta.url === "string" ||
      store.read.firstTrigger(thread.key)?.url
    )
      continue;
    const chatId = thread.ref.id.split(":")[0];
    if (chatId)
      store.threads.save({
        ...thread,
        meta: { ...thread.meta, url: feishuChatLink(lark ? "lark" : "feishu", chatId) },
      });
  }
}
/**
 * Reassign triggers from the removed `github-issue` source to `github`, schedule a retry from the earliest waiting message
 * within `POLL_HORIZON_MS` on each issue that had pending messages, and delete the obsolete `github-issue` KV keys.
 */
export function issueSourceRecords(store: Store): void {
  store.db.exec(
    `UPDATE trigger SET value = json_set(value, '$.source', 'github') WHERE value ->> '$.source' = 'github-issue'`,
  );
  const pending =
    store.get(
      "github-issue-pending" as Key<
        Record<
          string,
          {
            number: number;
            at: string;
          }
        >
      >,
    ) ?? {};
  const retries = { ...store.get(KV.github.retries) };
  for (const { number, at } of Object.values(pending)) {
    if (!(Date.now() - Date.parse(at) < POLL_HORIZON_MS)) continue;
    const retry = retries[number];
    retries[number] = { ...retry, since: retry && retry.since < at ? retry.since : at, pr: retry?.pr ?? false };
  }
  if (Object.keys(retries).length) store.set(KV.github.retries, retries);
  const kept = [
    "github-issue-pending",
    "github-issues-since",
    "github-issues-started-at",
    ...store.keys("github-issue-eligibility:"),
  ];
  for (const name of kept) store.delete(name);
}
/** Consolidate per-issue/PR notification and thread subscription cursors into a single cursor holding the later timestamp. */
export function githubCursors(store: Store): void {
  for (const name of [...store.keys("github-thread:"), ...store.keys("thread-since:github:")]) {
    const at = store.get<string>(name as Key<string>);
    const cursor = KV.github.cursor(Number(name.slice(name.lastIndexOf(":") + 1)));
    const current = store.get(cursor);
    if (at && !(current && current >= at)) store.set(cursor, at);
    store.delete(name);
  }
}
/** Attach trigger IDs to pending assessment effects and re-enqueue undelivered active evaluations so their timeout deadlines start. */
export function assessmentTriggers(store: Store): void {
  const triggers = new Map(
    store.threads
      .active()
      .flatMap(thread => (thread.evaluating ? [[thread.evaluating.id, thread.evaluating.triggerIds[0]] as const] : [])),
  );
  for (const row of store.db
    .prepare("SELECT key FROM effect WHERE kind = 'assessment' AND value ->> '$.triggerId' IS NULL")
    .all()) {
    const triggerId = triggers.get(String(row.key));
    const named = JSON.stringify({ triggerId });
    if (triggerId)
      store.db.prepare("UPDATE effect SET value = ? WHERE kind = 'assessment' AND key = ?").run(named, row.key!);
    else store.db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(row.key!);
  }
  // Re-enqueue active evaluations that predate delivery tracking so delivery starts their timeout deadline instead of leaving the thread stuck.
  let seq = Number(store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM effect").get()?.seq ?? 0);
  for (const thread of store.threads.active()) {
    const evaluation = thread.evaluating;
    if (!evaluation || evaluation.delivered || !evaluation.triggerIds[0]) continue;
    store.db
      .prepare(
        `INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('assessment', ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING`,
      )
      .run(
        evaluation.id,
        JSON.stringify({ triggerId: evaluation.triggerIds[0] }),
        ++seq,
        Date.now(),
        new Date().toISOString(),
      );
  }
}
