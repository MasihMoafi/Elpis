import { type ProviderType } from "@/lib/provider-form";
import { type Providers } from "@/components/provider-usage";
export type ProviderId =
  "openai" | "claude" | "openrouter" | "anthropic" | "google-gemini" | "gemini" | "local" | "cloudroom" | string;
export type Method = "api-key" | "chatgpt-subscription" | "claude-subscription" | "openrouter-key" | "local";
export type AccountId = string;
export type SetKeyOptions = {
  type?: ProviderType;
  name?: string;
  baseUrl?: string;
  version?: string | null;
  existing?: boolean;
  action?: "preserve" | "replace" | "clear";
};
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
export type ErrorCategory =
  | "cancelled"
  | "denied"
  | "timeout"
  | "invalid_key"
  | "rate_limit"
  | "quota"
  | "network"
  | "storage"
  | "conflict"
  | "unsupported"
  | "unknown";
export type LoginEvent = {
  type:
    | "attempt-started"
    | "attempt-completed"
    | "attempt-cancelled"
    | "attempt-failed"
    | "refresh-outcome"
    | "disconnect-outcome";
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
  auth: {
    source: string;
    keySet: boolean;
    envKey: string | null;
    acceptsKey?: boolean;
  };
};
export type ProviderConfigsSnapshot = {
  application?: {
    scope: string;
    message: string;
    credentialClearMessage: string;
  };
  version: string | null;
  configPath: string | null;
  write: {
    available: boolean;
    reason?: string | null;
  };
  managed: {
    modelProvider: string | null;
  };
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
    options?: SetKeyOptions,
  ): Promise<ProviderConfigsSnapshot | null>;
  select(provider: ProviderId, account: AccountId): Promise<void>;
  disconnect(
    provider: ProviderId,
    account?: AccountId,
    options?: {
      version?: string | null;
      name?: string;
      baseUrl?: string;
    },
  ): Promise<DisconnectResult>;
  subscribe(listener: (event: LoginEvent) => void): Unsubscribe;
}
