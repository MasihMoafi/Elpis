"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Attachment } from "@/lib/attachments";

type Review = { path: string; quote: string; instruction: string };
export type ReviewAction = "mark" | "edit" | "remove";
const ReviewContext = createContext<((path: string, action: ReviewAction, quote?: string) => void) | null>(null);
export const useDocumentReview = () => useContext(ReviewContext);

/** File cards and document viewers share one editable feedback draft and the normal composer attachments. */
export function DocumentReviewProvider({ onAttach, children }: { onAttach: (parts: Attachment[]) => Promise<boolean>; children: ReactNode }) {
  const [draft, setDraft] = useState<Review | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const open = (path: string, action: ReviewAction, quote = "") => {
    setError(""); setDraft({ path, quote: quote.slice(0, 24000), instruction: action === "remove" ? quote ? "Remove this passage from the document." : "Remove this file." : action === "edit" ? "Update this document as follows:" : "Review this document and the marked passage." });
  };
  async function attach() {
    if (!draft || pending) return;
    setPending(true); setError("");
    try {
      const ok = await onAttach([{ id: crypto.randomUUID(), name: `Feedback on ${draft.path.split("/").pop()}`, type: "text", mimeType: "text/plain", text: `Document feedback\nFile: ${draft.path}\n\n${draft.quote ? `Selected passage:\n${draft.quote}\n\n` : ""}Instructions:\n${draft.instruction}` }]);
      if (ok) setDraft(null); else setError("The feedback could not be added. Your notes are kept here.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add feedback."); }
    finally { setPending(false); }
  }
  return <ReviewContext.Provider value={open}>{children}<AlertDialog open={!!draft} onOpenChange={value => { if (!value && !pending) setDraft(null); }}>
    <AlertDialogContent><AlertDialogTitle>Document feedback</AlertDialogTitle><AlertDialogDescription className="break-all">{draft?.path}. Add your notes to the message, then send when ready.</AlertDialogDescription>
      <label className="field">Selected passage<Textarea aria-label="Selected passage" rows={3} maxLength={24000} value={draft?.quote ?? ""} onChange={event => setDraft(value => value ? { ...value, quote: event.target.value } : value)} /></label>
      <label className="field">Instructions for the agent<Textarea aria-label="Instructions for the agent" rows={4} maxLength={8000} value={draft?.instruction ?? ""} onChange={event => setDraft(value => value ? { ...value, instruction: event.target.value } : value)} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>Cancel</Button><Button disabled={pending || !draft?.instruction.trim()} onClick={() => void attach()}>{pending ? "Adding…" : "Add to message"}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog></ReviewContext.Provider>;
}
