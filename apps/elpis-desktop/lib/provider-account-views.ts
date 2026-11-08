import type { AccountView, ProviderConfigItem, ClaudeAccountsSnapshot } from './provider-login-types.ts';
import type { ConfiguredProvider, OpenAIAccount, Subscription } from "@/components/provider-usage";
export function mapOpenAIView(openai: OpenAIAccount): AccountView {
    const signedIn = openai.auth.state === "signedIn";
    return {
        id: "openai-default",
        provider: "openai",
        label: openai.auth.email || "OpenAI / ChatGPT",
        email: openai.auth.email ?? null,
        plan: openai.auth.plan ?? null,
        method: "chatgpt-subscription",
        source: "subscription",
        owner: "codex-cli",
        selected: signedIn,
        writable: true,
        state: signedIn ? "connected" : openai.auth.state === "unknown" ? "unavailable" : "signed out",
        error: openai.auth.error ?? openai.usageError ?? null,
    };
}
export function mapClaudeViews(claude: Subscription, claudeAccounts: ClaudeAccountsSnapshot | null): AccountView[] {
    if (claudeAccounts?.accounts?.length) {
        return claudeAccounts.accounts.map(account => ({
            id: account.id,
            provider: "claude",
            label: account.email ?? account.label,
            email: account.email,
            plan: account.plan,
            method: "claude-subscription",
            source: "subscription",
            owner: "claude-code",
            selected: claudeAccounts.activeId === account.id && !claude.signedOut,
            writable: true,
            duplicate: account.duplicate,
            state: claude.signedOut
                ? "signed out"
                : account.signingIn
                    ? "signing in"
                    : account.error
                        ? "error"
                        : account.authenticated
                            ? "connected"
                            : "not configured",
            error: account.error,
        }));
    }
    return [{
            id: "default",
            provider: "claude",
            label: "Anthropic Claude",
            method: "claude-subscription",
            source: "subscription",
            owner: "claude-code",
            selected: !claude.signedOut && claude.state === "connected",
            writable: true,
            state: claude.signedOut
                ? "signed out"
                : claude.state === "connected" || claude.state === "available"
                    ? "connected"
                    : claude.state === "unknown"
                        ? "unavailable"
                        : "not configured",
        }];
}
export function mapKeyProviderView(item: ProviderConfigItem, openrouterItems: ConfiguredProvider[]): AccountView {
    const isOpenRouter = item.id === "openrouter" || openrouterItems.some(or => or.id === item.id) || (item.baseUrl ?? "").includes("openrouter.ai");
    const isLocal = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])\b/i.test(item.baseUrl ?? "");
    const keySet = Boolean(item.auth.keySet);
    const source = (["subscription", "saved", "environment", "stored"].includes(item.auth.source) ? item.auth.source : isLocal ? "local" : "none") as AccountView["source"];
    return {
        id: item.id,
        provider: isOpenRouter ? "openrouter" : isLocal ? "local" : item.id,
        label: item.name,
        method: isOpenRouter ? "openrouter-key" : isLocal ? "local" : "api-key",
        source,
        owner: source === "environment" ? "environment" : "app",
        selected: keySet || isLocal,
        writable: item.editable,
        state: keySet || isLocal ? "configured, unverified" : "not configured",
        baseUrl: item.baseUrl,
        envKey: item.auth.envKey,
        keySet,
    };
}
