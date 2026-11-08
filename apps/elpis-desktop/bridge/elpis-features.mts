export { hooksSnapshot, mcpSnapshot } from "./integration-projections.mts";

export { providersSnapshot } from "./provider-projections.mts";
export { rolloutAgentModel, rolloutTurnModels, rolloutShares, restoredTokenUsage } from "./rollout-readers.mts";

export {
  tokenUsageSnapshot,
  cacheUse,
  contextLedger,
  SHARE_KEYS,
  sizedItem,
  smartPruneSnapshot,
} from "./token-accounting.mts";
import { string, boolean, strings } from "./projection-values.mts";
import type {
  RecordValue,
  Definition,
  Config,
  ConfigRead,
  RequirementsRead,
  Pruner,
  Option,
} from "./feature-types.mts";
import { acceptsPastedKey, BUILT_IN_KEY_PROVIDERS } from "./provider-settings.mts";
import { PERMISSION_PRESETS, PROFILES, permissionAllowed } from "./permission-presets.mts";
import { defaultPermissionMode } from "./resources/permission-policy.mts";
export { defaultPermissionMode } from "./resources/permission-policy.mts";

// Config fields the Settings pages edit, by their native key. Values are the
// native serde spellings; null removes the key so Elpis uses its own default.
export const CONFIG_OPTIONS = {
  reasoningEffort: {
    keyPath: "model_reasoning_effort",
    values: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
  },
  defaultPermissions: { keyPath: "approval_policy", values: ["ask", "auto", "full"] },
  webSearch: { keyPath: "web_search", values: ["disabled", "cached", "indexed", "live"] },
  verbosity: { keyPath: "model_verbosity", values: ["low", "medium", "high"] },
  reasoningSummary: { keyPath: "model_reasoning_summary", values: ["auto", "concise", "detailed", "none"] },
  serviceTier: { keyPath: "service_tier", values: ["default", "fast", "flex"] },
  developerInstructions: { keyPath: "developer_instructions", text: 32000 },
  projectRootMarkers: { keyPath: "project_root_markers", names: 16 },
  worktreeRoot: { keyPath: "desktop.git-worktree-root", absolutePath: 4096 },
  automaticPruning: { keyPath: "features.automatic_context_pruning", values: [true, false] },
};
const configValue = (config: Config, keyPath: string) =>
  keyPath
    .split(".")
    .reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as RecordValue)[key] : undefined),
      config,
    );
/** Whether the engine takes the default sandbox from `default_permissions`, as
 * codex-rs/core/src/config/mod.rs resolve_permission_config_syntax decides: the highest layer naming either key
 * wins, and within a layer `default_permissions` wins over `sandbox_mode`. */
function usesPermissionProfiles(read: ConfigRead) {
  const layer = (read?.layers ?? []).find(
    layer => layer?.config?.default_permissions != null || layer?.config?.sandbox_mode != null,
  );
  return layer ? layer.config!.default_permissions != null : read?.config?.default_permissions != null;
}
/** New chats' mode: the preset the config names, Full access when it names no approval policy (Masih, 24 Oct: "default
 * permission be full access"), or `custom` for any other combination, which new chats then take from the config. */
function defaultPermissions(config: Config, profiles: boolean) {
  return defaultPermissionMode({
    config,
    layers: [
      {
        config: profiles ? { default_permissions: config.default_permissions } : { sandbox_mode: config.sandbox_mode },
      },
    ],
  });
}
/** The mode new chats start in, from a config/read (with layers): `ask`, `auto` or `full`, or `custom`. */
function optionSnapshot(config: Config, profiles: boolean) {
  const tier = string(config.service_tier);
  return {
    reasoningEffort: string(config.model_reasoning_effort),
    defaultPermissions: defaultPermissions(config, profiles),
    webSearch: string(config.web_search),
    verbosity: string(config.model_verbosity),
    reasoningSummary: string(config.model_reasoning_summary),
    serviceTier: tier === "priority" ? "fast" : tier,
    developerInstructions: string(config.developer_instructions),
    projectRootMarkers: strings(config.project_root_markers),
    worktreeRoot: string(configValue(config, "desktop.git-worktree-root")),
  };
}
/** Native edits for the submitted options; rejects anything outside CONFIG_OPTIONS or managed policy. Default
 * permissions write approval policy, reviewer and sandbox together; with `profiles`, the sandbox is saved as the
 * built-in permission profile the engine reads instead of `sandbox_mode`. */
