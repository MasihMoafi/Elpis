import { isAgentRun, type ProviderSettings } from "@/lib/api";
import type { PermissionMode } from "@/components/composer-controls";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useConversationOptions } from "@/lib/use-conversation-options";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { View } from "@/lib/workspace-types";

export function conversationStatus(
  session: ReturnType<typeof useConversationSession>,
  options: ReturnType<typeof useConversationOptions>,
  runtime: ReturnType<typeof useRuntimeState>,
  providerSettings: ProviderSettings | null,
  view: View,
) {
  const { selected, entries } = session,
    { threadModes, newMode, nextTurn, threadPlans, newPlan, planAnswered } = options;
  const { activeTurns, approvals } = runtime;
  const activeTurn = selected ? activeTurns[selected.id] : undefined;
  // A new chat starts in Settings' default permissions until a mode is chosen; an unmatched config shows Ask.
  const defaultMode = providerSettings?.options?.defaultPermissions;
  const configuredMode: PermissionMode =
    defaultMode === "ask" || defaultMode === "custom" ? "ask" : defaultMode === "auto" ? "auto" : "full";
  const permissionMode: PermissionMode = selected ? (threadModes[selected.id] ?? "ask") : (newMode ?? configuredMode);
  const planMode = selected ? (nextTurn[selected.id]?.plan ?? threadPlans[selected.id] ?? false) : newPlan;
  // The last finished turn's proposed plan, while the chat is in Plan mode and it is unanswered.
  const lastTurnId = entries.at(-1)?.turnId;
  const proposedPlan =
    selected &&
    planMode &&
    lastTurnId &&
    lastTurnId !== activeTurn &&
    planAnswered[selected.id] !== lastTurnId &&
    entries.some(entry => entry.turnId === lastTurnId && entry.item.type === "plan")
      ? lastTurnId
      : null;
  const outsideChatApprovals = approvals.filter(
    approval => view !== "chat" || approval.params.threadId !== selected?.id,
  );
  const readOnlyRun = !!selected && (isAgentRun(selected) || selected.desktopAccess?.writable === false);
  const continues = readOnlyRun || selected?.desktopAccess?.mode === "continue";
  return { activeTurn, permissionMode, planMode, proposedPlan, outsideChatApprovals, readOnlyRun, continues };
}
