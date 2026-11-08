import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { expect } from "expect";
import { Store } from "./store.mts";
import { KV } from "../sources/kv.mts";
import { reasonsOf, withoutCopies } from "./migration.mts";
import { directory, schema10, actor, mandate, ticket10, indexed } from "./migration.fixtures.mts";

it("writes the Sources' records in their current shape once, so no Source converts an earlier one when it reads it", () => {
  const path = join(directory, "db.sqlite");
  const recent = new Date(Date.now() - 3600_000).toISOString();
  const dm = { source: "feishu", thread: "feishu:oc_dm", address: { chatId: "oc_dm", messageId: "om_1" } };
  const evaluating = {
    id: "e1",
    threadKey: "github:5",
    triggerIds: ["issue"],
    strength: "inferred",
    actor,
    policyVersion: "v1",
    startedAt: "",
    deadline: "",
    basis: { via: "listed" },
  };
  schema10(
    path,
    {
      "feishu-chats": { oc_dm: true, oc_team: false },
      "feishu-history:oc_team": "2026-09-01T00:00:00.000Z",
      // Earlier versions kept a chat's topics as a list.
      "feishu-history-threads:oc_team": ["omt_old"],
      "github-thread:7": "2026-09-02T00:00:00.000Z",
      "thread-since:github:7": "2026-09-03T00:00:00.000Z",
      "github-thread:8": "2026-09-04T00:00:00.000Z",
      "github-issue-pending": { a: { number: 12, at: recent }, b: { number: 13, at: "2026-01-01T00:00:00.000Z" } },
      "github-issues-since": "x",
    },
    {
      trigger: [
        {
          id: "dm",
          source: "feishu",
          threads: [{ source: "feishu", id: "oc_dm:om_1" }],
          actor,
          human: true,
          at: "2026-09-01T00:00:00Z",
          text: "fix",
          channel: dm,
          meta: {},
        },
        {
          id: "issue",
          source: "github-issue",
          threads: [{ source: "github", id: "12" }],
          actor: { source: "github", id: "alice" },
          human: true,
          at: "2026-09-01T00:00:00Z",
          text: "Login fails",
          meta: { number: 12 },
        },
      ],
      thread: [
        {
          key: "feishu:oc_team:om_9",
          ref: { source: "feishu", id: "oc_team:om_9" },
          createdAt: "",
          subscriptions: [],
          correlated: [],
          pending: [],
          meta: {},
        },
        {
          key: "github:5",
          ref: { source: "github", id: "5" },
          createdAt: "",
          subscriptions: [],
          correlated: [],
          pending: [],
          evaluating,
          meta: {},
        },
      ],
    },
  );
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO outbox (id, value) VALUES (?, ?)").run(
    "r1",
    JSON.stringify({ id: "r1", channel: dm, text: "Done", kind: "reply", attempts: 0, error: "" }),
  );
  // Assessments queued before effects named their Trigger: one whose Eval runs, and one whose Eval ended.
  for (const [seq, evalId] of [
    [1, "e1"],
    [2, "e2"],
  ] as const) {
    db.prepare("INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)").run(
      "assessment",
      evalId,
      "{}",
      seq,
      0,
      "",
    );
  }
  db.close();
  const store = new Store(path);
  expect(store.get(KV.feishu.topics("oc_team"))).toEqual({ omt_old: "2026-09-01T00:00:00.000Z" });
  expect(store.triggers.get("dm")!.channel!.address).toEqual({ chatId: "oc_dm", messageId: "om_1", direct: "true" });
  expect(store.receipts.waiting()[0]!.channel.address).toEqual({ chatId: "oc_dm", messageId: "om_1", direct: "true" });
  expect(store.threads.get("feishu:oc_team:om_9")!.meta.url).toBe(
    "https://applink.feishu.cn/client/chat/open?openChatId=oc_team",
  );
  expect(store.triggers.get("issue")!.source).toBe("github");
  // The waiting mention within the polling horizon is read again; the older one is no fresh request.
  expect(store.get(KV.github.retries)).toEqual({ 12: { since: recent, pr: false } });
  expect(store.get(KV.github.cursor(7))).toBe("2026-09-03T00:00:00.000Z");
  expect(store.get(KV.github.cursor(8))).toBe("2026-09-04T00:00:00.000Z");
  for (const name of [
    "github-issue-pending",
    "github-issues-since",
    "github-thread:7",
    "thread-since:github:7",
    "github-thread:8",
  ]) {
    expect(store.get(name)).toBeUndefined();
  }
  const effects = store.db
    .prepare("SELECT key, value FROM effect WHERE kind = 'assessment'")
    .all()
    .map(row => [row.key, JSON.parse(String(row.value))]);
  expect(effects).toEqual([["e1", { triggerId: "issue" }]]);
  store.close();
});

