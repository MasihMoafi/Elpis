"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

const FADE_MS = 240;
const INTRO_MS = 700;

/** The third motion study's E gyroscope, with its surrounding rings removed. */
export function StartupSplash() {
  const [leaving, setLeaving] = useState(false), [gone, setGone] = useState(false);
  useEffect(() => {
    // The introduction is visual only. Bridge health, lists and restored history load in the app.
    const intro = setTimeout(() => setLeaving(true), INTRO_MS);
    const timer = setTimeout(() => setGone(true), INTRO_MS + FADE_MS);
    return () => { clearTimeout(intro); clearTimeout(timer); };
  }, []);
  if (gone) return null;
  return <div className={`startup-splash${leaving ? " leaving" : ""}`} style={{ transitionDuration: `${FADE_MS}ms` }} role="status" aria-label="Elpis is starting">
    <div className="splash-stage" aria-hidden="true">
      <div className="splash-gyro">
        <img className="splash-logo" src="/branding/elpis-symbol-amber.svg" alt="" width={160} height={160} draggable={false} />
      </div>
      <p className="splash-name">Elpis</p>
    </div>
  </div>;
}
