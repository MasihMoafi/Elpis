import { acceptsPastedKey, BUILT_IN_KEY_PROVIDERS } from './provider-settings.mjs';
// Keep provider credentials, full config layers, audit paths and arbitrary fields server-side.
const string = value => typeof value === 'string' ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : null;
const numericFields = (value, keys) => value && typeof value === 'object'
  ? Object.fromEntries(keys.filter(key => typeof value[key] === 'number' && Number.isFinite(value[key])).map(key => [key, value[key]])) : null;

// Config fields the Settings pages edit, by their native key. Values are the
// native serde spellings; null removes the key so Elpis uses its own default.
export const CONFIG_OPTIONS = {
  approvalPolicy: { keyPath: 'approval_policy', values: ['untrusted', 'on-request', 'never'] },
  sandboxMode: { keyPath: 'sandbox_mode', values: ['read-only', 'workspace-write', 'danger-full-access'] },
  webSearch: { keyPath: 'web_search', values: ['disabled', 'cached', 'indexed', 'live'] },
  verbosity: { keyPath: 'model_verbosity', values: ['low', 'medium', 'high'] },
  reasoningSummary: { keyPath: 'model_reasoning_summary', values: ['auto', 'concise', 'detailed', 'none'] },
  serviceTier: { keyPath: 'service_tier', values: ['default', 'fast', 'flex'] },
  developerInstructions: { keyPath: 'developer_instructions', text: 32000 },
  projectRootMarkers: { keyPath: 'project_root_markers', names: 16 },
  worktreeRoot: { keyPath: 'desktop.git-worktree-root', absolutePath: 4096 },
};
const configValue = (config, keyPath) => keyPath.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, config);
function optionSnapshot(config) {
  const approval = config.approval_policy;
  const tier = string(config.service_tier);
  return {
    approvalPolicy: typeof approval === 'string' ? approval : approval && typeof approval === 'object' ? 'granular' : null,
    sandboxMode: string(config.sandbox_mode), webSearch: string(config.web_search),
    verbosity: string(config.model_verbosity), reasoningSummary: string(config.model_reasoning_summary),
    serviceTier: tier === 'priority' ? 'fast' : tier,
    developerInstructions: string(config.developer_instructions),
    projectRootMarkers: strings(config.project_root_markers),
    worktreeRoot: string(configValue(config, 'desktop.git-worktree-root')),
  };
}
/** Native edits for the submitted options; rejects anything outside CONFIG_OPTIONS or managed policy. */
export function optionEdits(input, managed = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(CONFIG_OPTIONS, key))) throw new Error('Unsupported setting');
  return Object.entries(input).map(([name, value]) => {
    const option = CONFIG_OPTIONS[name];
    if (value !== null) {
      if (option.values) {
        if (!option.values.includes(value)) throw new Error('Choose one of the listed values');
        const allowed = name === 'approvalPolicy' ? managed.allowedApprovalPolicies : name === 'sandboxMode' ? managed.allowedSandboxModes : null;
        if (Array.isArray(allowed) && !allowed.includes(value)) throw new Error('This choice is restricted by managed settings');
      } else if (option.text) {
        if (typeof value !== 'string' || value.length > option.text) throw new Error('Instructions are too long');
        value = value.trim() ? value : null;
      } else if (option.names) {
        if (!Array.isArray(value) || !value.length || value.length > option.names || value.some(item => typeof item !== 'string' || !/^[^/\\\0\r\n]{1,100}$/.test(item.trim()) || ['.', '..'].includes(item.trim()))) throw new Error('Give one to sixteen file or folder names, without slashes');
        value = value.map(item => item.trim());
      } else if (option.absolutePath) {
        if (typeof value !== 'string' || value.length > option.absolutePath || /[\0\r\n]/.test(value)) throw new Error('Give an absolute folder path');
        value = value.trim() || null;
        if (value !== null && !value.startsWith('/')) throw new Error('Give an absolute folder path');
      }
    }
    return { keyPath: option.keyPath, value, mergeStrategy: 'replace' };
  });
}

/** Whether a provider reads its key from a variable that is unset and has no key saved in the Elpis home. */
const needsKey = (definition, saved, id, env) => acceptsPastedKey(id, definition) && !saved.has(id) && !(typeof env[definition.env_key] === 'string' && env[definition.env_key].trim());