it("keeps each fact of a ticket once: its end, its latest report, and no worker Session it can derive", () => {
  const base = {
    id: "t",
    title: "Fix",
    decisionId: "d",
    channels: [],
    inputs: [],
    undelivered: [],
    createdAt: "1",
    updatedAt: "2",
    mandate: mandate({ via: "listed" }),
    origin: { triggerId: "x", triggerIds: ["x"] },
    execution: { name: "fix", directory: "/w", session: "worker-t", assignment: "Do it." },
  };
  const open = withoutCopies({
    ...base,
    state: "open",
    summary: "Working on it",
    assignments: [{ id: "a1", ticketId: "t", ref: "worker-t", state: "running", createdAt: "1" }],
  });
  expect(open).toEqual({
    ...base,
    execution: { name: "fix", directory: "/w", assignment: "Do it." },
    assignments: [
      { id: "a1", state: "running", createdAt: "1", report: { state: "progress", summary: "Working on it", at: "2" } },
    ],
  });
  // A report the ticket had stays the latest one; an ended ticket without an end record ended closed.
  const reported = {
    id: "a1",
    ticketId: "t",
    ref: "",
    state: "ended",
    createdAt: "1",
    report: { state: "ready", summary: "Done", at: "2" },
  };
  expect(withoutCopies({ ...base, state: "ended", summary: "Done", assignments: [reported] })).toMatchObject({
    ended: { at: "2", by: "executor", outcome: "closed" },
    assignments: [{ id: "a1", state: "ended", report: { summary: "Done" } }],
  });
});

it("reads the reasons earlier versions stored in words as codes, and keeps any other words as written", () => {
  expect(reasonsOf("Assessment timed out")).toEqual([{ code: "timeout" }]);
  expect(reasonsOf("a1: not_a_member; b2: no_mention")).toEqual([
    { code: "not_a_member", triggerId: "a1" },
    { code: "no_mention", triggerId: "b2" },
  ]);
  expect(reasonsOf("Routed to ticket t9")).toEqual([{ code: "routed", values: { ticket: "t9" } }]);
  expect(reasonsOf("Observe mode: would accept (a copy fix)")).toEqual([
    { code: "observed", values: { text: "a copy fix" } },
  ]);
  // An assessor's words may hold a colon or a semicolon; they stay one reason.
  expect(reasonsOf("Not a request: chatter; nothing to do")).toEqual([
    { code: "said", values: { text: "Not a request: chatter; nothing to do" } },
  ]);
  expect(reasonsOf([{ code: "timeout" }])).toEqual([{ code: "timeout" }]);
});

it("dates each Thread from its Triggers, and keeps every Trigger's time in the one form stored times take", () => {
  const path = join(directory, "db.sqlite");
  const comment = (id: string, at: string) => ({
    id,
    source: "github",
    threads: [{ source: "github", id: "7" }],
    actor,
    human: true,
    at,
    text: id,
    meta: {},
  });
  // GitHub wrote its times in whole seconds; a Thread a schema 10 build saved before it knew of activity times has none.
  const triggers = [comment("first", "2026-10-01T00:00:00Z"), comment("last", "2026-10-09T00:00:00.000Z")];
  schema10(
    path,
    {},
    {
      trigger: triggers,
      thread: [
        {
          key: "github:7",
          ref: { source: "github", id: "7" },
          createdAt: "2026-10-05T00:00:00.000Z",
          subscriptions: [],
          correlated: [],
          pending: [],
          meta: {},
        },
      ],
    },
  );
  indexed(path, triggers);
  const store = new Store(path);
  expect(store.threads.get("github:7")).toMatchObject({
    createdAt: "2026-10-01T00:00:00.000Z",
    lastAt: "2026-10-09T00:00:00.000Z",
  });
  expect(store.triggers.get("first")!.at).toBe("2026-10-01T00:00:00.000Z");
  expect(
    store.db
      .prepare("SELECT at FROM trigger WHERE id = 'first' UNION ALL SELECT at FROM trigger_thread WHERE id = 'first'")
      .all(),
  ).toEqual([{ at: "2026-10-01T00:00:00.000Z" }, { at: "2026-10-01T00:00:00.000Z" }]);
  store.close();
});

it("names the ticket it stopped at when a ticket does not read, and leaves the database at schema 10 as it was", () => {
  const path = join(directory, "db.sqlite");
  const { inputs: _inputs, ...broken } = ticket10("t9");
  schema10(path, {}, { ticket: [broken] });
  expect(() => new Store(path)).toThrow(
    /^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: ticket t9: /,
  );
  const db = new DatabaseSync(path);
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: "10" });
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t9'").get()!.value))).toEqual(broken);
  db.close();
});

