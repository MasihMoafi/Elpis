import type { createThreadState } from './bridge-thread-state.mts';
import type { createHelperPermissions } from "./bridge-helper-permissions.mts";
import type { BridgeClient, AccessSettings } from "./bridge-types.mts";
import type { BridgeEnvironment } from "./bridge-server.mts";
export function createConnectionAccess({ resumeResults, threadPolicy, chatAccess, relayed, ws, settleRelay, fullFor, explicitChatChoices, threadSandbox, confirmations }: Pick<BridgeEnvironment, 'chatAccess' | 'relayed' | 'settleRelay' | 'fullFor' | 'explicitChatChoices'> & Pick<ReturnType<typeof createThreadState>, 'resumeResults' | 'threadPolicy' | 'threadSandbox'> & {
    ws: BridgeClient;
    confirmations(): ReturnType<typeof createHelperPermissions>['confirmations'];
}) {
    const sessionModel = new Map<string, string>();
    const threadCollab = new Map<string, string>();
    // thread id -> its permission profile and approvals reviewer, as the engine last confirmed
    // them; with the approval policy and Plan they pick Claude's own mode (claudeModeOf).
    const threadAccess = new Map<string, {
        profile: string | undefined;
        reviewer: string | undefined;
    }>();
    const noteAccess = (threadId: string, s: AccessSettings | null | undefined) => {
        if (!threadId || !s)
            return;
        const cached = resumeResults.get(threadId);
        if (cached) {
            for (const k of ["approvalPolicy", "approvalsReviewer", "activePermissionProfile", "cwd", "collaborationMode", "serviceTier", "disabledPluginIds"])
                if (s[k] !== undefined)
                    cached[k] = s[k];
            if (s.sandboxPolicy)
                cached.sandbox = s.sandboxPolicy;
        }
        if (s.approvalPolicy)
            threadPolicy.set(threadId, s.approvalPolicy);
        const sandbox = (s.sandboxPolicy ?? s.sandbox)?.type;
        const profile = s.permissions ?? s.activePermissionProfile?.id
            ?? (sandbox && (({ readOnly: ":read-only", dangerFullAccess: ":danger-full-access" } as Record<string, string>)[sandbox] ?? ":workspace"));
        const prev = threadAccess.get(threadId);
        const access = { profile: profile ?? prev?.profile, reviewer: s.approvalsReviewer ?? prev?.reviewer };
        threadAccess.set(threadId, access);
        chatAccess.set(threadId, { policy: threadPolicy.get(threadId), profile: access.profile });
        if (threadPolicy.get(threadId) === 'never')
            for (const [id, relay] of relayed) {
                if (relay.origin === ws && relay.toolPermission && relay.message.params.threadId === threadId)
                    settleRelay(id, { result: { decision: fullFor(threadId) ? 'accept' : 'decline' } });
            }
        for (const confirm of confirmations().get(threadId) ?? [])
            confirm(access.profile);
    };
    // The Claude Code mode a chat's turn runs in: Codex's permission modes, mapped to Claude's own.
    // Ask uses Accept edits, Approve for me uses Auto. Full access keeps normal
    // provider checks and answers their permission hook; only Bypass selects the
    // provider's bypass mode. A read-only helper that may not ask plans.
    const MODE_NAMES = { default: "Manual", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto", bypassPermissions: "Bypass permissions" };
    const claudeModeOf = (threadId: string, agentKey: string, ask: boolean) => threadCollab.get(threadId) === "plan" ? "plan" : accessModeOf(threadId, agentKey, ask);
    // The mode of the chat's permission mode alone, which a Plan turn returns to once its plan is
    // approved.
    const accessModeOf = (threadId: string, agentKey: string, ask: boolean) => {
        const { profile, reviewer } = threadAccess.get(threadId) ?? {};
        const readOnly = (!explicitChatChoices.has(threadId) && threadSandbox.get(threadId) === "read-only") || !!profile?.includes("read-only");
        // Never asking is an approval policy, not permission to leave a restricted profile.
        // Unknown/custom profiles stay restricted unless the engine explicitly names Full Access.
        if (!ask)
            return readOnly ? "plan" : profile === ':bypass-permissions' ? "bypassPermissions" : "default";
        if (agentKey !== "claude" || readOnly)
            return "default";
        return reviewer === "auto_review" ? "auto" : "acceptEdits";
    };
    const sessionMode = new Map<string, string>();
    return { sessionModel, threadCollab, threadAccess, noteAccess, MODE_NAMES, claudeModeOf, accessModeOf, sessionMode };
}
