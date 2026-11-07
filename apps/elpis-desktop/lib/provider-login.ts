import { api } from "@/lib/api";
import { providerFormId, type ProviderType } from "@/lib/provider-form";
import { refreshUsage, type ConfiguredProvider, type OpenAIAccount, type Providers, type Subscription } from "@/components/provider-usage";

export type ProviderId = "openai" | "claude" | "openrouter" | "anthropic" | "google-gemini" | "gemini" | "local" | "cloudroom" | string;
export type Method = "api-key" | "chatgpt-subscription" | "claude-subscription" | "openrouter-key" | "local";
export type AccountId = string;
export type AttemptId = string;
export type SecretInput = string;

export type AccountState =
  | "not configured"
  | "signing in"
  | "configured, unverified"
  | "connected"
  | "refreshing"
  | "expired / sign in again"
  | "offline"
  | "unavailable"
  | "signed out"
  | "error";

export type AccountView = {
  id: AccountId;
  provider: ProviderId;
  label: string;
  email?: string | null;
  plan?: string | null;
  method: Method;
  source: "subscription" | "saved" | "environment" | "stored" | "local" | "external" | "none";
  owner: "app" | "codex-cli" | "claude-code" | "environment" | "external";
  selected: boolean;
  writable: boolean;
  state: AccountState;
  baseUrl?: string | null;
  envKey?: string | null;
  keySet?: boolean;
  duplicate?: boolean;
  error?: string | null;
};

export type Attempt = {
  id: AttemptId;
  provider: ProviderId;
  method: Method;
  accountId?: AccountId;
  state: "signing in" | "completed" | "cancelled" | "error";
  authUrl?: string;
  instructions: string;
};

export type DisconnectResult = {
  provider: ProviderId;
  accountId: AccountId;
  removedLocal: boolean;
  externalOwner?: string | null;
  remoteRevoked: boolean;
  message: string;
};

export type ErrorCategory = "cancelled" | "denied" | "timeout" | "invalid_key" | "rate_limit" | "quota" | "network" | "storage" | "conflict" | "unsupported" | "unknown";

export type LoginEvent = {
  type: "attempt-started" | "attempt-completed" | "attempt-cancelled" | "attempt-failed" | "refresh-outcome" | "disconnect-outcome";
  provider: ProviderId;
  method: Method;
  attemptId?: AttemptId;
  errorCategory?: ErrorCategory;
  durationMs: number;
};

export type Unsubscribe = () => void;

export type ProviderConfigItem = {
  id: string;
  name: string;
  baseUrl: string | null;
  wireApi: string;
  editable: boolean;
  gateway?: boolean;
  auth: { source: string; keySet: boolean; envKey: string | null; acceptsKey?: boolean };
};

export type ProviderConfigsSnapshot = {
  application?: { scope: string; message: string; credentialClearMessage: string };
  version: string | null;
  configPath: string | null;
  write: { available: boolean; reason?: string | null };
  managed: { modelProvider: string | null };
  providers: ProviderConfigItem[];
};

export type ClaudeAccountItem = {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  authenticated: boolean;
  duplicate: boolean;
  signingIn: boolean;
  error: string | null;
};

export type ClaudeAccountsSnapshot = {
  activeId: string;
  accounts: ClaudeAccountItem[];
  authUrl?: string;
};

export type CredentialCapability = {
  provider: ProviderId;
  accountId: AccountId;
  method: Method;
  source: AccountView["source"];
  configured: boolean;
  selected: boolean;
  baseUrl: string | null;
};

export type ProviderStatusSnapshot = {
  providers: Providers | null;
  config: ProviderConfigsSnapshot | null;
  claudeAccounts: ClaudeAccountsSnapshot | null;
  accounts: AccountView[];
};

export interface ProviderLogin {
  capabilities(provider: ProviderId): Promise<Method[]>;
  accounts(provider?: ProviderId): Promise<AccountView[]>;
  begin(provider: ProviderId, method?: Method, account?: AccountId): Promise<Attempt>;
  cancel(attempt: AttemptId): Promise<void>;
  setKey(
    provider: ProviderId,
    account: AccountId,
    secret: SecretInput,
    options?: { type?: ProviderType; name?: string; baseUrl?: string; version?: string | null; existing?: boolean; action?: "preserve" | "replace" | "clear" },
  ): Promise<ProviderConfigsSnapshot | null>;
  select(provider: ProviderId, account: AccountId): Promise<void>;
  disconnect(
    provider: ProviderId,
    account?: AccountId,
    options?: { version?: string | null; name?: string; baseUrl?: string },
  ): Promise<DisconnectResult>;
  subscribe(listener: (event: LoginEvent) => void): Unsubscribe;
}

const listeners = new Set<(event: LoginEvent) => void>();
const attempts = new Map<AttemptId, Attempt & { startedAt: number }>();
let attemptCounter = 0;

function emit(event: LoginEvent) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* subscriber errors never break auth flow */ }
  }
}

export function classifyLoginError(error: unknown): ErrorCategory {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.toLowerCase();
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("changed elsewhere") || text.includes("stale") || text.includes("reload settings")) return "conflict";
  if (text.includes("denied") || text.includes("401") || text.includes("403")) return "denied";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("took too long")) return "timeout";
  if (text.includes("ascii") || text.includes("invalid") || text.includes("credential")) return "invalid_key";
  if (text.includes("rate limit") || text.includes("429")) return "rate_limit";
  if (text.includes("quota") || text.includes("limit")) return "quota";
  if (text.includes("writable") || text.includes("config") || text.includes("file")) return "storage";
  if (text.includes("network") || text.includes("fetch") || text.includes("reach")) return "network";
  return "unknown";
}

export async function openAuthPage(url: string) {
  if (typeof window === "undefined" || !url) return;
  if (window.elpisDesktop?.browser) {
    try {
      await window.elpisDesktop.browser.command("external-url", { url });
      return;
    } catch {
      // Fallback to window.open when the URL is handled by the window opener or test harness.
    }
  }
  window.open(url, "_blank", "noopener");
}

function mapOpenAIView(openai: OpenAIAccount): AccountView {
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

function mapClaudeViews(claude: Subscription, claudeAccounts: ClaudeAccountsSnapshot | null): AccountView[] {
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

function mapKeyProviderView(item: ProviderConfigItem, openrouterItems: ConfiguredProvider[]): AccountView {
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
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
