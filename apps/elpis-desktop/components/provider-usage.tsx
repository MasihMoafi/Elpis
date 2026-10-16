"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export type Providers = { openai: OpenAIAccount; claude: Subscription; gemini: Subscription };

/** Every account's reported usage, reloaded when an account changes and every five minutes. A subscription's
 * bridge reads its usage in the background, so it can be missing at first, and the first request can fail while
 * Elpis starts: then it asks twice more. */
export function useProviderUsage(refreshKey: number) {
  const [data, setData] = useState<Providers | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const retries = useRef(0);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api<Providers>("/providers")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { retries.current = 0; void load(); const timer = setInterval(() => void load(), 5 * 60_000); return () => clearInterval(timer); }, [refreshKey, load]);
  useEffect(() => {
    // Also when the first request failed, as it can while Elpis is still starting.
    const missing = error || (data && [data.claude, data.gemini].some(item => item?.state === "connected" && !item.usage?.length));
    if (!missing || retries.current >= 2) return;
    const timer = setTimeout(() => { retries.current++; void load(); }, 6000);
    return () => clearTimeout(timer);
  }, [data, error, load]);
  return { data, error, loading, load };
}

/** The reported window closest to its limit: the one that will stop work first. */
export function tightest(limits: UsageLimit[]) {
  const windows = limits.flatMap(limit => [limit.primary, limit.secondary]).filter((window): window is UsageWindow => typeof window?.usedPercent === "number");
  return windows.sort((a, b) => b.usedPercent! - a.usedPercent!)[0] ?? null;
}

/** The sidebar's usage, as the ChatGPT app's "Usage 73% left": each account's share left on its tightest limit,
 * loaded at start and every five minutes; selecting it opens Usage & limits. */
export function UsagePanel({ refreshKey, onOpen }: { refreshKey: number; onOpen: () => void }) {
  const { data, error } = useProviderUsage(refreshKey);
  const rows = data ? ([["ChatGPT", data.openai?.auth?.state === "signedIn" ? data.openai.usage : []], ["Anthropic", data.claude?.usage], ["Antigravity", data.gemini?.usage]] as const)
    .map(([name, limits]) => ({ name, window: tightest([...(limits ?? [])]) })).filter(row => row.window) : [];
  return <button type="button" className="usage-summary" aria-label="Usage and limits" title="Usage and limits" onClick={onOpen}>
    {rows.map(({ name, window }) => { const used = Math.max(0, Math.min(100, window!.usedPercent!));
      return <span key={name} className={`usage-row${used >= 95 ? " critical" : used >= 80 ? " high" : ""}`} title={[`${windowLabel(window!.windowDurationMins)} limit`, countdown(window!.resetsAt)].filter(Boolean).join(" · ")}>
        <span>{name}</span><span className="usage-left">{Math.round(100 - used)}% left</span><i style={{ "--used": `${used}%` } as React.CSSProperties} />
      </span>; })}
    {!data && !error && <span className="usage-row-note">Loading usage…</span>}
    {error && <span className="usage-row-note">Usage unavailable</span>}
    {data && !rows.length && <span className="usage-row-note">Usage not reported</span>}
  </button>;
}
