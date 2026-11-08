import { string, boolean, number } from './projection-values.mts';
import type { RecordValue, Definition, Config } from './feature-types.mts';
// Base URLs may carry tokens in their query; only the scheme, host and path leave the bridge.
export const publicUrl = (value: unknown) => { try {
    const url = new URL(value as string);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
catch {
    return null;
} };
export const hostOf = (value: unknown) => { try {
    return new URL(value as string).hostname.replace(/^\[|\]$/g, '');
}
catch {
    return '';
} };
export const usageWindow = (value: RecordValue | null | undefined) => value && typeof value === 'object'
    ? { usedPercent: number(value.usedPercent), windowDurationMins: number(value.windowDurationMins), resetsAt: number(value.resetsAt) } : null;
export const usageLimit = (value: (RecordValue & {
    primary?: RecordValue | null;
    secondary?: RecordValue | null;
}) | null | undefined) => value && typeof value === 'object'
    ? { limitId: string(value.limitId), limitName: string(value.limitName), planType: string(value.planType), primary: usageWindow(value.primary), secondary: usageWindow(value.secondary), reached: string(value.rateLimitReachedType) } : null;
/** Each provider's own sign-in and usage. Subscription limits arrive keyed by limit ID from the Elpis bridge.
 * `anthropic.signedOut`: Elpis's own sign-out of the Claude subscription, which shows no models or usage while it is on.
 * `models`: the engine's model list, or null when it could not be read. */
export function providersSnapshot({ account, limits, config, models, anthropic, env = process.env }: {
    account?: {
        account?: {
            type?: unknown;
            email?: unknown;
            planType?: unknown;
        } | null;
        error?: unknown;
        requiresOpenaiAuth?: unknown;
    } | null;
    limits?: {
        rateLimitsByLimitId?: Record<string, RecordValue>;
        rateLimits?: RecordValue & {
            limitId?: unknown;
        };
        error?: unknown;
    } | null;
    config?: Config | null | undefined;
    models?: {
        model?: unknown;
        displayName?: unknown;
    }[] | null;
    anthropic?: {
        signedOut?: unknown;
    } | null;
    env?: NodeJS.ProcessEnv;
}) {
    const byId = { ...(limits?.rateLimitsByLimitId ?? {}) };
    if (typeof limits?.rateLimits?.limitId === 'string' && !byId[limits.rateLimits.limitId])
        byId[limits.rateLimits.limitId] = limits.rateLimits;
    const usage = (prefix: string) => Object.entries(byId).filter(([id]) => id === prefix || id.startsWith(`${prefix}-`)).map(([, value]) => usageLimit(value as RecordValue)).filter(Boolean);
    const offered = (prefix: string) => (models ?? []).filter(model => typeof model?.model === 'string' && model.model.startsWith(prefix)).map(model => string(model.displayName) ?? model.model);
    const subscription = (prefix: string, limitPrefix: string) => {
        const names = offered(prefix), found = usage(limitPrefix);
        // `models` is null when the model list could not be read: then a subscription without usage is unknown, not signed out.
        return { state: found.length ? 'connected' : names.length ? 'available' : models ? 'notConnected' : 'unknown', models: names, usage: found };
    };
    const signedIn = account?.account;
    const auth = account?.error ? { state: 'unknown', error: string(account.error) }
        : signedIn?.type === 'chatgpt' ? { state: 'signedIn', method: 'ChatGPT', email: string(signedIn.email), plan: string(signedIn.planType) }
            : signedIn ? { state: 'signedIn', method: signedIn.type === 'apiKey' ? 'API key' : string(signedIn.type) }
                : { state: 'signedOut' };
    const configured = Object.entries(config?.model_providers ?? {}).filter(([, def]) => def && typeof def === 'object');
    const describe = ([id, def]: [
        string,
        NonNullable<Definition>
    ]) => ({ id, name: string(def.name) ?? id, baseUrl: publicUrl(def.base_url),
        envKey: string(def.env_key), keySet: typeof def.env_key === 'string' ? Boolean(env[def.env_key]) : Boolean(def.experimental_bearer_token) });
    const codex = usage('codex');
    return {
        openai: { auth, requiresOpenaiAuth: boolean(account?.requiresOpenaiAuth), usage: codex,
            usageError: codex.length ? null : string(limits?.error) },
        claude: anthropic?.signedOut === true ? { state: 'notConnected', models: [], usage: [], signedOut: true } : { ...subscription('claude/', 'claude'), signedOut: false },
        gemini: subscription('agy/', 'antigravity'),
        openrouter: configured.filter(([, def]) => hostOf(def.base_url).endsWith('openrouter.ai')).map(describe),
    };
}
