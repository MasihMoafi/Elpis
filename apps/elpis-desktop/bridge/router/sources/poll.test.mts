// Ported from dsh-superagent (MIT), tests/sources.spec.ts
import { it } from "node:test";
import { expect } from "expect";
import { cursorAt, polled, pollThreads, POLL_HORIZON_MS } from "./poll.mts";
import type { SourceContext } from "./host.mts";
import type { Thread, Ticket } from "../core/index.mts";

const thread = (key: string, at: string, subscriptions: string[] = []): Thread => ({
  key,
  ref: { source: "github", id: key },
  createdAt: at,
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
});
it("polls recent threads and old threads with live tickets, but not expired ones", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const ctx = { tickets: { get: (id: string) => (id === "live" ? ({} as Ticket) : undefined) } } as SourceContext;
  expect(polled(ctx, thread("recent", new Date(now - POLL_HORIZON_MS + 1).toISOString()), now)).toBe(true);
  expect(polled(ctx, thread("old", new Date(now - POLL_HORIZON_MS - 1).toISOString()), now)).toBe(false);
  expect(polled(ctx, thread("followed", new Date(now - POLL_HORIZON_MS - 1).toISOString(), ["live"]), now)).toBe(true);
  expect(cursorAt("2026-10-01T00:00:10Z")).toBe("2026-10-01T00:00:05.000Z");
});
it("records a failed thread without stopping the next and clears an old error on success", async () => {
  const rows = [thread("bad", new Date().toISOString()), thread("good", new Date().toISOString())];
  const patches: [string, Record<string, unknown>][] = [];
  const ctx = {
    tickets: {
      get: (): Ticket | undefined => undefined,
      open: (): Ticket[] => [],
      bindThread: () => {},
      threadClosed: () => {},
    },
    threads: {
      get: (): Thread | undefined => undefined,
      describe: () => {},
      subscribed: () => rows,
      patch: (id: string, meta: Record<string, unknown>) => {
        patches.push([id, meta]);
      },
    },
  } as Pick<SourceContext, "tickets" | "threads"> as SourceContext;
  await pollThreads(
    ctx,
    "github",
    () => false,
    async row => {
      if (row.key === "bad") throw new Error("offline");
    },
  );
  expect(patches).toEqual([
    ["bad", { pollError: "Error: offline" }],
    ["good", { pollError: undefined }],
  ]);
});