export function settingsSnapshot(read, requirementsRead, prunerRead = null, saved = new Set(), env = process.env) {
  const config = read?.config ?? {};
  const requirements = requirementsRead?.requirements;
  const definitions = { ...(config.model_providers ?? {}), ...(requirements?.modelProviders ?? {}) };
  const providerIds = new Set(Object.keys(definitions));
  if (typeof config.model_provider === 'string') providerIds.add(config.model_provider);
  for (const provider of prunerRead?.providers ?? []) if (typeof provider.id === 'string') {
    providerIds.add(provider.id);
    definitions[provider.id] = { name: string(provider.displayName) ?? provider.id };
  }
  const userLayer = read?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile);
  return {
    main: { model: string(config.model), provider: string(config.model_provider) },
    background: { model: string(config.background_model), provider: string(config.background_provider), purpose: 'smartPruneFallback' },
    smartPrune: {
      enabled: boolean(config.features?.automatic_context_pruning),
      explicitOverride: prunerRead ? { available: true, model: string(prunerRead.model), provider: string(prunerRead.provider), version: string(prunerRead.version) }
        : { available: false, reason: 'The running Elpis version does not expose the separate pruning override. Update and restart Elpis to edit it here.' },
    },
    memory: {
      enabled: boolean(config.features?.memories),
      generate: boolean(config.memories?.generate_memories), use: boolean(config.memories?.use_memories),
      skipExternalContext: boolean(config.memories?.disable_on_external_context),
      extractionModel: string(config.memories?.extract_model), consolidationModel: string(config.memories?.consolidation_model),
      admissionPolicy: null,
    },
    options: optionSnapshot(config),
    providers: [...providerIds].sort().map(id => ({ id, displayName: string(definitions[id]?.name) ?? id, ...(needsKey(config.model_providers?.[id] ?? BUILT_IN_KEY_PROVIDERS[id], saved, id, env) ? { needsKey: true } : {}) })),
    managed: {
      available: requirementsRead !== null,
      modelProvider: string(requirements?.modelProvider),
      allowedApprovalPolicies: strings(requirements?.allowedApprovalPolicies),
      allowedSandboxModes: strings(requirements?.allowedSandboxModes),
    },
    version: string(userLayer?.version),
    write: { available: typeof userLayer?.version === 'string', reason: 'Background and memory changes apply to new conversations.' },
  };
}

const usageKeys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const attributionKeys = ['systemInstructions', 'developerMessages', 'userMessages', 'agentMessages', 'reasoning', 'toolCalls', 'toolResults', 'toolDefinitions', 'outputSchema', 'unrecognizedItems', 'estimatedTotal'];
export function tokenUsageSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return { total: numericFields(value.total, usageKeys), last: numericFields(value.last, usageKeys),
    modelContextWindow: typeof value.modelContextWindow === 'number' ? value.modelContextWindow : null,
    contextAttribution: numericFields(value.contextAttribution, attributionKeys) };
}

