import { openAuthPage } from './provider-auth-page.ts';
export { openAuthPage } from './provider-auth-page.ts'
import { subscribeLoginEvents, emit, classifyLoginError } from './provider-auth-events.ts';
export { classifyLoginError } from './provider-auth-events.ts'
import { mapOpenAIView, mapClaudeViews, mapKeyProviderView } from './provider-account-views.ts';
import type { ProviderId, Method, AccountId, AttemptId, SecretInput, AccountView, Attempt, DisconnectResult, LoginEvent, Unsubscribe, ProviderConfigsSnapshot, ClaudeAccountsSnapshot, CredentialCapability, ProviderStatusSnapshot, ProviderLogin } from './provider-login-types.ts';
export type { ProviderId, Method, AccountId, AttemptId, SecretInput, AccountState, AccountView, Attempt, DisconnectResult, ErrorCategory, LoginEvent, Unsubscribe, ProviderConfigItem, ProviderConfigsSnapshot, ClaudeAccountItem, ClaudeAccountsSnapshot, CredentialCapability, ProviderStatusSnapshot, ProviderLogin } from './provider-login-types.ts'
import { api } from "@/lib/api";
import { providerFormId, type ProviderType } from "@/lib/provider-form";
import { refreshUsage, type Providers } from "@/components/provider-usage";
const attempts = new Map<AttemptId, Attempt & { startedAt: number }>();
let attemptCounter = 0;

export async function readProviderConfig(): Promise<ProviderConfigsSnapshot | null> {
  const configured = await api<ProviderConfigsSnapshot>("/providers/settings").catch(() => null);
  return configured && Array.isArray(configured.providers) ? configured : null;
}

export async function readClaudeAccounts(): Promise<ClaudeAccountsSnapshot | null> {
  const res = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts").catch(() => null);
  return res && Array.isArray(res.accounts) ? res : null;
}

