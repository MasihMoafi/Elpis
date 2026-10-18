"use client";

import { useEffect, useState } from 'react';
import { api, unreadable } from '@/lib/api';
import { openPrune, pruneOf, pruneSummary, type PruneTarget } from '@/lib/smart-prune';
import { Button } from '@/components/ui/button';

export function SmartPruneLine({ value, mediaBase }: { value: unknown; mediaBase?: string }) {
  const prune = pruneOf(value), thread = mediaBase?.match(/^\/api\/threads\/([^/]+)\//)?.[1];
  if (!prune) throw unreadable('Smart Prune');
  const summary = pruneSummary(prune);
  return <div className="text-xs text-muted-foreground">
    <Button variant="ghost" size="sm" className="h-auto max-w-full justify-start whitespace-normal px-1 py-1 text-left text-xs font-normal" disabled={!thread} onClick={() => thread && openPrune({ threadId: decodeURIComponent(thread), prune })}>{summary}</Button>
  </div>;
}

export function SmartPruneDetail({ target }: { target: PruneTarget }) {
  const [detail, setDetail] = useState<{ original: string; compact: string | null } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let current = true; setDetail(null); setError('');
    const { prune, threadId } = target;
    void api<{ original: unknown; compact: unknown }>(`/threads/${encodeURIComponent(threadId)}/smart-prune/${encodeURIComponent(prune.attemptId)}/${encodeURIComponent(prune.callId)}`).then(value => {
      if (typeof value.original !== 'string' || (value.compact !== null && typeof value.compact !== 'string')) throw unreadable('Smart Prune evidence');
      if (current) setDetail({ original: value.original, compact: value.compact });
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [target]);
  return <section aria-label="Smart Prune comparison" className="h-full overflow-auto p-4 text-sm">
    <p className="mb-4 text-xs text-muted-foreground">{pruneSummary(target.prune)}</p>
    {error ? <p role="alert">{error}</p> : !detail ? <p role="status">Loading original and compact output…</p> :
      <div className="grid grid-cols-2 gap-4">
        <section className="min-w-0"><h3 className="mb-2 font-medium">Original output</h3><pre className="whitespace-pre-wrap break-words text-xs">{detail.original}</pre></section>
        <section className="min-w-0"><h3 className="mb-2 font-medium">Compact output</h3>{detail.compact !== null ? <pre className="whitespace-pre-wrap break-words text-xs">{detail.compact}</pre> : <p className="text-muted-foreground">Original kept; no compact version was used.</p>}</section>
      </div>}
  </section>;
}
