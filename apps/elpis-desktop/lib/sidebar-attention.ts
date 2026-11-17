import type { useChatAttention } from "@/lib/use-sidebar-state";
import type { useConversationOptions } from "@/lib/use-conversation-options";

export function createSidebarAttention(
  attentionState: ReturnType<typeof useChatAttention>,
  options: ReturnType<typeof useConversationOptions>,
) {
  const { attention, attentionOp, markRead } = attentionState,
    { setPlanAnswered } = options;
  return function attentionFor(id: string) {
    return {
      unread: attention.unread.includes(id),
      planReady: !!attention.plans[id],
      onToggleRead: () => attention.unread.includes(id) ? markRead(id) : attentionOp({ kind: "unread", id }),
      onComplete: () => {
        setPlanAnswered(previous => ({ ...previous, [id]: attention.plans[id]! }));
        markRead(id);
        attentionOp({ kind: "clearPlan", id, turn: attention.plans[id]! });
      },
    };
  };
}
