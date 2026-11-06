import type { RefObject } from "react";
import { agentName, type Entry, type Thread } from "@/lib/api";
import { ATTACHMENT_LIMITS, attachmentFromFile, fitAttachments } from "@/lib/attachments";
import { errorText } from "@/lib/error-text.mjs";
import type { FollowUp } from "@/lib/follow-ups";
import { replyAttachment, withoutReplyAttachments } from "@/lib/message-reply";
import type { ReplyImage } from "@/components/image-reply";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  composer: ReturnType<typeof useComposerState>; attachmentsState: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>; runtime: ReturnType<typeof useRuntimeState>;
  selectedRef: RefObject<Thread | null>; newDraftKey: RefObject<string>; readOnlyRun: boolean; focusComposer: () => void; editDraft: (value: string) => void;
};

export function createReplyActions({ composer, attachmentsState, drafts, runtime, selectedRef, newDraftKey, readOnlyRun, focusComposer, editDraft }: Inputs) {
  const { textRef, pickedMentions, setShellMode } = composer;
  const { attachmentsRef, readingFiles, setAttaching, setFileNotice, setAttachments } = attachmentsState;
  const { savedAttachments, saveAttachments } = drafts;
  const { setRuntimeNotices } = runtime;
  function beginReply(entry: Entry, quote?: string) {
    if (!selectedRef.current || readOnlyRun || readingFiles.current) return;
    const attachment = replyAttachment(entry, entry.item.type === "userMessage" ? "You" : agentName(selectedRef.current) || "Elpis", quote);
    const fit = fitAttachments(withoutReplyAttachments(attachmentsRef.current), [attachment]);
    if (fit.problems.length) { setFileNotice(fit.problems.join("\n")); return; }
    setShellMode(false); setAttachments(fit.kept); saveAttachments(selectedRef.current.id, fit.kept); setFileNotice(""); focusComposer();
  }

  async function beginImageReply(entry: Entry, image: ReplyImage) {
    const owner = selectedRef.current?.id;
    if (!owner || readOnlyRun || readingFiles.current) return;
    const speaker = entry.item.type === "userMessage" ? "You" : agentName(selectedRef.current) || "Elpis";
    readingFiles.current = true; setAttaching(true); setFileNotice("");
    try {
      const response = await fetch(image.src, { credentials: "same-origin", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error("This image could not be attached. Try again after it loads.");
      const blob = await response.blob();
      const file = await attachmentFromFile(new File([blob], image.name, { type: blob.type }));
      if (file.type !== "image") throw Error("This picture could not be read as an image.");
      const attachment = replyAttachment(entry, speaker, undefined, image.name.slice(0, 500));
      file.id = `reply-image-${attachment.id}`;
      const fit = fitAttachments(withoutReplyAttachments(savedAttachments(owner)), [attachment, file]);
      if (fit.problems.length) throw Error(fit.problems.join("\n"));
      saveAttachments(owner, fit.kept);
      if (selectedRef.current?.id === owner) { setShellMode(false); setAttachments(fit.kept); focusComposer(); }
    } catch (cause) {
      const message = errorText(cause);
      if (selectedRef.current?.id === owner) setFileNotice(message);
      else setRuntimeNotices(previous => ({ ...previous, [owner]: message }));
    } finally { readingFiles.current = false; setAttaching(false); }
  }

  /** A queued message's Edit in composer, as in Claude: it returns to the box above whatever is typed, with its files and @-mentions. */
  function editQueued(item: FollowUp) {
    editDraft([item.text, textRef.current].filter(part => part.trim()).join("\n\n"));
    for (const mention of item.mentions ?? []) pickedMentions.current.set(mention.path, mention);
    if (item.attachments.length) {
      const all = [...attachmentsRef.current, ...item.attachments], kept = all.slice(0, ATTACHMENT_LIMITS.count);
      setAttachments(kept); saveAttachments(selectedRef.current?.id || newDraftKey.current, kept);
      if (kept.length < all.length) setFileNotice(`A message holds up to ${ATTACHMENT_LIMITS.count} files; the extra files of the queued message were left out.`);
    }
    focusComposer();
  }
  return { beginReply, beginImageReply, editQueued };
}
