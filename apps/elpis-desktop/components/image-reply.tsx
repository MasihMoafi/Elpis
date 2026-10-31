"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Reply } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReplyImage = { src: string; name: string };
const ImageReply = createContext<{ onReply?: (image: ReplyImage) => void; reference?: string }>({});
export function ImageReplyProvider({ onReply, reference, children }: { onReply?: (image: ReplyImage) => void; reference?: string; children: ReactNode }) {
  return <ImageReply.Provider value={{ onReply, reference }}>{children}</ImageReply.Provider>;
}

function transparentTail(image: HTMLImageElement) {
  try {
    const url = new URL(image.currentSrc || image.src, window.location.href);
    if (url.origin !== window.location.origin && url.protocol !== "data:") return 0;
  } catch { return 0; }

  const scale = Math.min(1, 512 / image.naturalWidth, 512 / image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return 0;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let y = canvas.height - 1; y >= 0; y--) {
      for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] !== 0) return (canvas.height - y - 1) / canvas.height;
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** One action for Markdown pictures, uploaded images and viewed-image thumbnails. */
export function ReplyableImage({ src, name, children }: ReplyImage & { children: ReactNode }) {
  const { onReply: reply, reference } = useContext(ImageReply);
  const root = useRef<HTMLSpanElement>(null);
  const enabled = Boolean(reply);
  useEffect(() => {
    const wrapper = root.current;
    const image = wrapper?.querySelector<HTMLImageElement>(":scope > img");
    if (!enabled || !wrapper || !image || image.classList.contains("activity-thumb")) return;
    let observer: ResizeObserver | undefined;
    let restore: (() => void) | undefined;
    const inspect = () => {
      if (!image.complete || !image.naturalWidth || !image.naturalHeight || restore) return;
      const style = getComputedStyle(image);
      const background = style.backgroundColor.match(/[\d.]+/g);
      const clearBackground = style.backgroundColor === "transparent" || background?.length === 4 && Number(background[3]) === 0;
      if (style.backgroundImage !== "none" || !clearBackground
        || Number.parseFloat(style.borderTopWidth) || Number.parseFloat(style.borderBottomWidth)) return;
      const ratio = transparentTail(image);
      if (!ratio) return;
      const originalMarginBottom = image.style.marginBottom;
      const baseMarginBottom = Number.parseFloat(style.marginBottom) || 0;
      const applyTail = () => {
        const box = image.getBoundingClientRect();
        const contentHeight = box.height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
        const tail = contentHeight * ratio;
        if (tail < 1) return;
        image.style.marginBottom = `${baseMarginBottom - tail}px`;
        wrapper.dataset.trimmed = "true";
      };
      applyTail();
      observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyTail);
      observer?.observe(image);
      restore = () => {
        image.style.marginBottom = originalMarginBottom;
        delete wrapper.dataset.trimmed;
      };
    };
    image.addEventListener("load", inspect);
    inspect();
    return () => {
      image.removeEventListener("load", inspect);
      observer?.disconnect();
      restore?.();
    };
  }, [src, enabled]);
  if (!reply) return children;
  return <span ref={root} data-image-reference={reference} tabIndex={-1} className="inline-flex max-w-full flex-col items-start gap-1" onClick={event => event.stopPropagation()}>
    {children}
    <Button type="button" variant="ghost" size="sm" aria-label={`Reply to image: ${name}`} onClick={event => { event.preventDefault(); event.stopPropagation(); reply({ src, name }); }}><Reply size={14} aria-hidden="true" />Reply</Button>
  </span>;
}
