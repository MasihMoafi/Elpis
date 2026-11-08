import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { Store, SCHEMA_VERSION } from "./store.mts";
import { MemoryRepositories, type Decision, type Repositories } from "../core/index.mts";
import { threadFacts } from "./views/records.mts";
import { KV } from "../sources/kv.mts";
import { SettingsSchema } from "../policy.mts";
import { directory, ticket, thread, ids } from "./store.fixtures.mts";

it("refuses databases newer than this build and rolls back failed atomic work", () => {
  const path = join(directory, "orchestrator.sqlite");
  const store = new Store(path);
  expect(() =>
    store.atomic(() => {
      store.set("a", 1);
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(store.get("a")).toBeUndefined();
  store.set("schema", SCHEMA_VERSION + 1);
  store.close();
  expect(() => new Store(path)).toThrow("Unsupported");
});

it("finds triggers by thread", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  store.triggers.save({
    id: "a",
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_1:om_%_x" }],
    actor: { source: "feishu", id: "u" },
    human: true,
    at: "2",
    text: "later",
    meta: {},
  });
  store.triggers.save({
    id: "b",
    source: "feishu",
    threads: [
      { source: "feishu", id: "oc_1:om_%_x" },
      { source: "github", id: "3" },
    ],
    actor: { source: "feishu", id: "u" },
    human: true,
    at: "1",
    text: "earlier",
    meta: {},
  });
  store.triggers.save({
    id: "c",
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_1:om_y_x" }],
    actor: { source: "feishu", id: "u" },
    human: true,
    at: "3",
    text: "other",
    meta: {},
  });
  expect(store.read.threadTriggers("feishu:oc_1:om_%_x").map(trigger => trigger.id)).toEqual(["b", "a"]);
  expect(store.read.threadTriggers("github:3").map(trigger => trigger.id)).toEqual(["b"]);
  // Saving a Trigger again replaces the Threads it is found on.
  store.triggers.save({ ...store.triggers.get("b")!, threads: [{ source: "github", id: "3" }] });
  expect(store.read.threadTriggers("feishu:oc_1:om_%_x").map(trigger => trigger.id)).toEqual(["a"]);
  expect(store.read.threadTriggers("github:3").map(trigger => trigger.id)).toEqual(["b"]);
  expect(store.read.subscribedThreads()).toEqual([]);
  store.close();
});

it("reads the working sets alone, in SQLite as in memory, and follows each save", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
    repo.tickets.save(ticket("running", "open", [{ state: "running" }]));
    // A retry or a resume adds a pending Assignment after the ones that ended.
    repo.tickets.save(ticket("queued", "open", [{ state: "ended" }, { state: "pending" }]));
    // An ended Ticket a person's message reached without resuming it, which versions before schema 11 left to their next pass.
    repo.tickets.save(ticket("waking", "ended", [{ state: "ended" }], ["input"]));
    repo.tickets.save(ticket("done", "ended", [{ state: "ended" }]));
    repo.threads.save(thread("1", "github", { pending: ["a"] }));
    repo.threads.save(
      thread("2", "github", {
        subscriptions: ["running"],
        evaluating: {
          id: "e",
          threadKey: "github:2",
          triggerIds: ["b"],
          strength: "explicit",
          actor: { source: "github", id: "alice" },
          basis: { via: "followup" },
          policyVersion: "",
          startedAt: "",
          deadline: "",
        },
      }),
    );
    repo.threads.save(thread("oc:om", "feishu", { subscriptions: ["done"] }));
    repo.threads.save(thread("3", "github"));
    expect(ids(repo.tickets.open())).toEqual(["queued", "running"]);
    expect(ids(repo.tickets.active())).toEqual(["queued", "running", "waking"]);
    expect(ids(repo.threads.active())).toEqual(["github:1", "github:2"]);
    repo.tickets.save(ticket("running", "ended", [{ state: "ended" }]));
    repo.threads.save(thread("1", "github"));
    expect(ids(repo.tickets.open())).toEqual(["queued"]);
    expect(ids(repo.tickets.active())).toEqual(["queued", "waking"]);
    expect(ids(repo.threads.active())).toEqual(["github:2"]);
  }
  expect(ids(store.read.subscribedThreads())).toEqual(["feishu:oc:om", "github:2"]);
  expect(ids(store.read.subscribedThreads("github"))).toEqual(["github:2"]);
  store.close();
});

