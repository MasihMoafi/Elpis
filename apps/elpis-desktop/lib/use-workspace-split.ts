import type { AgentPanelState } from "@/lib/use-chat-team";
import { useLayoutEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useSessionSplit } from "@/components/session-split";
import type { Thread } from "@/lib/api";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { useWorkspacePanels } from "@/lib/use-workspace-panels";
import type { useChildConversations } from "@/lib/use-child-conversations";
import type { useOpenConversation } from "@/lib/use-open-conversation";

type Inputs = {
  session: ReturnType<typeof useConversationSession>;
  composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>;
  drafts: ReturnType<typeof useDraftStore>;
  runtime: ReturnType<typeof useRuntimeState>;
  pages: ReturnType<typeof useWorkspacePagesState>;
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  children: ReturnType<typeof useChildConversations>;
  desktop: boolean;
  newDraftKey: RefObject<string>;
  newChat: () => void;
  editDraft: (value: string) => void;
  loadThread: ReturnType<typeof useOpenConversation>["loadThread"];
  setAgentsPanelState: Dispatch<SetStateAction<AgentPanelState>>;
};

export function useWorkspaceSplit({
  session,
  composer,
  attachments: attachmentState,
  drafts,
  runtime,
  pages,
  workspacePanels,
  children,
  desktop,
  newDraftKey,
  newChat,
  editDraft,
  loadThread,
  setAgentsPanelState,
}: Inputs) {
  const { selected } = session,
    { text, composerRef } = composer,
    { attachments, setAttachments } = attachmentState;
  const { saveAttachments } = drafts,
    { ready, connected } = runtime,
    { view, setView } = pages;
  const { side, panelShown } = workspacePanels,
    { holdAgentPanel } = children;
  const split = useSessionSplit(
    { thread: selected, text, attachments },
    () => composerRef.current?.focus(),
    remaining => {
      const restore = () => {
        editDraft(remaining.text);
        setAttachments(remaining.attachments);
        saveAttachments(remaining.thread?.id || newDraftKey.current, remaining.attachments);
      };
      if (remaining.thread) void loadThread(remaining.thread).then(restore);
      else {
        newChat();
        restore();
      }
    },
  );
  // A disconnected chat must remain editable even if the team could not be read.
  useLayoutEffect(() => {
    if (
      view !== "chat" ||
      !selected ||
      (ready && connected) ||
      panelShown ||
      split.thread ||
      (!desktop && window.elpisDesktop) ||
      document.querySelector(".startup-splash:not(.leaving)") ||
      !window.matchMedia("(min-width: 1101px)").matches
    )
      return;
    holdAgentPanel(selected);
  }, [view, selected, ready, connected, desktop, panelShown, split.thread, holdAgentPanel]);
  const openSplit = (thread: Thread) => {
    side.closePanel();
    setAgentsPanelState(previous => ({ ...previous, open: false }));
    setView("chat");
    split.open(thread);
  };
  return { split, openSplit };
}
