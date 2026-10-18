export type Prune = { attemptId: string; callId: string; tool: string; sourceTokens: number; admittedTokens: number; kept: string | null; failureReason: string | null };
export type PruneTarget = { threadId: string; prune: Prune };
const requests = new Set<(target: PruneTarget) => void>();
export function openPrune(target: PruneTarget) { for (const listener of requests) listener(target); }
export function onPruneRequest(listener: (target: PruneTarget) => void) { requests.add(listener); return () => { requests.delete(listener); }; }

export function pruneOf(value: unknown): Prune | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  return typeof p.attemptId === 'string' && typeof p.callId === 'string' && typeof p.tool === 'string' &&
    typeof p.sourceTokens === 'number' && typeof p.admittedTokens === 'number' &&
    (p.kept === null || typeof p.kept === 'string') && (p.failureReason === null || typeof p.failureReason === 'string') ? p as Prune : null;
}
export function pruneSummary(p: Prune): string {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  const tokens = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  return p.failureReason ? `✂ Smart Prune failed · kept the full output · ${clean(p.failureReason)}` :
    `✂ Smart Prune · ${clean(p.tool)} · ${tokens(p.sourceTokens)} → ${tokens(p.admittedTokens)} tokens · kept: ${clean(p.kept ?? 'reason unavailable')}`;
}
