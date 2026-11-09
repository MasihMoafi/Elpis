import { attempts, nextAttemptId, readProviderConfig } from "@/lib/provider-login-flows";
export { attempts, readProviderConfig } from "@/lib/provider-login-flows";
import { runBegin, runDisconnect } from "@/lib/provider-login-flows";
import { openAuthPage } from "./provider-auth-page.ts";
export { openAuthPage } from "./provider-auth-page.ts";
import { subscribeLoginEvents, emit, classifyLoginError } from "./provider-auth-events.ts";
export { classifyLoginError } from "./provider-auth-events.ts";
import { mapOpenAIView, mapClaudeViews, mapKeyProviderView } from "./provider-account-views.ts";
import type { ProviderId, Method, AccountId, AttemptId, SecretInput, AccountView, Attempt, DisconnectResult, LoginEvent, Unsubscribe, ProviderConfigsSnapshot, ClaudeAccountsSnapshot, CredentialCapability, ProviderStatusSnapshot, ProviderLogin, SetKeyOptions } from "./provider-login-types.ts";
export type {
  ProviderId,
  Method,
  AccountId,
  AttemptId,
  SecretInput,
  AccountState,
  AccountView,
  Attempt,
  DisconnectResult,
  ErrorCategory,
  LoginEvent,
  Unsubscribe,
  ProviderConfigItem,
  ProviderConfigsSnapshot,
  ClaudeAccountItem,
  ClaudeAccountsSnapshot,
  CredentialCapability,
  ProviderStatusSnapshot,
  ProviderLogin,
} from "./provider-login-types.ts";
import { api } from "@/lib/api";
import { providerFormId, type ProviderType } from "@/lib/provider-form";
import { refreshUsage, type Providers } from "@/components/provider-usage";

export async function readClaudeAccounts(): Promise<ClaudeAccountsSnapshot | null> {
  const res = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts").catch(() => null);
  return res && Array.isArray(res.accounts) ? res : null;
}

