// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/timeline.spec.ts.
/** Thread timeline pagination, neighbour lookup, and timestamp normalization. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { expect } from "expect";
import { Engine, type ChannelRef, type Trigger } from "../core/index.mts";
import { Store } from "./store.mts";
import { threadDetail } from "./views/threads.mts";
import { SettingsSchema, settingsPolicy } from "../policy.mts";
import { githubKind } from "../sources/github.mts";
import { githubLink } from "../sources/github-channel.mts";
import { SourceRegistry } from "../sources/registry.mts";

let directory: string;
let store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dsh-superagent-timeline-"));
  store = new Store(join(directory, "orchestrator.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const sources = new SourceRegistry(() => SettingsSchema.parse({}));
sources.register(githubKind);
const host = () => ({ store, sources, links: (channel: ChannelRef) => githubLink(channel.address, {}) });
const engine = () =>
  new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(SettingsSchema.parse({}), sources),
    assessor: { request: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
  });
const comment = (id: string, at: string): Trigger => ({
  id,
  source: "github",
  threads: [{ source: "github", id: "7" }],
  actor: { source: "github", id: "alice" },
  human: true,
  at,
  text: `comment ${id}`,
  meta: {},
});
const saveThread = () =>
  store.threads.save({
    key: "github:7",
    ref: { source: "github", id: "7" },
    createdAt: "",
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
  });
const ids = (detail: ReturnType<typeof threadDetail>) => detail!.timeline.map(item => item.id);

it("pages a thread by time and then id, so a Trigger of the same second as a page's oldest one shows on the next page", () => {
  saveThread();
  for (const item of [
    comment("a", "2026-10-01T00:00:00.000Z"),
    comment("b", "2026-10-01T00:00:01.000Z"),
    comment("c", "2026-10-01T00:00:01.000Z"),
  ])
    store.triggers.save(item);
  const first = threadDetail(host(), "github:7", undefined, 1)!;
  const second = threadDetail(host(), "github:7", first.earlier!, 1)!;
  const third = threadDetail(host(), "github:7", second.earlier!, 1)!;
  expect([ids(first), ids(second), ids(third), third.earlier]).toEqual([["c"], ["b"], ["a"], null]);
  // Legacy timestamp-only cursors still page before that timestamp.
  expect(ids(threadDetail(host(), "github:7", "2026-10-01T00:00:01.000Z", 5))).toEqual(["a"]);
});

it("shows the page around a GitHub comment with that comment, though GitHub writes its time in whole seconds", () => {
  // Lexicographically, `...:00Z` sorts after `...:00.001Z` unless normalized to milliseconds.
  const taking = engine();
  for (const item of [
    comment("old", "2026-10-01T00:00:00Z"),
    comment("new", "2026-10-01T00:00:00.500Z"),
    comment("newest", "2026-10-01T00:00:01Z"),
  ]) {
    taking.receive(item);
  }
  expect(ids(threadDetail(host(), "github:7", undefined, 50, "old"))).toEqual(["old"]);
  expect(ids(threadDetail(host(), "github:7", undefined, 50, "new"))).toEqual(["old", "new"]);
});

it("finds the Triggers before and after one among Triggers of the same time", () => {
  for (const item of [
    comment("a", "2026-10-01T00:00:01.000Z"),
    comment("b", "2026-10-01T00:00:01.000Z"),
    comment("c", "2026-10-01T00:00:01.000Z"),
  ])
    store.triggers.save(item);
  const around = store.read.neighbours("github:7", "2026-10-01T00:00:01.000Z", "b");
  expect([around.before?.id, around.after?.id]).toEqual(["a", "c"]);
});

it("stores every received Trigger's time in the one form stored times take", () => {
  engine().receive(comment("raw", "2026-10-01T08:00:00+08:00"));
  expect(store.triggers.get("raw")?.at).toBe("2026-10-01T00:00:00.000Z");
  expect(store.read.threadTriggers("github:7").map(item => item.at)).toEqual(["2026-10-01T00:00:00.000Z"]);
});
