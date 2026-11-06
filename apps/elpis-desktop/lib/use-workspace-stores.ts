import { useAppPreferences } from "@/lib/preferences";
import { useConversationSession } from "@/lib/use-conversation-session";
import { useChatTabs } from "@/lib/use-chat-tabs";
import { useWorkspaceModels } from "@/lib/use-workspace-models";
import { useConversationOptions } from "@/lib/use-conversation-options";
import { useProjectState } from "@/lib/use-project-state";
import { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";

/** The window's shared settings and the stores for its open conversations and pages. */
export function useWorkspaceStores(onError: (message: string) => void) {
  const preferences = useAppPreferences();
  const session = useConversationSession();
  const chatTabs = useChatTabs(onError);
  const models = useWorkspaceModels();
  const options = useConversationOptions();
  const projectState = useProjectState();
  const pages = useWorkspacePagesState();
  return { preferences, session, chatTabs, models, options, projectState, pages };
}
