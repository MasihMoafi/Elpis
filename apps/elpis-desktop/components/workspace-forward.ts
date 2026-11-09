import type { createChatDeletion } from "@/lib/chat-deletion";
import type { createChatSend } from "@/lib/chat-send";
import type { createConversationSettings } from "@/lib/conversation-settings";
import type { createMessageActions } from "@/lib/message-actions";
import type { createSidebarPlacement } from "@/lib/sidebar-placement";
import type { useOpenConversation } from "@/lib/use-open-conversation";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { useWorkspaceSplit } from "@/lib/use-workspace-split";

type Settings = ReturnType<typeof createConversationSettings>;
type Placement = ReturnType<typeof createSidebarPlacement>;
type Deletion = ReturnType<typeof createChatDeletion>;

/** What the workspace's earlier layers call from closures but later layers create. Filled in during each render. */
export type WorkspaceForward = {
  openSplit: ReturnType<typeof useWorkspaceSplit>["openSplit"];
  openThread: ReturnType<typeof useOpenConversation>["openThread"];
  send: ReturnType<typeof createChatSend>;
  rememberModes: Settings["rememberModes"];
  noteStartedMode: Settings["noteStartedMode"];
  loadVersions: ReturnType<typeof createMessageActions>["loadVersions"];
  placementReveal: Placement["placementReveal"];
  revealPlacement: Placement["revealPlacement"];
  nativeParents: ReturnType<typeof useSidebarThreads>["nativeParents"];
  archiveChats: Deletion["archiveChats"];
  deleteChats: Deletion["deleteChats"];
};
