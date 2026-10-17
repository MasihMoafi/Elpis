"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

// Usage as Elpis reports it from account/rateLimits/read, one provider at a time (Cloudroom's usage card).
export type UsageWindow = { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null };
export type UsageLimit = { limitId: string | null; limitName: string | null; planType: string | null; primary: UsageWindow | null; secondary: UsageWindow | null; reached: string | null };
// `signedOut`: Elpis's own sign-out of the subscription (Claude only); the account on this computer stays signed in.
// `unknown`: Elpis could not read its model list this time; that is not a sign-out, so reported usage stays.
export type Subscription = { state: "connected" | "available" | "notConnected" | "unknown"; models: string[]; usage: UsageLimit[]; signedOut?: boolean };
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
  if (subscription.signedOut) return { kind: "unauthenticated", hint: `Signed out in Elpis. Sign in under Models & accounts to see ${name} usage.` };
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

export type ConfiguredProvider = { id: string; name: string; baseUrl: string | null; envKey: string | null; keySet: boolean | null };
export type Providers = { openai: OpenAIAccount; claude: Subscription; gemini: Subscription; openrouter: ConfiguredProvider[] };

/** A later answer can omit an account's usage while its bridge rereads it (a subscription then reads "available").
 * A reported value stays until the account signs out or reports a new one; it is never replaced by "not reported". */
export function keepReportedUsage(previous: Providers | null, next: Providers): Providers {
  if (!previous) return next;
  const openai = next.openai?.auth?.state === "signedOut" || next.openai?.usage?.length || !previous.openai?.usage?.length ? next.openai
    : { ...next.openai, usage: previous.openai.usage, usageError: null };
  const subscription = (before: Subscription, after: Subscription): Subscription => after?.state === "notConnected" || after?.usage?.length || !before?.usage?.length ? after
    : { ...after, state: "connected", usage: before.usage };
  return { ...next, openai, claude: subscription(previous.claude, next.claude), gemini: subscription(previous.gemini, next.gemini) };
}

// One store for the whole app: the sidebar, Usage & limits and Models & accounts read the same answer, and only one
// request runs at a time; a reload asked for meanwhile runs once after it.
type UsageState = { data: Providers | null; error: string; loading: boolean };
let usage: UsageState = { data: null, error: "", loading: false };
const listeners = new Set<() => void>();
let running: Promise<void> | null = null, queued = false, seenKey: number | null = null, retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
const update = (next: Partial<UsageState>) => { usage = { ...usage, ...next }; for (const listener of listeners) listener(); };

function reload(): Promise<void> {
  if (running) { queued = true; return running; }
  clearTimeout(retryTimer); update({ loading: true });
  running = (async () => {
    try { update({ data: keepReportedUsage(usage.data, await api<Providers>("/providers")), error: "" }); }
    catch (e) { update({ error: e instanceof Error ? e.message : String(e) }); }
    finally {
      running = null; update({ loading: false });
      if (queued) { queued = false; void reload(); }
      // A subscription's bridge reads its usage in the background, so it can be missing at first, and the first
      // request can fail while Elpis starts: then it asks twice more.
      else if ((usage.error || [usage.data?.claude, usage.data?.gemini].some(item => item?.models?.length && !item.usage?.length)) && retries < 2) retryTimer = setTimeout(() => { retries++; void reload(); }, 6000);
    }
  })();
  return running;
}
/** Reads every account again now, as the Refresh buttons and account changes do. */
export function refreshUsage() { retries = 0; return reload(); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  interval ??= setInterval(() => void reload(), 5 * 60_000);
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(interval); interval = undefined; } };
}
const snapshot = () => usage;

/** Every account's reported usage, from the shared store: loaded once, again when an account changes (refreshKey),
 * and every five minutes. */
export function useProviderUsage(refreshKey: number) {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (refreshKey === seenKey && (usage.data || running)) return;
    seenKey = refreshKey; void refreshUsage();
  }, [refreshKey]);
  return { ...state, load: refreshUsage };
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
