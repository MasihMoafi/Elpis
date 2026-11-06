import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { agentName, api, type Thread } from "@/lib/api";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { createConversationSettings } from "@/lib/conversation-settings";
import { errorText } from "@/lib/error-text.mjs";
import { savedPersona } from "@/lib/matilda";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useOpenConversation } from "@/lib/use-open-conversation";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  composer: ReturnType<typeof useComposerState>; conversations: ReturnType<typeof useConversationList>;
  projectState: ReturnType<typeof useProjectState>; runtime: ReturnType<typeof useRuntimeState>; loveActivity: ReturnType<typeof useLoveActivity>;
  selectedRef: RefObject<Thread | null>; request: RefObject<number>; setError: Dispatch<SetStateAction<string>>;
  threadModes: Record<string, PermissionMode>; permissionMode: PermissionMode;
  openNewChat: ReturnType<typeof createChatNavigation>["openNewChat"]; loadThread: ReturnType<typeof useOpenConversation>["loadThread"];
  noteStartedMode: ReturnType<typeof createConversationSettings>["noteStartedMode"];
};

export function createClearConversation({ composer, conversations, projectState, runtime, loveActivity, selectedRef, request, setError, threadModes, permissionMode, openNewChat, loadThread, noteStartedMode }: Inputs) {
  const { composerRef } = composer;
  const { settingsOf, upsertThread } = conversations;
  const { setProjectId, projectChatsRef, projectId, setCwd, cwd } = projectState;
  const { activeTurns } = runtime;
  return async () => {
    const previous = selectedRef.current;
    if (previous && loveActivity.isLoveChat(previous) && agentName(previous) === "Matilda") {
      if (activeTurns[previous.id]) { setError("Love Spot is already replying. Wait for this turn."); return; }
      const originalRequest = request.current;
      const settings = { ...previous, ...settingsOf.current[previous.id] };
      try {
        const result = await api<{ thread: Thread; permissions?: PermissionMode | null }>("/love-spot/talk/new", {
          threadId: previous.id,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.modelProvider ? { provider: settings.modelProvider } : {}),
          ...(previous.cwd ? { cwd: previous.cwd } : {}),
          permissions: threadModes[previous.id] ?? permissionMode,
          persona: savedPersona(),
        });
        if (!result.thread || typeof result.thread.id !== "string") throw new Error("Matilda could not start a fresh chat.");
        upsertThread(result.thread);
        noteStartedMode(result.thread.id, result.permissions ?? threadModes[previous.id] ?? permissionMode);
        setProjectId(projectChatsRef.current[previous.id] ?? projectId);
        setCwd(result.thread.cwd ?? previous.cwd ?? cwd);
        if (request.current === originalRequest) {
          await loadThread(result.thread);
          requestAnimationFrame(() => composerRef.current?.focus());
        }
      } catch (cause) { setError(errorText(cause)); }
      return;
    }
    if (previous) { setCwd(previous.cwd || cwd); setProjectId(projectChatsRef.current[previous.id] ?? projectId); }
    openNewChat(`clear-${crypto.randomUUID()}`);
  };
}
