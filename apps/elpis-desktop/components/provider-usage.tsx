"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

// Usage as Elpis reports it from account/rateLimits/read, one provider at a time (Cloudroom's usage card).
export type UsageWindow = { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null };
export type UsageLimit = { limitId: string | null; limitName: string | null; planType: string | null; primary: UsageWindow | null; secondary: UsageWindow | null; reached: string | null };
export type Subscription = { state: "connected" | "available" | "notConnected"; models: string[]; usage: UsageLimit[] };
export type OpenAIAccount = { auth: { state: "signedIn" | "signedOut" | "unknown"; method?: string | null; email?: string | null; plan?: string | null; error?: string | null }; usage: UsageLimit[]; usageError: string | null };
export type UsageStatus = { kind: "ok"; limits: UsageLimit[] } | { kind: "unauthenticated"; hint: string } | { kind: "error"; message: string } | { kind: "notReported" };

export const windowLabel = (minutes: number | null) => minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : !minutes ? "" :
  minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes >= 60 ? `${Math.round(minutes / 60)}-hour` : `${minutes}-minute`;
export function countdown(resetsAt: number | null, now = Date.now()) {
  if (!resetsAt) return null;
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return "Resets now";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Resets in ${hours}h ${minutes % 60}m` : `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
const resetTime = (resetsAt: number | null) => resetsAt ? new Date(resetsAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;

export function openAIUsage(account: OpenAIAccount): UsageStatus {
  if (account.auth.state === "signedOut") return { kind: "unauthenticated", hint: "Sign in with ChatGPT to see ChatGPT usage." };
  if (account.usageError) return { kind: "error", message: account.usageError };
  return { kind: "ok", limits: account.usage };
}
export function subscriptionUsage(subscription: Subscription, name: string, signIn: string): UsageStatus {
  if (subscription.state === "notConnected") return { kind: "unauthenticated", hint: `${signIn} to see ${name} usage.` };
  return subscription.usage.length ? { kind: "ok", limits: subscription.usage } : { kind: "notReported" };
}

/** One row per reported window: used share, a bar only when Elpis reported the share, and when it resets. */
export function UsageWindows({ status }: { status: UsageStatus }) {
  if (status.kind === "unauthenticated") return <p className="provider-note">{status.hint}</p>;
  if (status.kind === "error") return <p className="provider-note" role="alert">Usage unavailable: {status.message}</p>;
  if (status.kind === "notReported") return <p className="provider-note">Usage not reported.</p>;
  const windows = status.limits.flatMap(limit => [limit.primary, limit.secondary].filter((w): w is UsageWindow => !!w).map(window => ({ limit, window })));
  if (!windows.length) return <p className="provider-note">No usage limits reported for this plan.</p>;
  return <ul className="usage-list">{windows.map(({ limit, window }, index) => {
    const known = typeof window.usedPercent === "number";
    const used = known ? Math.max(0, Math.min(100, window.usedPercent!)) : 0;
    const name = [limit.limitName, windowLabel(window.windowDurationMins) ? `${windowLabel(window.windowDurationMins)} limit` : null].filter(Boolean).join(" · ") || "Limit";
    const reset = resetTime(window.resetsAt), left = countdown(window.resetsAt);
    return <li key={`${limit.limitId}:${index}`} className="usage-window">
      <div className="flex flex-wrap justify-between gap-x-3 text-sm"><span>{name}</span><span className={`usage-value${used >= 95 ? " critical" : used >= 80 ? " high" : ""}`}>{known ? `${Math.round(used)}% used` : "Share not reported"}</span></div>
      {known && <div className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={name}><span style={{ width: `${used}%` }} /></div>}
      <p className="usage-reset">{left ? `${left}${reset ? ` · ${reset}` : ""}` : "Reset time not reported"}</p>
    </li>;
  })}</ul>;
}

type Providers = { openai: OpenAIAccount; claude: Subscription; gemini: Subscription };

/** Sidebar disclosure with each subscription's limits; loads when opened and when an account changes. */
export function UsagePanel({ refreshKey }: { refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Providers | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api<Providers>("/providers")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, refreshKey, load]);
  return <details className="usage-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Provider usage</summary>
    <div className="usage-panel-body">
      <div className="flex items-center justify-end"><Button variant="ghost" size="icon-xs" aria-label="Reload provider usage" disabled={loading} onClick={() => void load()}><RefreshCw size={13} /></Button></div>
      {error && <p className="provider-note" role="alert">Usage unavailable: {error}</p>}
      {!data && !error && <p className="provider-note" role="status">Loading usage…</p>}
      {data && <>
        <section aria-label="OpenAI / ChatGPT usage"><h4>OpenAI / ChatGPT</h4><UsageWindows status={openAIUsage(data.openai)} /></section>
        <section aria-label="Claude usage"><h4>Claude</h4><UsageWindows status={subscriptionUsage(data.claude, "Claude", "Sign in with Claude Code")} /></section>
        <section aria-label="Antigravity usage"><h4>Antigravity</h4><UsageWindows status={subscriptionUsage(data.gemini, "Antigravity", "Sign in to Antigravity")} /></section>
      </>}
    </div>
  </details>;
}
