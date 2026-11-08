import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { expect } from "expect";
import { SCHEMA_VERSION, Store } from "./store.mts";
import { KV } from "../sources/kv.mts";
import { basisOf } from "./migration.mts";
import { Prompts, composePrompt, defaultPrompts } from "./prompts.mts";
import { masterPrompt } from "./context.mts";
import { directory, schema10, mandate, legacyPrompts, opened, lastSchema10 } from "./migration.fixtures.mts";

it("keeps each message as a receipt of what became of it, with why one was dropped by the code the panel words it by", () => {
  const path = join(directory, "db.sqlite");
  schema10(path, {});
  const db = new DatabaseSync(path);
  const message = (id: string, sent: number, fields: object = {}) =>
    db
      .prepare("INSERT INTO outbox (id, value, sent) VALUES (?, ?, ?)")
      .run(
        id,
        JSON.stringify({
          id,
          channel: { source: "feishu", thread: "feishu:oc_1:om_1", address: {} },
          text: id,
          kind: "reply",
          attempts: 2,
          error: "offline",
          nextAttemptAt: 1,
          ...fields,
        }),
        sent,
      );
  message("gone", 1, {
    dropped: { at: "2026-09-01T00:00:00.000Z", reason: "The conversation can no longer receive messages" },
  });
  message("ignored", 1, {
    dropped: { at: "2026-09-02T00:00:00.000Z", reason: "The Source no longer listens to this conversation" },
  });
  message("sent", 1);
  message("waiting", 0);
  db.close();
  const store = new Store(path);
  expect(store.read.droppedReplies().map(item => [item.id, item.dropped.reason])).toEqual([
    ["ignored", "channelIgnored"],
    ["gone", "channelGone"],
  ]);
  expect(["gone", "sent", "waiting"].map(id => store.replyStatus(id))).toEqual(["dropped", "sent", "pending"]);
  // A receipt holds no attempts: the message that waits has a `reply` effect, which keeps the ones it had and counts on.
  expect(store.receipts.get("waiting")).toEqual({
    id: "waiting",
    channel: { source: "feishu", thread: "feishu:oc_1:om_1", address: {} },
    text: "waiting",
    kind: "reply",
    status: "pending",
  });
  expect(store.db.prepare("SELECT kind, key, attempts, error FROM effect").all()).toEqual([
    { kind: "reply", key: "waiting", attempts: 2, error: "offline" },
  ]);
  expect(
    store.db
      .prepare("SELECT name FROM pragma_table_xinfo('outbox')")
      .all()
      .map(row => row.name),
  ).not.toContain("sent");
  store.close();
});

it("changes nothing when one step fails: the database stays at schema 10 as it was", () => {
  const path = join(directory, "db.sqlite");
  const ticket = {
    id: "t1",
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
    meta: { sourceTriggerId: "trig-1", workspace: "/w/fix-1" },
  };
  // The current settings must validate; an invalid value aborts the migration transaction.
  schema10(path, { settings: { executor: { maxWorkers: "many" } } }, { ticket: [ticket] });
  expect(() => new Store(path)).toThrow(
    /^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: the settings: /,
  );
  const db = new DatabaseSync(path);
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: "10" });
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t1'").get()!.value))).toMatchObject({
    meta: { workspace: "/w/fix-1" },
  });
  db.close();
});

it("reads every basis an earlier gate recorded in the current shape", () => {
  const scope = { chatId: "oc_1", direct: false };
  expect(basisOf({ source: "feishu", scope, row: "oc_1", sender: "Alice", addressed: "mention" })).toEqual({
    via: "addressed",
    source: "feishu",
    scope,
    row: "oc_1",
    sender: "Alice",
    addressed: "mention",
  });
  expect(basisOf({ source: "feishu", scope, followup: true, rules: ["r"] })).toEqual({
    via: "followup",
    source: "feishu",
    scope,
    rules: ["r"],
  });
  expect(basisOf({ source: "feishu", scope, addressed: "direct", admission: "unlistedAddressed" })).toEqual({
    via: "admission",
    source: "feishu",
    scope,
    cell: "unlistedAddressed",
    addressed: "direct",
  });
  // Observed under an earlier gate that recorded no cell: the sender had to be on the list.
  expect(basisOf({ source: "feishu", scope, sender: "Alice", observation: true, mode: "auto", rules: ["r"] })).toEqual({
    via: "listed",
    source: "feishu",
    scope,
    sender: "Alice",
    rules: ["r"],
    observation: { mode: "auto" },
  });
  expect(basisOf({ chatId: "oc_1", direct: true, followup: true, member: "ou_a" })).toEqual({
    via: "followup",
    source: "feishu",
    scope: { chatId: "oc_1", direct: true },
    sender: "ou_a",
  });
  expect(basisOf({ member: "ou_a", mention: true })).toEqual({ via: "listed", sender: "ou_a", addressed: "mention" });
  expect(basisOf({ legacyAuthority: "explicit_mention" })).toEqual({ via: "listed", authority: "explicit_mention" });
  expect(basisOf({ via: "followup" })).toEqual({ via: "followup" });
});