export function optionEdits(input: unknown, managed: { allowedWebSearchModes?: unknown } = {}, profiles = false) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !Object.hasOwn(CONFIG_OPTIONS, key))
  )
    throw new Error("Unsupported setting");
  return Object.entries(input).flatMap(([name, value]) => {
    const option = (CONFIG_OPTIONS as Record<string, Option>)[name]!;
    if (name === "defaultPermissions") {
      const preset = PERMISSION_PRESETS[value as keyof typeof PERMISSION_PRESETS];
      if (!option.values!.includes(value) || !preset) throw new Error("Choose one of the listed values");
      if (!permissionAllowed(value as string, managed))
        throw new Error("This choice is restricted by managed settings");
      return [
        { keyPath: "approval_policy", value: preset.approval, mergeStrategy: "replace" },
        { keyPath: "approvals_reviewer", value: preset.reviewer, mergeStrategy: "replace" },
        profiles
          ? {
              keyPath: "default_permissions",
              value: PROFILES[preset.sandbox as keyof typeof PROFILES],
              mergeStrategy: "replace",
            }
          : { keyPath: "sandbox_mode", value: preset.sandbox, mergeStrategy: "replace" },
      ];
    }
    if (value !== null) {
      if (option.values) {
        if (!option.values!.includes(value)) throw new Error("Choose one of the listed values");
        const allowed = name === "webSearch" ? managed.allowedWebSearchModes : null;
        if (Array.isArray(allowed) && !allowed.includes(value))
          throw new Error("This choice is restricted by managed settings");
      } else if (option.text) {
        if (typeof value !== "string" || value.length > option.text) throw new Error("Instructions are too long");
        value = value.trim() ? value : null;
      } else if (option.names) {
        if (
          !Array.isArray(value) ||
          !value.length ||
          value.length > option.names ||
          value.some(
            item =>
              typeof item !== "string" ||
              !/^[^/\\\0\r\n]{1,100}$/.test(item.trim()) ||
              [".", ".."].includes(item.trim()),
          )
        )
          throw new Error("Give one to sixteen file or folder names, without slashes");
        value = value.map(item => item.trim());
      } else if (option.absolutePath) {
        if (typeof value !== "string" || value.length > option.absolutePath || /[\0\r\n]/.test(value))
          throw new Error("Give an absolute folder path");
        value = value.trim() || null;
        if (value !== null && !(value as string).startsWith("/")) throw new Error("Give an absolute folder path");
      }
    }
    return { keyPath: option.keyPath, value, mergeStrategy: "replace" };
  });
}

/** Whether a provider reads its key from a variable that is unset and has no key saved in the Elpis home. */
const needsKey = (definition: Definition, saved: Set<string>, id: string, env: NodeJS.ProcessEnv) =>
  acceptsPastedKey(id, definition) &&
  !saved.has(id) &&
  !(typeof env[definition!.env_key as string] === "string" && env[definition!.env_key as string]!.trim());

/** How many agents a work graph may use (codex-rs core/src/tools/handlers/work_graphs.rs, core/src/config/mod.rs): up
 * to 256 in one graph, and at once no more than the session's agent threads: agents.max_threads (6 by default), or
 * with multi-agent v2 its threads per session less the chat itself (4 by default); never more than 32. */
function agentLimits(config: Config) {
  const count = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null,
    v2 = config.features?.multi_agent_v2;
  if (v2 === true || (v2 && typeof v2 === "object" && v2.enabled !== false)) {
    const session =
      count((v2 as { max_concurrent_threads_per_session?: unknown })?.max_concurrent_threads_per_session) ??
      (count(config.agents?.max_concurrent_threads_per_session) ?? 3) + 1;
    return { graph: 256, atOnce: Math.min(32, Math.max(0, session - 1)), source: "features.multi_agent_v2" };
  }
  const threads = count(config.agents?.max_threads);
  return {
    graph: 256,
    atOnce: Math.min(32, threads ?? 6),
    source: threads === null ? "Elpis default" : "agents.max_threads",
  };
}

