"use client";

import { useEffect, useRef } from "react";
import { subscribeLoveSpotEvents } from "./love-spot-events";

type Shot = { id: string; name: string; dataURL: string };

/** A screenshot taken while Elpis runs asks for the corner thumbnail (desktop/screenshot-popup.cjs); its click calls `open`
 * with every screenshot taken since Elpis started that still waits in Love Spot's tray, oldest first, so several taken in a
 * row open together in the order they were taken (Masih, 31 Oct). Screenshots already waiting when the window starts do not
 * pop up. */
export function useScreenshotPopup(ready: boolean, open: (ids: string[]) => void) {
  const opener = useRef(open); opener.current = open;
  const waiting = useRef<string[]>([]); // newest first, as the tray lists them
  useEffect(() => window.elpisDesktop?.screenshotPopup?.onOpen(id => {
    const ids = waiting.current.includes(id) ? [...waiting.current].reverse() : [id];
    opener.current(ids);
  }), []);
  useEffect(() => {
    if (!ready || !window.elpisDesktop?.screenshotPopup) return;
    let known: Set<string> | null = null;
    const taken = new Set<string>();
    return subscribeLoveSpotEvents(event => {
      let data: { type?: string; screenshots?: Shot[] };
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== "screenshots" || !Array.isArray(data.screenshots)) return;
      const fresh = known ? data.screenshots.filter(shot => !known!.has(shot.id)) : [];
      known = new Set([...(known ?? []), ...data.screenshots.map(shot => shot.id)]);
      for (const shot of fresh) taken.add(shot.id);
      waiting.current = data.screenshots.filter(shot => taken.has(shot.id)).map(shot => shot.id);
      // The list is newest first; the thumbnail shows the newest one, with how many wait to open together.
      if (fresh[0]) window.elpisDesktop?.screenshotPopup?.show({ ...fresh[0], count: waiting.current.length });
    });
  }, [ready]);
}
