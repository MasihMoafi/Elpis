// Ported from dsh-superagent (MIT), src/executor/dsh.ts
import { transient } from "./transient.mts";
import { Later } from "./effects.mts";
import { liveTicket, runningAssignment, type Ticket } from "../core/index.mts";
import { workerSessionId } from "./messages.mts";
import type { ExecutorHost } from "./dsh.mts";
const TRANSIENT_TRIES = 3,
  TRANSIENT_BACKOFF_MS = 15000,
  SLOT_WAIT_MS = 5000;
type RetryPorts = {
  running(ticket: Ticket): boolean;
  reserve(id: string): void;
  free(id: string): void;
  background(work: Promise<void>): Promise<void>;
  failed(id: string, summary: string): void;
};
/** Owns retry counters, pending resumptions, and all retry timers. */
export class WorkerRetries {
  private readonly transient = new Map<string, number>();
  private readonly resuming = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly host: Pick<ExecutorHost, "store" | "closing" | "paused" | "sessions">;
  private readonly ports: RetryPorts;
  constructor(host: Pick<ExecutorHost, "store" | "closing" | "paused" | "sessions">, ports: RetryPorts) {
    this.host = host;
    this.ports = ports;
  }
  has(id: string) {
    return this.resuming.has(id);
  }
  reset(id: string) {
    this.transient.delete(id);
  }
  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.resuming.clear();
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  retry(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0;
    if (!transient(error) || tries >= TRANSIENT_TRIES) {
      this.transient.delete(key);
      return false;
    }
    this.transient.set(key, tries + 1);
    return true;
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!;
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`;
    this.resuming.add(assignmentId);
    const go = () => {
      if (this.host.closing()) return;
      const ticket = this.host.store.tickets.get(ticketId);
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) {
        this.resuming.delete(assignmentId);
        return;
      }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) {
        this.after(SLOT_WAIT_MS, go);
        return;
      }
      const sessionId = workerSessionId(ticketId);
      const waking = !this.ports.running(ticket);
      try {
        if (waking) this.ports.reserve(ticketId);
      } catch (failure) {
        if (!(failure instanceof Later)) throw failure;
        this.after(SLOT_WAIT_MS, go);
        return;
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, "queue");
      void this.ports.background(
        sent
          .finally(() => {
            if (waking) this.ports.free(ticketId);
            this.resuming.delete(assignmentId);
          })
          .catch(failure => {
            this.ports.failed(ticketId, String(failure));
          }),
      );
    };
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go);
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      then();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }
}
