import type { RefObject } from "react";
import { api, type Approval } from "@/lib/api";
import { approvalDraftKey, type useApprovalDrafts, type useSubmitOnce } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  approvals: ReturnType<typeof useApprovalDrafts>;
  submissions: ReturnType<typeof useSubmitOnce>;
  runtime: ReturnType<typeof useRuntimeState>;
  request: RefObject<number>;
  restoreComposerFocus: (origin: Element | null) => void;
};

export function createApprovalActions({ approvals, submissions, runtime, request, restoreComposerFocus }: Inputs) {
  const { answersFor, draftAnswer, clearApprovalDraft } = approvals;
  const { pending: pendingDrafts, submit: submitDraft } = submissions;
  const { setApprovals } = runtime;
  /** Answers a request; `instead` is "Deny, and tell Elpis what to do instead" (body: { text }). */
  /** An approval card's answers, sending and drafts: the same wherever the card is shown. */
  const approvalCardProps = (approval: Approval) => {
    const key = approvalDraftKey(approval);
    return {
      approval,
      answer: (id: string, body: unknown) => answer(id, body, key),
      deny: (id: string, text: string) => answer(id, { text }, key, true),
      busy: !!pendingDrafts[key],
      answers: answersFor(approval),
      onAnswerChange: (id: string, value: string[]) => draftAnswer(approval, id, value),
    };
  };
  async function answer(id: string, body: unknown, key: string, instead = false) {
    const originalFocus = document.activeElement,
      originalRequest = request.current;
    await submitDraft(key, () => api(`/approvals/${encodeURIComponent(id)}${instead ? "/instead" : ""}`, body));
    setApprovals(prev => prev.filter(a => a.id !== id));
    clearApprovalDraft(id);
    if (request.current === originalRequest) restoreComposerFocus(originalFocus);
  }
  return { approvalCardProps };
}