it("adds the working sets to a database that predates them, from the rows it holds", () => {
  const path = join(directory, "orchestrator.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare("INSERT INTO kv VALUES (?,?)").run("schema", String(SCHEMA_VERSION));
  db.prepare("INSERT INTO ticket VALUES (?,?)").run("t", JSON.stringify(ticket("t", "open", [{ state: "running" }])));
  db.prepare("INSERT INTO thread VALUES (?,?)").run(
    "github:1",
    JSON.stringify(thread("1", "github", { pending: ["a"], subscriptions: ["t"] })),
  );
  db.close();
  const store = new Store(path);
  expect([ids(store.tickets.open()), ids(store.tickets.active())]).toEqual([["t"], ["t"]]);
  expect([ids(store.threads.active()), ids(store.read.subscribedThreads("github"))]).toEqual([
    ["github:1"],
    ["github:1"],
  ]);
  store.close();
});

it("names a thread by its first human trigger", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  const base = {
    source: "github",
    threads: [{ source: "github", id: "5" }],
    actor: { source: "github", id: "x" },
    meta: {},
  };
  store.triggers.save({ ...base, id: "ci", human: false, at: "1", text: "GitHub PR #5 CI: {}" });
  store.triggers.save({ ...base, id: "person", human: true, at: "2", text: "please look" });
  expect(store.read.firstTrigger("github:5")?.id).toBe("ci");
  expect(store.read.firstTrigger("github:5", true)?.id).toBe("person");
  store.close();
});

it("counts triggers per Source and lists them newest first, optionally only the filtered ones", () => {
  const store = new Store(join(directory, "db.sqlite"));
  const trigger = (id: string, source: string, at: string) => ({
    id,
    source,
    threads: [{ source, id: "x" }],
    actor: { source, id: "a" },
    human: true,
    at,
    text: id,
    meta: {},
  });
  store.triggers.save(trigger("old", "feishu", "2026-09-01T00:00:00Z"));
  store.triggers.save(trigger("kept", "feishu", "2026-09-23T00:00:00Z"));
  store.triggers.save(trigger("dropped", "feishu", "2026-09-23T01:00:00Z"));
  store.triggers.saveDisposition("dropped", { filtered: { code: "chat_not_allowed" }, fanout: [], at: "" });
  store.triggers.save(trigger("gh", "github", "2026-09-22T00:00:00Z"));
  expect(store.read.triggerStats("2026-09-22T12:00:00Z")).toEqual({
    feishu: { received: 2, filtered: 1, lastAt: "2026-09-23T01:00:00Z" },
    github: { received: 0, filtered: 0, lastAt: "2026-09-22T00:00:00Z" },
  });
  expect(store.read.triggers({ source: "feishu" }, 0, 2)).toEqual({
    items: [expect.objectContaining({ id: "dropped" }), expect.objectContaining({ id: "kept" })],
    more: true,
  });
  expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(["dropped"]);
  store.close();
});

it("links a Thread to the page its Source named, or else to the message that started it", () => {
  const store = new Store(join(directory, "links.sqlite"));
  const thread = (keyValue: string, source: string, id: string, meta: Record<string, unknown> = {}) =>
    store.threads.save({
      key: keyValue,
      ref: { source, id },
      createdAt: "",
      subscriptions: [],
      correlated: [],
      pending: [],
      meta,
    });
  thread("github:7", "github", "7", { url: "https://github.com/acme/widgets/pull/7" });
  thread("feishu:oc_1:om_1", "feishu", "oc_1:om_1");
  store.triggers.save({
    id: "f1",
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_1:om_1" }],
    actor: { source: "feishu", id: "ou_a" },
    human: true,
    at: "1",
    text: "hi",
    url: "https://applink.feishu.cn/client/message/link/open?token=t",
    meta: {},
  });
  expect(threadFacts(store, store.threads.get("github:7")!).url).toBe("https://github.com/acme/widgets/pull/7");
  expect(threadFacts(store, store.threads.get("feishu:oc_1:om_1")!).url).toBe(
    "https://applink.feishu.cn/client/message/link/open?token=t",
  );
  store.close();
});

