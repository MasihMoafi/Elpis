"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { LoveSpotIcon } from "@/components/elpis-icons";
import { HEART_REACTION, createHeartDeduper, talkHeartReaction, type HeartReaction } from "@/lib/heart-reactions";
import { subscribeLoveSpotTalk } from "@/lib/love-spot-talk-events";
import "@/components/matilda-heart-burst.css";

const hearts = [
  [9, 7, 26, -24, 48, 0], [17, 14, 34, 18, 56, 120], [25, 5, 22, -34, 42, 60],
  [33, 20, 30, 22, 52, 180], [41, 8, 20, -12, 47, 100], [49, 16, 36, 15, 58, 0],
  [57, 4, 24, -20, 44, 180], [65, 18, 32, 30, 54, 80], [73, 6, 22, -18, 50, 140],
  [81, 13, 34, 24, 57, 40], [90, 7, 26, -25, 45, 160],
] as const;

/** Both the main chat and Love Spot use the same short-lived, non-interactive effect. */
export function MatildaHeartBurst() {
  const [burst, setBurst] = useState(0);
  const accept = useRef(createHeartDeduper());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (reaction: HeartReaction | null) => {
      if (!accept.current(reaction) || document.hidden) return;
      clearTimeout(timer);
      setBurst(current => current + 1);
      timer = setTimeout(() => setBurst(0), 2200);
    };
    const native = (event: Event) => show((event as CustomEvent<HeartReaction>).detail);
    window.addEventListener(HEART_REACTION, native);
    const stop = subscribeLoveSpotTalk(event => {
      try { show(talkHeartReaction(JSON.parse(event.data))); } catch { /* Ignore unreadable snapshots. */ }
    });
    return () => { window.removeEventListener(HEART_REACTION, native); stop(); clearTimeout(timer); };
  }, []);
  if (!burst) return null;
  return createPortal(<div key={burst} className="matilda-heart-burst" aria-hidden="true">
    {hearts.map(([left, bottom, size, drift, rise, delay], index) => <LoveSpotIcon key={index} size={size} style={{
      "--heart-left": `${left}%`, "--heart-bottom": `${bottom}%`, "--heart-drift": `${drift}px`,
      "--heart-rise": `${rise}vh`, "--heart-delay": `${delay}ms`,
    } as CSSProperties} />)}
  </div>, document.body);
}
