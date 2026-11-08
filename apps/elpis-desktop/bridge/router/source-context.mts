// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/source-context.ts.
/** Scoped runtime context exposed to each Source kind, isolating Sources from direct Store or Engine access. */
import type { EngineForSources, ReceiveResult, Trigger } from "./core/index.mts";
import type { Deployment } from "./deployment.mts";
import type { Commands } from "./infra/commands.mts";
import type { SetupProblem } from "./infra/setup.mts";
import type { SourceContext } from "./sources/host.mts";
import type { SourceRegistry } from "./sources/registry.mts";
import type { Outbox } from "./outbox.mts";
import type { Store } from "./app/store.mts";

export interface SourceContextDeps {
  readonly store: Pick<
    Store,
    "atomic" | "get" | "set" | "delete" | "keys" | "threads" | "tickets" | "triggers" | "read"
  >;
  readonly outbox: Pick<Outbox, "send">;
  readonly engine: Pick<EngineForSources, "bindThread" | "threadClosed">;
  readonly commands: Commands;
  readonly sources: SourceRegistry;
  /** Throws when accessed before initial setup completes. */
  readonly deployment: Deployment;
  readonly ready: Promise<void>;
  configured(): boolean;
  /** Setup problem whose `place` matches the Source kind receives it on `context.problem`. */
  readonly setupProblem?: SetupProblem | undefined;
  /** Why setup found no Feishu bot even though the Feishu Source names a CLI. */
  readonly feishuProblem?: SetupProblem | undefined;
  /** Hands a Trigger to the Engine and schedules the pass that assesses it. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>;
}

/**
 * Builds the context for one Source kind. Health reports are restricted to entries declared by the kind and
 * bound to the active registration, becoming no-ops once unregistered.
 */
export function sourceContext(
  deps: SourceContextDeps,
  kind: { kind: string; health: readonly string[] },
): SourceContext {
  const { store } = deps;
  const health = deps.sources.healthEntries(kind.health);
  return {
    get deployment() {
      return deps.deployment;
    },
    commands: deps.commands,
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() {
      return [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind);
    },
    config: <C extends Record<string, unknown>>(id: string) => {
      const instance = deps.sources.instance<C>(id);
      return instance?.enabled ? instance.config : undefined;
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(name),
      set: (name, value) => {
        if (value === undefined) store.delete(name);
        else store.set(name, value);
      },
      keys: prefix => store.keys(prefix),
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => {
        store.threads.patchMeta(key, meta);
      },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => {
        deps.engine.bindThread(id, thread, own);
      },
      threadClosed: (thread, outcome, at) => {
        deps.engine.threadClosed(thread, outcome, at);
      },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => {
      deps.outbox.send(message);
    },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`);
      health.get(entry)?.set(value);
    },
  };
}