it("sets and removes a Source's keys in a Thread's meta", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  store.threads.save({
    key: "github:5",
    ref: { source: "github", id: "5" },
    createdAt: "",
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: { isPr: true, gone: true },
  });
  store.threads.patchMeta("github:5", { gone: undefined, title: "Fix" });
  expect(store.threads.get("github:5")!.meta).toEqual({ isPr: true, title: "Fix" });
  store.threads.patchMeta("github:6", { title: "none" });
  expect(store.threads.get("github:6")).toBeUndefined();
  store.close();
});

it("spells every kv key in KV alone, so each record is named by its entry there", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = Object.values(KV).flatMap(group => Object.values(group) as (string | { prefix: string })[]);
  // Ignore single-word keys that collide with unrelated string literals.
  const keys = entries
    .map(entry => (typeof entry === "string" ? entry : entry.prefix))
    .filter(name => /[-:]/.test(name));
  const modules = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    path =>
      /\.mts$/.test(path) &&
      !path.includes(".test.") &&
      !path.includes(".fixtures.") &&
      !path.startsWith("fixtures/") &&
      !["sources/kv.mts", "app/migration.mts"].includes(path),
  );
  const spelled = modules.flatMap(path => {
    const text = readFileSync(join(src, path), "utf8");
    return keys.filter(name => text.includes(`'${name}`) || text.includes(`\`${name}`)).map(name => `${path}: ${name}`);
  });
  expect(spelled).toEqual([]);
});

