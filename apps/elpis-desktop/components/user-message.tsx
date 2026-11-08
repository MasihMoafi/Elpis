"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  FileText,
  Pencil,
  Reply,
  Trash2,
  Undo2,
} from "lucide-react";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/markdown-text";
import { plainText } from "@/lib/message-copy";
import { InkRow } from "@/components/ink-row";
import { messageDomId } from "@/lib/message-reply";
import type { VersionControl } from "@/lib/turn-replacement";

/** What a person can do with a message: the hover buttons, the "…" and the right-click menu all draw this one list.
 * `menuLabel` is the item's words in the menus (the hover button keeps its short name); `menuOnly` items have no hover button. */
export type MessageAction = MenuAction & {
  title?: string;
  copy?: () => string;
  menuLabel?: string;
  menuOnly?: boolean;
};

export const write = (value: string) => void navigator.clipboard.writeText(value).catch(() => {});

/** "Copy as Markdown": the message as written; the hover button copies the same. */
export const copyAction = (label: string, text: () => string): MessageAction => ({
  id: "copy",
  label,
  menuLabel: "Copy as Markdown",
  icon: <Copy size={14} />,
  copy: text,
  run: () => write(text()),
});

/** "Copy text": the message as a reader sees it, without the Markdown marks. */
export const copyTextAction = (markdown: () => string, markup = true): MessageAction => ({
  id: "copy-text",
  label: "Copy text",
  icon: <FileText size={14} />,
  menuOnly: true,
  run: () => write(markup ? plainText(markdown()) : markdown()),
});

export const replyAction = (reply?: () => void): MessageAction[] =>
  reply ? [{ id: "reply", label: "Reply", icon: <Reply size={14} />, run: reply }] : [];

export const rewindAction = (rewind?: () => void): MessageAction[] =>
  rewind ? [{ id: "rewind", label: "Rewind to here", icon: <Undo2 size={14} />, menuOnly: true, run: rewind }] : [];

/** Delete: this exchange (the newest) or this exchange and those after it; Undo brings them back until the next send. */
export type DeleteControl = { label: string; run: () => void };

export const deleteAction = (remove?: DeleteControl): MessageAction[] =>
  remove ? [{ id: "delete", label: remove.label, icon: <Trash2 size={14} />, menuOnly: true, run: remove.run }] : [];

export const menuActions = (actions: MessageAction[]): MenuAction[] =>
  actions
    .filter(action => action.id !== "model")
    .map(action => ({ ...action, label: action.menuLabel ?? action.label }));

export function MessageButtons({ actions }: { actions: MessageAction[] }) {
  return (
    <>
      {actions
        .filter(action => !action.menuOnly)
        .map(action =>
          action.id === "model" ? (
            <span key={action.id} className="message-model" title={`Model: ${action.label}`}>
              {action.label}
            </span>
          ) : action.copy ? (
            <CopyButton key={action.id} label={action.label} text={action.copy} />
          ) : (
            <Button
              key={action.id}
              variant="ghost"
              size="icon-xs"
              aria-label={action.label}
              title={action.title ?? action.label}
              onClick={action.run}
            >
              {action.icon}
            </Button>
          ),
        )}
      <MoreMenu actions={menuActions(actions)} label="More message actions" title="More actions" />
    </>
  );
}

/** ChatGPT's ‹ 2 / 2 › under an edited message: the other versions of it, one click away. */
export function MessageVersions({ version }: { version: VersionControl }) {
  return (
    <span className="message-versions" role="group" aria-label="Message versions">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous version"
        title="Previous version"
        disabled={!version.onPrevious}
        onClick={version.onPrevious}
      >
        <ChevronLeft size={14} />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">
        {version.index} / {version.count}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next version"
        title="Next version"
        disabled={!version.onNext}
        onClick={version.onNext}
      >
        <ChevronRight size={14} />
      </Button>
    </span>
  );
}

/** How tall a message of his may be before it folds: about twelve lines. Matches `.message-body[data-clamped]`. */
export const LONG_MESSAGE_PX = 288;

/** Sending an edit replaces this message and every later turn through Elpis (thread/revert), then starts the edited turn;
 * the message's attachments go with the edited text, and the chat as it was stays reachable as the previous version. */
