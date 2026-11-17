"use client";

import { useEffect, useState } from "react";
import { api, unreadable } from "@/lib/api";
import { openPrune, pruneOf, pruneSummary, type PruneTarget } from "@/lib/smart-prune";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure-summary";
import { errorText } from "@/lib/error-text.mts";

export function SmartPruneLine({ value, mediaBase }: { value: unknown; mediaBase?: string }) {
  const prune = pruneOf(value),
    thread = mediaBase?.match(/^\/api\/threads\/([^/]+)\//)?.[1];
  if (!prune) throw unreadable("Smart Prune");
  const summary = pruneSummary(prune);
  return (
    <div className="text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full justify-start whitespace-normal px-1 py-1 text-left text-xs font-normal"
        disabled={!thread}
        onClick={() => thread && openPrune({ threadId: decodeURIComponent(thread), prune })}
      >
        {summary}
      </Button>
    </div>
  );
}

export function SmartPruneDetail({ target }: { target: PruneTarget }) {
  const [detail, setDetail] = useState<{ original: string; compact: string | null } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError("");
    const { prune, threadId } = target;
    void api<{ original: unknown; compact: unknown }>(
      `/threads/${encodeURIComponent(threadId)}/smart-prune/${encodeURIComponent(prune.attemptId)}/${encodeURIComponent(prune.callId)}`,
    )
      .then(value => {
        if (typeof value.original !== "string" || (value.compact !== null && typeof value.compact !== "string"))
          throw unreadable("Smart Prune evidence");
        if (current) setDetail({ original: value.original, compact: value.compact });
      })
      .catch(cause => {
        if (current) setError(errorText(cause));
      });
    return () => {
      current = false;
    };
  }, [target]);
  return (
    <section aria-label="Smart Prune comparison" className="h-full overflow-auto p-4 text-sm">
      <p className="mb-4 text-xs text-muted-foreground">{pruneSummary(target.prune)}</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !detail ? (
        <p role="status">Loading original and compact output…</p>
      ) : (
        <SmartPruneOutput original={detail.original} compact={detail.compact} />
      )}
    </section>
  );
}

export function SmartPruneOutput({ original, compact, diff, unavailable = false }: {
  original: string; compact: string | null; diff?: string | null; unavailable?: boolean;
}) {
  return <>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-2 font-medium">Original output</h3>
            <pre className="whitespace-pre-wrap break-words text-xs">{original}</pre>
          </section>
          <section className="min-w-0">
            <h3 className="mb-2 font-medium">Compact output</h3>
            {compact !== null ? (
              <pre className="whitespace-pre-wrap break-words text-xs">{compact}</pre>
            ) : (
              <p className="text-muted-foreground">{unavailable
                ? "Committed replacement evidence is unavailable."
                : "Original kept; no compact version was used."}</p>
            )}
          </section>
        </div>
    {diff !== null && diff !== undefined && <Disclosure className="mt-4">
      <DisclosureSummary>Text changes</DisclosureSummary>
      <pre className="whitespace-pre-wrap break-words text-xs">{diff || "The recorded text is unchanged."}</pre>
    </Disclosure>}
  </>;
}
