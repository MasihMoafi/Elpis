"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Reply } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReplyImage = { src: string; name: string };
const ImageReply = createContext<((image: ReplyImage) => void) | undefined>(undefined);
export function ImageReplyProvider({ onReply, children }: { onReply?: (image: ReplyImage) => void; children: ReactNode }) {
  return <ImageReply.Provider value={onReply}>{children}</ImageReply.Provider>;
}

/** One action for Markdown pictures, uploaded images and viewed-image thumbnails. */
export function ReplyableImage({ src, name, children }: ReplyImage & { children: ReactNode }) {
  const reply = useContext(ImageReply);
  if (!reply) return children;
  return <span className="inline-flex max-w-full flex-col items-start gap-1" onClick={event => event.stopPropagation()}>
    {children}
    <Button type="button" variant="ghost" size="sm" aria-label={`Reply to image: ${name}`} onClick={event => { event.preventDefault(); event.stopPropagation(); reply({ src, name }); }}><Reply size={14} aria-hidden="true" />Reply</Button>
  </span>;
}
