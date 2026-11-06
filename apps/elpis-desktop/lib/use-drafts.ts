"use client";
// What he has typed but not sent: message drafts and attachments per chat (kept across reloads), answers to an agent's
// questions, and the requests on their way, so one cannot be sent twice.
import { useCallback, useRef, useState } from "react";
import type { QuestionAnswers } from "@/components/approval-card";
import type { Approval } from "./api";
import { readAttachmentDraft, writeAttachmentDraft, type Attachment } from "./attachments";
import { readDraft, writeDraft } from "./drafts";
import { without } from "./utils";

/** Message text and attachments per chat (or new-chat key), read once from the store and written through. */
export function useDraftStore(onError: (message: string) => void) {
  const drafts = useRef<Record<string, string>>({});
  const attachmentDrafts = useRef<Record<string, Attachment[]>>({});
  const savedDraft = useCallback((id: string) => drafts.current[id] ?? readDraft(id), []);
  const saveDraft = useCallback((id: string, value: string) => {
    drafts.current[id] = value;
    if (!writeDraft(id, value)) onError("Draft recovery is unavailable. Your text is kept in this window; copy it before reloading.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const savedAttachments = useCallback((id: string) => attachmentDrafts.current[id] ?? (attachmentDrafts.current[id] = readAttachmentDraft(id)), []);
  const saveAttachments = useCallback((id: string, value: Attachment[]) => {
    attachmentDrafts.current[id] = value;
    if (!writeAttachmentDraft(id, value)) onError("Attachment recovery is unavailable. Your files are kept in this window; save them before reloading.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Attachments already read for a key, without reading the store. */
  const heldAttachments = (id: string) => attachmentDrafts.current[id];
  /** A deleted chat's drafts, its own and its recovery copy. */
  const forget = useCallback((ids: Iterable<string>) => {
    for (const id of ids) for (const key of [id, `recovery-${id}`]) { delete drafts.current[key]; writeDraft(key, ""); delete attachmentDrafts.current[key]; writeAttachmentDraft(key, []); }
  }, []);
  return { savedDraft, saveDraft, savedAttachments, saveAttachments, heldAttachments, forget };
}

/** Each request key goes out once at a time; `pending[key]` is true while it does. */
export function useSubmitOnce() {
  const submitting = useRef(new Set<string>());
  const [pending, setPending] = useState<Record<string, boolean>>({});
  async function submit<T,>(key: string, send: () => Promise<T>): Promise<T> {
    if (submitting.current.has(key)) throw new Error("This request is already being sent.");
    submitting.current.add(key); setPending(previous => ({ ...previous, [key]: true }));
    try { return await send(); }
    finally { submitting.current.delete(key); setPending(previous => without(previous, key)); }
  }
  return { pending, submit };
}

/** One approval card's identity: the same request id can come from two chats. */
export const approvalDraftKey = (approval: Approval) => JSON.stringify([approval.ownerThreadId, approval.id]);

/** The answers picked on each approval card before it is sent. */
export function useApprovalDrafts() {
  const [drafts, setDrafts] = useState<Record<string, { id: string; answers: QuestionAnswers }>>({});
  const answersFor = (approval: Approval) => drafts[approvalDraftKey(approval)]?.answers ?? {};
  const draftAnswer = (approval: Approval, id: string, value: string[]) => {
    const key = approvalDraftKey(approval);
    setDrafts(previous => ({ ...previous, [key]: { id: approval.id, answers: { ...previous[key]?.answers, [id]: value } } }));
  };
  /** A request answered or withdrawn: its drafts go, in every chat. */
  const clearApprovalDraft = useCallback((id: string) => setDrafts(previous => {
    const keys = Object.keys(previous).filter(key => previous[key]?.id === id);
    if (!keys.length) return previous;
    const next = { ...previous }; for (const key of keys) delete next[key]; return next;
  }), []);
  return { answersFor, draftAnswer, clearApprovalDraft };
}