/** The version of the user's config layer: the one a write must quote. */
export function userConfigVersion(read: ConfigRead) {
  return string(
    read?.layers?.find(layer => layer.name?.type === "user" && !layer.name.profile && !layer.disabledReason)?.version,
  );
}
export function settingsSnapshot(
  read: ConfigRead,
  requirementsRead: RequirementsRead,
  prunerRead: Pruner = null,
  saved = new Set<string>(),
  env = process.env,
) {
  const config = read?.config ?? {};
  const requirements = requirementsRead?.requirements;
  const definitions = { ...(config.model_providers ?? {}), ...(requirements?.modelProviders ?? {}) };
  const providerIds = new Set(Object.keys(definitions));
  if (typeof config.model_provider === "string") providerIds.add(config.model_provider);
  for (const provider of prunerRead?.providers ?? [])
    if (typeof provider.id === "string") {
      providerIds.add(provider.id);
      definitions[provider.id] = { name: string(provider.displayName) ?? provider.id };
    }
  const userLayer = read?.layers?.find(
    layer => layer.name?.type === "user" && !layer.name.profile && !layer.disabledReason,
  );
  const permissionProfiles = usesPermissionProfiles(read);
  return {
    main: { model: string(config.model), provider: string(config.model_provider) },
    background: {
      model: string(config.background_model),
      provider: string(config.background_provider),
      purpose: "smartPruneFallback",
    },
    smartPrune: {
      enabled: boolean(config.features?.automatic_context_pruning),
      explicitOverride: prunerRead
        ? {
            available: true,
            model: string(prunerRead.model),
            provider: string(prunerRead.provider),
            reasoningEffort: string(prunerRead.reasoningEffort),
            version: string(prunerRead.version),
          }
        : {
            available: false,
            reason:
              "The running Elpis version does not expose the separate pruning override. Update and restart Elpis to edit it here.",
          },
    },
    memory: {
      enabled: boolean(config.features?.memories),
      generate: boolean(config.memories?.generate_memories),
      use: boolean(config.memories?.use_memories),
      skipExternalContext: boolean(config.memories?.disable_on_external_context),
      extractionModel: string(config.memories?.extract_model),
      consolidationModel: string(config.memories?.consolidation_model),
      admissionPolicy: null,
    },
    options: optionSnapshot(config, permissionProfiles),
    permissionProfiles,
    providers: [...providerIds]
      .sort()
      .map(id => ({
        id,
        displayName: string(definitions[id]?.name) ?? id,
        ...(needsKey(config.model_providers?.[id] ?? BUILT_IN_KEY_PROVIDERS[id], saved, id, env)
          ? { needsKey: true }
          : {}),
      })),
    sources: Object.fromEntries(
      Object.values(CONFIG_OPTIONS).map(({ keyPath }) => [keyPath, read?.origins?.[keyPath]?.name?.type ?? "default"]),
    ),
    agents: agentLimits(config),
    managed: {
      available: requirementsRead !== null,
      modelProvider: string(requirements?.modelProvider),
      allowedApprovalPolicies: strings(requirements?.allowedApprovalPolicies),
      allowedApprovalsReviewers: strings(requirements?.allowedApprovalsReviewers),
      allowedSandboxModes: strings(requirements?.allowedSandboxModes),
      allowedPermissionProfiles:
        requirements?.allowedPermissionProfiles && typeof requirements.allowedPermissionProfiles === "object"
          ? Object.fromEntries(
              Object.entries(requirements.allowedPermissionProfiles).filter(([, value]) => typeof value === "boolean"),
            )
          : null,
      allowedWebSearchModes: strings(requirements?.allowedWebSearchModes),
    },
    version: string(userLayer?.version),
    write: {
      available: typeof userLayer?.version === "string",
      reason:
        typeof userLayer?.version === "string"
          ? null
          : "Elpis reported no writable config.toml, so this cannot be saved here. Edit the file or restart Elpis.",
    },
  };
}

/** The Context Ledger's switches, read from the keys the TUI ledger writes: Smart Prune is
 * `features.automatic_context_pruning` (off by default), Subagents is `features.multi_agent` (on unless false; the
 * Claude bridge reads the same key), and RAG is the `rag` MCP server's `enabled` (null when none is configured). */
export function contextSwitchesSnapshot(read: ConfigRead) {
  const config = read?.config ?? {},
    userLayer = read?.layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
  const rag = config.mcp_servers?.rag,
    version = string(userLayer?.version);
  return {
    version,
    write: version
      ? { available: true }
      : { available: false, reason: "Elpis reported no writable config.toml, so these switches cannot be saved here." },
    smartPrune: config.features?.automatic_context_pruning === true,
    subagents: config.features?.multi_agent !== false,
    rag: rag && typeof rag === "object" ? rag.enabled !== false : null,
  };
}
export const CONTEXT_SWITCH_KEYS = {
  smartPrune: "features.automatic_context_pruning",
  subagents: "features.multi_agent",
  rag: "mcp_servers.rag.enabled",
};
