import type WebSocket from "ws";
import type { Acp } from "./bridge-acp.mts";
import type { ThreadElpisInstructionsReadResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadElpisInstructionsReadResponse.ts";

export type BridgeError = { message?: string; code?: string | number; signedOut?: boolean; data?: { errorKind?: unknown } | null; errorKind?: unknown };
export type RequestId = string | number;
export type BridgeClient = WebSocket & { pending: Set<RequestId>; sendWire: (line: Parameters<WebSocket["send"]>[0]) => void; drainShadow?: boolean };
export type BridgeMessage = { id?: RequestId; method?: string; params?: { threadId?: string; turnId?: string; [key: string]: unknown }; result?: unknown; error?: unknown; [key: string]: unknown };
export type NoticeParams = { threadId?: string; thread?: { id?: string; [key: string]: unknown }; [key: string]: unknown };
export type ResumeResult = { thread: EngineThread; model?: string | undefined; [key: string]: unknown };
export type HelperScope = SavedHelper & { requested: string; ceiling: Ceiling; owners: Set<(id: string) => Promise<boolean>>; activeOwner?: ((id: string) => Promise<boolean>) | null; lastTurn?: TranscriptTurn };
export type ProviderOwner = { ws: BridgeClient; nativeHelper?: boolean; model: () => string | null | undefined; effort: () => string | null; status: () => { type: string; activeFlags?: string[] }; decorate: (thread: EngineThread) => void; lastTurn?: () => TranscriptTurn | undefined; dispatch: (message: BridgeMessage & { id: RequestId }, client: BridgeClient) => void };
export type StartPick = { model?: string | undefined; effort?: string | null; forkOf?: ForkLink; forkTurns?: TranscriptTurn[] };
export type LiveSession = { id: string; mode: string; subagents: boolean; agent: string; accountId: string | null; prune: boolean; instructions: string; mcp: string; environment: string };
export type RelayReply = { result?: unknown; error?: unknown };
export type Relay = { answer: (reply: RelayReply) => void; origin: BridgeClient; upstreamId: RequestId | undefined; toolPermission: boolean; clients: Set<BridgeClient>; message: BridgeMessage & { params: { threadId: string; turnId?: string; [key: string]: unknown } }; threadId: string };
export type BridgeContext = {
  failed: boolean; claudeBusy: () => boolean; stopProvider: (id: string) => Promise<void>; stopProviderFor: (id: string, action: string) => Promise<void>;
  resumeQueue: (id: string) => void; nativeLifecycle: (method: string, id: string) => Promise<unknown>; isBridgeChild: (id: string) => boolean;
  childrenOf: (ids: Set<string>) => string[]; forgetThread: (id: string) => void; forgetArchived: (id: string) => void;
  busy: () => boolean; busyThreads: () => string[]; loadedThreads: () => Promise<string[]>; close: () => void; releaseIfUnused: () => void;
};
export type PromptInput = { type: string; text?: string; path?: string; url?: string; name?: string; text_elements?: unknown[] };
export type McpConfig = Record<string, { command?: string; args?: unknown[]; env?: Record<string, unknown> }>;
export type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type ToolState = {
  name: string | null | undefined; title: string | null; raw: { file_path?: string; notebook_path?: string; content?: string; command?: string; pattern?: string; path?: string; description?: string };
  response: { filePath?: string; type?: string; structuredPatch?: PatchHunk[]; content?: string; stdout?: string; stderr?: string } | null;
  text: string | null; diffs: { path: string; oldText?: string | null; newText?: string | null }[];
  status: string; declined: boolean; shown: boolean; start: number; end: number | null;
};

export type TranscriptItem = { type: string; id?: string; status?: string; commandActions?: { type: string; path?: string | null }[]; text?: string; content?: PromptInput[] | string[]; review?: string | undefined; changes?: { path: string; diff: string; [key: string]: unknown }[]; aggregatedOutput?: string | null; [key: string]: unknown };
export type TranscriptTurn = { id?: string; items: TranscriptItem[]; startedAt?: number | null; startedAtMs?: number | null; completedAt?: number | null; status?: string | undefined; claudeMessageId?: string | null; [key: string]: unknown };
export type ContextFile = { name: string; path: string; estimatedTokens?: number | undefined; group: string; included: boolean; selectable: boolean; reason?: string };
export type Goal = { threadId: string; objective: string; status: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number };
export type ActiveRecord = { turnId: string; startedAt: number; startedAtMs?: number; pid: number; cwd?: string; userItems?: TranscriptItem[]; preview?: string; transcriptOffset?: number; inputs?: string[] | undefined };
export type ForkLink = { threadId: string; at?: number; beforeTurnId?: string | null; lastTurnId?: string | null; copied?: boolean };
export type SavedSession = { model?: string | null | undefined; nativeModel?: string; effort?: string | null; agent?: string; mode?: string; session?: string; sessions?: Record<string, string>; claudeAccountId?: string | null; turns?: TranscriptTurn[]; active?: ActiveRecord; parentThreadId?: string; rootThreadId?: string; thread?: EngineThread; cwd?: string; contextFiles?: ContextFile[]; contextSessionId?: string | undefined; forkOf?: ForkLink; goal?: Goal | null; plan?: { turnId: string; explanation: string | null; plan: { step: string; status: string }[] }; providerHistory?: boolean };
export type SavedHelper = { parentThreadId: string; model?: string | null | undefined; requested?: string; ceiling?: Ceiling; startedAt?: number; workflowRunId?: string; workflowAgentId?: string | null };
export type Store = Record<string, SavedSession> & { _default?: { model: string; effort?: string | null }; _delegations?: Record<string, SavedHelper> };
export type StoreUpdate = { fn: (store: Store) => void; resolve: (success: boolean) => void };
export type ContextChars = { user: number; agent: number; reasoning: number; toolCalls: number; toolResults: number };
export type UsageTotals = { input: number; output: number; cachedRead: number; cachedWrite: number; total: number };
export type AcpUsage = { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; totalTokens?: number };
export type ClaudeWindow = { utilization?: number; resets_at?: string };
export type AgyBucket = { window: string; remaining_fraction?: number; reset_time?: string };
export type AgyGroup = { name: string; buckets?: AgyBucket[] };
export type LimitWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number | null };
export type RateLimit = { limitId: string; limitName: string; normalModelSlug: null; primary: LimitWindow | null; secondary: LimitWindow | null; credits: null; individualLimit: null; spendControlReached: null; planType: null; rateLimitReachedType: null };
export type ProviderAgent = { key: string; speaker: string; prefix: string; label: string; description: string; adapter: string; env: NodeJS.ProcessEnv; catalogFile: string; signedOut?: () => boolean; limits: () => Promise<RateLimit[]> };

