"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;
const INTRO_MS = 700;

/** The third motion study's E gyroscope, with its surrounding rings removed. */
export function StartupSplash({ done }: { done: boolean }) {
  const [expired, setExpired] = useState(false), [gone, setGone] = useState(false);
  const [introduced, setIntroduced] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), LONGEST_MS);
    const intro = setTimeout(() => setIntroduced(true), INTRO_MS);
    return () => { clearTimeout(timer); clearTimeout(intro); };
  }, []);
  const leaving = (done && introduced) || expired;
  useEffect(() => { if (!leaving) return; const timer = setTimeout(() => setGone(true), FADE_MS); return () => clearTimeout(timer); }, [leaving]);
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
