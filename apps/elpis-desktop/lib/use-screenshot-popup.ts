"use client";

import { useEffect, useRef } from "react";
import { subscribeLoveSpotEvents } from "./love-spot-events";

type Shot = { id: string; name: string; dataURL: string };

/** A screenshot taken while Elpis runs asks for the corner thumbnail (desktop/screenshot-popup.cjs); its click calls `open`.
 * Screenshots already waiting in Love Spot's tray when the window starts do not pop up. */
export function useScreenshotPopup(ready: boolean, open: (id: string) => void) {
  const opener = useRef(open); opener.current = open;
  useEffect(() => window.elpisDesktop?.screenshotPopup?.onOpen(id => opener.current(id)), []);
  useEffect(() => {
    if (!ready || !window.elpisDesktop?.screenshotPopup) return;
    let known: Set<string> | null = null;
    return subscribeLoveSpotEvents(event => {
      let data: { type?: string; screenshots?: Shot[] };
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== "screenshots" || !Array.isArray(data.screenshots)) return;
      const fresh = known ? data.screenshots.filter(shot => !known!.has(shot.id)) : [];
      known = new Set([...(known ?? []), ...data.screenshots.map(shot => shot.id)]);
      // The list is newest first; the thumbnail shows the newest one, as a second screenshot replaces the first on macOS.
      if (fresh[0]) window.elpisDesktop?.screenshotPopup?.show(fresh[0]);
    });
  }, [ready]);
}