export const providerLogin: ProviderLogin & {
  listProviders: () => Promise<ProviderStatusSnapshot>;
  status: (provider?: ProviderId) => Promise<ProviderStatusSnapshot>;
  signIn: (input: {
    provider: ProviderId;
    method?: Method;
    accountId?: AccountId;
    code?: string;
  }) => Promise<Attempt & { claudeAccounts?: ClaudeAccountsSnapshot | null }>;
  signOut: (input: {
    provider: ProviderId;
    accountId?: AccountId;
    version?: string | null;
    name?: string;
    baseUrl?: string;
  }) => Promise<DisconnectResult>;
  getCredentials: (provider?: ProviderId) => Promise<CredentialCapability[]>;
  loginClaudeAccount: (accountId?: string | null) => Promise<ClaudeAccountsSnapshot>;
  selectClaudeAccount: (accountId: string) => Promise<ClaudeAccountsSnapshot>;
  completeClaudeCode: (code: string, accountId?: string | null) => Promise<ClaudeAccountsSnapshot>;
  saveBuiltInKey: (provider: ProviderId, key: SecretInput) => Promise<void>;
} = {
  capabilities(provider: ProviderId): Promise<Method[]> {
    if (provider === "openai") return Promise.resolve(["chatgpt-subscription", "api-key"]);
    if (provider === "claude") return Promise.resolve(["claude-subscription", "api-key"]);
    if (provider === "openrouter") return Promise.resolve(["openrouter-key", "api-key"]);
    if (provider === "local") return Promise.resolve(["local"]);
    return Promise.resolve(["api-key"]);
  },

  async listProviders(): Promise<ProviderStatusSnapshot> {
    const [providers, config, claudeAccounts] = await Promise.all([
      api<Providers>("/providers").catch(() => null),
      readProviderConfig(),
      readClaudeAccounts(),
    ]);
    const accounts: AccountView[] = [];
    if (providers?.openai) accounts.push(mapOpenAIView(providers.openai));
    if (providers?.claude) accounts.push(...mapClaudeViews(providers.claude, claudeAccounts));
    const configured =
      config?.providers.filter(p => p.id !== "openai" && p.auth.source !== "subscription" && !p.gateway) ?? [];
    for (const item of configured) accounts.push(mapKeyProviderView(item, providers?.openrouter ?? []));
    return { providers, config, claudeAccounts, accounts };
  },

  async status(provider?: ProviderId): Promise<ProviderStatusSnapshot> {
    const snapshot = await this.listProviders();
    if (!provider) return snapshot;
    return {
      ...snapshot,
      accounts: snapshot.accounts.filter(account => account.provider === provider || account.id === provider),
    };
  },

  async accounts(provider?: ProviderId): Promise<AccountView[]> {
    const snapshot = await this.status(provider);
    return snapshot.accounts;
  },

  async begin(provider: ProviderId, method?: Method, account?: AccountId): Promise<Attempt> {
    return runBegin.call(this, provider, method, account);
  },

  cancel(attemptId: AttemptId): Promise<void> {
    const current = attempts.get(attemptId);
    attempts.delete(attemptId);
    if (current) {
      emit({
        type: "attempt-cancelled",
        provider: current.provider,
        method: current.method,
        attemptId,
        errorCategory: "cancelled",
        durationMs: Date.now() - current.startedAt,
      });
    }
    return Promise.resolve();
  },

  async loginClaudeAccount(accountId?: string | null): Promise<ClaudeAccountsSnapshot> {
    const startedAt = Date.now();
    const id = nextAttemptId();
    emit({ type: "attempt-started", provider: "claude", method: "claude-subscription", attemptId: id, durationMs: 0 });
    try {
      const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", {
        action: "login",
        ...(accountId ? { id: accountId } : {}),
      });
      if (next.authUrl) await openAuthPage(next.authUrl);
      return next;
    } catch (error) {
      emit({
        type: "attempt-failed",
        provider: "claude",
        method: "claude-subscription",
        attemptId: id,
        errorCategory: classifyLoginError(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },

  async selectClaudeAccount(accountId: string): Promise<ClaudeAccountsSnapshot> {
    const startedAt = Date.now();
    const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", { action: "select", id: accountId });
    emit({
      type: "refresh-outcome",
      provider: "claude",
      method: "claude-subscription",
      durationMs: Date.now() - startedAt,
    });
    return next;
  },

  async completeClaudeCode(code: string, accountId?: string | null): Promise<ClaudeAccountsSnapshot> {
    const startedAt = Date.now();
    try {
      const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", {
        action: "code",
        ...(accountId ? { id: accountId } : {}),
        code: code.trim(),
      });
      emit({
        type: "attempt-completed",
        provider: "claude",
        method: "claude-subscription",
        durationMs: Date.now() - startedAt,
      });
      return next;
    } catch (error) {
      emit({
        type: "attempt-failed",
        provider: "claude",
        method: "claude-subscription",
        errorCategory: classifyLoginError(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },

  async saveBuiltInKey(provider: ProviderId, key: SecretInput): Promise<void> {
    const startedAt = Date.now();
    const method: Method = provider === "openrouter" ? "openrouter-key" : "api-key";
    try {
      await api("/providers/key", { provider, key });
      emit({ type: "attempt-completed", provider, method, durationMs: Date.now() - startedAt });
    } catch (error) {
      emit({
        type: "attempt-failed",
        provider,
        method,
        errorCategory: classifyLoginError(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },

  async setKey(
    provider: ProviderId,
    account: AccountId,
    secret: SecretInput,
    options?: SetKeyOptions,
  ): Promise<ProviderConfigsSnapshot | null> {
    const startedAt = Date.now();
    const method: Method =
      provider === "openrouter" || options?.type === "openrouter"
        ? "openrouter-key"
        : options?.type === "local"
          ? "local"
          : "api-key";
    try {
      if (!options?.baseUrl && ["openrouter", "anthropic", "google-gemini"].includes(provider) && !options?.version) {
        await this.saveBuiltInKey(provider, secret);
        return await readProviderConfig();
      }
      const current = options?.version ? null : await readProviderConfig();
      const version = options?.version ?? current?.version ?? null;
      const existingIds = current?.providers.map(item => item.id) ?? [];
      const type: ProviderType =
        options?.type ?? (provider === "openrouter" ? "openrouter" : provider === "local" ? "local" : "custom");
      const name = (
        options?.name ?? (type === "openrouter" ? "OpenRouter" : type === "local" ? "Local server" : provider)
      ).trim();
      const baseUrl = (
        options?.baseUrl ??
        (type === "openrouter" ? "https://openrouter.ai/api/v1" : type === "local" ? "http://127.0.0.1:1234/v1" : "")
      ).trim();
      const id = providerFormId(
        { type, name, ...(options?.existing && account ? { existingId: account } : {}) },
        existingIds,
      );
      const action = options?.action ?? (secret ? "replace" : "preserve");
      const saved = await api<ProviderConfigsSnapshot>("/providers/settings", {
        version,
        id,
        name,
        baseUrl,
        credential: { action, ...(action === "replace" ? { value: secret } : {}) },
      });
      await refreshUsage();
      emit({ type: "attempt-completed", provider, method, durationMs: Date.now() - startedAt });
      return saved;
    } catch (error) {
      emit({
        type: "attempt-failed",
        provider,
        method,
        errorCategory: classifyLoginError(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },

  async select(provider: ProviderId, account: AccountId): Promise<void> {
    const startedAt = Date.now();
    if (provider === "claude") {
      await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", { action: "select", id: account });
      await refreshUsage();
      emit({
        type: "refresh-outcome",
        provider: "claude",
        method: "claude-subscription",
        durationMs: Date.now() - startedAt,
      });
      return;
    }
  },

  async disconnect(
    provider: ProviderId,
    account: AccountId = "default",
    options?: { version?: string | null; name?: string; baseUrl?: string },
  ): Promise<DisconnectResult> {
    return runDisconnect.call(this, provider, account, options);
  },

  async signIn(input: { provider: ProviderId; method?: Method; accountId?: AccountId; code?: string }) {
    if (input.provider === "claude" && input.code) {
      const claudeAccounts = await this.completeClaudeCode(input.code, input.accountId);
      return {
        id: "claude-code",
        provider: "claude",
        method: "claude-subscription" as const,
        state: "completed" as const,
        instructions: "Claude account connected.",
        claudeAccounts,
      };
    }
    return await this.begin(input.provider, input.method, input.accountId);
  },

  async signOut(input: {
    provider: ProviderId;
    accountId?: AccountId;
    version?: string | null;
    name?: string;
    baseUrl?: string;
  }) {
    return await this.disconnect(input.provider, input.accountId, input);
  },

  async getCredentials(provider?: ProviderId): Promise<CredentialCapability[]> {
    const accounts = await this.accounts(provider);
    return accounts.map(account => ({
      provider: account.provider,
      accountId: account.id,
      method: account.method,
      source: account.source,
      configured: account.state === "connected" || account.state === "configured, unverified",
      selected: account.selected,
      baseUrl: account.baseUrl ?? null,
    }));
  },

  subscribe(listener: (event: LoginEvent) => void): Unsubscribe {
    return subscribeLoginEvents(listener);
  },
};
