// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/retry-health.ts.
/** Projects active model budget retry waits from session event streams without modifying retry policy or logs. */
export interface RetryHealthEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}
export interface BudgetRetryStatus {
  sessionId: string;
  provider: string;
  attempts: number;
  since: string;
  lastAt: string;
}
type Chain = { id: string; provider: string; status: BudgetRetryStatus };
type State = { seq: number; turn: number; step: number; ended: boolean; settled: boolean; active?: Chain | undefined };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const ordinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Identify model budget exhaustion from structured failure metadata without inspecting assistant message content. */
function budgetFailure(value: unknown): boolean {
  const failure = record(value);
  if (!failure) return false;
  if (
    [401, 403, 429].includes(Number(failure.status)) ||
    (typeof failure.code === "string" && /AUTH|RATE_LIMIT|CONTEXT|TOKEN_LIMIT/i.test(failure.code))
  )
    return false;
  if (failure.type === "budget_exceeded" || failure.code === "budget_exceeded") return true;
  if (typeof failure.message !== "string") return false;
  const message = failure.message.slice(0, 8192);
  try {
    const body = record(JSON.parse(message.slice(message.indexOf("{"))));
    const error = record(body?.error) ?? body;
    if (error?.type === "budget_exceeded" || error?.code === "budget_exceeded") return true;
  } catch {
    /* Some providers expose only the known plain-text budget error. */
  }
  return /\bBudget has been exceeded(?:!|[.:]|$)/i.test(message);
}

/**
 * Tracks which managed sessions are currently blocked on model budget retries by observing session lifecycle and retry events.
 * `Sessions` feeds session events into it and mirrors the aggregated retry state into the `models` health entry, while `resources` and views attach per-session retry status to ticket cards.
 */
export class RetryHealth {
  private readonly sessions = new Map<string, State>();

  /** Replay an ordered native event snapshot; the caller must clear idle or disposed agents afterwards. */
  restore(sessionId: string, events: readonly RetryHealthEvent[]): void {
    this.sessions.delete(sessionId);
    for (const event of events) this.observe(sessionId, event);
  }

  /** Clear active retry status while preserving the sequence watermark against out-of-order events. */
  clear(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.active = undefined;
      state.settled = true;
    }
  }

  get(sessionId: string): BudgetRetryStatus | undefined {
    const status = this.sessions.get(sessionId)?.active?.status;
    return status ? { ...status } : undefined;
  }

  list(): BudgetRetryStatus[] {
    return [...this.sessions.values()].flatMap(state => (state.active ? [{ ...state.active.status }] : []));
  }

  observe(sessionId: string, event: RetryHealthEvent): void {
    if (!ordinal(event.seq) || !Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) return;
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { seq: -1, turn: -1, step: -1, ended: false, settled: false };
      this.sessions.set(sessionId, state);
    }
    if (event.seq <= state.seq) return;
    state.seq = event.seq;
    const data = record(event.data);
    if (!data) return;
    if (event.type === "turn/start" || event.type === "turn/end") {
      if (!ordinal(data.turn) || data.turn < state.turn) return;
      if (data.turn > state.turn)
        Object.assign(state, { turn: data.turn, step: -1, ended: false, settled: false, active: undefined });
      if (event.type === "turn/end") {
        state.active = undefined;
        state.ended = true;
      }
      return;
    }
    if (event.type === "llm/retry-started") return; // A retry attempt starting does not mean the budget failure has recovered.
    if (!["step/start", "llm/retry", "assistant/message"].includes(event.type)) return;
    if (!ordinal(data.turn) || !ordinal(data.step)) return;
    if (data.turn < state.turn || (data.turn === state.turn && (state.ended || data.step < state.step))) return;
    if (event.type === "assistant/message") {
      const source = record(record(data.message)?.source);
      if (
        state.active &&
        data.turn === state.turn &&
        data.step === state.step &&
        data.interrupted !== true &&
        source?.kind === "model" &&
        source.provider === state.active.provider
      ) {
        state.active = undefined;
        state.settled = true;
      }
      return;
    }
    if (data.turn > state.turn || data.step > state.step)
      Object.assign(state, { turn: data.turn, step: data.step, ended: false, settled: false, active: undefined });
    if (event.type === "step/start" || state.settled) return;
    if (
      typeof data.retryId !== "string" ||
      !data.retryId ||
      typeof data.provider !== "string" ||
      typeof data.retry !== "number" ||
      !Number.isInteger(data.retry) ||
      data.retry < 1
    )
      return;
    if (!budgetFailure(data.failure)) {
      state.active = undefined;
      return;
    }
    const attempts = Math.min(data.retry, Number.MAX_SAFE_INTEGER);
    const previous =
      state.active?.id === data.retryId && state.active.provider === data.provider ? state.active.status : undefined;
    if (previous && attempts <= previous.attempts) return;
    const at = new Date(event.time).toISOString();
    state.active = {
      id: data.retryId,
      provider: data.provider,
      status: {
        sessionId,
        provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(data.provider) ? data.provider : "unknown",
        attempts,
        since: previous?.since ?? at,
        lastAt: at,
      },
    };
  }
}
