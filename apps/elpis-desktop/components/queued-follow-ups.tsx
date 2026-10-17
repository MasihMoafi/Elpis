"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft, Pencil, X } from "lucide-react";
import { MoreMenu } from "@/components/action-menu";
import { Button } from "@/components/ui/button";
import { clearFollowUps, removeFollowUp, sendFollowUpNow, takeFollowUp, useFollowUps, type FollowUp } from "@/lib/follow-ups";

/** What Claude's desktop app does with a queued message, in its words. `run` gets the element that had the focus, so the
 * composer can take it back when that element goes away with the message. */
type Act = { id: string; label: string; icon: ReactNode; destructive?: boolean; run: (origin: Element | null) => void };

const TRAY = "mx-auto mb-2 w-full max-w-[740px] overflow-hidden rounded-sm border bg-card text-sm";
const ROW = "flex min-h-10 items-center gap-2 px-3";
const count = (n: number) => `${n} message${n === 1 ? "" : "s"} queued`;
const preview = (item: FollowUp) => item.text || `${item.attachments.length} attached file${item.attachments.length === 1 ? "" : "s"}`;

/** Messages waiting for the running turn to finish (Ctrl+Enter, or Settings → General → Follow-up behavior → Queue), above the
 * message box as in Claude: one message is a row with its three actions; several collapse into a stack that opens into a list. */
export function QueuedFollowUps({ threadId, activeTurnId, onError, onComplete, onEdit }: {
  threadId?: string; activeTurnId?: string; onError?: (message: string) => void; onComplete?: (origin: Element | null) => void;
  /** Edit in composer: the message has left the queue; put it back in the message box. */ onEdit?: (item: FollowUp) => void;
}) {
  const items = useFollowUps(threadId);
  if (!threadId || !items.length) return null;
  return <Tray key={threadId} {...{ threadId, items, activeTurnId, onError, onComplete, onEdit }} />;
}

function Tray({ threadId, items, activeTurnId, onError, onComplete, onEdit }: { threadId: string; items: FollowUp[] } & Pick<Parameters<typeof QueuedFollowUps>[0], "activeTurnId" | "onError" | "onComplete" | "onEdit">) {
  const [open, setOpen] = useState(false);
  const acts = (item: FollowUp): Act[] => [
    ...onEdit ? [{ id: "edit", label: "Edit in composer", icon: <Pencil />, run: () => { if (takeFollowUp(threadId, item.id)) onEdit(item); } }] : [],
    { id: "send", label: "Send now", icon: <CornerDownLeft />, run: origin => void sendFollowUpNow(threadId, item.id, activeTurnId).then(() => onComplete?.(origin)).catch(error => onError?.(error instanceof Error ? error.message : String(error))) },
    { id: "remove", label: "Remove from queue", icon: <X />, destructive: true, run: origin => { removeFollowUp(threadId, item.id); onComplete?.(origin); } },
  ];
  const [first] = items;

  if (items.length === 1) return <ul aria-label="Queued follow-ups" className={TRAY}>
    <li className={ROW}>
      <span className="shrink-0 font-medium">{count(1)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={first.text}>{preview(first)}</span>
      {acts(first).map(act => <Button key={act.id} type="button" variant="ghost" size="icon-xs" aria-label={act.label} title={act.label} className={act.destructive ? "" : "text-muted-foreground hover:text-foreground"} onClick={event => act.run(event.currentTarget)}>{act.icon}</Button>)}
    </li>
  </ul>;

  if (!open) return <button type="button" aria-expanded="false" className={`${TRAY} ${ROW} text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50`} onClick={() => setOpen(true)}>
    <span className="shrink-0 font-medium">{count(items.length)}</span>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">Next: {preview(first)}</span>
    <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
  </button>;

  return <div className={TRAY}>
    <div className={ROW}>
      <span className="flex-1 font-medium">{count(items.length)}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-expanded="true" aria-label="Collapse queued messages" title="Collapse queued messages" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}><ChevronUp /></Button>
    </div>
    <ul aria-label="Queued follow-ups" className="max-h-[min(40vh,22rem)] divide-y overflow-y-auto overscroll-contain border-t">
      {items.map(item => <li key={item.id} className="flex min-h-10 items-start gap-2 py-1.5 pl-3 pr-2">
        <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5" title={item.text}>{preview(item)}</span>
        <MoreMenu label="Queued message actions" title="Queued message actions" align="end" actions={acts(item).map(act => ({ ...act, run: () => act.run(document.activeElement) }))} />
      </li>)}
    </ul>
    <div className="flex justify-end border-t px-2 py-1">
      <Button type="button" variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={event => { clearFollowUps(threadId); onComplete?.(event.currentTarget); }}>Clear all</Button>
    </div>
  </div>;
}