it("writes a prompt version saved before the team sections in them, keeping its skills and auto-merge threshold, and marks it", () => {
  const store = opened({
    ...legacyPrompts(3, {
      notes:
        'Call orchestrator_create_task with event_id, read event/<id>, follow guide/work and guide/release, load dsh-tag-github, cd "$DSH_TAG_DIR".',
    }),
  });
  const prompts = new Prompts(
    store,
    () => 100000,
    () => undefined,
    () => true,
  );
  const { config } = prompts.version(3);
  expect(config.communication).toBe(defaultPrompts().communication);
  expect(config.delivery).toContain("it changes fewer than 350 lines (additions plus deletions);");
  expect(config.delivery).not.toContain("fewer than 200 lines");
  // Guides that are now fixed or built-in are gone; the team's own skills stay, in current names.
  expect(Object.keys(config.skills)).toEqual(["identities", "notes"]);
  expect(config.skills.notes).toBe(
    'Call orchestrator_route (kind accept) with trigger_id, read trigger/<id>, follow the work section and skill dsh-superagent-release, load dsh-superagent-github, cd "$DSH_SUPERAGENT_DIR".',
  );
  const prompt = composePrompt(config, "orchestrator");
  expect(prompt).not.toContain("Legacy orchestrator");
  expect(prompt).toContain(masterPrompt);
  expect(prompts.current().revision).toBe(3);
  // Read as the built-in text, a legacy version says so instead of listing its differences.
  expect(prompts.history(0, 1).revisions.map(version => version.changed)).toEqual([["legacy"]]);
  store.close();
});

it("writes saved team sections and skills under current names: earlier project names, the tools that became reads and the routing tools", () => {
  const config = {
    ...defaultPrompts(),
    delivery: "Merge with --repo $DSH_FREELANCER_GITHUB_REPOSITORY.",
    skills: {
      notes:
        'Load dsh-freelancer-github; cd "$DSH_FREELANCER_DIR". List with orchestrator_tickets, then orchestrator_ticket_inspect.',
      routing:
        "Accept with orchestrator_ticket_accept; stop with orchestrator_ticket_stop, never orchestrator_trigger_ignore.",
    },
  };
  const store = opened({
    "prompt-version:1": { revision: 1, previousRevision: 0, savedAt: "", source: "web", config },
    "prompt-revision": 1,
    "prompt-settings-text": 1,
  });
  const { config: current } = new Prompts(
    store,
    () => 100000,
    () => undefined,
    () => true,
  ).current();
  expect(current.delivery).toBe("Merge with --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY.");
  expect(current.skills.notes).toBe(
    'Load dsh-superagent-github; cd "$DSH_SUPERAGENT_DIR". List with orchestrator_read tickets, then orchestrator_read ticket/<id>.',
  );
  // The four routing tools are one.
  expect(current.skills.routing).toBe(
    "Accept with orchestrator_route (kind accept); stop with orchestrator_route (kind stop), never orchestrator_route (kind ignore).",
  );
  store.close();
});

