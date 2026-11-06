import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { api, type ProviderChoice, type Thread } from "@/lib/api";
import type { ChatTabs } from "@/lib/chat-tabs";
import { errorText } from "@/lib/error-text.mts";
import { newChatFolder } from "@/lib/preferences";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useConversationOptions } from "@/lib/use-conversation-options";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  composer: ReturnType<typeof useComposerState>; attachments: ReturnType<typeof useComposerAttachments>; conversations: ReturnType<typeof useConversationList>;
  drafts: ReturnType<typeof useDraftStore>; projectState: ReturnType<typeof useProjectState>; runtime: ReturnType<typeof useRuntimeState>;
  session: ReturnType<typeof useConversationSession>; options: ReturnType<typeof useConversationOptions>; newDraftKey: RefObject<string>; tabsRef: RefObject<ChatTabs>;
  setError: Dispatch<SetStateAction<string>>; newChoice: ProviderChoice | undefined;
  noteStartedMode: (id: string, mode: PermissionMode | null | undefined) => void;
  assignProject: (ids: string | string[], destination: string | null | undefined) => Promise<void>;
  browser: { adoptSession: (from: string, to: string) => Promise<void> }; focusComposer: () => void;
};

export function createShellSend({ composer, attachments, conversations, drafts, projectState, runtime, session, options, newDraftKey, tabsRef, setError, newChoice, noteStartedMode, assignProject, browser, focusComposer }: Inputs) {
  const { selectedRef, request, busy, setBusy } = session;
  const { newMode, model } = options;
  const { textRef, shellCreated, setText } = composer;
  const { attachmentsRef, setFileNotice } = attachments;
  const { upsertThread, select } = conversations;
  const { savedDraft, saveDraft } = drafts;
  const { projectChanging, cwd, projectId } = projectState;
  const { ready, connected } = runtime;
  async function sendShell() {
    const command = textRef.current, originalRequest = request.current;
    if (!command.trim() || busy || !ready || !connected || projectChanging) return;
    if (attachmentsRef.current.length) { setFileNotice("Bash mode is on. Return to chat to send attachments."); return; }
    setBusy(true); setError("");
    let thread = selectedRef.current;
    const originalId = thread?.id || newDraftKey.current, browserDraft = `draft:${tabsRef.current.activeId}`;
    try {
      if (!thread) {
        const result = await api<{ thread: Thread; permissions?: PermissionMode | null }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}) });
        thread = result.thread; upsertThread(thread); noteStartedMode(thread.id, result.permissions ?? newMode);
        if (projectId) await assignProject(thread.id, projectId);
        await browser.adoptSession(browserDraft, thread.id);
        if (request.current === originalRequest) { saveDraft(originalId, ""); saveDraft(thread.id, command); shellCreated.current = thread.id; select(thread); }
      }
      await api(`/threads/${encodeURIComponent(thread.id)}/shell`, { command });
      if (savedDraft(thread.id) === command) saveDraft(thread.id, "");
      if (selectedRef.current?.id === thread.id && textRef.current === command && request.current === originalRequest) setText("");
    } catch (e) { if (request.current === originalRequest) setError(errorText(e)); }
    finally { setBusy(false); if (request.current === originalRequest) focusComposer(); }
  }
  return sendShell;
}
