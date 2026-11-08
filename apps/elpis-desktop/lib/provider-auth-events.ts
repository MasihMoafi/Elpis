import type { Unsubscribe } from './provider-login-types';
import type { ErrorCategory, LoginEvent } from './provider-login-types.ts';
export const listeners = new Set<(event: LoginEvent) => void>();
export function emit(event: LoginEvent) {
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch { /* subscriber errors never break auth flow */ }
    }
}
export function classifyLoginError(error: unknown): ErrorCategory {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const text = raw.toLowerCase();
    if (text.includes("cancel"))
        return "cancelled";
    if (text.includes("changed elsewhere") || text.includes("stale") || text.includes("reload settings"))
        return "conflict";
    if (text.includes("denied") || text.includes("401") || text.includes("403"))
        return "denied";
    if (text.includes("timeout") || text.includes("timed out") || text.includes("took too long"))
        return "timeout";
    if (text.includes("ascii") || text.includes("invalid") || text.includes("credential"))
        return "invalid_key";
    if (text.includes("rate limit") || text.includes("429"))
        return "rate_limit";
    if (text.includes("quota") || text.includes("limit"))
        return "quota";
    if (text.includes("writable") || text.includes("config") || text.includes("file"))
        return "storage";
    if (text.includes("network") || text.includes("fetch") || text.includes("reach"))
        return "network";
    return "unknown";
}
export function subscribeLoginEvents(listener: (event: LoginEvent) => void): Unsubscribe { listeners.add(listener); return () => { listeners.delete(listener); }; }