export function UserMessage({
  body,
  bodyContent,
  attachments,
  attachmentContent,
  copyText,
  onEdit,
  onRewind,
  onDelete,
  editBlockedReason,
  editDraft,
  onEditDraftChange,
  editPending,
  time,
  onReply,
  reference,
  replyContent,
  version,
}: {
  version?: VersionControl | undefined;
  onDelete?: DeleteControl | undefined;
  onReply?: (() => void) | undefined;
  reference?: string | undefined;
  replyContent?: React.ReactNode;
  body: string;
  bodyContent?: React.ReactNode;
  attachments: string[];
  attachmentContent?: React.ReactNode;
  copyText?: string;
  onEdit?: ((text: string) => Promise<void>) | undefined;
  onRewind?: (() => void) | undefined;
  editBlockedReason?: string | undefined;
  editDraft?: string | undefined;
  onEditDraftChange?: ((value: string | null) => void) | undefined;
  editPending?: boolean | undefined;
  time?: number | undefined;
}) {
  const [localEditing, setEditing] = useState(false);
  const [localDraft, setLocalDraft] = useState(body);
  const [localBusy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busy = localBusy || !!editPending;
  const editing = onEditDraftChange ? editDraft !== undefined : localEditing,
    draft = onEditDraftChange ? (editDraft ?? body) : localDraft;
  const setDraft = (value: string) => (onEditDraftChange ? onEditDraftChange(value) : setLocalDraft(value));
  const cancel = () => {
    if (onEditDraftChange) onEditDraftChange(null);
    else {
      setEditing(false);
      setLocalDraft(body);
    }
    setError("");
  };
  async function save() {
    if (busy || !onEdit || !draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onEdit(draft);
      if (!onEditDraftChange) setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  // A long message of his shows its first lines, with a chevron to open the rest, as ChatGPT does (27 Oct: "when a
  // message is too long there should be an option to collapse it"); the chevron sits in the message, not elsewhere.
  // Hooks stay above the editing return, so opening Edit never changes the hook order (1 Nov: Edit crashed the message).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const check = () => setLong(element.scrollHeight > LONG_MESSAGE_PX + 8);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body, editing]);
  if (editing)
    return (
      <form
        className="message user editing"
        aria-label="Edit message"
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}
      >
        <Textarea
          aria-label="Edited message"
          value={draft}
          rows={3}
          autoFocus
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape" && !busy) cancel();
          }}
        />
        <p className="text-xs text-muted-foreground">
          {attachments.length
            ? "Sending replaces this message and everything after it; its attachments stay with it."
            : "Sending replaces this message and everything after it."}{" "}
          The earlier version stays one click away.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !onEdit || !draft.trim()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    );
  const whole = () => copyText ?? [body, ...attachments].filter(Boolean).join("\n");
  const actions: MessageAction[] = [
    ...replyAction(onReply),
    copyTextAction(whole, false),
    copyAction("Copy message", whole),
    ...(onEdit
      ? [
          {
            id: "edit",
            label: "Edit message",
            menuLabel: "Edit and retry",
            title: "Edit and resend",
            icon: <Pencil size={14} />,
            run: () => {
              setDraft(body);
              setError("");
              setEditing(true);
            },
          },
        ]
      : []),
    ...rewindAction(onRewind),
    ...deleteAction(onDelete),
  ];
  return (
    <RightClickMenu
      actions={menuActions(actions)}
      area={
        <div
          className="user-turn"
          id={reference ? messageDomId(reference) : undefined}
          data-message-reference={onReply ? reference : undefined}
          tabIndex={reference ? -1 : undefined}
        />
      }
    >
      <div className="message user">
        {replyContent}
        <div ref={bodyRef} className="message-body" dir="auto" data-clamped={long && !open ? "" : undefined}>
          {bodyContent ?? body}
        </div>
        {long && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="message-fold"
            aria-expanded={open}
            aria-label={open ? "Collapse message" : "Show the whole message"}
            title={open ? "Collapse" : "Show all"}
            onClick={() => setOpen(value => !value)}
          >
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </Button>
        )}
        {attachmentContent ||
          (attachments.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm" aria-label="Message attachments">
              {attachments.map((label, index) => (
                <li key={index}>{label}</li>
              ))}
            </ul>
          ))}
        {!body && !attachments.length && <span>Message content unavailable.</span>}
      </div>
      <InkRow className="message-actions">
        {time && (
          <time
            className="message-time"
            dateTime={new Date(time).toISOString()}
            title={new Date(time).toLocaleString()}
          >
            {new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
        )}
        {version && <MessageVersions version={version} />}
        <MessageButtons actions={actions} />
        {!onEdit && editBlockedReason && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Why editing is unavailable"
            title={editBlockedReason}
            onClick={() => setError(previous => (previous ? "" : editBlockedReason))}
          >
            <Pencil size={14} />
          </Button>
        )}
      </InkRow>
      {error && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {error}
        </p>
      )}
    </RightClickMenu>
  );
}
