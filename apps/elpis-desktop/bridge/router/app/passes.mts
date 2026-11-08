// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/passes.ts.
/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from "../core/index.mts";
import type { HealthEntry } from "../infra/health.mts";
import type { Effects } from "../executor/effects.mts";

export interface PassesHost {
  readonly engine: Pick<Engine, "receive" | "evaluateDue">;
  readonly effects: Pick<Effects, "kick" | "idle">;
  readonly health: HealthEntry;
  readonly lifetime: AbortSignal;
  configured(): boolean;
  closing(): boolean;
}

const now = (): string => new Date().toISOString();

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private pumping: Promise<void> | undefined;
  private pumpAgain: Promise<void> | undefined;
  private readonly host: PassesHost;
  constructor(host: PassesHost) {
    this.host = host;
  }
  start(): void {
    if (!this.stopped)
      this.timer = setInterval(() => {
        this.request();
      }, 2000);
  }
  stop(): Promise<unknown> {
    this.stopped = true;
    clearInterval(this.timer);
    return Promise.allSettled([this.pumping, this.pumpAgain]);
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error("Orchestrator is stopping");
    const result = this.host.engine.receive(trigger);
    if (result === "stored") this.request();
    return result;
  }
  request(): void {
    const { health } = this.host;
    this.pump().then(
      () => {
        if (health.get()?.state !== "error" || this.host.lifetime.aborted) return;
        health.set({ state: "ready", detail: "Orchestrator is ready", at: now() });
      },
      (error: unknown) => {
        health.set({ state: "error", detail: `A pass failed: ${String(error)}`, at: now() });
      },
    );
  }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain]);
      await this.host.effects.idle();
      if (!this.pumping && !this.pumpAgain) return;
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (!this.host.configured() || this.host.closing()) return;
    if (!this.pumping)
      return (this.pumping = this.pumpOnce().finally(() => {
        this.pumping = undefined;
      }));
    const next = () => {
      this.pumpAgain = undefined;
      return this.pump();
    };
    return (this.pumpAgain ??= this.pumping.then(next, next));
  }
  private pumpOnce(): Promise<void> {
    return Promise.resolve().then(() => {
      this.host.effects.kick();
      if (this.host.closing()) return;
      // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
      this.host.engine.evaluateDue();
    });
  }
}