it("runs what waits for a commit once the outermost transaction commits, and never what a rolled back one queued", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  const ran: string[] = [];
  store.atomic(() => {
    store.afterCommit(() => {
      ran.push("outer");
    });
    store.atomic(() => {
      store.afterCommit(() => {
        ran.push("inner");
      });
    });
    expect(() =>
      store.atomic(() => {
        store.afterCommit(() => {
          ran.push("rolled back");
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // Nothing runs before the outermost transaction commits.
    expect(ran).toEqual([]);
  });
  expect(ran).toEqual(["outer", "inner"]);
  expect(() =>
    store.atomic(() => {
      store.afterCommit(() => {
        ran.push("failed");
      });
      throw new Error("boom");
    }),
  ).toThrow("boom");
  store.afterCommit(() => {
    ran.push("outside");
  });
  expect(ran).toEqual(["outer", "inner", "outside"]);
  store.close();
});

it("reports an action that fails after a commit, runs the others, and keeps what committed", () => {
  const reported: unknown[] = [];
  const store = new Store(join(directory, "orchestrator.sqlite"), error => {
    reported.push(error);
  });
  const ran: string[] = [];
  const value = store.atomic(() => {
    store.set(KV.runtime.masterId, "m");
    store.afterCommit(() => {
      throw new Error("cancel failed");
    });
    store.afterCommit(() => {
      ran.push("next");
    });
    return "done";
  });
  expect(value).toBe("done");
  expect(ran).toEqual(["next"]);
  expect(reported).toEqual([new Error("cancel failed")]);
  expect(store.get(KV.runtime.masterId)).toBe("m");
  store.close();
});

it("closes a database it cannot open as this version's, so a later attempt can open it", () => {
  const path = join(directory, "orchestrator.sqlite");
  const store = new Store(path);
  store.set(KV.store.schema, SCHEMA_VERSION + 1);
  store.close();
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  try {
    expect(() => new Store(path)).toThrow("Unsupported orchestrator database version");
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

it("keeps the settings as versions: the current settings are the snapshot of the current revision, kept nowhere else", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  expect(store.settings()).toEqual(SettingsSchema.parse({}));
  store.saveSettings(
    { ...store.settings(), paused: true },
    { source: "panel", block: "pause", policyVersion: "v", policyChanged: false, notified: [] },
  );
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 5 } });
  expect(store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } });
  expect(store.settingsHistory().map(version => [version.revision, version.source])).toEqual([
    [2, "internal"],
    [1, "panel"],
  ]);
  expect([
    store.get(KV.settings.revision),
    store.blockRevision("pause"),
    store.keys("settings").filter(name => name === "settings"),
  ]).toEqual([2, 1, []]);
  store.close();
});

it("replaces a working-set column an earlier build defined otherwise, and drops one this version no longer has", () => {
  const path = join(directory, "orchestrator.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE ticket ADD COLUMN open INTEGER AS (CASE WHEN value ->> '$.state' = 'open' THEN 1 END);
    ALTER TABLE ticket ADD COLUMN ref TEXT AS (nullif(value ->> '$.assignments[#-1].ref', ''));
    CREATE INDEX ticket_open ON ticket(open) WHERE open IS NOT NULL; CREATE INDEX ticket_ref ON ticket(ref) WHERE ref IS NOT NULL`);
  db.prepare("INSERT INTO kv VALUES (?,?)").run("schema", String(SCHEMA_VERSION));
  db.prepare("INSERT INTO ticket (id, value) VALUES (?,?)").run(
    "t",
    JSON.stringify(ticket("t", "open", [{ state: "running" }])),
  );
  db.close();
  const store = new Store(path);
  // The open set reads the ticket's end now.
  expect(ids(store.tickets.open())).toEqual(["t"]);
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('ticket') WHERE name = 'ref'").all()).toEqual([]);
  store.close();
});

it("lists in the same order in SQLite and in memory, and undoes a failed nested transaction alone in both", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  const order = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key);
  const decision = (id: string): Decision => ({
    id,
    evalId: "",
    threadKey: "github:1",
    triggerIds: [],
    policyVersion: "",
    at: id,
    kind: "ignore",
    reason: [],
    strength: "explicit",
  });
  const run = (repo: Repositories) => {
    repo.tickets.save(ticket("first", "open", [{ state: "running" }]));
    repo.tickets.save(ticket("second", "ended", [{ state: "ended" }]));
    repo.tickets.save(ticket("third", "open", [{ state: "pending" }]));
    // Saving a ticket again keeps its place.
    repo.tickets.save({ ...repo.tickets.get("first")!, title: "again" });
    repo.threads.save(thread("1", "github", { pending: ["a"] }));
    repo.threads.save(thread("2", "github"));
    repo.threads.save(thread("3", "github", { pending: ["b"] }));
    repo.decisions.save(decision("d2"));
    repo.decisions.save(decision("d1"));
    // A failed nested transaction undoes its own writes; the one around it goes on and keeps its own.
    repo.atomic(() => {
      repo.tickets.save(ticket("outer", "open", []));
      expect(() =>
        repo.atomic(() => {
          repo.tickets.save(ticket("inner", "open", []));
          throw new Error("boom");
        }),
      ).toThrow("boom");
    });
    return {
      tickets: order(repo.tickets.list()),
      open: order(repo.tickets.open()),
      active: order(repo.tickets.active()),
      threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()),
      decisions: order(repo.decisions.byThread("github:1")),
    };
  };
  const memory = run(new MemoryRepositories());
  expect(memory).toEqual({
    tickets: ["outer", "third", "second", "first"],
    open: ["outer", "third", "first"],
    active: ["third", "first"],
    threads: ["github:1", "github:2", "github:3"],
    activeThreads: ["github:1", "github:3"],
    decisions: ["d2", "d1"],
  });
  expect(run(store)).toEqual(memory);
  store.close();
});

it("creates the state directory for its owner alone, and the database readable by its owner alone", () => {
  const path = join(directory, "state", "orchestrator.sqlite");
  new Store(path).close();
  expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600]);
});
