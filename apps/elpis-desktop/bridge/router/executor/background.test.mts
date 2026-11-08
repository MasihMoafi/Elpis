// Ported from dsh-superagent (MIT), tests/background.spec.ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { stopSubagents, untilQuiet, killJobs, type Jobs } from "./background.mts";
import type { Context, Agent } from "./runtime.mts";

function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren = async (): Promise<void> => {}) {
  const live = new Map<string, { id: string; owner: string; status: string }>(),
    events = new Set<(event: { type: string }) => void>();
  let looks = 0,
    joins = 0,
    cancelled = 0;
  const waits: (() => void)[] = [];
  const jobs: Jobs = {
    list: () => {
      looks++;
      return [...live.values()];
    },
    wait: async id => {
      const job = live.get(id)!;
      if (job.status === "running") await new Promise<void>(resolve => waits.push(resolve));
      return { status: job.status };
    },
    kill: id => end(id),
    events: {
      subscribe: (_filter, listener) => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
    },
  };
  const agent: Agent & { status: "running" | "idle" } = {
    id: "worker-t1",
    status: "idle",
    whenIdle: async () => {},
    inbox: { remove: () => {} },
    session: { snapshotEvents: () => [] },
    cancel: () => {
      cancelled++;
      agent.status = "idle";
    },
  };
  const ctx: Context = {
    jobs,
    subagents: {
      waitForChildren: agent => {
        joins++;
        return waitForChildren(agent);
      },
      listChildren: async () => [{ id: "child-1" }],
      drainChildren,
    },
    agents: new Map([["child-1", agent]]),
    subprocess: {
      spawn: () => {
        throw new Error("No subprocess expected");
      },
    },
    on: () => () => {},
  };
  function run(owner = agent.id) {
    const id = `job-${live.size}`;
    live.set(id, { id, owner, status: "running" });
    return id;
  }
  function end(id: string) {
    live.get(id)!.status = "ended";
    for (const wait of waits.splice(0)) wait();
    for (const event of events) event({ type: "settled" });
  }
  return { ctx, agent, jobs, run, end, events, looks: () => looks, joins: () => joins, cancelled: () => cancelled };
}
it("is not quiet when an end during the subagent check woke the worker", async () => {
  const h = setup(async () => {
      h.end(id);
      h.agent.status = "running";
      return false;
    }),
    id = h.run();
  assert.equal(await untilQuiet(h.ctx, h.agent, new AbortController().signal), false);
});
it("stops waiting for subagents that never settle once the host stops", async () => {
  const h = setup(() => new Promise(() => {})),
    stop = new AbortController();
  const quiet = untilQuiet(h.ctx, h.agent, stop.signal);
  stop.abort();
  assert.equal(await quiet, false);
});
it("looks at jobs only when one ends, not at every output of a noisy one", async () => {
  const h = setup(async () => false),
    id = h.run(),
    stop = new AbortController();
  const quiet = untilQuiet(h.ctx, h.agent, stop.signal);
  await setImmediate();
  const looked = h.looks();
  for (let line = 0; line < 100; line++) for (const event of h.events) event({ type: "output" });
  assert.equal(h.looks(), looked);
  h.end(id);
  assert.equal(await quiet, true);
});
it("joins a worker's subagents once across aborted looks", async () => {
  const h = setup(() => new Promise(() => {}));
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController(),
      quiet = untilQuiet(h.ctx, h.agent, stop.signal);
    stop.abort();
    assert.equal(await quiet, false);
  }
  assert.equal(h.joins(), 1);
});
it("bounds a release that never ends and cancels the turn its children woke", async t => {
  const h = setup(
    async () => false,
    () => new Promise(() => {}),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = stopSubagents(h.ctx, h.agent);
  await setImmediate();
  t.mock.timers.tick(10_000);
  await stopping;
  assert.equal(h.cancelled(), 1);
});
it("stops all owned jobs after one kill fails, and leaves unrelated jobs alone", async () => {
  const h = setup(async () => false),
    one = h.run(),
    two = h.run(),
    other = h.run("unrelated");
  h.jobs.kill = id => {
    h.end(id);
    if (id === one) throw new Error("Kill failed");
  };
  await assert.rejects(killJobs(h.ctx, h.agent.id, "stop"), AggregateError);
  assert.equal(h.jobs.list(h.agent.id).find(job => job.id === two)?.status, "ended");
  assert.equal(h.jobs.list(h.agent.id).find(job => job.id === other)?.status, "running");
});
