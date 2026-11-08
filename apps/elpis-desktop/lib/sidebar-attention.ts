import { without } from "@/lib/utils";
import type { useChatAttention } from "@/lib/use-sidebar-state";
import type { useConversationOptions } from "@/lib/use-conversation-options";

export function createSidebarAttention(
  attentionState: ReturnType<typeof useChatAttention>,
  options: ReturnType<typeof useConversationOptions>,
) {
  const { attention, setAttention } = attentionState,
    { setPlanAnswered } = options;
  return function attentionFor(id: string) {
    return {
      unread: attention.unread.includes(id),
      planReady: !!attention.plans[id],
      onToggleRead: () =>
        setAttention(previous => ({
          ...previous,
          unread: previous.unread.includes(id)
            ? previous.unread.filter(value => value !== id)
            : [...previous.unread, id],
        })),
      onComplete: () => {
        setPlanAnswered(previous => ({ ...previous, [id]: attention.plans[id]! }));
        setAttention(previous => ({
          unread: previous.unread.filter(value => value !== id),
          plans: without(previous.plans, id),
        }));
      },
    };
  };
}
