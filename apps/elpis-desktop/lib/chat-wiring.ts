import type { RefObject } from "react";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";

/** The chat state that opening and navigating between chats both work on. */
export type ChatWiring = {
  conversations: ReturnType<typeof useConversationList>;
  history: ReturnType<typeof useTranscriptHistory>;
  drafts: ReturnType<typeof useDraftStore>;
  attachments: ReturnType<typeof useComposerAttachments>;
  tabsRef: ReturnType<typeof useChatTabs>["tabsRef"];
  updateTabs: ReturnType<typeof useChatTabs>["updateTabs"];
  session: ReturnType<typeof useConversationSession>;
  newDraftKey: RefObject<string>;
};
