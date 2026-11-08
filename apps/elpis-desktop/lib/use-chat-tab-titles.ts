import { useEffect } from "react";
import { title } from "@/lib/api";
import { followChat, renameTabs } from "@/lib/chat-tabs";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useRelatedConversations } from "@/lib/use-related-conversations";

export function useChatTabTitles(
  session: ReturnType<typeof useConversationSession>,
  chatTabs: ReturnType<typeof useChatTabs>,
  related: ReturnType<typeof useRelatedConversations>,
  ready: boolean,
) {
  const { selected, threads } = session,
    { tabsRef, updateTabs } = chatTabs;
  const find = (id?: string | null) => (id ? (threads.find(thread => thread.id === id) ?? related[id]) : undefined);
  const selectedTitle = selected ? title(selected) : "";
  useEffect(() => {
    if (ready) updateTabs(followChat(tabsRef.current, selected ? { id: selected.id, title: selectedTitle } : null));
  }, [ready, selected?.id, selectedTitle]);
  useEffect(() => {
    updateTabs(
      renameTabs(tabsRef.current, id => {
        const thread = find(id);
        return thread ? title(thread) : undefined;
      }),
    );
  }, [threads, related]);
  return find;
}
