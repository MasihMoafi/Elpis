"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Reply } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReplyImage = { src: string; name: string };
const ImageReply = createContext<{ onReply?: (image: ReplyImage) => void; reference?: string }>({});
export function ImageReplyProvider({ onReply, reference, children }: { onReply?: (image: ReplyImage) => void; reference?: string; children: ReactNode }) {
  return <ImageReply.Provider value={{ onReply, reference }}>{children}</ImageReply.Provider>;
}

/** One action for Markdown pictures, uploaded images and viewed-image thumbnails. */
export function ReplyableImage({ src, name, children }: ReplyImage & { children: ReactNode }) {
  const { onReply: reply, reference } = useContext(ImageReply);
  if (!reply) return children;
  return <span data-image-reference={reference} tabIndex={-1} className="inline-flex max-w-full flex-col items-start gap-1" onClick={event => event.stopPropagation()}>
    {children}
    <Button type="button" variant="ghost" size="sm" aria-label={`Reply to image: ${name}`} onClick={event => { event.preventDefault(); event.stopPropagation(); reply({ src, name }); }}><Reply size={14} aria-hidden="true" />Reply</Button>
  </span>;
}
