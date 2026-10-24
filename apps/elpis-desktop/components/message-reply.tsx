"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Reply, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { messageDomId, type MessageReply } from "@/lib/message-reply";

export function ReplyPreview({ reply, image, onRemove, disabled }: { reply: MessageReply; image?: string; onRemove?: () => void; disabled?: boolean }) {
  const [missing, setMissing] = useState(false);
  function jump() {
    const target = document.getElementById(messageDomId(reply.reference));
    if (!target) { setMissing(true); return; }
    for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  return <div data-slot="reply-preview" className="flex min-w-0 gap-2 rounded-md border-s-2 border-primary bg-muted/30 px-3 py-2 text-start text-sm">
    <button data-slot="reply-quote" type="button" className="grid min-w-0 flex-1 gap-1 text-start" aria-label="Jump to original message" onClick={jump}>
      <span className="flex items-center gap-1.5 font-medium text-primary"><Reply size={14} aria-hidden="true" />Replying to {reply.speaker}</span>
      {reply.image && image && <img src={image} alt={reply.image.name} className="h-16 max-w-32 rounded-sm object-contain" />}
      <span className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">{reply.text}</span>
      {missing && <span role="status" className="text-muted-foreground">The original message is no longer in this view.</span>}
    </button>
    {onRemove && <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label="Cancel reply" title="Cancel reply" onClick={onRemove}><X size={14} /></Button>}
  </div>;
}

/** A selection belongs to one message. Crossing messages, selecting controls, and collapsed selections have no quote. */
export function SelectionReply({ onQuote }: { onQuote: (reference: string, text: string) => void }) {
  const [quote, setQuote] = useState<{ reference: string; text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const show = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) { setQuote(null); return; }
      const range = selection.getRangeAt(0);
      const owner = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-message-reference]");
      const start = owner(range.startContainer), end = owner(range.endContainer);
      if (!start || start !== end) { setQuote(null); return; }
      const rect = range.getBoundingClientRect();
      setQuote({ reference: start.dataset.messageReference!, text: selection.toString().trim(), x: Math.min(Math.max(8, rect.left), innerWidth - 130), y: rect.bottom + 40 < innerHeight ? rect.bottom + 6 : Math.max(40, rect.top - 38) });
    };
    const clear = () => { if (window.getSelection()?.isCollapsed) setQuote(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setQuote(null); else show(); };
    document.addEventListener("pointerup", show); document.addEventListener("keyup", escape); document.addEventListener("selectionchange", clear);
    return () => { document.removeEventListener("pointerup", show); document.removeEventListener("keyup", escape); document.removeEventListener("selectionchange", clear); };
  }, []);
  if (!quote) return null;
  return createPortal(<Button type="button" size="sm" variant="secondary" className="fixed z-50 gap-1.5 border border-border shadow-md" style={{ left: quote.x, top: quote.y }} onPointerDown={event => event.preventDefault()} onClick={() => { onQuote(quote.reference, quote.text); setQuote(null); window.getSelection()?.removeAllRanges(); }}><Reply size={14} />Quote selection</Button>, document.body);
}
