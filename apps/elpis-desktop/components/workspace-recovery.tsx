import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/markdown-text";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";

type Props = {
  session: ReturnType<typeof useConversationSession>;
  composer: ReturnType<typeof useComposerState>;
  attachmentsState: ReturnType<typeof useComposerAttachments>;
  drafts: ReturnType<typeof useDraftStore>;
  editDraft: (value: string) => void;
};

export function WorkspaceRecovery({ session, composer, attachmentsState, drafts, editDraft }: Props) {
  const { selected } = session,
    { text } = composer,
    { attachments, setAttachments } = attachmentsState;
  const { savedDraft, saveDraft, saveAttachments } = drafts;
  const recoveredEdit = selected ? savedDraft(`recovery-${selected.id}`) : "";
  const recoveryAttachments = selected ? (drafts.heldAttachments(`recovery-${selected.id}`) ?? []) : [];
  return (
    selected &&
    (recoveredEdit || recoveryAttachments.length > 0) && (
      <div className="error-banner">
        <details className="min-w-0 w-full">
          <DisclosureSummary>Recover unsent message</DisclosureSummary>
          <pre className="whitespace-pre-wrap break-words py-2" dir="auto">
            {recoveredEdit}
          </pre>
          {recoveryAttachments.length > 0 && <p>Files: {recoveryAttachments.map(part => part.name).join(", ")}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {recoveredEdit && <CopyButton label="Copy unsent message" text={() => recoveredEdit} />}
            <Button
              variant="outline"
              size="sm"
              disabled={!!text.trim() || attachments.length > 0}
              title={
                text.trim() || attachments.length
                  ? "Keep or clear your current draft before restoring this message."
                  : undefined
              }
              onClick={() => {
                saveDraft(`recovery-${selected.id}`, "");
                saveAttachments(`recovery-${selected.id}`, []);
                editDraft(recoveredEdit);
                setAttachments(recoveryAttachments);
                saveAttachments(selected.id, recoveryAttachments);
              }}
            >
              Use in composer
            </Button>
            {(!!text.trim() || attachments.length > 0) && (
              <span>Your current draft is kept. Save it, or clear it to restore the unsent message.</span>
            )}
          </div>
        </details>
      </div>
    )
  );
}