export function smartPruneSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    enabled: boolean(value.enabled),
    ...numericFields(value, ['examinedOutputs', 'admittedOutputs', 'unchangedOutputs', 'failedBatches', 'approxSourceTokens', 'approxAdmittedTokens', 'approxSavedTokens', 'optimizerRequests', 'optimizerUsageReports', 'optimizerLatencyMs', 'mainRequestSequence']),
    optimizerUsage: numericFields(value.optimizerUsage, usageKeys), latestAttempt: null,
  };
  if (value.latestAttempt && typeof value.latestAttempt === 'object') {
    const attempt = value.latestAttempt;
    result.latestAttempt = {
      status: string(attempt.status), failureReason: string(attempt.failureReason),
      modelSlug: string(attempt.modelSlug), reasoningEffort: string(attempt.reasoningEffort),
      ...numericFields(attempt, ['candidateOutputs', 'admittedOutputs', 'approxSavedTokens', 'latencyMs']),
      usage: numericFields(attempt.usage, usageKeys),
    };
  }
  return result;
}

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// Base URLs may carry tokens in their query; only the scheme, host and path leave the bridge.
const publicUrl = value => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/$/, '')}`; } catch { return null; } };
const hostOf = value => { try { return new URL(value).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } };
const usageWindow = value => value && typeof value === 'object'
  ? { usedPercent: number(value.usedPercent), windowDurationMins: number(value.windowDurationMins), resetsAt: number(value.resetsAt) } : null;
const usageLimit = value => value && typeof value === 'object'
  ? { limitId: string(value.limitId), limitName: string(value.limitName), planType: string(value.planType), primary: usageWindow(value.primary), secondary: usageWindow(value.secondary), reached: string(value.rateLimitReachedType) } : null;

/** Each provider's own sign-in and usage. Subscription limits arrive keyed by limit ID from the Elpis bridge. */
export function providersSnapshot({ account, limits, config, models, env = process.env }) {
  const byId = { ...(limits?.rateLimitsByLimitId ?? {}) };
  if (typeof limits?.rateLimits?.limitId === 'string' && !byId[limits.rateLimits.limitId]) byId[limits.rateLimits.limitId] = limits.rateLimits;
  const usage = prefix => Object.entries(byId).filter(([id]) => id === prefix || id.startsWith(`${prefix}-`)).map(([, value]) => usageLimit(value)).filter(Boolean);
  const offered = prefix => (models ?? []).filter(model => typeof model?.model === 'string' && model.model.startsWith(prefix)).map(model => string(model.displayName) ?? model.model);
  const subscription = (prefix, limitPrefix) => {
    const names = offered(prefix), found = usage(limitPrefix);
    return { state: found.length ? 'connected' : names.length ? 'available' : 'notConnected', models: names, usage: found };
  };
  const signedIn = account?.account;
  const auth = account?.error ? { state: 'unknown', error: string(account.error) }
    : signedIn?.type === 'chatgpt' ? { state: 'signedIn', method: 'ChatGPT', email: string(signedIn.email), plan: string(signedIn.planType) }
    : signedIn ? { state: 'signedIn', method: signedIn.type === 'apiKey' ? 'API key' : string(signedIn.type) }
    : { state: 'signedOut' };
  const configured = Object.entries(config?.model_providers ?? {}).filter(([, def]) => def && typeof def === 'object');
  const describe = ([id, def]) => ({ id, name: string(def.name) ?? id, baseUrl: publicUrl(def.base_url),
    envKey: string(def.env_key), keySet: typeof def.env_key === 'string' ? Boolean(env[def.env_key]) : Boolean(def.experimental_bearer_token) });
  const codex = usage('codex');
  return {
    openai: { auth, requiresOpenaiAuth: boolean(account?.requiresOpenaiAuth), usage: codex,
      usageError: codex.length ? null : string(limits?.error) },
    claude: subscription('claude/', 'claude'),
    gemini: subscription('agy/', 'antigravity'),
    openrouter: configured.filter(([, def]) => hostOf(def.base_url).endsWith('openrouter.ai')).map(describe),
    local: configured.filter(([, def]) => /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/.test(hostOf(def.base_url))).map(describe),
  };
}

/** Lifecycle hooks as Elpis discovered them, with the user-layer version their state writes need. */
export function hooksSnapshot(list, read) {
  const userLayer = read?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile);
  const seen = new Set(), hooks = [], warnings = [], errors = [];
  for (const entry of Array.isArray(list?.data) ? list.data : []) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (typeof hook?.key !== 'string' || seen.has(hook.key)) continue;
      seen.add(hook.key);
      hooks.push({
        key: hook.key, event: string(hook.eventName), handler: string(hook.handlerType),
        command: string(hook.command), server: string(hook.server), tool: string(hook.tool),
        matcher: string(hook.matcher), timeoutSec: number(hook.timeoutSec), statusMessage: string(hook.statusMessage),
        source: string(hook.source), sourcePath: string(hook.sourcePath), pluginId: string(hook.pluginId),
        enabled: hook.enabled === true, managed: hook.isManaged === true, trust: string(hook.trustStatus), currentHash: string(hook.currentHash),
      });
    }
    for (const warning of Array.isArray(entry?.warnings) ? entry.warnings : []) if (typeof warning === 'string' && !warnings.includes(warning)) warnings.push(warning);
    for (const error of Array.isArray(entry?.errors) ? entry.errors : []) if (typeof error?.message === 'string') errors.push({ path: string(error.path), message: error.message });
  }
  return { version: string(userLayer?.version), write: { available: typeof userLayer?.version === 'string' }, hooks, warnings, errors };
}

const CREDENTIAL = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;
/** MCP servers from the effective config: names, transport and credential presence only. */
export function mcpSnapshot(read, env = process.env) {
  const servers = read?.config?.mcp_servers ?? {};
  const userLayer = read?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile);
  return {
    version: string(userLayer?.version),
    configPath: string(userLayer?.name?.file),
    write: { available: typeof userLayer?.version === 'string' },
    servers: Object.entries(servers).filter(([, def]) => def && typeof def === 'object').sort(([a], [b]) => a.localeCompare(b)).map(([name, def]) => ({
      name, enabled: def.enabled !== false, transport: typeof def.url === 'string' ? 'http' : 'stdio',
      command: typeof def.command === 'string' ? def.command : null, url: typeof def.url === 'string' ? publicUrl(def.url) : null,
      credentials: [
        ...Object.entries(def.env ?? {}).filter(([key]) => CREDENTIAL.test(key)).map(([key, value]) => ({ name: key, source: 'config', set: value !== '' && value != null })),
        ...(Array.isArray(def.env_vars) ? def.env_vars : []).filter(key => typeof key === 'string' && CREDENTIAL.test(key)).map(key => ({ name: key, source: 'environment', set: Boolean(env[key]) })),
        ...(typeof def.bearer_token_env_var === 'string' ? [{ name: def.bearer_token_env_var, source: 'environment', set: Boolean(env[def.bearer_token_env_var]) }] : []),
      ],
      ...(name === 'whispertype' ? { whispertype: { backend: def.env?.WHISPERTYPE_BACKEND ?? 'openrouter', model: string(def.env?.WHISPERTYPE_CLOUD_MODEL) } } : {}),
    })),
  };
}
