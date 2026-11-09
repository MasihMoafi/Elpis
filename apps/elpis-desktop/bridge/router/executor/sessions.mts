// Ported from dsh-superagent (MIT), src/app/sessions.ts (worker delivery and persistence)
import { RecordSchema, WorkerAgent } from "./session-turns.mts";
export { RecordSchema, WorkerAgent } from "./session-turns.mts";
export type { SessionRecord } from "./session-turns.mts";
import { runOpen, runPrompt, runFlush, runReceive } from "./session-turns.mts";

import type { SubprocessRuntime } from "../infra/types.mts";
import type { Jobs, Subagents } from "./background.mts";
import { type Runtime, type RuntimeAdapter, type WorkerSession } from "./adapters.mts";
import type { Agent, Context, RuntimeEvents } from "./runtime.mts";
import type { ExecutorStore } from "./store.mts";

import type { Effects } from "./effects.mts";
import { RuntimeBackground } from "./runtime-background.mts";
import { key } from "../core/index.mts";
import { KV } from "../sources/kv.mts";
import type { Tool } from "../app/tools/tool.mts";
import type { Prompts, PromptVersion } from "../app/prompts.mts";
import type { TranscriptEvent } from "../app/host.mts";
import { RetryHealth } from "../app/retry-health.mts";
import type { HealthEntry } from "../infra/health.mts";
import { ToolRuntime } from "./tool-runtime.mts";
export type Mode = "queue" | "steer" | { inject: string };
export interface SessionOptions {
  store: ExecutorStore;
  adapters: RuntimeAdapter[];
  subprocess: SubprocessRuntime;
  effects?: Pick<Effects, "handle" | "enqueue" | "pending" | "idle">;
  modelHealth?: HealthEntry;
  stateDir?: string;
  mainSessionId?: string;
  parentThreadId?: string;
  jobs?: Jobs;
  subagents?: Subagents;
  instructions?: (sessionId: string) => string;
  relay?: (id: string, text: string) => Promise<void>;
  tools?: (sessionId: string) => Tool[];
  prompts?: Prompts;
  environment?: (sessionId: string) => Record<string, string | undefined>;
  onError?: (error: unknown) => void;
}

