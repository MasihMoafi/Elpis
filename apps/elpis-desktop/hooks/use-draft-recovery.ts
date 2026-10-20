/** Owns saved composer text and attachments for chats and empty tabs. */
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { readDraft, writeDraft } from "@/lib/drafts";
import { readAttachmentDraft, writeAttachmentDraft, type Attachment } from "@/lib/attachments";
import type { Thread } from "@/lib/api";

export function useDraftRecovery(selectedRef: { current: Thread | null }, setText: (value: string) => void,
  setAttachments: (value: Attachment[]) => void, setFileNotice: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<string>>) {
  const drafts = useRef<Record<string, string>>({});
  const attachmentDrafts = useRef<Record<string, Attachment[]>>({});
  const newDraftKey = useRef("new");
  const savedDraft = useCallback((id: string) => drafts.current[id] ?? readDraft(id), []);
  const saveDraft = useCallback((id: string, value: string) => {
    drafts.current[id] = value;
    if (!writeDraft(id, value)) setError("Draft recovery is unavailable. Your text is kept in this window; copy it before reloading.");
  }, []);
  const editDraft = (value: string) => { setText(value); saveDraft(selectedRef.current?.id || newDraftKey.current, value); };
  const savedAttachments = useCallback((id: string) => attachmentDrafts.current[id] ?? (attachmentDrafts.current[id] = readAttachmentDraft(id)), []);
  const saveAttachments = useCallback((id: string, value: Attachment[]) => {
    attachmentDrafts.current[id] = value;
    if (!writeAttachmentDraft(id, value)) setError("Attachment recovery is unavailable. Your files are kept in this window; save them before reloading.");
  }, []);
  const restoreAttachments = useCallback((id: string) => {
    try { setAttachments(savedAttachments(id)); savedAttachments(`recovery-${id}`); }
    catch { setAttachments([]); setError("Saved attachments could not be restored. Add the files again before sending."); }
    setFileNotice("");
  }, [savedAttachments, setAttachments]);
  return { drafts, attachmentDrafts, newDraftKey, savedDraft, saveDraft, editDraft, savedAttachments,
    saveAttachments, restoreAttachments };
}
