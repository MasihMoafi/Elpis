// Ported from dsh-superagent (MIT), tests/effects.spec.ts
/** The durable effect queue: coalescing, per-kind limits, retries with backoff, health and shutdown. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { expect } from "expect";
import { fn } from "jest-mock";
import { Effects, Later } from "./effects.mts";
import { ExecutorStore as Store } from "./store.mts";
import { HealthBoard } from "../infra/health.mts";
import { deferred, waitFor } from "./fixtures.mts";

let directory: string;
let store: Store;
let clock: number;
let board: HealthBoard;
let health: Readonly<Record<string, unknown>>;
let effects: Effects;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "effects-"));
  store = new Store(directory);
  clock = Date.parse("2026-09-09T00:00:00Z");
  board = new HealthBoard();
  health = board.all;
  effects = new Effects(store, board, () => clock);
  effects.start();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const relay = (text: string) => ({ text });

it("runs an effect queued inside a transaction once it commits, and none from a transaction that rolled back", async () => {
  const run = fn(async () => {});
  effects.handle("relay", run);
  store.atomic(() => {
    effects.enqueue("relay", "kept", relay("a"));
  });
  expect(() =>
    store.atomic(() => {
      effects.enqueue("relay", "dropped", relay("b"));
      throw new Error("rolled back");
    }),
  ).toThrow("rolled back");
  await effects.idle();
  expect(run.mock.calls).toEqual([[relay("a"), "kept"]]);
  expect(effects.pending("relay")).toBe(false);
});

it("keeps one effect per key with the latest payload, and runs it again when a new payload arrives while it runs", async () => {
  const hold = deferred();
  const run = fn(async (payload: { text: string }) => {
    if (payload.text === "first") await hold.promise;
  });
  effects.handle("relay", run);
  effects.enqueue("relay", "k", relay("first"));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  effects.enqueue("relay", "k", relay("second"));
  effects.enqueue("relay", "k", relay("third"));
  hold.resolve();
  await effects.idle();
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(["first", "third"]);
});

it("runs a kind oldest first, as many at once as its limit allows, and holds it while the limit is 0", async () => {
  const holds = new Map<string, ReturnType<typeof deferred<void>>>();
  let limit = 2;
  const run = fn(async (_payload: unknown, key: string) => {
    const hold = deferred();
    holds.set(key, hold);
    await hold.promise;
  });
  effects.handle("launch", run, { limit: () => limit });
  for (const key of ["a", "b", "c"]) effects.enqueue("launch", key, { ticketId: key, assignmentId: key });
  await waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(["a", "b"]));
  limit = 0;
  holds.get("a")!.resolve();
  await waitFor(() => expect(effects.pending("launch", "a")).toBe(false));
  effects.kick();
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2);
  limit = 2;
  holds.get("b")!.resolve();
  await waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(["a", "b", "c"]));
  holds.get("c")!.resolve();
  await effects.idle();
});

it("keeps an effect's place in its queue when it is queued again with a new payload", async () => {
  const run = fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {});
  let room = 0;
  effects.handle("launch", run, { limit: () => room });
  store.atomic(() => {
    effects.enqueue("launch", "first", { ticketId: "t1", assignmentId: "a1" });
    effects.enqueue("launch", "second", { ticketId: "t2", assignmentId: "a2" });
    effects.enqueue("launch", "first", { ticketId: "t1", assignmentId: "a1" });
  });
  await effects.idle();
  room = 1;
  await effects.idle();
  expect(run.mock.calls.map(([, key]) => key)).toEqual(["first", "second"]);
});

it("retries a failed effect after a delay that doubles up to its maximum, and reports the kind in error after three failures", async () => {
  let fail = true;
  const run = fn(async () => {
    if (fail) throw new Error("session busy");
  });
  effects.handle("notice", run, { retry: [1000, 3000] });
  effects.enqueue("notice", "prompts", { value: { prompt_config_saved: 2 }, summary: "Prompt configuration saved" });
  await effects.idle();
  expect(health.notice).toMatchObject({ state: "ready", detail: "1 waiting since 2026-09-09T00:00:00.000Z" });
  for (const wait of [1000, 2000, 3000, 3000]) {
    clock += wait - 1;
    await effects.idle();
    const calls = run.mock.calls.length;
    clock += 1;
    await effects.idle();
    expect(run).toHaveBeenCalledTimes(calls + 1);
    if (wait === 2000)
      expect(health.notice).toMatchObject({
        state: "error",
        detail: expect.stringContaining(
          "1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy",
        ),
      });
  }
  fail = false;
  clock += 3000;
  await effects.idle();
  expect(health.notice).toMatchObject({ state: "ready", detail: "Nothing waiting" });
  expect(effects.pending("notice")).toBe(false);
});

it("starts nothing once drained, keeps what waits and what shutdown cut short, and runs it after the next start", async () => {
  const hold = deferred();
  effects.handle("relay", async () => {
    await hold.promise;
    throw new Error("aborted");
  });
  effects.enqueue("relay", "cut", relay("a"));
  await waitFor(() => expect(effects.pending("relay", "cut")).toBe(true));
  await Promise.resolve();
  const drained = effects.drain();
  effects.enqueue("relay", "later", relay("b"));
  hold.resolve();
  await drained;
  const next = new Effects(store, new HealthBoard(), () => clock);
  next.start();
  const run = fn(async (_payload: { text: string }, _key: string) => {});
  next.handle("relay", run);
  await next.idle();
  expect(run.mock.calls.map(([, key]) => key)).toEqual(["cut", "later"]);
});

it("lets a handler defer an effect without a failure, until a later dispatch after its first delay", async () => {
  let later = true;
  const run = fn(async () => {
    if (later) throw new Later("paused");
  });
  effects.handle("launch", run, { retry: [5000, 60_000] });
  effects.enqueue("launch", "a", { ticketId: "t", assignmentId: "a" });
  await effects.idle();
  expect(health.launch).toMatchObject({ state: "ready", detail: "1 waiting since 2026-09-09T00:00:00.000Z" });
  later = false;
  clock += 4999;
  await effects.idle();
  expect(run).toHaveBeenCalledTimes(1);
  clock += 1;
  await effects.idle();
  expect(run).toHaveBeenCalledTimes(2);
  expect(effects.pending("launch")).toBe(false);
});

it("runs an ordered kind one at a time in the order queued, and holds the later effects while an earlier one fails", async () => {
  const failing = new Set(["first"]);
  const run = fn(async (_payload: { text: string }, key: string) => {
    if (failing.has(key)) throw new Error("offline");
  });
  effects.handle("relay", run, { ordered: true, limit: () => 4, retry: [1000, 1000] });
  effects.enqueue("relay", "first", relay("a"));
  effects.enqueue("relay", "second", relay("b"));
  await effects.idle();
  clock += 1000;
  await effects.idle();
  expect(run.mock.calls.map(([, key]) => key)).toEqual(["first", "first"]);
  failing.clear();
  clock += 1000;
  await effects.idle();
  expect(run.mock.calls.map(([, key]) => key)).toEqual(["first", "first", "first", "second"]);
});

it("keeps a quiet kind's failures out of its health, and asks no limit while nothing is due", async () => {
  const limit = fn(() => 4);
  effects.handle(
    "delivery",
    async () => {
      throw new Error("Session gone");
    },
    { quiet: true, limit, retry: [1000, 1000] },
  );
  effects.kick();
  await effects.idle();
  expect(limit).not.toHaveBeenCalled();
  effects.enqueue("delivery", "t", { ticketId: "t" });
  for (let attempt = 0; attempt < 4; attempt++) {
    await effects.idle();
    clock += 1000;
  }
  expect(health.delivery).toMatchObject({ state: "ready", detail: "1 waiting since 2026-09-09T00:00:00.000Z" });
});

it("keeps an effect cancelled and queued again while its first run goes on, which the first run does not end", async () => {
  const hold = deferred<void>();
  const run = fn(async (_payload: { text: string }, _key: string) => {
    if (run.mock.calls.length === 1) await hold.promise;
  });
  effects.handle("relay", run);
  effects.enqueue("relay", "k", relay("first"));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  effects.cancel("relay", "k");
  effects.enqueue("relay", "k", relay("second"));
  hold.resolve();
  await effects.idle();
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(["first", "second"]);
  expect(effects.pending("relay")).toBe(false);
});

it("queues an effect after a restart behind the ones that waited, for a kind that keeps its order", async () => {
  const hold = deferred<void>();
  effects.handle(
    "relay",
    async () => {
      await hold.promise;
      throw new Error("aborted");
    },
    { ordered: true },
  );
  effects.enqueue("relay", "first", relay("a"));
  effects.enqueue("relay", "second", relay("b"));
  await waitFor(() => expect(effects.pending("relay", "first")).toBe(true));
  const drained = effects.drain();
  hold.resolve();
  await drained;
  // Sequence numbers continue across restarts so newly queued effects run after existing pending ones.
  const next = new Effects(store, new HealthBoard(), () => clock);
  next.enqueue("relay", "third", relay("c"));
  next.start();
  const run = fn(async (_payload: { text: string }, _key: string) => {});
  next.handle("relay", run, { ordered: true });
  await next.idle();
  expect(run.mock.calls.map(([, key]) => key)).toEqual(["first", "second", "third"]);
});

it("reports a failure of the queue itself under its kind, until a dispatch of that kind succeeds again", async () => {
  let broken = true;
  effects.handle("relay", async () => {}, {
    limit: () => {
      if (broken) throw new Error("database is locked");
      return 1;
    },
  });
  effects.enqueue("relay", "k", relay("a"));
  await effects.idle();
  expect(health.relay).toMatchObject({ state: "error", detail: "The effect queue failed: Error: database is locked" });
  broken = false;
  effects.kick();
  await effects.idle();
  expect(health.relay).toMatchObject({ state: "ready", detail: "Nothing waiting" });
});

it("refuses a second handler for a kind", () => {
  effects.handle("relay", async () => {});
  expect(() => effects.handle("relay", async () => {})).toThrow("The relay effects already have a handler");
});
