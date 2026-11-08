import { z } from 'zod';
import { BridgeError } from './validate.mts';
import type { DecoratedInput, EngineItem } from './client-thread-list.mts';
import type { WorkGraphListResponse } from '../../../codex-rs/app-server-protocol/schema/typescript/v2/WorkGraphListResponse.ts';
type ConfigRead = {
    config?: {
        model_provider?: string | null;
        model_providers?: Record<string, Record<string, unknown>>;
        realtime?: {
            voice?: string | null;
        } | null;
        features?: {
            multi_agent?: boolean | null;
        } | null;
        mcp_servers?: Record<string, {
            env?: Record<string, unknown> | null;
        }>;
        [key: string]: unknown;
    };
};
type ConfigRequirements = {
    requirements?: {
        modelProvider?: string | null;
        modelProviders?: Record<string, Record<string, unknown>> | null;
        featureRequirements?: Record<string, unknown> | null;
    } | null;
};
type ThreadResponse = {
    thread: DecoratedInput;
    followingLive?: boolean;
    model?: string;
    modelProvider?: string;
    serviceTier?: string | null;
    reasoningEffort?: string | null;
    collaborationMode?: {
        mode?: string;
    } | null;
    initialTurnsPage?: TurnPage | null;
};
type ContextFiles = {
    files: {
        name: string;
        path: string;
        group: string;
        estimatedTokens: number;
        included: boolean;
        reason: string;
        selectable: boolean;
    }[];
    note?: string;
};
type ThreadPage = {
    data: DecoratedInput[];
    nextCursor?: string | null;
};
type TurnPage = {
    data: {
        id: string;
        status?: string;
    }[];
    nextCursor?: string | null;
};
type ItemPage = {
    data: {
        turnId: string;
        item: EngineItem;
    }[];
    nextCursor?: string | null;
    backwardsCursor?: string | null;
};
export type RpcResponses = {
    'config/read': ConfigRead;
    'configRequirements/read': ConfigRequirements;
    'thread/read': ThreadResponse;
    'thread/start': ThreadResponse;
    'thread/resume': ThreadResponse;
    'thread/subscribe': ThreadResponse;
    'thread/fork': ThreadResponse;
    'thread/unarchive': ThreadResponse;
    'thread/list': ThreadPage;
    'thread/turns/list': TurnPage;
    'thread/items/list': ItemPage;
    'turn/start': {
        turn: {
            id: string;
        };
    };
    'review/start': {
        turn: {
            id: string;
        };
        reviewThreadId: string;
    };
    'turn/settings/update': {
        status: string;
    };
    'thread/goal/get': {
        goal: unknown;
    };
    'thread/contextFiles/list': ContextFiles;
    'thread/contextFiles/set': ContextFiles;
    'thread/register': ThreadResponse;
    'externalAgentConfig/detect': {
        items: {
            itemType?: string;
            details?: {
                sessions?: {
                    path?: unknown;
                    cwd?: unknown;
                    title?: unknown;
                }[];
            } | null;
        }[];
    };
    'externalAgentConfig/import': {
        importId: string;
    };
    'externalAgentConfig/import/readHistories': {
        data: {
            importId: string;
            successes: unknown[];
            failures: {
                message?: unknown;
            }[];
        }[];
    };
    'experimentalFeature/list': {
        data: {
            stage: string;
            name: string;
            displayName?: string | null;
            description?: string | null;
            enabled: boolean;
        }[];
        nextCursor?: string | null;
    };
    'account/login/start': {
        authUrl?: string;
        loginId?: string;
    };
    'workGraph/list': {
        data: (WorkGraphListResponse['data'][number] & {
            startedAt?: number;
            createdAt?: number;
        })[];
    };
    'account/read': {
        account?: {
            type?: string;
        } | null;
    };
    'thread/realtime/listVoices': {
        voices: {
            v1: string[];
            defaultV1: string;
        };
    };
    'claudeAccounts/read': {
        activeId: string;
        accounts: {
            id?: unknown;
            authenticated?: unknown;
            duplicate?: unknown;
        }[];
    };
    'claudeAccounts/write': {
        activeId: string;
        accounts: {
            id?: unknown;
            authenticated?: unknown;
            duplicate?: unknown;
        }[];
    };
    'claudeSubscription/write': {
        signedOut?: boolean;
    };
};
export type RpcResponse<M extends string> = M extends keyof RpcResponses ? RpcResponses[M] : unknown;
const object = z.looseObject({});
const text = z.string();
const strings = z.array(text);
const record = z.record(text, z.unknown());
const nullableText = text.nullish();
const item = z.looseObject({ id: text, type: text, text: text.optional(), path: text.optional(),
    content: z.union([strings, z.array(z.looseObject({ type: text.optional(), text: text.optional() }))]).optional() })
    .refine(value => !value.content || value.content.every(part => typeof part === (value.type === 'reasoning' ? 'string' : 'object')));
