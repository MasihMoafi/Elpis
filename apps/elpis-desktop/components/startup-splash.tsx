"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;

/** The website's ribbon opening, reversed: the M turns into the fiery Elpis E.
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
    <svg className="splash-ribbon" viewBox="0 0 1200 600" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="startup-ribbon-tone" x1="1" y1="0" x2="0" y2="1">
          <stop stopColor="#D97913" />
          <stop offset=".55" stopColor="#F2A626" />
          <stop offset="1" stopColor="#FFD45A" />
        </linearGradient>
      </defs>
      <path d="M1140 120 C1270 390 790 290 650 430 S170 490 -40 585" pathLength="1" fill="none" stroke="url(#startup-ribbon-tone)" />
    </svg>
    <div className="splash-stage" aria-hidden="true">
      <img className="splash-logo" src="/branding/elpis-symbol-amber.svg" alt="" width={160} height={160} draggable={false} />
      <p className="splash-name">Elpis</p>
    </div>
  </div>;
}
