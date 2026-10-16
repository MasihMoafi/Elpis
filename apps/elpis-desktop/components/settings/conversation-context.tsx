"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// The selected conversation's reported usage and pruning (formerly on the "Elpis" page).
type Usage = { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; totalTokens?: number };
type Context = {
  threadId: string;
  reason?: string;
  tokenUsage: { total: Usage | null; last: Usage | null; modelContextWindow: number | null; contextAttribution?: Record<string, number> | null } | null;
  smartPrune: { approxSavedTokens?: number; optimizerRequests?: number; optimizerUsageReports?: number; optimizerLatencyMs?: number; optimizerUsage?: Usage | null;
    latestAttempt?: { latencyMs?: number; status: string | null; modelSlug: string | null; failureReason: string | null } | null } | null;
};
const setting = (value: string | boolean | null | undefined) => typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : value || "Not reported";
const count = (value: number | null | undefined) => typeof value === "number" ? value.toLocaleString() : "Not reported";
const categories = { systemInstructions: "System instructions", developerMessages: "Developer instructions", userMessages: "User messages", agentMessages: "Agent replies", reasoning: "Reasoning", toolCalls: "Tool calls", toolResults: "Tool results", toolDefinitions: "Tool definitions", outputSchema: "Output schema", unrecognizedItems: "Other items" };

/** Polls the selected conversation every five seconds while visible; a response for another chat is rejected. */
export function ConversationContext({ threadId, active = true }: { threadId?: string; active?: boolean }) {
  const [contextState, setContextState] = useState<{ threadId: string; data: Context | null; error: string }>({ threadId: "", data: null, error: "" });
  const context = contextState.threadId === threadId ? contextState.data : null;
  const contextError = contextState.threadId === threadId ? contextState.error : "";
  const latestInput = context?.tokenUsage?.last?.inputTokens;
  const contextWindow = context?.tokenUsage?.modelContextWindow;
  const attribution = context?.tokenUsage?.contextAttribution;
  const inputShare = typeof latestInput === "number" && typeof contextWindow === "number" && contextWindow > 0 ? latestInput / contextWindow * 100 : null;
  const pruning = context?.smartPrune;
  const usageReports = pruning?.optimizerUsageReports;
  const requests = pruning?.optimizerRequests;
  const hasReportedUsage = typeof usageReports === "number" && usageReports > 0;
  const partialUsage = hasReportedUsage && typeof requests === "number" && usageReports < requests;
  const pruningTokens = hasReportedUsage && typeof pruning?.optimizerUsage?.totalTokens === "number"
    ? `${count(pruning.optimizerUsage.totalTokens)}${partialUsage ? " (partial)" : ""}`
    : "Not reported";
  useEffect(() => {
    let disposed = false;
    if (!threadId || !active) return;
    const selectedId = threadId;
    let timer: ReturnType<typeof setTimeout>;
    setContextState({ threadId: selectedId, data: null, error: "" });
    async function refresh() {
      try {
        const value = await api<Context>(`/threads/${encodeURIComponent(selectedId)}/context`);
        if (value.threadId !== selectedId) throw new Error("Context response belongs to another conversation.");
        if (!disposed) setContextState({ threadId: selectedId, data: value, error: "" });
      } catch (error) {
        if (!disposed) setContextState({ threadId: selectedId, data: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!disposed) timer = setTimeout(poll, 5000);
      }
    }
    function poll() {
      if (document.visibilityState === "visible") void refresh();
      else timer = setTimeout(poll, 5000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [threadId, active]);
  return <section className="feature-section" aria-label="Selected conversation context"><h2>Selected conversation · context</h2>
      {!threadId ? <p className="text-sm text-muted-foreground">Open a conversation to see its reported usage.</p> : <>
        {contextError && <p role="alert">Could not refresh context: {contextError}</p>}
        {!context && !contextError && <p role="status">Loading context…</p>}
        {context && <>
        <h3 className="mb-3 font-medium">Latest reported request</h3>
        <dl className="feature-values">
          <dt>Latest input tokens</dt><dd>{count(latestInput)}</dd>
          <dt>Context window</dt><dd>{count(contextWindow)}</dd>
          <dt>Input / context window</dt><dd>{inputShare === null ? "Not reported" : `${inputShare.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Latest provider input is a request snapshot. Cumulative usage below is not the amount currently occupying the context window.</p>
        <details className="mt-5" open={!!attribution}>
          <summary className="cursor-pointer font-medium">Estimated context composition</summary>
          {attribution ? <><dl className="feature-values mt-3">{Object.entries(categories).map(([key, label]) => <div className="contents" key={key}><dt>{label}</dt><dd>{count(attribution[key])}</dd></div>)}<dt>Estimated total</dt><dd>{count(attribution.estimatedTotal)}</dd></dl><p className="mt-3 text-xs text-muted-foreground">Estimates from Elpis's latest request. They can differ from provider counts. This does not list or change admitted files and memories.</p></> : <p className="mt-3 text-sm text-muted-foreground">Elpis has not reported context composition for this conversation.</p>}
        </details>
        <h3 className="mb-3 mt-6 font-medium">Cumulative usage and pruning</h3>
        <dl className="feature-values">
          <dt>Input tokens</dt><dd>{count(context.tokenUsage?.total?.inputTokens)}</dd>
          <dt>Cache-read input tokens</dt><dd>{count(context.tokenUsage?.total?.cachedInputTokens)}</dd>
          <dt>Cache-write input tokens</dt><dd>{count(context.tokenUsage?.total?.cacheWriteInputTokens)}</dd>
          <dt>Output tokens</dt><dd>{count(context.tokenUsage?.total?.outputTokens)}</dd>
          <dt>Estimated tokens pruned</dt><dd>{count(context.smartPrune?.approxSavedTokens)}</dd>
          <dt>Pruning model tokens</dt><dd>{pruningTokens}</dd>
          <dt>Cumulative pruning request time (ms)</dt><dd>{count(context.smartPrune?.optimizerLatencyMs)}</dd>
          <dt>Latest pruning attempt time (ms)</dt><dd>{count(context.smartPrune?.latestAttempt?.latencyMs)}</dd>
          <dt>Latest pruning model</dt><dd>{setting(context.smartPrune?.latestAttempt?.modelSlug)}</dd>
          <dt>Latest pruning status</dt><dd>{setting(context.smartPrune?.latestAttempt?.status)}</dd>
        </dl>
        {context.smartPrune?.latestAttempt?.failureReason && <p className="mt-4 text-sm" role="status">{context.smartPrune.latestAttempt.failureReason}</p>}
        {typeof usageReports === "number" && typeof requests === "number" && <p className="mt-4 text-xs text-muted-foreground">Usage reported for {count(usageReports)} of {count(requests)} pruning requests.</p>}
        <p className="mt-4 text-xs text-muted-foreground">Pruned tokens are estimates, not net token or cost savings. Pruning request time does not measure added user waiting time.</p>
        <p className="mt-4 text-xs text-muted-foreground">{context.reason || "Usage reflects events observed since this app connected."}</p></>}
      </>}
  </section>;
}