export type EngineThread = { id: string; model?: string | null | undefined; parentThreadId?: string | null; status?: { type?: string; activeFlags?: string[] }; source?: string | { subAgent?: unknown; custom?: string }; turns?: TranscriptTurn[]; cwd?: string; ephemeral?: boolean; name?: string | null; preview?: string; path?: string | null; modelProvider?: string; createdAt?: number; updatedAt?: number; recencyAt?: number | null; reasoningEffort?: string | null; workflowRunId?: string; workflowAgentId?: string | null; [key: string]: unknown };
export type AccessSettings = { approvalPolicy?: string; approvalsReviewer?: string; permissions?: string; activePermissionProfile?: { id?: string } | null; sandboxPolicy?: { type?: string } | null; sandbox?: { type?: string } | null; [key: string]: unknown };
export type EngineConfig = { model?: string | null; features?: { multi_agent?: boolean | null } | null; [key: string]: unknown };
export type TurnPage = { data?: TranscriptTurn[]; nextCursor?: string | null; backwardsCursor?: string | null };
export type ItemRow = { turnId: string | undefined; item: TranscriptItem; startedAtMs: number | null; completedAtMs: number | null };
export type ItemPage = { data?: ItemRow[]; nextCursor?: string | null; backwardsCursor?: string | null };
export type BridgeResponses = {
  "config/read": { config?: EngineConfig; layers?: { config?: EngineConfig }[] | null };
  "configRequirements/read": { requirements?: Record<string, unknown> | null };
  "thread/read": { thread?: EngineThread };
  "thread/resume": { thread?: EngineThread; approvalPolicy?: string; activePermissionProfile?: { id?: string } | null };
  "thread/loaded/list": { data?: string[] };
  "thread/turns/list": TurnPage;
  "thread/items/list": ItemPage;
  "thread/contextFiles/list": { files: ContextFile[] };
  "thread/contextFiles/set": { files: ContextFile[] };
  "thread/elpisInstructions/read": Partial<ThreadElpisInstructionsReadResponse>;
  "thread/approval/review": { decision?: string; rationale?: string };
  "thread/revert": { thread?: EngineThread; turnsBackwardsCursor?: string | null };
};
export type EngineCall = { <K extends keyof BridgeResponses>(method: K, params: object, timeoutMs?: number): Promise<BridgeResponses[K]>; (method: string, params: object, timeoutMs?: number): Promise<unknown> };
export type EffortLevels = { levels: { reasoningEffort: string; description: string }[]; current: string | null | undefined };
export type Catalog = { at?: number; models?: { value: string; name: string }[]; efforts?: Record<string, EffortLevels>; fallback?: EffortLevels; modes?: string[] | null };
export type CatalogResult = { models: { value: string; name: string; description?: string }[]; efforts: Record<string, EffortLevels>; fallback: EffortLevels; modes: string[] | null };
export type AcpOption = { id: string; currentValue?: unknown; options?: unknown; [key: string]: unknown };
export type AcpSession = { sessionId: string; configOptions?: AcpOption[] | null; modes?: { availableModes?: { id: string }[] } | null };
export type AcpResponses = {
  "session/new": AcpSession;
  "session/fork": { sessionId: string };
  "session/set_config_option": { configOptions?: AcpOption[] | null };
  "session/prompt": { stopReason: string; usage?: AcpUsage | null; _meta?: Record<string, unknown> | null };
  "_session/steering": { outcome?: string; _meta?: { delivery?: string } | null };
  "_elpis/contextFiles": { files: { path: string; estimatedTokens?: number }[] };
};
export type SubagentUpdate = { sessionUpdate: "subagent_update"; sessionId: string; title?: string; description?: string; state?: { state: string; stopReason?: string }; capabilities?: { cancel?: unknown } };
export type SessionMessage = { sessionUpdate: "session_message"; content?: { type: "text"; text: string }[] };
export type AcpEvent = SubagentUpdate | SessionMessage
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk"; content: { type: "text"; text: string }; messageId?: string }
  | { sessionUpdate: "usage_update"; used?: number; size?: number; cost?: unknown; _meta?: Record<string, unknown> }
  | { sessionUpdate: "plan"; entries: { content: string; status: string }[] }
  | { sessionUpdate: "tool_call" | "tool_call_update"; toolCallId: string; kind?: string; title?: string; status?: string;
      rawInput?: ToolState["raw"]; toolName?: string; toolResponse?: NonNullable<ToolState["response"]>;
      content?: ({ type: "diff"; path: string; oldText?: string | null; newText?: string | null } | { type: "content"; content: { type: "text"; text: string } })[] }
  | { sessionUpdate: "_unhandled"; original: string };
