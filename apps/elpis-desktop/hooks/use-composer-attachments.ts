/** Owns file attachments from the composer and browser panel. */
import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, type Thread } from "@/lib/api";
import { attachFiles, fitAttachments, type Attachment } from "@/lib/attachments";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = {
  shellMode: boolean; setFileNotice: Setter<string>; selectedRef: Ref<Thread | null>;
  newDraftKey: Ref<string>; savedAttachments: (id: string) => Attachment[];
  saveAttachments: (id: string, files: Attachment[]) => void;
  setAttachments: (files: Attachment[]) => void;
  setRuntimeNotices: Setter<Record<string, string>>;
  showChat: () => void; send: () => Promise<void>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
};

export function useComposerAttachments({ shellMode, setFileNotice, selectedRef, newDraftKey,
  savedAttachments, saveAttachments, setAttachments, setRuntimeNotices, showChat, send, composerRef }: Props) {
  const [attaching, setAttaching] = useState(false);
  const readingFiles = useRef(false);
  async function addFiles(files: File[]) {
    if (!files.length) return;
    if (shellMode) { setFileNotice("Bash mode is on, so nothing was added. Press Backspace in the empty message box to return to chat, then try again."); return; }
    if (readingFiles.current) { setFileNotice("Wait for the current files to finish reading."); return; }
    const owner = selectedRef.current?.id || newDraftKey.current;
    readingFiles.current = true; setAttaching(true); setFileNotice("");
    try {
      const read = await attachFiles(savedAttachments(owner), files, body => api("/attachments/extract", body));
      const fit = fitAttachments(savedAttachments(owner), read.added); // the list may have changed while the files were read
      if (read.added.length) { saveAttachments(owner, fit.kept); if ((selectedRef.current?.id || newDraftKey.current) === owner) setAttachments(fit.kept); }
      if (read.problems.length || fit.problems.length) throw Error([...read.problems, ...fit.problems].join("\n"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if ((selectedRef.current?.id || newDraftKey.current) === owner) setFileNotice(message);
      else setRuntimeNotices(previous => ({ ...previous, [owner]: message }));
    } finally { readingFiles.current = false; setAttaching(false); }
  }
  /** The browser's annotations and screenshots join the composer's files; its Send also sends the message. */
  async function attachFromBrowser(parts: Attachment[], submit: boolean) {
    const owner = selectedRef.current?.id || newDraftKey.current;
    try {
      const fit = fitAttachments(savedAttachments(owner), parts);
      if (fit.problems.length) throw Error(fit.problems.join("\n"));
      saveAttachments(owner, fit.kept); setAttachments(fit.kept); setFileNotice("");
    } catch (cause) { setFileNotice(cause instanceof Error ? cause.message : String(cause)); showChat(); return false; }
    showChat();
    if (submit) await send(); else requestAnimationFrame(() => composerRef.current?.focus());
    return true;
  }
  return { attaching, addFiles, attachFromBrowser };
}
