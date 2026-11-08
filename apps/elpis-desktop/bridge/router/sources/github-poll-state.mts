// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/sources/github.ts.
import { CliError, type Tally } from "../infra/commands.mts";
import { SOURCE } from "./github-trigger.mts";
import { type Pull } from "./github-pull.mts";
import { type SourceContext } from "./host.mts";
export interface Round {
  started: string;
  signal?: AbortSignal | undefined;
  pulls: Map<number, Promise<Pull>>;
  read: Set<number>;
  failures: string[];
  dropped: number[];
  abandoned: number[];
  tally: Tally;
  retryAt: number;
}
export const newRound = (signal?: AbortSignal): Round => ({
  started: new Date().toISOString(),
  signal,
  pulls: new Map(),
  read: new Set(),
  failures: [],
  dropped: [],
  abandoned: [],
  tally: { skipped: 0 },
  retryAt: 0,
});
export const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE);
export interface Retry {
  since: string;
  pr: boolean;
  failedAt?: string;
  attempts?: number;
  nextAt?: number;
}
export const RETRY_WINDOW_MS = 24 * 3600000;
export const retryDelay = (cadence: number, failures: number): number =>
  Math.max(cadence, Math.min(30 * 60000, cadence * 2 ** Math.min(failures, 10)));
export function cooldown(round: Round, error: unknown): void {
  if (error instanceof CliError) round.retryAt = Math.max(round.retryAt, error.retryAt ?? 0);
}
/** True when GitHub returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
export const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410;
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
export function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  cooldown(round, error);
  if (deleted(error)) round.dropped.push(number);
  else if (abandoned) round.abandoned.push(number);
  else round.failures.push(`#${number}: ${String(error)}`);
  ctx.threads.patch(`github:${number}`, { pollError: String(error) });
}
export function included(raw: string): {
  headers: string;
  body: string;
} {
  const split = raw.search(/\r?\n\r?\n/);
  if (split < 0) throw new Error("GitHub returned no HTTP headers");
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() };
}
export function nameThread(ctx: SourceContext, number: number, title: string): void {
  ctx.threads.patch(`github:${number}`, { title });
  ctx.threads.describe(`github:${number}`, {
    label: `#${number} ${title}`,
    facts: { number: { value: `#${number}` } },
  });
}