const turn = z.looseObject({ id: text, status: text.optional(), items: z.array(item) });
const summaryTurn = turn.partial({ items: true });
const thread = z.looseObject({ id: text, cwd: text.optional(), path: nullableText, name: nullableText, preview: nullableText,
    model: nullableText, modelProvider: text.optional(), parentThreadId: nullableText, reasoningEffort: nullableText,
    turns: z.array(turn).optional(), status: z.looseObject({ type: text.optional() }).optional(),
    source: z.union([text, z.looseObject({ custom: text.optional(), subAgent: z.union([text, z.looseObject({ other: z.unknown().optional(),
                thread_spawn: z.looseObject({ agent_path: z.unknown().optional() }).optional() })]).optional() })]).optional(),
    archived: z.boolean().optional(), workflowTaskTitle: text.optional(), canAcceptDirectInput: z.boolean().nullish() });
const threadResponse = z.looseObject({ thread, followingLive: z.boolean().optional(), model: text.optional(), modelProvider: text.optional(),
    serviceTier: nullableText, reasoningEffort: nullableText, collaborationMode: z.looseObject({ mode: text.optional() }).nullish(),
    initialTurnsPage: z.looseObject({ data: z.array(summaryTurn) }).nullish() });
const config = z.looseObject({ model_provider: nullableText, model_providers: z.record(text, record).optional(),
    realtime: z.looseObject({ voice: nullableText }).nullish(), features: z.looseObject({ multi_agent: z.boolean().nullish() }).nullish(),
    mcp_servers: z.record(text, z.looseObject({ env: record.nullish() })).optional() });
const contextFiles = z.looseObject({ files: z.array(z.looseObject({ name: text, path: text, group: text,
        estimatedTokens: z.number(), included: z.boolean(), reason: text, selectable: z.boolean() })), note: text.optional() });