/** Persistent logical worker IDs mapped to native runtime IDs. One session owns each delivery receipt. */
export class Sessions implements Context {
  readonly agents = new Map<string, WorkerAgent>();
  readonly subprocess: SubprocessRuntime;
  readonly jobs?: Jobs;
  readonly subagents?: Subagents;
  readonly options: SessionOptions;
  private readonly listeners: { [K in keyof RuntimeEvents]: Set<(...args: RuntimeEvents[K]) => void> } = {
    "agent/result": new Set(),
    "agent/status": new Set(),
    "agent/inbox/claimed": new Set(),
    "session/event": new Set(),
    "agent/error": new Set(),
  };
  private readonly ensuring = new Map<string, Promise<WorkerAgent>>();
  readonly sending = new Map<string, Promise<void>>();
  readonly subscriptions = new Map<string, () => void>();
  disposed = false;
  readonly lifetime = new AbortController();
  readonly retries = new RetryHealth();
  retrySeq = 0;
  readonly retryTurns = new Map<string, { id: string; ordinal: number; attempts: number }>();
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly backgroundWork: RuntimeBackground;
  readonly toolRuntime: ToolRuntime | undefined;
  constructor(options: SessionOptions) {
    this.options = options;
    this.subprocess = options.subprocess;
    this.toolRuntime = options.tools && options.stateDir ? new ToolRuntime(options.store, options.stateDir) : undefined;
    this.backgroundWork = new RuntimeBackground(
      id => {
        const agent = this.agents.get(id);
        return agent?.record.threadId
          ? { adapter: this.adapter(agent.record.runtime), threadId: agent.record.threadId }
          : undefined;
      },
      error => options.onError?.(error),
    );
    this.jobs = options.jobs ?? this.backgroundWork.jobs;
    this.subagents = options.subagents ?? this.backgroundWork.subagents;
    options.effects?.handle(
      "relay",
      async (payload, key) => {
        if (options.relay) {
          await options.relay(key, payload.text);
          return;
        }
        if (!options.mainSessionId) throw new Error("The router main session is not bound");
        await this.prompt(options.mainSessionId, key, payload.text, "steer");
      },
      { ordered: true },
    );
    options.effects?.handle(
      "notice",
      async (payload, name) => {
        if (!options.mainSessionId) throw new Error("The router main session is not bound");
        const text = JSON.stringify(payload.value);
        await this.prompt(options.mainSessionId, `notice:${name}:${key(text)}`, text, { inject: payload.summary });
      },
      { ordered: true },
    );
    this.on("agent/status", ({ agent, status }) => {
      if (status === "idle") {
        this.retries.clear(agent.id);
        this.updateModelHealth();
      }
    });
    this.updateModelHealth();
  }
  on<K extends keyof RuntimeEvents>(name: K, listener: (...args: RuntimeEvents[K]) => void): () => void {
    this.listeners[name].add(listener);
    return () => {
      this.listeners[name].delete(listener);
    };
  }
  emit<K extends keyof RuntimeEvents>(name: K, ...args: RuntimeEvents[K]): void {
    if (!this.disposed) for (const listener of this.listeners[name]) listener(...args);
  }
  adapter(runtime: Runtime): RuntimeAdapter {
    const adapter = this.options.adapters.find(item => item.runtime === runtime);
    if (!adapter) throw new Error(`The ${runtime} runtime is unavailable`);
    return adapter;
  }
  save(agent: WorkerAgent): void {
    this.options.store.saveSession(agent.id, agent.record);
  }
  async refresh(id: string): Promise<void> {
    await this.backgroundWork.refresh(id);
  }
  /** Bind a discovered existing session without creating a worker or replacing its selected model. */
  async adopt(sessionId: string, runtime: Runtime, threadId: string): Promise<Agent> {
    const old = this.options.store.session(sessionId);
    const record = old ? RecordSchema.parse(old) : null;
    if (record?.threadId && (record.threadId !== threadId || record.runtime !== runtime))
      throw new Error("The logical session already belongs to another runtime session");
    this.options.store.saveSession(sessionId, {
      runtime,
      threadId,
      creating: false,
      model: record?.model ?? null,
      messages: record?.messages ?? [],
    });
    return this.ensure(sessionId, "", sessionId, "worker");
  }
  ensure(sessionId: string, directory: string, title: string, role: "worker" | "orchestrator"): Promise<WorkerAgent> {
    if (this.disposed) return Promise.reject(new Error("The session manager is stopped"));
    const active = this.ensuring.get(sessionId);
    if (active) return active;
    const existing = this.agents.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const work = this.open(sessionId, directory, title, role).finally(() => {
      this.ensuring.delete(sessionId);
    });
    this.ensuring.set(sessionId, work);
    return work;
  }
  private async open(id: string, cwd: string, title: string, role: "worker" | "orchestrator"): Promise<WorkerAgent> {
    return runOpen.call(this, id, cwd, title, role);
  }
  promptedId(id: string): string {
    return `router:${id}`;
  }
  async holds(sessionId: string, id: string): Promise<boolean> {
    const agent = this.agents.get(sessionId);
    if (!agent?.record.threadId) return false;
    this.reconcile(agent, await this.adapter(agent.record.runtime).read(agent.record.threadId));
    return agent.record.messages.some(message => message.id === this.promptedId(id));
  }
  /** Queue before sending; the effect and its receipt share the same durable store as the Assignment. */
  async prompt(
    sessionId: string,
    id: string,
    text: string,
    mode: Mode,
    authorize?: () => void,
    accepted?: () => void,
  ): Promise<void> {
    return runPrompt.call(this, sessionId, id, text, mode, authorize, accepted);
  }
  async flush(
    agent: WorkerAgent,
    authorize?: () => void,
    accepted?: () => void,
    requestedId?: string,
  ): Promise<void> {
    return runFlush.call(this, agent, authorize, accepted, requestedId);
  }
  reconcile(agent: WorkerAgent, remote: WorkerSession): void {
    for (const item of remote.messages) {
      let message = agent.record.messages.find(message => message.id === item.id);
      if (!message) {
        message = { id: item.id, text: item.text, mode: "steer", state: "sent", read: false, accepted: true };
        agent.record.messages.push(message);
      }
      message.state = "sent";
      message.accepted = true;
      if (!message.read) {
        message.read = true;
        this.emit(
          "session/event",
          { id: agent.id },
          { type: "user/message", data: { id: message.id, source: { kind: "dsh-superagent" } } },
        );
      }
    }
    if (remote.result) this.result(agent, remote.result.id, remote.result.text);
    this.save(agent);
    agent.state(remote.activeTurn);
  }
  result(agent: WorkerAgent, id: string, text: string): void {
    if (agent.record.resultId === id) return;
    this.options.store.atomic(() => {
      this.emit("agent/result", { agent, text });
      agent.record.resultId = id;
      this.save(agent);
    });
  }
  receive(agent: WorkerAgent, raw: unknown): void {
    return runReceive.call(this, agent, raw);
  }
  updateModelHealth(): void {
    const retries = this.retries.list();
    this.options.modelHealth?.set(
      retries.length
        ? {
            state: "error",
            detail: retries
              .slice(0, 5)
              .map(
                item =>
                  `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}`,
              )
              .join("; "),
            at: retries.at(-1)!.lastAt,
          }
        : { state: "ready", detail: "No managed session is waiting on a model budget retry" },
    );
  }
  background(work: Promise<unknown>): void {
    this.pendingWork.add(work);
    void work.catch(error => this.options.onError?.(error)).finally(() => this.pendingWork.delete(work));
  }
  async cancel(agent: WorkerAgent, keepInbox: boolean): Promise<void> {
    if (!keepInbox) {
      agent.record.messages = agent.record.messages.filter(message => message.state === "sent");
      this.save(agent);
    }
    if (agent.record.threadId) {
      const adapter = this.adapter(agent.record.runtime);
      const remote = await adapter.read(agent.record.threadId);
      if (remote.activeTurn) await adapter.stop(agent.record.threadId, remote.activeTurn);
      // turn/interrupt acknowledges the cancellation; next delivery waits for the runtime to finish it.
      this.reconcile(agent, await adapter.read(agent.record.threadId));
    }
  }
  relay(id: string, text: string): void {
    if (!this.options.effects) throw new Error("Worker reports need the durable relay effect queue");
    this.options.effects.enqueue("relay", id, { text });
  }
  notify(id: string, value: Record<string, unknown>, summary: string): void {
    if (!this.options.effects) throw new Error("Notices need the durable effect queue");
    this.options.effects.enqueue("notice", id, { value, summary });
  }
  async delivery(id: string): Promise<"injected" | "pending"> {
    await this.options.effects?.idle("notice");
    return this.options.effects?.pending("notice", id) ? "pending" : "injected";
  }
  instructions(id: string): string {
    const prompts = this.options.prompts;
    if (prompts) {
      const revision = prompts.current().revision,
        key = KV.sessions.prompts(id),
        revisions = this.options.store.get(key) ?? [];
      if (revisions.at(-1) !== revision) this.options.store.set(key, [...revisions, revision]);
    }
    return this.options.instructions?.(id) ?? "";
  }
  promptVersion(id: string): PromptVersion {
    if (!this.options.prompts) throw new Error("Prompts are not configured");
    const revision = this.options.store.get(KV.sessions.prompts(id))?.at(-1);
    return revision === undefined ? this.options.prompts.current() : this.options.prompts.version(revision);
  }
  mayRead(id: string, revision: number): boolean {
    return (
      revision === this.promptVersion(id).revision ||
      (this.options.store.get(KV.sessions.prompts(id)) ?? []).includes(revision)
    );
  }
  status() {
    return {
      revision: this.options.prompts?.current().revision ?? 0,
      notificationPending: this.options.effects?.pending("notice", "prompts") ?? false,
      sessions: [...this.agents.keys()].map(sessionId => ({
        sessionId,
        revision: this.options.store.get(KV.sessions.prompts(sessionId))?.at(-1) ?? 0,
      })),
    };
  }
  modelRetry(id?: string | false) {
    const retry = id ? this.retries.get(id) : undefined;
    return retry ? { model_retry: retry } : {};
  }
  nativeId(id: string): string | undefined {
    return (
      this.agents.get(id)?.record.threadId ??
      RecordSchema.safeParse(this.options.store.session(id)).data?.threadId ??
      undefined
    );
  }
  async inspect(id: string): Promise<{ events: TranscriptEvent[] }> {
    const agent = this.agents.get(id);
    if (!agent?.record.threadId) throw new Error("This managed session is unavailable");
    const remote = await this.adapter(agent.record.runtime).read(agent.record.threadId);
    return { events: remote.transcript ?? [] };
  }
  /** Reattach saved running workers before DshExecutor.resume interrupts or recovers Assignments. */
  async recover(): Promise<void> {
    for (const ticket of this.options.store.tickets.open()) {
      const id = `worker-${ticket.id}`;
      if (this.options.store.session(id)) {
        try {
          await this.ensure(id, ticket.execution?.directory ?? "", ticket.title, "worker");
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.backgroundWork.dispose();
    for (const dispose of this.subscriptions.values()) dispose();
    this.subscriptions.clear();
    for (const listeners of Object.values(this.listeners)) listeners.clear();
    for (const adapter of this.options.adapters) adapter.close();
  }
  async drained(): Promise<void> {
    await Promise.allSettled([
      ...this.ensuring.values(),
      ...this.sending.values(),
      ...this.pendingWork,
      ...this.options.adapters.map(adapter => adapter.drain?.()),
    ]);
    await this.toolRuntime?.close();
  }
}