export const providerLogin: ProviderLogin & {
  listProviders: () => Promise<ProviderStatusSnapshot>;
  status: (provider?: ProviderId) => Promise<ProviderStatusSnapshot>;
  signIn: (input: { provider: ProviderId; method?: Method; accountId?: AccountId; code?: string }) => Promise<Attempt & { claudeAccounts?: ClaudeAccountsSnapshot | null }>;
  signOut: (input: { provider: ProviderId; accountId?: AccountId; version?: string | null; name?: string; baseUrl?: string }) => Promise<DisconnectResult>;
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
    const configured = config?.providers.filter(p => p.id !== "openai" && p.auth.source !== "subscription" && !p.gateway) ?? [];
    for (const item of configured) accounts.push(mapKeyProviderView(item, providers?.openrouter ?? []));
    return { providers, config, claudeAccounts, accounts };
  },

  async status(provider?: ProviderId): Promise<ProviderStatusSnapshot> {
    const snapshot = await this.listProviders();
    if (!provider) return snapshot;
    return { ...snapshot, accounts: snapshot.accounts.filter(account => account.provider === provider || account.id === provider) };
  },

  async accounts(provider?: ProviderId): Promise<AccountView[]> {
    const snapshot = await this.status(provider);
    return snapshot.accounts;
  },

  async begin(provider: ProviderId, method?: Method, account?: AccountId): Promise<Attempt> {
    const startedAt = Date.now();
    const resolvedMethod: Method = method ?? (provider === "openai" ? "chatgpt-subscription" : provider === "claude" ? "claude-subscription" : provider === "openrouter" ? "openrouter-key" : "api-key");
    const id = `attempt-${++attemptCounter}`;
    emit({ type: "attempt-started", provider, method: resolvedMethod, attemptId: id, durationMs: 0 });
    try {
      if (provider === "openai" && resolvedMethod === "chatgpt-subscription") {
        const result = await api<{ authUrl?: string; loginId?: string }>("/providers", { action: "chatgpt" });
        const attempt: Attempt = {
          id: result.loginId || id,
          provider,
          method: resolvedMethod,
          state: result.authUrl ? "signing in" : "completed",
          ...(result.authUrl ? { authUrl: result.authUrl } : {}),
          instructions: "Complete sign-in in the page that opened.",
        };
        attempts.set(attempt.id, { ...attempt, startedAt });
        if (result.authUrl) await openAuthPage(result.authUrl);
        else {
          await refreshUsage();
          emit({ type: "attempt-completed", provider, method: resolvedMethod, attemptId: attempt.id, durationMs: Date.now() - startedAt });
        }
        return attempt;
      }
      if (provider === "claude" && resolvedMethod === "claude-subscription") {
        if (account === "elpis-enable") {
          await api("/providers", { action: "anthropicSignIn" });
          await refreshUsage();
          const attempt: Attempt = { id, provider, method: resolvedMethod, state: "completed", instructions: "Claude subscription enabled in Elpis." };
          emit({ type: "attempt-completed", provider, method: resolvedMethod, attemptId: id, durationMs: Date.now() - startedAt });
          return attempt;
        }
        const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", { action: "login", ...(account ? { id: account } : {}) });
        const signingAccount = next.accounts.find(item => item.signingIn)?.id ?? account;
        const attempt: Attempt = {
          id,
          provider,
          method: resolvedMethod,
          ...(signingAccount ? { accountId: signingAccount } : {}),
          state: next.authUrl ? "signing in" : "completed",
          ...(next.authUrl ? { authUrl: next.authUrl } : {}),
          instructions: "Paste the code from the Claude page to complete sign-in.",
        };
        attempts.set(id, { ...attempt, startedAt });
        if (next.authUrl) await openAuthPage(next.authUrl);
        return attempt;
      }
      const attempt: Attempt = { id, provider, method: resolvedMethod, state: "signing in", instructions: "Enter your API key on this device." };
      attempts.set(id, { ...attempt, startedAt });
      return attempt;
    } catch (error) {
      emit({ type: "attempt-failed", provider, method: resolvedMethod, attemptId: id, errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  },

  cancel(attemptId: AttemptId): Promise<void> {
    const current = attempts.get(attemptId);
    attempts.delete(attemptId);
    if (current) {
      emit({ type: "attempt-cancelled", provider: current.provider, method: current.method, attemptId, errorCategory: "cancelled", durationMs: Date.now() - current.startedAt });
    }
    return Promise.resolve();
  },

  async loginClaudeAccount(accountId?: string | null): Promise<ClaudeAccountsSnapshot> {
    const startedAt = Date.now();
    const id = `attempt-${++attemptCounter}`;
    emit({ type: "attempt-started", provider: "claude", method: "claude-subscription", attemptId: id, durationMs: 0 });
    try {
      const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", {
        action: "login",
        ...(accountId ? { id: accountId } : {}),
      });
      if (next.authUrl) await openAuthPage(next.authUrl);
      return next;
    } catch (error) {
      emit({ type: "attempt-failed", provider: "claude", method: "claude-subscription", attemptId: id, errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  },

  async selectClaudeAccount(accountId: string): Promise<ClaudeAccountsSnapshot> {
    const startedAt = Date.now();
    const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", { action: "select", id: accountId });
    emit({ type: "refresh-outcome", provider: "claude", method: "claude-subscription", durationMs: Date.now() - startedAt });
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
      emit({ type: "attempt-completed", provider: "claude", method: "claude-subscription", durationMs: Date.now() - startedAt });
      return next;
    } catch (error) {
      emit({ type: "attempt-failed", provider: "claude", method: "claude-subscription", errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
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
      emit({ type: "attempt-failed", provider, method, errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  },

  async setKey(
    provider: ProviderId,
    account: AccountId,
    secret: SecretInput,
    options?: { type?: ProviderType; name?: string; baseUrl?: string; version?: string | null; existing?: boolean; action?: "preserve" | "replace" | "clear" },
  ): Promise<ProviderConfigsSnapshot | null> {
    const startedAt = Date.now();
    const method: Method = provider === "openrouter" || options?.type === "openrouter" ? "openrouter-key" : options?.type === "local" ? "local" : "api-key";
    try {
      if (!options?.baseUrl && ["openrouter", "anthropic", "google-gemini"].includes(provider) && !options?.version) {
        await this.saveBuiltInKey(provider, secret);
        return await readProviderConfig();
      }
      const current = options?.version ? null : await readProviderConfig();
      const version = options?.version ?? current?.version ?? null;
      const existingIds = current?.providers.map(item => item.id) ?? [];
      const type: ProviderType = options?.type ?? (provider === "openrouter" ? "openrouter" : provider === "local" ? "local" : "custom");
      const name = (options?.name ?? (type === "openrouter" ? "OpenRouter" : type === "local" ? "Local server" : provider)).trim();
      const baseUrl = (options?.baseUrl ?? (type === "openrouter" ? "https://openrouter.ai/api/v1" : type === "local" ? "http://127.0.0.1:1234/v1" : "")).trim();
      const id = providerFormId({ type, name, ...(options?.existing && account ? { existingId: account } : {}) }, existingIds);
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
      emit({ type: "attempt-failed", provider, method, errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  },

  async select(provider: ProviderId, account: AccountId): Promise<void> {
    const startedAt = Date.now();
    if (provider === "claude") {
      await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", { action: "select", id: account });
      await refreshUsage();
      emit({ type: "refresh-outcome", provider: "claude", method: "claude-subscription", durationMs: Date.now() - startedAt });
      return;
    }
  },

  async disconnect(
    provider: ProviderId,
    account: AccountId = "default",
    options?: { version?: string | null; name?: string; baseUrl?: string },
  ): Promise<DisconnectResult> {
    const startedAt = Date.now();
    const method: Method = provider === "openai" ? "chatgpt-subscription" : provider === "claude" ? "claude-subscription" : provider === "openrouter" ? "openrouter-key" : "api-key";
    try {
      if (provider === "openai") {
        await api("/providers", { action: "signOut" });
        await refreshUsage();
        const result: DisconnectResult = {
          provider,
          accountId: account,
          removedLocal: true,
          externalOwner: null,
          remoteRevoked: false,
          message: "Signed out of ChatGPT on this device.",
        };
        emit({ type: "disconnect-outcome", provider, method, durationMs: Date.now() - startedAt });
        return result;
      }
      if (provider === "claude") {
        await api("/providers", { action: "anthropicSignOut" });
        await refreshUsage();
        const result: DisconnectResult = {
          provider,
          accountId: account,
          removedLocal: true,
          externalOwner: "claude-code",
          remoteRevoked: false,
          message: "Elpis is not using your Claude subscription. Claude Code on this computer stays signed in.",
        };
        emit({ type: "disconnect-outcome", provider, method, durationMs: Date.now() - startedAt });
        return result;
      }
      const current = options?.version ? null : await readProviderConfig();
      const target = current?.providers.find(item => item.id === account || item.id === provider);
      const version = options?.version ?? current?.version ?? null;
      const name = options?.name ?? target?.name ?? account;
      const baseUrl = options?.baseUrl ?? target?.baseUrl ?? "";
      await api<ProviderConfigsSnapshot>("/providers/settings", {
        version,
        id: account,
        name,
        baseUrl,
        credential: { action: "clear" },
      });
      await refreshUsage();
      const result: DisconnectResult = {
        provider,
        accountId: account,
        removedLocal: true,
        externalOwner: null,
        remoteRevoked: false,
        message: "Cleared the saved key for new conversations.",
      };
      emit({ type: "disconnect-outcome", provider, method, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      emit({ type: "disconnect-outcome", provider, method, errorCategory: classifyLoginError(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  },

  async signIn(input: { provider: ProviderId; method?: Method; accountId?: AccountId; code?: string }) {
    if (input.provider === "claude" && input.code) {
      const claudeAccounts = await this.completeClaudeCode(input.code, input.accountId);
      return { id: "claude-code", provider: "claude", method: "claude-subscription" as const, state: "completed" as const, instructions: "Claude account connected.", claudeAccounts };
    }
    return await this.begin(input.provider, input.method, input.accountId);
  },

  async signOut(input: { provider: ProviderId; accountId?: AccountId; version?: string | null; name?: string; baseUrl?: string }) {
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
