import { Button } from "@/components/ui/button";
import { WorkspaceNotices } from "@/components/workspace-notices";
import { WorkspaceRecovery } from "@/components/workspace-recovery";
import { without } from "@/lib/utils";
import { refusedOffline } from "@/lib/workspace-types";
import type { useWorkspaceNotices } from "@/lib/use-workspace-notices";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useRewindState } from "@/lib/use-rewind-state";
import type { useModelCatalog } from "@/lib/model-catalog";
import type { createMessageActions } from "@/lib/message-actions";

type Props = {
  notices: ReturnType<typeof useWorkspaceNotices>; session: ReturnType<typeof useConversationSession>;
  runtime: ReturnType<typeof useRuntimeState>; composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  rewind: ReturnType<typeof useRewindState>; catalog: ReturnType<typeof useModelCatalog>;
  activeTurn: string | undefined; undoDelete: () => Promise<unknown>;
  switchRewind: ReturnType<typeof createMessageActions>["switchRewind"]; editDraft: (value: string) => void;
};

export function WorkspaceAlertArea({ notices, session, runtime, composer, attachments, drafts, rewind, catalog, activeTurn, undoDelete, switchRewind, editDraft }: Props) {
  const { error, setError, deletedNotice, setDeletedNotice, worktreeNotice, setWorktreeNotice } = notices;
  const { selected } = session, { connected, ready, connectionStatus, runtimeNotices, setRuntimeNotices } = runtime;
  const { rewindActions, rewindBusy } = rewind, { models, loading: catalogLoading, error: catalogError } = catalog;
  const connection = !ready || !connected ? connectionStatus : undefined;
  const visibleError = error && !(refusedOffline(error) && !connected) ? error : undefined;
  const conversationError = selected ? runtimeNotices[selected.id] : undefined;
  return <WorkspaceNotices {...(connection !== undefined ? { connection } : {})} deleted={deletedNotice} onUndoDelete={() => void undoDelete()} onDismissDeleted={() => setDeletedNotice(null)}
    rewind={selected && rewindActions[selected.id] && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1">Your files stay as they are.</span><Button variant="outline" size="sm" disabled={rewindBusy || !!activeTurn} onClick={() => void switchRewind({ action: rewindActions[selected.id]! }).catch(cause => setError(String(cause)))}>{rewindActions[selected.id] === "undo" ? "Undo rewind" : "Redo rewind"}</Button></div>}
    {...(visibleError !== undefined ? { error: visibleError } : {})} onDismissError={() => setError("")}
    worktree={worktreeNotice} onDismissWorktree={() => setWorktreeNotice("")} loadingModels={catalogLoading && !catalogError && !models.length}
    {...(conversationError !== undefined ? { conversationError } : {})} onDismissConversationError={() => selected && setRuntimeNotices(prev => without(prev, selected.id))}
    recovery={<WorkspaceRecovery session={session} composer={composer} attachmentsState={attachments} drafts={drafts} editDraft={editDraft} />} />;
}
