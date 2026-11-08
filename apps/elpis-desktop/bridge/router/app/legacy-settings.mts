// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
import { isObject } from './legacy-values.mts';
import type { Stored } from './legacy-values.mts';
import { z } from 'zod';
import { SettingsSchema, type SettingsOrigin } from '../policy.mts';
import { autoMergeThreshold, teamDefaults } from './context.mts';
import { PromptConfigSchema, type PromptConfig, type PromptVersion } from './prompts.mts';
import type { Store } from './store.mts';
import { KV } from '../sources/kv.mts';
/** Settings save origin names recorded by versions before schema 11, mapped to current `SettingsOrigin` values. */
export const ORIGINS: Readonly<Record<string, SettingsOrigin>> = { web: 'panel', 'orchestrator-tool': 'tool', 'policy-sync': 'sync', 'member-sync': 'sync' };
/** Source kinds removed from dsh-superagent; the unified `github` Source now ingests Issues via notifications. */
export const REMOVED_SOURCES: readonly string[] = ['github-issue'];
/**
 * Upgrade current and historical settings records to the schema 11 structure: strip removed source kinds from active
 * settings while keeping them in historical revisions and mapping historical origin names.
 */
export function migrateSettingsRecords(store: Store): void {
    const stored = store.get<unknown>('settings');
    if (stored !== undefined) {
        const settings = SettingsSchema.parse(migrateSettings(stored));
        store.set('settings', { ...settings, sources: Object.fromEntries(Object.entries(settings.sources).filter(([id]) => !REMOVED_SOURCES.includes(id))) });
    }
    // Preserve unparseable historical revisions as-is so a corrupt history entry does not block startup.
    for (const name of store.keys(KV.settings.version.prefix)) {
        const version = store.get<{
            source: string;
            settings: unknown;
        }>(name)!;
        const settings = SettingsSchema.safeParse(migrateSettings(version.settings));
        store.set(name, { ...version, source: ORIGINS[version.source] ?? version.source, ...settings.success ? { settings: settings.data } : {} });
    }
}
export interface Member {
    name?: string;
    feishuId?: string;
    github?: string;
}
/**
 * Convert legacy flat settings (chat lists in Policy, top-level pause flag) or pre-schema-11 domain settings into current domain blocks:
 * strips fields replaced by rule instructions and prompts (Executor reviewers and branch prefix, rule `visual` flag, `autoMergeLineLimit`, Source `authority`, GitHub `mergeCli`), extracts `paused` to the top level, and splits cross-source `members` into per-source `policy.sources` entries.
 */
