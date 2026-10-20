/** Owns approval requests, answers in progress, and their draft responses. */
import { useCallback, useRef, useState } from "react";
import type { QuestionAnswers } from "@/components/approval-card";
import type { Approval } from "@/lib/api";
import { without } from "@/lib/without";

export const approvalDraftKey = (approval: Approval) => JSON.stringify([approval.ownerThreadId, approval.id]);

export function useApprovals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, { id: string; answers: QuestionAnswers }>>({});
  const submitting = useRef(new Set<string>());
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, boolean>>({});
  async function submitDraft<T,>(key: string, send: () => Promise<T>): Promise<T> {
    if (submitting.current.has(key)) throw new Error("This request is already being sent.");
    submitting.current.add(key); setPendingDrafts(previous => ({ ...previous, [key]: true }));
    try { return await send(); }
    finally { submitting.current.delete(key); setPendingDrafts(previous => without(previous, key)); }
  }
  const clearApprovalDraft = useCallback((id: string) => setApprovalDrafts(previous => {
    const keys = Object.keys(previous).filter(key => previous[key].id === id);
    if (!keys.length) return previous;
    const next = { ...previous }; for (const key of keys) delete next[key]; return next;
  }), []);
  const draftAnswer = (approval: Approval, id: string, value: string[]) => {
    const key = approvalDraftKey(approval);
    setApprovalDrafts(previous => ({ ...previous, [key]: { id: approval.id, answers: { ...previous[key]?.answers, [id]: value } } }));
  };
  return { approvals, setApprovals, approvalDrafts, pendingDrafts, submitDraft, clearApprovalDraft, draftAnswer };
}
