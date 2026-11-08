import { useRef } from "react";
import { SectionToggle } from "@/components/sidebar-group";
import { useBookmarks, useChatAttention, usePins, useSidebarFolds, useChatGroups } from "@/lib/use-sidebar-state";
import { useWorkspaceDialogState } from "@/lib/use-workspace-dialog-state";
import { useWorkspaceNotices } from "@/lib/use-workspace-notices";
import { useSidebarSelection } from "@/lib/use-sidebar-selection";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useConversationOptions } from "@/lib/use-conversation-options";
import type { Thread } from "@/lib/api";

export function useWorkspaceSidebarState(
  session: ReturnType<typeof useConversationSession>,
  options: ReturnType<typeof useConversationOptions>,
  openSplit: (thread: Thread) => void,
  openThread: (thread: Thread) => Promise<void>,
) {
  const { pins, togglePinned } = usePins();
  const { bookmarks, toggleBookmarked } = useBookmarks();
  // The sidebar's order is declared further down; groups release it through this ref.
  const releaseChatOrder = useRef(() => {});
  const groups = useChatGroups(
    message => setError(message),
    () => releaseChatOrder.current(),
  );
  const dialogs = useWorkspaceDialogState();
  const notices = useWorkspaceNotices(),
    { setError } = notices;
  const attentionState = useChatAttention(options.planAnswered, setError);
  const selection = useSidebarSelection({ selected: session.selected, openSplit, openThread });
  const foldsState = useSidebarFolds();
  const { folds, changeFolds } = foldsState,
    collapsedProjects = folds.projects,
    collapsedSections = folds.sections;
  /** The heading of a sidebar section: every one of them folds its list the same way. */
  const foldable = (key: string, name: string) => (
    <SectionToggle
      name={name}
      open={!collapsedSections[key]}
      onToggle={() =>
        changeFolds(value => ({ ...value, sections: { ...value.sections, [key]: !value.sections[key] } }))
      }
    />
  );
  return {
    pins,
    togglePinned,
    bookmarks,
    toggleBookmarked,
    releaseChatOrder,
    groups,
    dialogs,
    notices,
    attentionState,
    selection,
    foldsState,
    collapsedProjects,
    collapsedSections,
    foldable,
  };
}
