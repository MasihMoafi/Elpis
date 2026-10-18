"use client";

import { useEffect, useState } from "react";
import { SendIcon } from "@/components/elpis-icons";

/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;

export function StartupSplash({ done }: { steps: { label: string; ok: boolean }[]; done: boolean }) {
  const [expired, setExpired] = useState(false), [gone, setGone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), LONGEST_MS);
    return () => clearTimeout(timer);
  }, []);
  const leaving = done || expired;
  useEffect(() => { if (!leaving) return; const timer = setTimeout(() => setGone(true), FADE_MS); return () => clearTimeout(timer); }, [leaving]);
  if (gone) return null;
  return <div className={`startup-splash${leaving ? " leaving" : ""}`} style={{ transitionDuration: `${FADE_MS}ms` }} role="status" aria-label="Elpis is starting">
    <div>
      <div className="splash-hex" aria-hidden="true"><SendIcon size={32} /></div>
      <p>Elpis</p>
    </div>
  </div>;
}
