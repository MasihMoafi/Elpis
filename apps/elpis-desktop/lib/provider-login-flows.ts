import { openAuthPage } from "./provider-auth-page.ts";
import { emit, classifyLoginError } from "./provider-auth-events.ts";
import type {
  ProviderId,
  Method,
  AccountId,
  Attempt,
  DisconnectResult,
  ProviderConfigsSnapshot,
  ClaudeAccountsSnapshot,
  ProviderLogin,
} from "./provider-login-types.ts";
import { api } from "@/lib/api";
import { refreshUsage } from "@/components/provider-usage";
import type { AttemptId } from "./provider-login-types.ts";

export async function runBegin(
  this: ProviderLogin,
  provider: ProviderId,
  method?: Method,
  account?: AccountId,
): Promise<Attempt> {
  const startedAt = Date.now();
  const resolvedMethod: Method =
    method ??
    (provider === "openai"
      ? "chatgpt-subscription"
      : provider === "claude"
        ? "claude-subscription"
        : provider === "openrouter"
          ? "openrouter-key"
          : "api-key");
  const id = nextAttemptId();
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
        emit({
          type: "attempt-completed",
          provider,
          method: resolvedMethod,
          attemptId: attempt.id,
          durationMs: Date.now() - startedAt,
        });
      }
      return attempt;
    }
    if (provider === "claude" && resolvedMethod === "claude-subscription") {
      if (account === "elpis-enable") {
        await api("/providers", { action: "anthropicSignIn" });
        await refreshUsage();
        const attempt: Attempt = {
          id,
          provider,
          method: resolvedMethod,
          state: "completed",
          instructions: "Claude subscription enabled in Elpis.",
        };
        emit({
          type: "attempt-completed",
          provider,
          method: resolvedMethod,
          attemptId: id,
          durationMs: Date.now() - startedAt,
        });
        return attempt;
      }
      const next = await api<ClaudeAccountsSnapshot>("/providers/claude-accounts", {
        action: "login",
        ...(account ? { id: account } : {}),
      });
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
    const attempt: Attempt = {
      id,
      provider,
      method: resolvedMethod,
      state: "signing in",
      instructions: "Enter your API key on this device.",
    };
    attempts.set(id, { ...attempt, startedAt });
    return attempt;
  } catch (error) {
    emit({
      type: "attempt-failed",
      provider,
      method: resolvedMethod,
      attemptId: id,
      errorCategory: classifyLoginError(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function runDisconnect(
  this: ProviderLogin,
  provider: ProviderId,
  account: AccountId = "default",
  options?: { version?: string | null; name?: string; baseUrl?: string },
): Promise<DisconnectResult> {
  const startedAt = Date.now();
  const method: Method =
    provider === "openai"
      ? "chatgpt-subscription"
      : provider === "claude"
        ? "claude-subscription"
        : provider === "openrouter"
          ? "openrouter-key"
          : "api-key";
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
    emit({
      type: "disconnect-outcome",
      provider,
      method,
      errorCategory: classifyLoginError(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export const attempts = new Map<AttemptId, Attempt & { startedAt: number }>();

let attemptCounter = 0;
export const nextAttemptId = () => `attempt-${++attemptCounter}`;

export async function readProviderConfig(): Promise<ProviderConfigsSnapshot | null> {
  const configured = await api<ProviderConfigsSnapshot>("/providers/settings").catch(() => null);
  return configured && Array.isArray(configured.providers) ? configured : null;
}
