import type { RefObject } from "react";
import { fitAttachments, type Attachment } from "@/lib/attachments";
import { errorText } from "@/lib/error-text.mjs";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";

type Inputs = {
  session: ReturnType<typeof useConversationSession>; composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  newDraftKey: RefObject<string>; showChat: () => void; send: () => Promise<unknown>;
};

/** The browser's annotations and screenshots join the composer's files; its Send also sends the message. */
export function createBrowserAttachment({ session, composer, attachments, drafts, newDraftKey, showChat, send }: Inputs) {
  const { selectedRef } = session, { composerRef } = composer, { setAttachments, setFileNotice } = attachments;
  const { savedAttachments, saveAttachments } = drafts;
  return async function attachFromBrowser(parts: Attachment[], submit: boolean) {
    const owner = selectedRef.current?.id || newDraftKey.current;
    try {
      const fit = fitAttachments(savedAttachments(owner), parts);
      if (fit.problems.length) throw Error(fit.problems.join("\n"));
      saveAttachments(owner, fit.kept); setAttachments(fit.kept); setFileNotice("");
    } catch (cause) { setFileNotice(errorText(cause)); showChat(); return false; }
    showChat();
    if (submit) await send(); else requestAnimationFrame(() => composerRef.current?.focus());
    return true;
  };
}