it("writes the removed auto-merge threshold and member identities into the prompts as one new version, unless an earlier version did", () => {
  const before = {
    policy: {
      autoMergeLineLimit: 350,
      members: [
        { name: "Alice", feishuId: "ou_alice", github: "alice" },
        { name: "Bob", feishuId: "ou_bob", github: "" },
      ],
    },
  };
  const store = opened({ "settings-before-9": before });
  const prompts = new Prompts(
    store,
    () => 100000,
    () => undefined,
    () => true,
  );
  const migrated = prompts.current();
  expect(migrated).toMatchObject({ revision: 1, previousRevision: 0, source: "settings-migration" });
  expect(migrated.config.delivery).toContain("it changes fewer than 350 lines (additions plus deletions);");
  expect(migrated.config.skills.identities).toContain("- Alice (Feishu ou_alice) is @alice on GitHub");
  expect(migrated.config.skills.identities).not.toContain("Bob");
  expect(store.get("settings-before-9")).toBeUndefined();
  store.close();
  // The default threshold and nobody with two identities change nothing; other delivery text gains the threshold as its own sentence.
  const unchanged = opened({
    "settings-before-9": { policy: { members: [{ name: "Bob", feishuId: "ou_bob", github: "" }] } },
  });
  expect(
    new Prompts(
      unchanged,
      () => 100000,
      () => undefined,
      () => true,
    ).current().revision,
  ).toBe(0);
  unchanged.close();
  const own = opened({
    "settings-before-9": { policy: { autoMergeLineLimit: 80 } },
    "prompt-revision": 1,
    "prompt-version:1": {
      revision: 1,
      previousRevision: 0,
      savedAt: "",
      source: "panel",
      config: { ...defaultPrompts(), delivery: "Deliver PRs." },
    },
  });
  expect(
    new Prompts(
      own,
      () => 100000,
      () => undefined,
      () => true,
    ).current().config.delivery,
  ).toBe("Deliver PRs.\nEnable auto-merge only on a PR that changes fewer than 80 lines (additions plus deletions).");
  own.close();
  const done = opened({ "settings-before-9": before, "prompt-settings-text": 1 });
  expect(
    new Prompts(
      done,
      () => 100000,
      () => undefined,
      () => true,
    ).current().revision,
  ).toBe(0);
  done.close();
});

it("reads a current prompt version that does not read as the one before it, keeping what it said", () => {
  const config = { ...defaultPrompts(), delivery: "Deliver PRs." };
  const store = opened({
    "prompt-revision": 2,
    "prompt-settings-text": 1,
    "prompt-version:1": { revision: 1, previousRevision: 0, savedAt: "", source: "web", config },
    "prompt-version:2": {
      revision: 2,
      previousRevision: 1,
      savedAt: "",
      source: "web",
      config: { delivery: ["not text"] },
    },
  });
  const prompts = new Prompts(
    store,
    () => 100000,
    () => undefined,
    () => true,
  );
  expect(prompts.current()).toMatchObject({ revision: 2, config, legacy: { config: { delivery: ["not text"] } } });
  expect(prompts.history(0, 2).revisions.map(version => version.changed)).toEqual([["legacy"], []]);
  store.close();
});

it("opens a database the last schema 10 build left, adds what this version keeps alongside, and migrates it", () => {
  const path = join(directory, "db.sqlite");
  lastSchema10(path);
  const store = new Store(path);
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION);
  expect(store.tickets.active().map(ticket => ticket.id)).toEqual(["t1"]);
  expect(store.read.subscribedThreads("feishu").map(thread => thread.key)).toEqual(["feishu:oc_team:om_1"]);
  expect(store.tickets.get("t1")).toMatchObject({
    origin: { triggerId: "trig-1" },
    execution: { name: "fix-1", directory: "/w/fix-1" },
    mandate: { basis: { via: "addressed", addressed: "mention" } },
  });
  expect(store.receipts.waiting().map(item => item.id)).toEqual(["reply-1"]);
  expect(store.db.prepare("SELECT kind, key, generation FROM effect ORDER BY seq").all()).toEqual([
    { kind: "relay", key: "report:old", generation: 0 },
    { kind: "reply", key: "reply-1", generation: 0 },
  ]);
  expect(store.db.prepare("SELECT id FROM inbox").all()).toEqual([{ id: "left-out" }]);
  const migrated = store.tickets.get("t1");
  store.close();
  const again = new Store(path);
  expect(again.tickets.get("t1")).toEqual(migrated);
  expect(again.db.prepare("SELECT COUNT(*) AS n FROM effect").get()).toEqual({ n: 2 });
  again.close();
});