it("makes the newest saved revision the current settings when it holds them, and moves a lagging pointer to it", () => {
  const path = join(directory, "db.sqlite");
  const version = (revision: number, settings: object) => ({
    revision,
    savedAt: "",
    source: "web",
    policyVersion: "",
    policyChanged: false,
    notified: [],
    settings,
  });
  schema10(path, {
    settings: { executor: { maxWorkers: 4 } },
    "settings-revision": 1,
    "settings-version:1": version(1, {}),
    "settings-version:2": version(2, { executor: { maxWorkers: 4 } }),
  });
  const store = new Store(path);
  expect(store.settingsHistory().map(item => item.revision)).toEqual([2, 1]);
  expect([store.get(KV.settings.revision), store.settings().executor.maxWorkers, store.get("settings")]).toEqual([
    2,
    4,
    undefined,
  ]);
  store.close();
});

it("reads the reasons a Trigger's filter and an Assignment's end stored in words as codes, and keeps an end's reason once", () => {
  const path = join(directory, "db.sqlite");
  const assignment = (id: string, endedReason: string) => ({
    id,
    ticketId: "t1",
    ref: "",
    state: "ended",
    createdAt: "1",
    endedAt: "2",
    endedReason,
  });
  schema10(
    path,
    {},
    {
      ticket: [
        ticket10("t1", {
          assignments: [
            assignment("a1", "Retried by a person"),
            assignment("a2", "host restarted"),
            { id: "a3", ticketId: "t1", ref: "", state: "running", createdAt: "2" },
          ],
        }),
      ],
    },
  );
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO disposition VALUES (?, ?)").run(
    "trig-1",
    JSON.stringify({ filtered: "Sender is not an authorized human member", fanout: [], at: "" }),
  );
  db.close();
  const store = new Store(path);
  expect(store.tickets.get("t1")!.assignments.map(item => item.endedReason)).toEqual([
    "retried",
    "hostRestarted",
    undefined,
  ]);
  expect(store.triggers.disposition("trig-1")).toMatchObject({ filtered: { code: "senderNotMember" } });
  store.close();
  // The Assignment an end stopped does not repeat the end's reason, which the end keeps.
  const ended = withoutCopies({
    ...ticket10("t2"),
    state: "ended",
    ended: { at: "5", by: "human", reason: "Not needed", outcome: "stopped" },
    assignments: [{ id: "a1", state: "ended", createdAt: "1", endedAt: "5", endedReason: "Not needed" }],
  });
  expect([ended.ended, ended.assignments[0]]).toEqual([
    { at: "5", by: "human", reason: "Not needed", outcome: "stopped" },
    { id: "a1", state: "ended", createdAt: "1", endedAt: "5" },
  ]);
});

it("marks a ticket's Channel to a direct Feishu chat as direct, and links a Thread in the Lark brand when Lark links are stored", () => {
  const path = join(directory, "db.sqlite");
  const dm = { source: "feishu", thread: "feishu:oc_dm", address: { chatId: "oc_dm", messageId: "om_1" } };
  const lark = {
    id: "lark",
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_team:om_2" }],
    actor,
    human: true,
    at: "2026-10-01T00:00:00.000Z",
    text: "hi",
    url: "https://applink.larksuite.com/client/message/link/open?token=x",
    meta: {},
  };
  schema10(
    path,
    { "feishu-chats": { oc_dm: true } },
    {
      ticket: [ticket10("t1", { channels: [dm] })],
      trigger: [lark],
      thread: [
        {
          key: "feishu:oc_other:om_9",
          ref: { source: "feishu", id: "oc_other:om_9" },
          createdAt: "",
          subscriptions: [],
          correlated: [],
          pending: [],
          meta: {},
        },
      ],
    },
  );
  const store = new Store(path);
  expect(store.tickets.get("t1")!.channels).toEqual([{ ...dm, address: { ...dm.address, direct: "true" } }]);
  expect(store.threads.get("feishu:oc_other:om_9")!.meta.url).toBe(
    "https://applink.larksuite.com/client/chat/open?openChatId=oc_other",
  );
  store.close();
});

it("delivers the candidate of an Eval in progress at the upgrade again, so its deadline starts and it can expire", () => {
  const path = join(directory, "db.sqlite");
  const evaluating = {
    id: "e9",
    threadKey: "github:9",
    triggerIds: ["issue-9"],
    strength: "explicit",
    actor,
    policyVersion: "v1",
    startedAt: "1",
    deadline: "2",
    basis: { via: "listed" },
  };
  schema10(
    path,
    {},
    {
      trigger: [
        {
          id: "issue-9",
          source: "github",
          threads: [{ source: "github", id: "9" }],
          actor,
          human: true,
          at: "2026-09-01T00:00:00Z",
          text: "Fix it",
          meta: {},
        },
      ],
      thread: [
        {
          key: "github:9",
          ref: { source: "github", id: "9" },
          createdAt: "",
          subscriptions: [],
          correlated: [],
          pending: [],
          evaluating,
          meta: {},
        },
      ],
    },
  );
  const store = new Store(path);
  const effects = store.db
    .prepare("SELECT key, value FROM effect WHERE kind = 'assessment'")
    .all()
    .map(row => [row.key, JSON.parse(String(row.value))]);
  expect(effects).toEqual([["e9", { triggerId: "issue-9" }]]);
  store.close();
});
