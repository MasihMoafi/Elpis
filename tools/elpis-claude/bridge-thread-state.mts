import type { AskForApproval } from '../../codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts';
import type { Acp } from "./bridge-acp.mts";
import type { RequestId, ResumeResult, LiveSession, McpConfig, SavedHelper, EngineThread, ChildThread, Steer, Ceiling } from "./bridge-types.mts";
export function createThreadState() {
    const threadCwd = new Map<string, string>();
    const threadSeen = new Map<string, EngineThread>();
    const childThreads = new Map<string, ChildThread>();
    const childIds = new Set<string>();
    const threadPolicy = new Map<string, AskForApproval>();
    const smartPrune = new Map<string, boolean>();
    const threadSandbox = new Map<string, Ceiling>();
    const pendingDelegation = new Map<RequestId, SavedHelper & {
        requested: string;
        ceiling: Ceiling;
        sandbox: Ceiling;
    }>();
    const pendingHelperTurns = new Map<RequestId, string>();
    const sessions = new Map<string, LiveSession>();
    const threadMcp = new Map<string, McpConfig>();
    const threadEnvironment = new Map<string, Record<string, string>>();
    const acps = new Map<string, Acp>();
    const claudeModel = new Map<string, string>();
    const pendingSteers = new Map<string, Map<string, Steer>>();
    const claudeEffort = new Map<string, string>();
    const resumeResults = new Map<string, ResumeResult>();
    const materializedProviders = new Set<string>();
    return { threadCwd, threadSeen, childThreads, childIds, threadPolicy, smartPrune, threadSandbox, pendingDelegation, pendingHelperTurns, sessions, threadMcp, threadEnvironment, acps, claudeModel, pendingSteers, claudeEffort, resumeResults, materializedProviders };
}
