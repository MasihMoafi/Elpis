"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { removeFollowUp, sendFollowUpNow, useFollowUps } from "@/lib/follow-ups";

/** Messages waiting for the running turn to finish (Settings → General → Follow-up behavior → Queue). */
export function QueuedFollowUps({ threadId, activeTurnId, onError, onComplete }: { threadId?: string; activeTurnId?: string; onError?: (message: string) => void; onComplete?: (origin: Element) => void }) {
  const items = useFollowUps(threadId);
  if (!threadId || !items.length) return null;
  return <ul aria-label="Queued follow-ups" className="mx-auto mb-2 grid w-full max-w-[740px] gap-1.5">
    {items.map(item => <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">Queued</span>
      <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text || `${item.attachments.length} attached file${item.attachments.length === 1 ? "" : "s"}`}</span>
      <Button type="button" variant="ghost" size="xs" onClick={event => { const origin = event.currentTarget; void sendFollowUpNow(threadId, item.id, activeTurnId).then(() => onComplete?.(origin)).catch(error => onError?.(error instanceof Error ? error.message : String(error))); }}>Send now</Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove queued message" onClick={event => { const origin = event.currentTarget; removeFollowUp(threadId, item.id); onComplete?.(origin); }}><X /></Button>
    </li>)}
  </ul>;
}
