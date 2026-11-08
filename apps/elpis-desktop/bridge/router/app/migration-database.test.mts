import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { expect } from "expect";
import { SCHEMA_VERSION, Store } from "./store.mts";
import { directory, schema10, actor, mandate } from "./migration.fixtures.mts";

it("refuses a database older than schema 10 and asks for a new state directory", () => {
  const path = join(directory, "db.sqlite");
  new Store(path).close();
  const schema = (version: number) => {
    const db = new DatabaseSync(path);
    db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version));
    db.close();
  };
  schema(9);
  expect(() => new Store(path)).toThrow(
    /schema 9 predates schema 10, which this version cannot migrate; start with a new state directory/,
  );
});

it("writes a schema 10 database in its current shape once, so nothing reads an older shape", () => {
  const path = join(directory, "db.sqlite");
  const ticket = {
    id: "t1",
    title: "Fix",
    decisionId: "d1",
    state: "open",
    assignments: [],
    summary: "",
    createdAt: "1",
    updatedAt: "2",
    // In schema 10, a GitHub Channel without a comment link marked a PR that the ticket opened.
    channels: [
      { source: "github", thread: "github:8", address: { number: "8" } },
      {
        source: "github",
        thread: "github:7",
        address: { number: "7", url: "https://github.com/acme/widgets/pull/7#issuecomment-1" },
      },
    ],
    mandate: mandate({ chatId: "oc_team", direct: false, member: "ou_alice", mention: true }),
    inputs: [
      { id: "i1", kind: "reopen", decisionId: "d2", at: "3" },
      { id: "i2", kind: "reopen", decisionId: "d0", at: "0" },
      { id: "i3", kind: "trigger", triggerId: "trig-2", at: "4" },
      { id: "i4", kind: "trigger", triggerId: "ci-1", at: "5" },
    ],
    undelivered: ["i1"],
    meta: {
      sourceTriggerId: "trig-1",
      triggerIds: ["trig-1", "trig-2"],
      workspace: "/w/fix-1",
      name: "fix-1",
      sessionId: "worker-t1",
      assignment: "Read trigger/trig-1.",
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      branch: "agent/fix-1",
      deliveryError: "offline",
      recovery: 2,
      worktreeName: "fix",
      scope: "small",
    },
  };
  const imported = {
    ...ticket,
    id: "t2",
    state: "ended",
    channels: [],
    inputs: [],
    undelivered: [],
    mandate: mandate({ legacyAuthority: "thread_followup", followup: true }),
    meta: {
      sourceTriggerId: "old",
      workspace: "/w/task-2",
      sessionId: "worker-task-2",
      legacyPrompt: "Read event/old",
    },
    ended: { at: "6", by: "executor", reason: "merged" },
  };
  // Ended with a person's message waiting, and with no execution or origin trigger.
  const waiting = {
    ...ticket,
    id: "t3",
    state: "ended",
    channels: [],
    ended: { at: "6", by: "human", reason: "Not needed" },
    inputs: [{ id: "i5", kind: "trigger", triggerId: "trig-2", at: "7" }],
    undelivered: ["i5"],
    mandate: mandate({ chatId: "p2p", direct: true, member: "ou_alice" }),
    meta: {},
  };
  const bare = { ...ticket, id: "t4", channels: [], inputs: [], undelivered: [], meta: undefined };
  const reopened = {
    id: "d2",
    threadKey: "feishu:oc_team:om_1",
    triggerIds: ["trig-2"],
    kind: "reopen",
    reason: "follow-up",
    at: "3",
    ticketId: "t1",
    policyVersion: "v1",
  };
  const unavailable = {
    id: "d3",
    threadKey: "feishu:oc_team:om_1",
    triggerIds: ["trig-2"],
    kind: "unavailable",
    reason: "Assessment timed out",
    at: "5",
    policyVersion: "v1",
  };
  const triggers = [
    {
      id: "trig-2",
      source: "feishu",
      threads: [{ source: "feishu", id: "oc_team:om_1" }],
      actor,
      human: true,
      at: "4",
      text: "more",
      meta: {},
    },
    {
      id: "ci-1",
      source: "github",
      threads: [{ source: "github", id: "7" }],
      actor: { source: "github", id: "ci" },
      human: false,
      at: "5",
      text: "CI",
      meta: {},
    },
  ];
  const decision = {
    id: "d1",
    threadKey: "feishu:oc_team:om_1",
    triggerIds: ["trig-1"],
    kind: "accept",
    reason: "",
    at: "1",
    ticketId: "t1",
    policyVersion: "v1",
    mandate: mandate({ legacyAuthority: "proactive_rule", observation: true, rules: ["copy"] }),
  };
  const evaluating = {
    id: "e1",
    threadKey: "github:5",
    triggerIds: ["x"],
    strength: "inferred",
    actor,
    policyVersion: "v1",
    startedAt: "",
    deadline: "",
    basis: {
      source: "github",
      scope: { number: 5 },
      row: "issues",
      admission: "listedUnaddressed",
      observation: true,
      mode: "auto",
    },
  };
  const thread = {
    key: "github:5",
    ref: { source: "github", id: "5" },
    createdAt: "",
    subscriptions: [],
    correlated: [],
    pending: [],
    evaluating,
    meta: {},
  };
  schema10(
    path,
    {
      settings: {
        policy: { rules: [{ id: "copy", name: "Copy", enabled: true, instruction: "x", visual: true }] },
        executor: { reviewer: "bob", prepare: "echo $DSH_TAG_DIR" },
        sources: {
          "github-issue": { enabled: true, config: {} },
          github: { enabled: true, config: { mergeCli: "gh" } },
        },
      },
      "settings-version:1": {
        revision: 1,
        savedAt: "",
        source: "web",
        policyVersion: "",
        policyChanged: false,
        notified: [],
        settings: { allowedChats: ["oc_team"], members: [], sources: undefined },
      },
      "settings-version:2": {
        revision: 2,
        savedAt: "",
        source: "orchestrator-tool",
        policyVersion: "",
        policyChanged: false,
        notified: [],
        settings: { sources: { "github-issue": { enabled: true, config: {} } } },
      },
      "prompt-revision": 1,
      "github-ended:8": { at: "2026-09-01T00:00:00Z", reason: "merged" },
      "problem-dismissed:d3": true,
      "prompt-version:1": {
        revision: 1,
        previousRevision: 0,
        savedAt: "",
        source: "web",
        config: {
          shared: "s",
          orchestrator: "o",
          worker: "w",
          guides: { release: "Use guide/github and dsh-tag-feishu." },
        },
      },
      "prompt-settings-text": 1,
      "task/t1/input/i0": '{"text":"old input"}',
      "task/t1/input/i9": '{"text":"older copy"}',
      "ticket/t1/input/i9": '{"text":"kept"}',
      "settings-version:3": {
        revision: 3,
        savedAt: "",
        source: "web",
        policyVersion: "",
        policyChanged: false,
        notified: [],
        settings: { executor: { maxWorkers: "many" } },
      },
      "prompt-version:2": {
        revision: 2,
        previousRevision: 1,
        savedAt: "",
        source: "web",
        config: { communication: 1 },
      },
      "answer-ready:t1:trig-3": true,
      "github-object-state:7": "open",
      subscriptions: [],
      "settings-before-9": { policy: {} },
      "thread-times-backfilled": true,
      "github-issue-pending": { 1: {} },
      // Caches of reads, which memory keeps now.
      "feishu-read:orchestrator-1:feishu/e1/thread": "{}",
      "github-read:worker-t1:github/pulls/7": "{}",
      "feishu-source-link:oc_team:om_1": "https://x",
      "orchestrator-1:prompt-preview/abc": "prompt",
    },
    {
      ticket: [ticket, imported, waiting, bare],
      decision: [decision, reopened, unavailable],
      thread: [thread],
      trigger: triggers,
    },
  );

  const store = new Store(path);
  expect(store.get("schema")).toBe(SCHEMA_VERSION);
  const settings = store.settings();
  expect(Object.keys(settings.sources)).toEqual(["github"]);
  expect(settings.sources.github!.config).not.toHaveProperty("mergeCli");
  expect(settings.policy.rules[0]).not.toHaveProperty("visual");
  expect(settings.executor).not.toHaveProperty("reviewer");
  expect(settings.executor.prepare).toBe("echo $DSH_SUPERAGENT_DIR");
  // The current settings are the newest revision, which the migration saved, since the newest saved one differs from them.
  const [current, , second, first] = store.settingsHistory();
  expect(current).toMatchObject({ revision: 4, source: "internal", settings });
  expect(store.get("settings")).toBeUndefined();
  expect(first).toMatchObject({
    source: "panel",
    settings: { sources: { feishu: { config: { chats: [{ chatId: "oc_team", listen: "mentions" }] } } } },
  });
  expect(second).toMatchObject({ source: "tool", settings: { sources: { "github-issue": { enabled: true } } } });
  expect(store.get("prompt-version:1")).toMatchObject({
    legacy: { config: { guides: { release: "Use guide/github and dsh-tag-feishu." } } },
    config: { skills: { release: "Use the github section and dsh-superagent-feishu." } },
  });
  // An invalid historical prompt version keeps its raw value under legacy and falls back to the preceding version's config.
  expect(store.get("prompt-version:2")).toMatchObject({
    legacy: { config: { communication: 1 } },
    config: store.get<{ config: object }>("prompt-version:1")!.config,
  });
  expect(store.get("settings-version:3")).toMatchObject({
    source: "panel",
    settings: { executor: { maxWorkers: "many" } },
  });
  const migrated = store.tickets.get("t1")!;
  expect(migrated).not.toHaveProperty("meta");
  expect(store.keys("github-ended:")).toEqual([]);
  expect(store.decisions.get("d3")).toMatchObject({ kind: "unavailable", dismissed: true });
  expect(store.keys("problem-dismissed:")).toEqual([]);
  expect(migrated).toMatchObject({
    origin: { triggerId: "trig-1", triggerIds: ["trig-1", "trig-2"] },
    execution: { name: "fix-1", directory: "/w/fix-1", assignment: "Read trigger/trig-1." },
    delivery: { error: "offline", at: "2" },
    follows: [
      { thread: "github:8", own: true, closed: { at: "2026-09-01T00:00:00Z", outcome: "merged" } },
      { thread: "github:7", own: false },
    ],
    channels: [
      {
        source: "github",
        thread: "github:7",
        address: { number: "7", url: "https://github.com/acme/widgets/pull/7#issuecomment-1" },
      },
    ],
    answers: ["trig-3"],
    mandate: {
      basis: {
        via: "listed",
        source: "feishu",
        scope: { chatId: "oc_team", direct: false },
        sender: "ou_alice",
        addressed: "mention",
      },
    },
  });
  expect(migrated.inputs[0]).toMatchObject({ id: "i1", kind: "text", text: expect.stringContaining('"resumed":true') });
  expect(migrated.inputs[0]).not.toMatchObject({ text: expect.stringContaining("reopen") });
  expect(migrated.inputs[1]).toEqual({ id: "i2", kind: "reopen", decisionId: "d0", at: "0" });
  expect(migrated.inputs.slice(2)).toEqual([
    { id: "i3", kind: "trigger", triggerId: "trig-2", at: "4", human: true },
    { id: "i4", kind: "trigger", triggerId: "ci-1", at: "5" },
  ]);
  expect(migrated).not.toHaveProperty("execution.recoveries");
  expect(store.tickets.get("t2")).toMatchObject({
    execution: { name: "task-2", assignment: "Read event/old" },
    mandate: { basis: { via: "followup", authority: "thread_followup" } },
  });
  expect(store.tickets.get("t2")).not.toHaveProperty("follows");
  // An end's reason that only repeats its outcome is not kept.
  expect(store.tickets.get("t2")!.ended).toEqual({ at: "6", by: "executor", outcome: "merged" });
  // A ticket a person stopped keeps nothing waiting; a ticket stored without its attributes gets an origin all the same.
  expect(store.tickets.get("t4")).toMatchObject({ origin: { triggerId: "", triggerIds: [] } });
  expect(store.tickets.get("t3")).toMatchObject({
    ended: { outcome: "stopped" },
    undelivered: [],
    origin: { triggerId: "", triggerIds: [] },
    mandate: {
      basis: {
        via: "listed",
        source: "feishu",
        scope: { chatId: "p2p", direct: true },
        sender: "ou_alice",
        addressed: "direct",
      },
    },
  });
  expect(store.tickets.get("t3")).not.toHaveProperty("execution");
  // A reason is a code; words the assessor wrote stay as written.
  expect(store.decisions.get("d2")).toEqual({ ...reopened, reason: [{ code: "said", values: { text: "follow-up" } }] });
  expect(store.decisions.get("d3")!.reason).toEqual([{ code: "timeout" }]);
  expect(store.decisions.get("d1")!.mandate!.basis).toEqual({
    via: "listed",
    rules: ["copy"],
    observation: {},
    authority: "proactive_rule",
  });
  expect(store.threads.get("github:5")!.evaluating!.basis).toEqual({
    via: "admission",
    source: "github",
    scope: { number: 5 },
    row: "issues",
    cell: "listedUnaddressed",
    observation: { mode: "auto" },
  });
  // kv: an Input is rendered from its ticket as it is read, so no body stays; records nothing reads go, and so do the
  // removed Issue Source's, which the migration converted.
  expect(store.get("ticket/t1/input/i0")).toBeUndefined();
  expect(store.get("ticket/t1/input/i9")).toBeUndefined();
  expect(store.keys("task/")).toEqual([]);
  for (const name of [
    "answer-ready:t1:trig-3",
    "github-object-state:7",
    "subscriptions",
    "settings-before-9",
    "thread-times-backfilled",
    "prompt-settings-text",
    "feishu-read:orchestrator-1:feishu/e1/thread",
    "github-read:worker-t1:github/pulls/7",
    "feishu-source-link:oc_team:om_1",
    "orchestrator-1:prompt-preview/abc",
  ]) {
    expect(store.get(name)).toBeUndefined();
  }
  expect(store.get("github-issue-pending")).toBeUndefined();
  // The schema 6 tables stay, with the rows the schema 7 import left out.
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox'").get()).toBeDefined();
  store.close();
  // Migrating the result again changes nothing.
  const db = new DatabaseSync(path);
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run();
  db.close();
  const again = new Store(path);
  expect(again.tickets.get("t1")).toEqual(migrated);
  again.close();
});