const accounts = z.looseObject({ activeId: text, accounts: z.array(z.looseObject({ id: z.unknown().optional(), authenticated: z.unknown().optional(), duplicate: z.unknown().optional() })) });
const page = <T extends z.ZodType>(row: T) => z.looseObject({ data: z.array(row), nextCursor: nullableText, backwardsCursor: nullableText });
const results = {
    // Layers contain raw JSON, not the effective Config projection (ConfigLayer.config).
    'config/read': z.looseObject({ config: config.optional(), layers: z.array(z.looseObject({ config: z.json().optional() })).nullish() }),
    'configRequirements/read': z.looseObject({ requirements: z.looseObject({ modelProvider: nullableText,
            modelProviders: z.record(text, record).nullish(), featureRequirements: record.nullish() }).nullish() }),
    'thread/read': threadResponse, 'thread/start': threadResponse, 'thread/resume': threadResponse,
    'thread/subscribe': threadResponse, 'thread/fork': threadResponse, 'thread/unarchive': threadResponse, 'thread/register': threadResponse,
    'thread/list': page(thread), 'thread/turns/list': page(summaryTurn),
    'thread/items/list': page(z.looseObject({ turnId: text, item })),
    'turn/start': z.looseObject({ turn: z.looseObject({ id: text }) }),
    'review/start': z.looseObject({ turn: z.looseObject({ id: text }), reviewThreadId: text }),
    'turn/settings/update': z.looseObject({ status: text }), 'thread/goal/get': z.looseObject({ goal: z.unknown() }),
    'thread/contextFiles/list': contextFiles, 'thread/contextFiles/set': contextFiles,
    'externalAgentConfig/detect': z.looseObject({ items: z.array(z.looseObject({ itemType: text.optional(),
            details: z.looseObject({ sessions: z.array(object).optional() }).nullish() })) }),
    'externalAgentConfig/import': z.looseObject({ importId: text }),
    'externalAgentConfig/import/readHistories': z.looseObject({ data: z.array(z.looseObject({ importId: text, successes: z.array(z.unknown()), failures: z.array(object) })) }),
    'experimentalFeature/list': page(z.looseObject({ stage: text, name: text, displayName: nullableText, description: nullableText, enabled: z.boolean() })),
    'account/login/start': z.looseObject({ authUrl: text.optional(), loginId: text.optional() }),
    'workGraph/list': z.looseObject({ data: z.array(z.looseObject({ id: text, name: text, status: text, maxConcurrency: z.number(), eventCount: z.number(), worktreeReport: text.nullable(), startedAt: z.number().optional(), createdAt: z.number().optional(), error: text.nullable(),
            tasks: z.array(z.looseObject({ id: text, kind: text, title: text, status: text, dependencies: strings, assignedThreadId: text.nullable(),
                provider: text.nullable(), model: text.nullable(), result: z.unknown(), evidence: strings, failureReason: text.nullable() })) })) }),
    'account/read': z.looseObject({ account: z.looseObject({ type: text.optional() }).nullish() }),
    'thread/realtime/listVoices': z.looseObject({ voices: z.looseObject({ v1: strings, defaultV1: text }) }),
    'claudeAccounts/read': accounts, 'claudeAccounts/write': accounts,
    'claudeSubscription/write': z.looseObject({ signedOut: z.boolean().optional() }),
} satisfies Record<keyof RpcResponses, z.ZodType>;
/** Validate before fulfilling a typed RPC promise. Unknown methods remain unknown. */
export function rpcResult<M extends string>(method: M, value: unknown): RpcResponse<M> {
    if (!isRpcResult(method, value))
        throw new BridgeError(`Elpis returned a malformed result for ${method}`, 502);
    return value;
}
function isRpcResult<M extends string>(method: M, value: unknown): value is RpcResponse<M> {
    const schemas: Readonly<Record<string, z.ZodType>> = results;
    const schema = Object.hasOwn(schemas, method) ? schemas[method] : undefined;
    return !schema || schema.safeParse(value).success;
}
const params = z.looseObject({ threadId: text.optional(), turnId: text.optional(), requestId: z.union([text, z.number()]).optional(),
    thread: thread.optional(), turn: z.looseObject({ id: text, model: nullableText }).optional(), item: z.unknown().optional(),
    threadSettings: z.unknown().optional(), tokenUsage: z.unknown().optional(), smartPrune: z.unknown().optional(), permissions: z.unknown().optional(),
    questions: z.array(z.looseObject({ id: text })).optional(), availableDecisions: z.array(z.unknown()).optional() });
const envelope = z.looseObject({ id: z.union([text, z.number()]).optional(), method: text.optional(), params: params.default({}), result: z.unknown().optional(),
    error: z.looseObject({ message: text.optional(), code: z.union([text, z.number()]).optional(), data: record.optional() }).nullish() });
export function readDesktopMessage(value: unknown) {
    const parsed = envelope.safeParse(value);
    return parsed.success ? parsed.data : null;
}
