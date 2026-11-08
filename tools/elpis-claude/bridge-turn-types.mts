import type { AskForApproval } from '../../codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts';
import type { Acp } from "./bridge-acp.mts";
import type { ClaudeAccounts } from "./claude-accounts.mts";
import type { EngineCall, BridgeClient, BridgeMessage, CatalogResult, ChildThread, ContextChars, EngineThread, Lane, LiveSession, McpConfig, NoticeParams, ProviderAgent, ProviderTurn, RateLimit, Store, UsageTotals } from "./bridge-types.mts";
export type Mode = "plan" | "bypassPermissions" | "default" | "auto" | "acceptEdits";
export type McpServer = {
    name: string;
    command: string | undefined;
    args: string[];
    env: {
        name: string;
        value: string;
    }[];
};
export type Dependencies = {
    log: (text: string) => void;
    now: () => number;
    SUBAGENT_TOOLS: string[];
    SUBAGENTS_DISABLED: string;
    AUTONOMOUS_ORIGINS: Set<string>;
    REPLY_UPDATES: Set<string>;
    mcpServersFor: (subagents: boolean, parentThreadId: string | null, memoryCwd: string | null, workflow?: boolean) => McpServer[];
    acpServersFrom: (config: McpConfig | null | undefined, threadId: string) => McpServer[];
    loadStore: () => Promise<Store>;
    storeChain: () => Promise<void>;
    updateStore: (fn: (store: Store) => void) => Promise<boolean>;
    deletedThreads: Set<string>;
    claudeAccounts: ClaudeAccounts;
    AGENTS: [
        ProviderAgent,
        ...ProviderAgent[]
    ];
    agentOf: (model: unknown) => ProviderAgent | undefined;
    refuseSignedOut: (agent: ProviderAgent | undefined) => void;
    acpErrorMessage: (error: {
        signedOut?: boolean;
        message?: string;
    } | null | undefined, agent?: ProviderAgent) => string | undefined;
    RECONNECT_MS: number;
    RECONNECT_NOTE: string;
    connectionDropped: (error: {
        message?: string;
    } | null | undefined) => boolean;
    announceLimits: (agent: ProviderAgent | undefined, send: (method: string, params: {
        rateLimits: RateLimit;
    }) => void) => void;
    smartPruneProxy: () => Promise<string | null>;
    recordAccounts: () => Promise<void>;
    fullFor: (threadId: string) => boolean;
    cancelRelays: (client: BridgeClient, threadId?: string, turnId?: string) => void;
    ws: BridgeClient;
    toTui: (message: BridgeMessage) => void;
    notify: (method: string, params: NoticeParams) => void;
    threadCwd: Map<string, string>;
    threadSeen: Map<string, EngineThread>;
    childThreads: Map<string, ChildThread>;
    childIds: Set<string>;
    threadPolicy: Map<string, AskForApproval>;
    smartPrune: Map<string, boolean>;
    sessions: Map<string, LiveSession>;
    threadMcp: Map<string, McpConfig>;
    threadEnvironment: Map<string, Record<string, string>>;
    claudeModel: Map<string, string>;
    claudeEffort: Map<string, string>;
    materializedProviders: Set<string>;
    sessionModel: Map<string, string>;
    threadAccess: Map<string, {
        profile: string | undefined;
        reviewer: string | undefined;
    }>;
    MODE_NAMES: Record<Mode, string>;
    claudeModeOf: (threadId: string, agent: string, ask: boolean) => Mode;
    accessModeOf: (threadId: string, agent: string, ask: boolean) => Mode;
    sessionMode: Map<string, string>;
    tokenSums: Map<string, UsageTotals>;
    ctxChars: Map<string, ContextChars>;
    devChars: Map<string, number>;
    addChars: (threadId: string, part: keyof ContextChars, n: number) => void;
    transcriptOf: (threadId: string) => string | null;
    lastTurnUsage: Map<string, UsageTotals>;
    sendUsage: (threadId: string, turnId: string, last: UsageTotals | null) => void;
    ensureAcp: (agent: ProviderAgent) => Promise<Acp>;
    catalogFor: (agent: ProviderAgent) => Promise<CatalogResult>;
    engineCall: EngineCall;
    elpisInstructions: (threadId: string, developerInstructions?: string | null) => Promise<string>;
    subagentsAllowed: (cwd: string | undefined) => Promise<boolean>;
    activeTurns: Map<string, ProviderTurn>;
    reconnects: Map<string, NodeJS.Timeout>;
    pendingMirrors: Map<string, Promise<void>>;
    priorTranscript: (threadId: string) => Promise<string>;
    askTui: (method: string, params: NoticeParams, toolPermission?: boolean) => Promise<{
        decision?: string;
    } | null>;
    newLane: (threadId: string, turnId: string, cwd: string, root: boolean) => Lane;
    runNext: (threadId: string) => void;
};
