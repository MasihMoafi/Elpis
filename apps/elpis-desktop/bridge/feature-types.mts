import type { acceptsPastedKey } from "./provider-settings.mts";
export type RecordValue = Record<string, unknown>;
export type RolloutItem = RecordValue & {
  type?: unknown;
  role?: string;
  output?:
    | {
        body?: unknown;
      }
    | string;
  encrypted_content?: unknown;
};
export type Usage = {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  totalTokens?: unknown;
};
export type TokenUsage = {
  last?: Usage | null;
  total?: Usage | null;
  modelContextWindow?: unknown;
  contextAttribution?: Record<string, number> | null;
};
export type Shares = Record<string, number> & {
  toolDefinitions: number;
};
export type Definition = Parameters<typeof acceptsPastedKey>[1];
export type ServerDefinition = {
  enabled?: unknown;
  url?: unknown;
  command?: unknown;
  env?: Record<string, unknown> | null;
  env_vars?: unknown;
  bearer_token_env_var?: unknown;
};
export type Config = RecordValue & {
  model_providers?: Record<string, NonNullable<Definition>>;
  features?: {
    automatic_context_pruning?: unknown;
    memories?: unknown;
    multi_agent?: unknown;
    multi_agent_v2?:
      | {
          enabled?: boolean;
          max_concurrent_threads_per_session?: unknown;
        }
      | boolean;
  } | null;
  agents?: {
    max_threads?: unknown;
    max_concurrent_threads_per_session?: unknown;
  };
  memories?: RecordValue;
  mcp_servers?: Record<string, ServerDefinition>;
};
export type ConfigRead =
  | {
      config?: Config;
      layers?: {
        config?: Config;
        name?: {
          type?: string;
          profile?: unknown;
          file?: unknown;
        };
        version?: unknown;
        disabledReason?: unknown;
      }[];
      origins?: Record<
        string,
        {
          name?: {
            type?: string;
          };
        }
      >;
    }
  | null
  | undefined;
export type Requirements = {
  modelProvider?: unknown;
  modelProviders?: Record<string, NonNullable<Definition>> | null;
  allowedApprovalPolicies?: unknown;
  allowedApprovalsReviewers?: unknown;
  allowedSandboxModes?: unknown;
  allowedPermissionProfiles?: unknown;
  allowedWebSearchModes?: unknown;
};
export type RequirementsRead = {
  requirements?: Requirements | null;
} | null;
export type Pruner = {
  providers?: {
    id?: unknown;
    displayName?: unknown;
  }[];
  model?: unknown;
  provider?: unknown;
  reasoningEffort?: unknown;
  version?: unknown;
} | null;
export type Option = {
  keyPath: string;
  values?: unknown[];
  text?: number;
  names?: number;
  absolutePath?: number;
};
