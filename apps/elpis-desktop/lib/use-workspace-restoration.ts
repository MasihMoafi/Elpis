import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { activeTab } from "@/lib/chat-tabs";
import { readProjectChats, readProjects } from "@/lib/projects";
import { errorText } from "@/lib/error-text.mts";
import type { useProjectState } from "@/lib/use-project-state";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useChatTabs } from "@/lib/use-chat-tabs";

type Inputs = {
  projects: ReturnType<typeof useProjectState>; composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  newDraftKey: RefObject<string>; restoreTabs: ReturnType<typeof useChatTabs>["restoreTabs"];
  setError: Dispatch<SetStateAction<string>>;
};

export function useWorkspaceRestoration({ projects, composer, attachments, drafts, newDraftKey, restoreTabs, setError }: Inputs) {
  const { setText } = composer, { savedDraft } = drafts, { restoreAttachments } = attachments;
  const { setProjects, setWorkflowProjectId, projectChatsRef, setProjectChats } = projects;
  useEffect(() => { setText(savedDraft(newDraftKey.current)); }, [savedDraft]);
  useEffect(() => {
    try { const stored = readProjects(); newDraftKey.current = "new"; setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setProjects(stored.projects); setWorkflowProjectId(stored.selectedId); const memberships = readProjectChats(); projectChatsRef.current = memberships; setProjectChats(memberships); }
    catch (e) { setError(errorText(e, "Could not restore workspace preferences.")); }
    const restored = restoreTabs(), shown = restored && activeTab(restored);
    if (shown && !shown.threadId && shown.draftKey) { newDraftKey.current = shown.draftKey; setText(savedDraft(shown.draftKey)); restoreAttachments(shown.draftKey); }
  }, []);
  useEffect(() => window.elpisDesktop?.storage?.onError(setError), []);
}
