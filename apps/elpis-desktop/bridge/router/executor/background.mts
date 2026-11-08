// Ported from dsh-superagent (MIT), src/executor/background.ts
/**
 * A worker's background work in DSH: the shell jobs its Session owns (`ctx.jobs`) and its subagents (`ctx.subagents`). They
 * keep the worker busy after its turn ended, and they stop with its Assignment. A profile without either service has none.
 */
import type { Context, Agent } from "./runtime.mts";

/** What the Executor uses of DSH's job registry: the jobs a Session can see, their events, a wait for one and a kill. */
export interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[];
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>;
  kill(id: string, caller: string, reason?: string): unknown;
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void };
}
/** What the Executor uses of DSH's subagents: joining a worker's subagents that work, its subagents, and releasing them. */
export interface Subagents {
  waitForChildren(parent: Agent): Promise<boolean>;
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>;
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>;
}
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 10_000;
/** How long a release of subagents may take; it can hold up a shutdown, so DSH's own callers bound it too. */
const DRAIN_LIMIT_MS = 10_000;
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
const COLLECT_WAIT_MS = 10 * 60_000;

const registry = (ctx: Context): Jobs | undefined => ctx.jobs;
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.subagents;
const running = (status: string) => status === "running" || status === "stopping";
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id));
/** `work`, or false once `signal` aborts or `ms` pass first. */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false);
  let stop!: () => void;
  const stopped = new Promise<false>(resolve => {
    stop = () => {
      resolve(false);
    };
  });
  signal?.addEventListener("abort", stop, { once: true });
  const timer = ms === undefined ? undefined : setTimeout(stop, ms);
  timer?.unref?.();
  return Promise.race([work, stopped]).finally(() => {
    signal?.removeEventListener("abort", stop);
    clearTimeout(timer);
  });
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
export const cancelled = new WeakSet<Agent>();
/** The pending join of each worker's subagents, which DSH cannot cancel, so a later look joins the same one. */
const joins = new WeakMap<Agent, Promise<boolean>>();
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent);
  if (!join) {
    join = subagents.waitForChildren(agent).finally(() => {
      joins.delete(agent);
    });
    joins.set(agent, join);
  }
  return join;
}

/** A job by its id and the first line of its label. */
const named = (job: { id: string; label?: string }) => {
  const line = job.label?.split("\n")[0]?.trim();
  return line ? `${job.id} (${line})` : job.id;
};
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
export const runningJobs = (
  ctx: Context,
  sessionId: string,
  except?: ReadonlySet<string>,
): { id: string; name: string }[] => {
  const jobs = registry(ctx);
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : [];
};

/**
 * Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
 * no waiter on any job, so each job's end still reaches the worker.
 */
function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx);
  if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => {
      done(false);
    };
    // Only an end can leave no job running; a job's output does not.
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === "settled" || event.type === "removed") && !owned(jobs, sessionId, except).length) done(true);
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/**
 * Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents. A job's or a
 * subagent's end wakes the worker with its result, which ends this look: the turn it starts ends with an idle of its own,
 * which looks afresh.
 * @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
 * as when the host stops or the look's time is up.
 */
export async function untilQuiet(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  except?: ReadonlySet<string>,
): Promise<boolean> {
  for (;;) {
    await ctx.refresh?.(agent.id);
    const subagents = subagentsOf(ctx);
    const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false;
    const jobs = await jobsEnd(ctx, agent.id, signal, except);
    if (signal.aborted || agent.status !== "idle") return false;
    if (!children && !jobs) return true;
  }
}

/**
 * Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
 * One failure stops none other.
 */
export async function killJobs(
  ctx: Context,
  sessionId: string,
  reason: string,
  except?: ReadonlySet<string>,
): Promise<void> {
  await ctx.refresh?.(sessionId);
  const jobs = registry(ctx);
  const live = jobs ? owned(jobs, sessionId, except) : [];
  const failures: unknown[] = [];
  // The waits start before the kills, so each end counts as collected.
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined));
  for (const job of live)
    try {
      await jobs!.kill(job.id, sessionId, reason);
    } catch (error) {
      failures.push(error);
    }
  await Promise.all(collected);
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`);
}

/**
 * Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
 * @returns the job's name and status once it ended; undefined when `signal` aborted first.
 */
export async function collectJob(
  ctx: Context,
  sessionId: string,
  job: { id: string; name: string },
  signal: AbortSignal,
): Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx);
  while (jobs && !signal.aborted) {
    const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => undefined);
    if (!view) return undefined;
    if (!running(view.status)) return { name: job.name, status: view.status };
  }
  return undefined;
}

/**
 * Release the worker's live subagents, for a bounded time. DSH delivers each one's end to the worker before the release
 * returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
 * with that turn. Its Session still admits subagents.
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx);
  if (!subagents) return;
  // The catalog lists every subagent the Session had; one that ended has no agent.
  // Elpis's adapter lists live descendants, including ones not loaded in this host process.
  const live = (await subagents.listChildren(agent.id)).map(child => child.id);
  if (!live.length) return;
  try {
    await until(subagents.drainChildren(agent, live), undefined, DRAIN_LIMIT_MS);
  } finally {
    if (agent.status !== "idle") cancelled.add(agent);
    agent.cancel({ kind: "user" }, { keepInbox });
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS);
  }
}

/**
 * Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and release its subagents (see
 * `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
 */
export async function stopBackground(
  ctx: Context,
  sessionId: string,
  reason: string,
  keepInbox = false,
): Promise<void> {
  const failures: unknown[] = [];
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => {
    failures.push(error);
  });
  const agent = ctx.agents.get(sessionId);
  if (agent)
    await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => {
      failures.push(error);
    });
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`);
}
