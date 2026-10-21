"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;

/** The Elpis symbol rotates upright, without a separate ribbon overlay.
 * Readiness still dismisses it immediately; reduced motion holds the upright E. */
export function StartupSplash({ done }: { done: boolean }) {
  const [expired, setExpired] = useState(false), [gone, setGone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), LONGEST_MS);
    return () => clearTimeout(timer);
  }, []);
  const leaving = done || expired;
  useEffect(() => { if (!leaving) return; const timer = setTimeout(() => setGone(true), FADE_MS); return () => clearTimeout(timer); }, [leaving]);
  if (gone) return null;
  return <div className={`startup-splash${leaving ? " leaving" : ""}`} style={{ transitionDuration: `${FADE_MS}ms` }} role="status" aria-label="Elpis is starting">
    <div className="splash-stage" aria-hidden="true">
      <img className="splash-logo" src="/branding/elpis-symbol-amber.svg" alt="" width={160} height={160} draggable={false} />
      <p className="splash-name">Elpis</p>
    </div>
  </div>;
}
