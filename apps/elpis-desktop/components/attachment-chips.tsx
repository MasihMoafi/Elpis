"use client";

import { readReply } from "@/lib/message-reply";
import { DRAWING_NOTE } from "@/lib/browser-notes";
import { ReplyPreview } from "@/components/message-reply";
import { X } from "lucide-react";
import { fileKind } from "@/components/file-cards";
import { Button } from "@/components/ui/button";
import type { Attachment } from "@/lib/attachments";

/** The files of the message in the box: one chip each, whatever the file is (as Claude's composer shows them). A picture
 * shows itself where another file shows the icon of its kind, in a place of the same size, so a row of both lines up. */
export function AttachmentChips({ attachments, disabled, onRemove }: { attachments: Attachment[]; disabled?: boolean; onRemove: (id: string) => void }) {
  if (!attachments.length) return null;
  return <ul aria-label="Message attachments" className="flex flex-wrap gap-2 p-2">
    {attachments.filter(part => part.name !== DRAWING_NOTE).map(part => {
      const reply = readReply(part);
      if (reply) return <li key={part.id} className="w-full min-w-0"><ReplyPreview reply={reply} disabled={disabled} onRemove={() => onRemove(part.id)} /></li>;
      const { Icon, kind, ext } = fileKind(part.name), caption = part.type === "image" ? "Image" : kind;
      return <li key={part.id} data-slot="attachment-chip" className="flex h-14 min-w-0 max-w-full items-center gap-2 hud-cut border border-border bg-card text-card-foreground p-1.5 pr-1 text-sm">
        <span data-slot="attachment-thumb" className="grid size-11 shrink-0 place-items-center overflow-hidden hud-cut-sm bg-muted text-muted-foreground">
          {part.type === "image" ? <img src={part.dataUrl} alt={part.name} className="size-full object-cover" /> : <Icon size={20} strokeWidth={1.5} aria-hidden="true" />}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span data-slot="attachment-name" title={part.name} className="max-w-48 truncate">{part.name}</span>
          <small data-slot="attachment-kind" className="text-muted-foreground">{ext ? `${caption} · ${ext.toUpperCase()}` : caption}</small>
        </span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${part.name}`} disabled={disabled} onClick={() => onRemove(part.id)}><X className="size-3" /></Button>
      </li>;
    })}
  </ul>;
}
