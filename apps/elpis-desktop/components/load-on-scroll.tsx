"use client";
import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

/**
 * The one way Elpis loads more of a list: a marker at the list's edge that loads the next part as it scrolls into view, as
 * the ChatGPT app does. There is no button (Masih, 31 Oct: "when I hover up load them; no need for that button"); while a
 * part loads, a small spinner shows in the marker's place. Every "Load more" list uses this, so a change here reaches all.
 */
/** `paused`: after a failed part the list waits (for the error to be dismissed) instead of asking again and again. */
export function LoadOnScroll({ onLoad, loading = false, paused = false, label, className = "" }: { onLoad: () => void; loading?: boolean; paused?: boolean; label: string; className?: string }) {
  const marker = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad); load.current = onLoad;
  // A new observer after each load reports at once whether the marker is still in view, so a short list keeps filling.
  useEffect(() => {
    const element = marker.current;
    if (!element || loading || paused) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load.current(); }, { rootMargin: "160px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, paused]);
  return <div ref={marker} className={`load-on-scroll ${className}`} data-loading={loading || undefined} role={loading ? "status" : undefined} aria-label={loading ? label : undefined}>
    {loading && <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />}
  </div>;
}
