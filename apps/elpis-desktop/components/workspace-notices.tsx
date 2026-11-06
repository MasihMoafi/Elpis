"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plainMessage } from "@/lib/use-workspace-notices";

/** One quiet line: the text and its close button. Every notice under the chat is this shape (globals.css .error-banner). */
function Notice({ tone, role = "status", label, onDismiss, className = "", children }: { tone: "notice" | "quiet"; role?: "status" | "alert"; label: string; onDismiss: () => void; className?: string; children: ReactNode }) {
  return <div className={`error-banner ${tone} ${className}`.trim()} role={role}><span className="min-w-0 flex-1">{children}</span><Button variant="ghost" size="icon-sm" aria-label={label} onClick={onDismiss}><X size={14} /></Button></div>;
}

/** The notices under the chat, in their fixed order (a newer alert waits until the one before it is dismissed). `rewind` and
 * `recovery` are the page's own controls, placed where they belong in that order. */
export function WorkspaceNotices({ connection, deleted, onUndoDelete, onDismissDeleted, rewind, error, onDismissError, worktree, onDismissWorktree, loadingModels, conversationError, onDismissConversationError, recovery }: {
  connection?: string; deleted: string | null; onUndoDelete: () => void; onDismissDeleted: () => void; rewind?: ReactNode;
  error?: string; onDismissError: () => void; worktree: string; onDismissWorktree: () => void; loadingModels: boolean;
  conversationError?: string; onDismissConversationError: () => void; recovery?: ReactNode;
}) {
  return <div className="workspace-notices">
    {connection && <div className="error-banner notice" role="status"><span>{connection}</span></div>}
    {deleted && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1 truncate">{deleted}</span><Button variant="outline" size="sm" title="Undo (Ctrl+Z)" onClick={onUndoDelete}>Undo</Button><Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismissDeleted}><X size={15} /></Button></div>}
    {rewind}
    {/* A quiet line, not a red band, and it fades on its own (6 Nov, Masih: "even if there is an error I like it shown gracefully"). */}
    {error && <Notice key={error} tone="quiet" role="alert" label="Dismiss error" onDismiss={onDismissError}>{plainMessage(error)}</Notice>}
    {worktree && <Notice tone="quiet" className="worktree-notice" label="Dismiss worktree notice" onDismiss={onDismissWorktree}>{worktree}</Notice>}
    {/* A failed model-list refresh shows no banner (4 Nov): the last list stays and lib/model-catalog.ts retries quietly. Only
        the first load shows this line; account events refresh the list during turns and a line per refresh shook the chat. */}
    {loadingModels && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">Loading models…</p>}
    {conversationError && <Notice tone="quiet" role="alert" label="Dismiss conversation error" onDismiss={onDismissConversationError}>{plainMessage(conversationError)}</Notice>}
    {recovery}
  </div>;
}
