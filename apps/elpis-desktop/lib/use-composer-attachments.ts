import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, type Thread } from "@/lib/api";
import { attachFiles, fitAttachments, type Attachment } from "@/lib/attachments";
import { errorText } from "@/lib/error-text.mts";

export function useComposerAttachments({
  selectedRef,
  newDraftKey,
  shellMode,
  savedAttachments,
  saveAttachments,
  setError,
  setRuntimeNotices,
}: {
  selectedRef: RefObject<Thread | null>;
  newDraftKey: RefObject<string>;
  shellMode: boolean;
  savedAttachments: (id: string) => Attachment[];
  saveAttachments: (id: string, value: Attachment[]) => void;
  setError: (message: string) => void;
  setRuntimeNotices: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const readingFiles = useRef(false);
  const [fileNotice, setFileNotice] = useState("");
  const setAttachments = useCallback((value: Attachment[]) => {
    attachmentsRef.current = value;
    setAttachmentsState(value);
  }, []);
  const restoreAttachments = useCallback(
    (id: string) => {
      try {
        setAttachments(savedAttachments(id));
        savedAttachments(`recovery-${id}`);
      } catch {
        setAttachments([]);
        setError("Saved attachments could not be restored. Add the files again before sending.");
      }
      setFileNotice("");
    },
    [savedAttachments, setAttachments, setError],
  );
  async function addFiles(files: File[]) {
    if (!files.length) return;
    if (shellMode) {
      setFileNotice(
        "Bash mode is on, so nothing was added. Press Backspace in the empty message box to return to chat, then try again.",
      );
      return;
    }
    if (readingFiles.current) {
      setFileNotice("Wait for the current files to finish reading.");
      return;
    }
    const owner = selectedRef.current?.id || newDraftKey.current;
    readingFiles.current = true;
    setAttaching(true);
    setFileNotice("");
    try {
      const read = await attachFiles(savedAttachments(owner), files, body => api("/attachments/extract", body));
      const fit = fitAttachments(savedAttachments(owner), read.added); // the list may have changed while the files were read
      if (read.added.length) {
        saveAttachments(owner, fit.kept);
        if ((selectedRef.current?.id || newDraftKey.current) === owner) setAttachments(fit.kept);
      }
      if (read.problems.length || fit.problems.length) throw Error([...read.problems, ...fit.problems].join("\n"));
    } catch (cause) {
      const message = errorText(cause);
      if ((selectedRef.current?.id || newDraftKey.current) === owner) setFileNotice(message);
      else setRuntimeNotices(previous => ({ ...previous, [owner]: message }));
    } finally {
      readingFiles.current = false;
      setAttaching(false);
    }
  }
  return {
    attachments,
    attachmentsRef,
    attaching,
    setAttaching,
    readingFiles,
    fileNotice,
    setFileNotice,
    setAttachments,
    restoreAttachments,
    addFiles,
  };
}
