"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SmartPruneOutput } from "@/components/smart-prune";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mts";
import type { SmartPruneLogListResponse, SmartPruneLogRecord, SmartPruneLogSummary } from "@/lib/smart-prune";

const count = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString();

function Tokens({ record }: { record: SmartPruneLogSummary }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span>{count(record.estimatedSourceTokens)} → {count(record.estimatedAdmittedTokens)} tokens · {count(record.estimatedSavedTokens)} saved</span>
      {record.estimatedSourceTokens !== null && record.estimatedSourceTokens > 0 && record.estimatedAdmittedTokens !== null && (
        <meter className="h-2 w-full max-w-48 accent-primary" aria-label="Estimated tokens retained"
          min={0} max={Math.max(record.estimatedSourceTokens, record.estimatedAdmittedTokens)} value={record.estimatedAdmittedTokens} />
      )}
    </div>
  );
}

/** Global audit, including attempts that kept the original output. No model calls are made here. */
export function SmartPruneLog() {
  const [page, setPage] = useState<SmartPruneLogListResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SmartPruneLogSummary | null>(null);
  const [record, setRecord] = useState<SmartPruneLogRecord | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void api<SmartPruneLogListResponse>(`/smart-prune${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, abort.signal)
      .then(value => {
        if (abort.signal.aborted) return;
        setPage(previous => ({ ...value, data: cursor ? [...(previous?.data ?? []), ...value.data] : value.data }));
      })
      .catch(cause => { if (!abort.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [cursor, revision]);
  useEffect(() => {
    const abort = new AbortController();
    setRecord(null);
    setDetailError("");
    if (selected) void api<{ record: SmartPruneLogRecord }>(
      `/smart-prune/${encodeURIComponent(selected.threadId)}/${encodeURIComponent(selected.attemptId)}`, undefined, abort.signal,
    ).then(value => {
      if (!abort.signal.aborted) setRecord(value.record);
    }).catch(cause => { if (!abort.signal.aborted) setDetailError(errorText(cause)); });
    return () => abort.abort();
  }, [selected, detailRevision]);
  const refresh = () => { setCursor(null); setRevision(value => value + 1); };
  const current = record?.threadId === selected?.threadId && record?.attemptId === selected?.attemptId ? record : null;
  return (
    <section className="min-h-0 flex-1 overflow-auto p-4 text-sm" aria-label="Smart Prune history">
      <div className="mb-4 flex items-center gap-2">
        {selected ? (
          <Button variant="ghost" size="icon-sm" aria-label="Back to prune history" onClick={() => setSelected(null)}><ArrowLeft /></Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="Refresh prune history" disabled={loading} onClick={refresh}><RefreshCw /></Button>
        )}
        <p className="text-muted-foreground">{selected ? selected.chatTitle || selected.threadId : "All chats"} · Estimated tokens</p>
      </div>
      {selected ? (
        detailError ? <p role="alert">{detailError} <Button variant="ghost" onClick={() => setDetailRevision(value => value + 1)}>Retry</Button></p>
          : !current ? <p role="status">Loading original and compact output…</p>
            : <div className="space-y-4">
              <p>{current.timestamp} · {current.model} · {current.reasoningEffort}{current.turnNumber !== null ? ` · Turn ${current.turnNumber}` : ""}</p>
              <Tokens record={current} />
              {current.note && <p className="text-muted-foreground">{current.note}</p>}
              {current.items.map(item => <section key={item.callId} className="space-y-2 border-t border-border pt-4" aria-label={item.description || item.callId}>
                <h3 className="font-medium">{item.description || item.callId}</h3>
                <p className="text-xs text-muted-foreground">{item.decision}{item.kept ? ` · Kept: ${item.kept}` : ""}</p>
                {current.estimatedSavedTokens !== null && <p className="text-xs text-muted-foreground">
                  {count(item.estimatedSourceTokens)} → {count(item.estimatedAdmittedTokens)} estimated tokens
                </p>}
                <SmartPruneOutput original={item.original} compact={item.compact} diff={item.diff} unavailable={current.estimatedSavedTokens === null} />
              </section>)}
              {!current.items.length && <p>No tool-output comparison was recorded for this attempt.</p>}
            </div>
      ) : (
        <>
          {error && <p role="alert">{error} <Button variant="ghost" onClick={() => setRevision(value => value + 1)}>Retry</Button></p>}
          {!!page?.unreadable && <p className="mb-4 text-muted-foreground">
            {page.unreadable} saved {page.unreadable === 1 ? "record could" : "records could"} not be read. The list is incomplete.
          </p>}
          {!loading && !error && !page?.data.length && <p>No Smart Prune attempts are recorded yet.</p>}
          <div className="flex flex-col gap-2">
            {page?.data.map(row => <Button key={`${row.threadId}:${row.attemptId}`} variant="ghost"
              className="h-auto w-full justify-start whitespace-normal p-2 text-left" onClick={() => setSelected(row)}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="break-words">{row.chatTitle || row.threadId}</span>
                <span className="text-xs font-normal text-muted-foreground">{row.timestamp} · {row.model}{row.turnNumber !== null ? ` · Turn ${row.turnNumber}` : ""}</span>
                <Tokens record={row} />
                {row.note && <span className="text-xs font-normal text-muted-foreground">{row.note}</span>}
              </div>
            </Button>)}
          </div>
          {loading ? <p role="status">Loading prune history…</p> : page?.nextCursor && !error && (
            <Button variant="ghost" onClick={() => setCursor(page.nextCursor)}>Load earlier attempts</Button>
          )}
        </>
      )}
    </section>
  );
}