export function migrateSettings(value: unknown): unknown {
    if (!isObject(value))
        return value;
    if (!('members' in value || 'allowedChats' in value || 'admission' in value))
        return withoutRemovedFields(value);
    const old = value as {
        models?: {
            orchestrator?: unknown;
            worker?: unknown;
        };
        paused?: boolean;
        allowedChats?: string[];
        members?: unknown[];
        allowDirectMessages?: boolean;
        pollSeconds?: number;
        maxWorkers?: number;
        admission?: {
            mode?: string;
            chats?: string[];
            timeoutSeconds?: number;
            rules?: unknown[];
        };
    };
    const chats = new Map<string, 'mentions' | 'all'>();
    for (const chatId of old.allowedChats ?? [])
        chats.set(chatId, 'mentions');
    // Observed chats were active only when admission was enabled.
    if (old.admission?.mode !== 'off')
        for (const chatId of old.admission?.chats ?? [])
            chats.set(chatId, 'all');
    const feishu = { chats: [...chats].map(([chatId, listen]) => ({ chatId, listen })), directMessages: old.allowDirectMessages ?? true };
    return withoutRemovedFields({
        sources: { feishu: { enabled: true, config: feishu }, github: { enabled: true, config: { pollSeconds: old.pollSeconds ?? 60 } } },
        policy: { ...(old.members ? { members: old.members } : {}), ...(old.admission?.rules ? { rules: old.admission.rules } : {}) },
        eval: { ...(old.admission?.mode ? { mode: old.admission.mode } : {}), ...(old.admission?.timeoutSeconds ? { timeoutSeconds: old.admission.timeoutSeconds } : {}),
            model: old.models?.orchestrator ?? null },
        executor: { model: old.models?.worker ?? null, ...(old.maxWorkers ? { maxWorkers: old.maxWorkers } : {}), paused: old.paused ?? false },
    });
}
export function withoutRemovedFields(value: Stored): Stored {
    const { executor, policy, sources, ...rest } = value as {
        executor?: Stored;
        policy?: Stored;
        sources?: Record<string, Stored>;
    };
    // `paused` is now a top-level setting rather than a field on `executor`.
    const { reviewer: _reviewer, visualReviewer: _visualReviewer, branchPrefix: _branchPrefix, paused, ...kept } = executor ?? {};
    const { members, memberChat, autoMergeLineLimit: _limit, rules: storedRules, ...policyRest } = policy ?? {};
    const rules = Array.isArray(storedRules) ? storedRules.map((rule: unknown) => { if (!isObject(rule))
        return rule; const { visual: _visual, ...fields } = rule; return fields; })
        : storedRules;
    const people = Array.isArray(members) ? members as Member[] : undefined;
    const parts = people ? {
        feishu: { allowed: people.filter(member => member.feishuId).map(member => ({ id: member.feishuId!, ...(member.name ? { name: member.name } : {}) })),
            ...(memberChat ? { syncChat: memberChat } : {}) },
        github: { allowed: people.filter(member => member.github).map(member => ({ id: member.github! })) },
    } : undefined;
    // The GitHub Source no longer configures a dedicated merge account; auto-merge policy now lives in prompts.
    const withoutMerge = (id: string, config: unknown) => { if (id !== 'github' || !isObject(config))
        return config; const { mergeCli: _mergeCli, ...fields } = config; return fields; };
    const instances = sources ? Object.fromEntries(Object.entries(sources).map(([id, instance]) => {
        const { authority: _authority, ...fields } = instance;
        return [id, 'config' in fields ? { ...fields, config: withoutMerge(id, fields.config) } : fields];
    })) : undefined;
    // Rewrite environment variable prefixes from the project's earlier names in `prepare` commands.
    if (typeof kept.prepare === 'string')
        kept.prepare = kept.prepare.replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_');
    return { ...rest, ...(typeof paused === 'boolean' ? { paused } : {}), ...(executor ? { executor: kept } : {}),
        ...(instances ? { sources: instances } : {}),
        ...(policy ? { policy: { ...policyRest, ...(rules ? { rules } : {}), ...(parts ? { sources: parts } : {}) } } : {}) };
}
/** Prompt configuration shape saved before team sections existed, when all sections (including fixed ones) were editable. */
export const LegacyPromptConfigSchema = z.object({ shared: z.string(), orchestrator: z.string(), worker: z.string(), guides: z.record(z.string(), z.string()) });
/** Guide names from legacy prompt configurations that are now fixed built-in prompt sections or skills. */
export const LEGACY_FIXED = new Set(['cli', 'subscriptions', 'replies', 'reviews', 'dispatch', 'work', 'feishu', 'github']);
/** Tool names used in saved prompts before the domain vocabulary rename, paired with what replaces them now. */
export const RENAMED_TOOLS: readonly (readonly [
    string,
    string
])[] = [
    ['orchestrator_subscription_remove', 'orchestrator_thread_unsubscribe'], ['orchestrator_subscriptions', 'orchestrator_threads'],
    ['orchestrator_create_task', 'orchestrator_route (kind accept)'], ['orchestrator_send_task', 'orchestrator_route (kind attach)'],
    ['orchestrator_reopen_task', 'orchestrator_route (kind attach)'], ['orchestrator_ticket_reopen', 'orchestrator_route (kind attach)'],
    ['orchestrator_stop_task', 'orchestrator_route (kind stop)'], ['orchestrator_ignore_event', 'orchestrator_route (kind ignore)'],
    ['orchestrator_request_status', 'orchestrator_ticket_request_status'], ['orchestrator_inspect_task', 'orchestrator_ticket_inspect'],
    ['orchestrator_observations', 'orchestrator_decisions'], ['orchestrator_event_replay', 'orchestrator_trigger_requeue'],
    ['orchestrator_tasks', 'orchestrator_tickets'], ['orchestrator_assess', 'orchestrator_eval'], ['admission_read', 'orchestrator_eval_read'],
    ['admission_decide', 'orchestrator_eval_decide'],
];
/** Read-only tools replaced by `orchestrator_read <resource>`, mapped to their resource paths. */
export const READ_TOOLS: Readonly<Record<string, string>> = { orchestrator_tickets: 'tickets', orchestrator_threads: 'threads', orchestrator_decisions: 'decisions',
    orchestrator_settings_read: 'settings', orchestrator_prompts_read: 'prompts', orchestrator_models: 'models', orchestrator_ticket_inspect: 'ticket/<id>' };
/**
 * Rewrites skill and variable prefixes from the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), replaces retired
 * read tools with `orchestrator_read`, and the four routing tools with `orchestrator_route` and their kind.
 */
export const currentNames = (value: string): string => value.replace(/\bdsh-(?:tag|go|freelancer)-/g, 'dsh-superagent-').replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
    .replace(/\borchestrator_(?:tickets|threads|decisions|settings_read|prompts_read|models|ticket_inspect)\b/g, name => `orchestrator_read ${READ_TOOLS[name]}`)
    .replace(/\borchestrator_(?:ticket_(accept|attach|stop)|trigger_(ignore))\b/g, (_name, ticket?: string, trigger?: string) => `orchestrator_route (kind ${ticket ?? trigger ?? ''})`);