export type AcpUpdate = { sessionId: string; update: AcpEvent };
export type AcpPermission = { sessionId: string; toolCall?: { toolCallId?: string; title?: string | null }; options: { optionId: string; kind: string }[] };
export type AcpHandlers = { onUpdate?: (params: AcpUpdate) => void; onPermission?: (params: AcpPermission) => Promise<string | null | undefined> };
export type AgentMessageItem = TranscriptItem & { type: "agentMessage"; text: string };
export type Lane = {
  threadId: string; turnId: string; items: TranscriptItem[]; tools: Map<string, ToolState>; message: AgentMessageItem | null; lastPlan: string | null; done: boolean; onIdle: () => void;
  say: (item: TranscriptItem) => void; activity: (kind: string, agentThreadId: string, name: string) => void; closeMessage: () => void;
  turn: () => TranscriptTurn; update: (event: AcpEvent) => void; end: () => void; depth?: number; startedAt?: number;
};
export type SubLane = Lane & { depth: number; name: string; parent: Lane; startedAt: number };
export type ChildThread = { thread: EngineThread; lane: SubLane; rootThreadId: string; cancel: (() => void) | null };
export type Steer = { cancelled: boolean; phase: string; turnId: string };
export type TurnOutcome = { status: string; turnId: string; seconds: number; tokens: number };
export type QueueEntry = { id: string; input: PromptInput[]; clientUserMessageId?: string | null | undefined; goal?: boolean; steer?: Steer; after?: (result: TurnOutcome) => void };
export type HistoryRequest = { threadId: string; limit?: number | null; sortDirection?: string | null; itemsView?: string | null; cursor?: string; turnId?: string };
export type HistoryOptions = Omit<HistoryRequest, "threadId">;
export type GlobalParams = { threadId?: string; excludeTurns?: boolean; initialTurnsPage?: HistoryOptions; approvalPolicy?: string; approvalsReviewer?: string; permissions?: string; model?: string | null; effort?: string | null; sandbox?: Ceiling; sandboxPolicy?: string | { type?: string }; config?: Record<string, unknown>; rootThreadId?: string; signedOut?: unknown; action?: string; id?: string; code?: string; script?: string | null | undefined; scriptPath?: string | undefined; args?: unknown; resumeFromRunId?: string | undefined; cwd?: string | string[]; budget?: number | null; limit?: number; sortDirection?: string; itemsView?: string; cursor?: string; turnId?: string; beforeTurnId?: string; lastTurnId?: string; target?: { type?: string; branch?: string; sha?: string; title?: string; instructions?: string }; input?: PromptInput[]; clientUserMessageId?: string | null; queuedSubmissionId?: string; queuedSubmissionIds?: string[]; objective?: string; status?: string; tokenBudget?: number | null; clientUserMessageIds?: string[]; includeTurns?: boolean; instructions?: string; collaborationMode?: { mode?: string; settings?: { model?: string | null; developer_instructions?: string | null } }; clientInfo?: { name?: string }; edits?: { keyPath: string; value?: unknown }[]; ancestorThreadId?: string; archived?: boolean; sortKey?: string; sourceKinds?: string[]; modelProviders?: string[]; searchTerm?: string; elpisParentThreadId?: string; elpisRequestedScope?: string; elpisWorkflow?: { runId?: string; agentId?: string | null }; parentThreadId?: string; [key: string]: unknown };
export type ThreadParams = GlobalParams & { threadId: string; cwd?: string };
export type GlobalRequest = { id: RequestId; method: string; params: GlobalParams };
export type ThreadRequest = { id: RequestId; method: string; params: ThreadParams };
export type ClaudeTurnRequest = { id?: RequestId; kind?: string; params: { threadId: string; input?: PromptInput[]; clientUserMessageId?: string | null | undefined; collaborationMode?: GlobalParams["collaborationMode"] }; reviewHint?: string; acp?: Acp; sessionId?: string };
export type ProviderTurn = {
  threadId: string; turnId: string; done: Promise<unknown>; sessionId: string | null; items: TranscriptItem[]; closeMessage: () => void;
  cancelled: boolean; ready: Promise<string | null>; toolsIdle: (() => void)[]; steers: Promise<void>; promptEnded: boolean; bufferedUpdates: AcpUpdate[] | null;
  toolsBusy: () => boolean; whenToolsIdle: () => Promise<void>; snapshot: (view?: string) => TranscriptTurn;
  acp?: Acp; own?: AcpHandlers; inputs?: string[]; quiet?: NodeJS.Timeout; followupEnded?: Promise<{ stopReason: string; usage?: AcpUsage }>;
  endFollowup?: (result: { stopReason: string; usage?: AcpUsage }) => void; endSubagents?: () => void; flushUpdates?: () => void;
  recover?: () => Promise<void> | undefined; stopRecordWatch?: () => void;
};
export type AcpMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

export type Ceiling = "read-only" | "workspace-write" | "danger-full-access";
