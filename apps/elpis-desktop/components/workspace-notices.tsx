"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plainMessage } from "@/lib/use-workspace-notices";

/** One quiet line: the text and its close button. Every notice under the chat is this shape (globals.css .error-banner). */
function Notice({
  tone,
  role = "status",
  label,
  onDismiss,
  className = "",
  children,
}: {
  tone: "notice" | "quiet";
  role?: "status" | "alert";
  label: string;
  onDismiss: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`error-banner ${tone} ${className}`.trim()} role={role}>
      <span className="min-w-0 flex-1">{children}</span>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onDismiss}>
        <X size={14} />
      </Button>
    </div>
  );
}

/** Notices after the transcript, in their fixed order (a newer alert waits until the one before it is dismissed). `rewind` and
 * `recovery` are the page's own controls, placed where they belong in that order. */
export function WorkspaceNotices({
  connection,
  rewind,
  error,
  onDismissError,
  loadingModels,
  conversationError,
  onDismissConversationError,
  recovery,
}: {
  connection?: string;
  rewind?: ReactNode;
  error?: string;
  onDismissError: () => void;
  loadingModels: boolean;
  conversationError?: string;
  onDismissConversationError: () => void;
  recovery?: ReactNode;
}) {
  return (
    <div className="workspace-notices">
      {connection && (
        <div className="error-banner notice" role="status">
          <span>{connection}</span>
        </div>
      )}
      {rewind}
      {/* A quiet line, not a red band, and it fades on its own (6 Nov, Masih: "even if there is an error I like it shown gracefully"). */}
      {error && (
        <Notice key={error} tone="quiet" role="alert" label="Dismiss error" onDismiss={onDismissError}>
          {plainMessage(error)}
        </Notice>
      )}
      {/* A failed model-list refresh shows no banner (4 Nov): the last list stays and lib/model-catalog.ts retries quietly. Only
        the first load shows this line; account events refresh the list during turns and a line per refresh shook the chat. */}
      {loadingModels && (
        <p className="px-4 py-2 text-sm text-muted-foreground" role="status">
          Loading models…
        </p>
      )}
      {conversationError && (
        <Notice tone="quiet" role="alert" label="Dismiss conversation error" onDismiss={onDismissConversationError}>
          {plainMessage(conversationError)}
        </Notice>
      )}
      {recovery}
    </div>
  );
}

const GAP = 8,
  CORNER_WIDTH = 260;
type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const visible = (element: Element | null | undefined): element is HTMLElement =>
  !!element && element.getClientRects().length > 0 && getComputedStyle(element).display !== "none";

/** Where the chat-action notices go (Masih, 13 Nov: they sat "on top of the last message of any conversation"): at the foot of
 * the sidebar, above its footer, where the row he acted on was; with the sidebar closed, small in the window's bottom left
 * corner; where that corner would touch the message box or the transcript (a narrow window), in the title bar's free middle. */
function place(stack: HTMLElement) {
  const shell = stack.closest(".app-shell"),
    sidebar = shell?.querySelector<HTMLElement>(":scope > .sidebar"),
    // The height follows the width (a long name wraps), so the width is set before the height is read.
    set = (where: string, left: number, width: number, top: (height: number) => number) => {
      stack.dataset.place = where;
      Object.assign(stack.style, { left: `${left}px`, width: `${Math.max(0, width)}px` });
      stack.style.top = `${top(stack.offsetHeight)}px`;
    };
  if (visible(sidebar)) {
    const box = sidebar.getBoundingClientRect(),
      foot = sidebar.querySelector(".sidebar-footer")?.getBoundingClientRect().top ?? box.bottom;
    return set("sidebar", box.left + GAP, box.width - 2 * GAP, height => foot - GAP - height);
  }
  stack.style.width = `${CORNER_WIDTH}px`;
  const height = stack.offsetHeight,
    bottom = () => innerHeight - GAP - height;
  const corner = { left: GAP, right: GAP + CORNER_WIDTH, bottom: innerHeight - GAP, top: bottom() };
  const keepClear = [...(shell?.querySelectorAll(".composer, .chat-scroll") ?? [])].filter(visible);
  if (!keepClear.some(element => overlaps(corner, element.getBoundingClientRect())))
    return set("corner", corner.left, CORNER_WIDTH, bottom);
  const bar = shell?.querySelector<HTMLElement>(":scope > .title-bar");
  if (!visible(bar)) return set("corner", corner.left, CORNER_WIDTH, bottom);
  const barBox = bar.getBoundingClientRect(),
    children = [...bar.children].filter(visible),
    end = children.find(child => child.classList.contains("title-bar-actions"))?.getBoundingClientRect().left ?? barBox.right,
    start = Math.max(
      barBox.left,
      ...children.filter(child => !child.classList.contains("title-bar-actions")).map(child => child.getBoundingClientRect().right),
    );
  set("title", start + GAP, Math.min(CORNER_WIDTH, end - start - 2 * GAP), height => barBox.top + (barBox.height - height) / 2);
}

/** The notices about a chat action (deleted with its Undo, what Ctrl+Z or Ctrl+Shift+Z did, the worktrees a delete or archive
 * kept): one small stack beside the chat, never over its messages or the message box. They keep role="status", their
 * buttons stay in the tab order, and each keeps its time on screen (lib/use-workspace-notices.ts). */
export function ActionNotices({
  deleted,
  onUndoDelete,
  onDismissDeleted,
  history,
  onDismissHistory,
  worktree,
  onDismissWorktree,
}: {
  deleted: string | null;
  onUndoDelete: () => void;
  onDismissDeleted: () => void;
  /** What Ctrl+Z or Ctrl+Shift+Z just did to a chat ("Undone: renamed …"). */
  history: string;
  onDismissHistory: () => void;
  worktree: string;
  onDismissWorktree: () => void;
}) {
  const stack = useRef<HTMLDivElement>(null);
  const shown = !!(deleted || history || worktree);
  // The sidebar opens, closes and resizes through the shell's own renders, so every render places the stack again.
  useLayoutEffect(() => {
    if (shown && stack.current) place(stack.current);
  });
  useEffect(() => {
    if (!shown) return;
    const again = () => stack.current && place(stack.current);
    addEventListener("resize", again);
    return () => removeEventListener("resize", again);
  }, [shown]);
  if (!shown) return null;
  return (
    <div ref={stack} className="action-notices">
      {deleted && (
        <div className="error-banner notice" role="status">
          <span className="min-w-0 flex-1 truncate">{deleted}</span>
          <Button variant="outline" size="xs" title="Undo (Ctrl+Z)" onClick={onUndoDelete}>
            Undo
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismissDeleted}>
            <X size={14} />
          </Button>
        </div>
      )}
      {history && (
        <Notice key={history} tone="notice" label="Dismiss" onDismiss={onDismissHistory}>
          {history}
        </Notice>
      )}
      {worktree && (
        <Notice tone="notice" className="worktree-notice" label="Dismiss worktree notice" onDismiss={onDismissWorktree}>
          {worktree}
        </Notice>
      )}
    </div>
  );
}