/** Rewrites a legacy skill body to current tool, argument, resource, section, skill, and variable names. */
export function legacyText(value: string): string {
    let result = value;
    for (const [from, to] of RENAMED_TOOLS)
        result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
    return currentNames(result.replaceAll('reply_to_event_id', 'reply_to_trigger_id').replace(/\bevent_id\b/g, 'trigger_id').replace(/\btask_id\b/g, 'ticket_id')
        .replaceAll('related_tasks', 'related_tickets').replace(/(?<![\w/-])event\//g, 'trigger/').replace(/(?<![\w/-])task\//g, 'ticket/').replaceAll('<event-id>', '<trigger-id>')
        .replace(/\bguide\/([a-z][a-z0-9-]*)\b/g, (_match, name: string) => LEGACY_FIXED.has(name) ? `the ${name} section` : `skill dsh-superagent-${name}`));
}
/**
 * Upgrade a stored prompt configuration to current sections, tool names, and skill references; legacy configurations take
 * built-in team sections, keep custom guides as skills, and carry any auto-merge line threshold into `delivery`.
 */
export function normalize(config: unknown): PromptConfig {
    const legacy = LegacyPromptConfigSchema.safeParse(config);
    const limit = legacy.success ? /fewer than (\d+) lines \(additions plus deletions\)/.exec(legacy.data.guides.work ?? '')?.[1] : undefined;
    const current = legacy.success ? { ...teamDefaults, delivery: limit ? teamDefaults.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(Number(limit))) : teamDefaults.delivery,
        skills: Object.fromEntries(Object.entries(legacy.data.guides).filter(([name]) => !LEGACY_FIXED.has(name)).map(([name, body]) => [name, legacyText(body)])) }
        : PromptConfigSchema.parse(config);
    return { communication: currentNames(current.communication), scope: currentNames(current.scope), delivery: currentNames(current.delivery),
        skills: Object.fromEntries(Object.entries(current.skills).map(([name, body]) => [name, currentNames(body)])) };
}
/**
 * Normalize stored prompt revisions to current sections and names (recording original configs under `legacy` when saved
 * before team sections existed or unparseable) and synthesize a new revision for removed settings fields (auto-merge
 * threshold and cross-source member identities) unless an earlier migration already created it.
 */
export function migratePrompts(store: Store): void {
    // Preserve original configs on legacy or unparseable revisions, falling back to the last readable config so sessions always have valid prompts.
    const versions = store.keys(KV.prompts.version.prefix).map(name => store.get<PromptVersion & {
        config: unknown;
    }>(name)!).sort((a, b) => a.revision - b.revision);
    let readable: PromptConfig = { ...teamDefaults, skills: {} };
    for (const version of versions) {
        const legacy = LegacyPromptConfigSchema.safeParse(version.config).success;
        let config: PromptConfig;
        try {
            config = normalize(version.config);
        }
        catch {
            config = readable;
        }
        const kept = legacy || config === readable ? { legacy: version.legacy ?? { config: version.config } } : {};
        store.set(KV.prompts.version(version.revision), { ...version, config, ...kept });
        readable = config;
    }
    if (store.get('prompt-settings-text') === 1)
        return;
    const before = store.get<unknown>('settings-before-9');
    const policy = (isObject(before) ? before.policy : undefined) as {
        autoMergeLineLimit?: unknown;
        members?: unknown;
    } | undefined;
    const limit = typeof policy?.autoMergeLineLimit === 'number' ? policy.autoMergeLineLimit : 200;
    const mapped = ((Array.isArray(policy?.members) ? policy.members : []) as Member[]).filter(person => person.feishuId && person.github);
    const revision = store.get(KV.prompts.revision);
    const current = revision === undefined ? undefined : store.get(KV.prompts.version(revision));
    const config = current?.config ?? { ...teamDefaults, skills: {} };
    const delivery = config.delivery.includes(autoMergeThreshold(200)) ? config.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(limit))
        : limit === 200 ? config.delivery : `${config.delivery}\nEnable auto-merge only on a PR that changes fewer than ${limit} lines (additions plus deletions).`;
    const identities = mapped.length && !config.skills.identities ? { identities: ['The same colleague may use a different account on each Source. When you mention, assign or request a review from someone you met on another Source, use their account on this one:',
            ...mapped.map(person => `- ${person.name ?? person.feishuId} (Feishu ${person.feishuId}) is @${person.github} on GitHub`)].join('\n') } : {};
    const next = { ...config, delivery, skills: { ...config.skills, ...identities } };
    if (JSON.stringify(next) === JSON.stringify(config))
        return;
    const previous = current?.revision ?? 0;
    if (!current)
        store.set(KV.prompts.version(0), { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config });
    store.set(KV.prompts.version(previous + 1), { revision: previous + 1, previousRevision: previous, savedAt: new Date().toISOString(), source: 'settings-migration', config: next });
    store.set(KV.prompts.revision, previous + 1);
}
