import { ProfileDialog } from "@/components/profile-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { CommandMenu, type CommandAction } from "@/components/command-menu";
import { StartupSplash } from "@/components/startup-splash";
import { errorText } from "@/lib/error-text.mts";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { useWorkspaceDialogState } from "@/lib/use-workspace-dialog-state";
import type { useProjectState } from "@/lib/use-project-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { useChildConversations } from "@/lib/use-child-conversations";
import type { useWorkspaceSplit } from "@/lib/use-workspace-split";
import type { useOpenConversation } from "@/lib/use-open-conversation";
import type { createProjectActions } from "@/lib/project-actions";
import type { useDesktopEntryPoints } from "@/lib/use-desktop-entry-points";
import type { useWorkspaceNotices } from "@/lib/use-workspace-notices";

type Props = {
  session: ReturnType<typeof useConversationSession>; runtime: ReturnType<typeof useRuntimeState>;
  notices: ReturnType<typeof useWorkspaceNotices>; pages: ReturnType<typeof useWorkspacePagesState>; dialogs: ReturnType<typeof useWorkspaceDialogState>;
  projectState: ReturnType<typeof useProjectState>; sidebarModel: ReturnType<typeof useSidebarThreads>;
  childrenState: ReturnType<typeof useChildConversations>; split: ReturnType<typeof useWorkspaceSplit>["split"];
  desktop: boolean; panelShown: boolean; actions: CommandAction[];
  openThread: ReturnType<typeof useOpenConversation>["openThread"]; selectProject: ReturnType<typeof createProjectActions>["selectProject"];
  newChat: () => void; setDesktopPrompt: ReturnType<typeof useDesktopEntryPoints>;
};

export function WorkspaceCommandDialogs({ session, runtime, notices, pages, dialogs, projectState, sidebarModel, childrenState, split, desktop, panelShown, actions, openThread, selectProject, newChat, setDesktopPrompt }: Props) {
  const { setError } = notices;
  const { selected, busy } = session, { ready, connected } = runtime, { view } = pages;
  const { shortcutsOpen, setShortcutsOpen, shortcutsReturnFocus, commandMenuOpen, setCommandMenuOpen, commandReturnFocus } = dialogs;
  const { projects, projectChanging } = projectState, { ordinaryThreads } = sidebarModel, { holdAgentPanel } = childrenState;
  return <>
    <ProfileDialog ready={ready && connected} />
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} returnFocus={shortcutsReturnFocus} />
    {commandMenuOpen && <CommandMenu threads={ordinaryThreads} projects={busy || projectChanging ? [] : projects} actions={actions} returnFocus={commandReturnFocus} onClose={() => setCommandMenuOpen(false)} onThread={thread => { void openThread(thread); }} onProject={item => { void selectProject(item).catch(cause => setError(errorText(cause))); }} onNewChat={prompt => { newChat(); setDesktopPrompt(prompt); }} />}
    {desktop && <StartupSplash onLeaving={() => {
      if (view === "chat" && selected && (!ready || !connected) && !panelShown && !split.thread && window.matchMedia("(min-width: 1101px)").matches) holdAgentPanel(selected);
    }} />}
  </>;
}
