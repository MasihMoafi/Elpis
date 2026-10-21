"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

/** The Elpis website's boot screen (website/index.html and app.js, `paintAceLogo`) in its default dark version: a gold
 * sweep runs across the logo while the app connects, and each boot line is ticked only when that part has really loaded.
 * The logo's top row has the E's first block restored, which the website's copy lacks. */
const LOGO = `███████╗ ██╗     ██████╗ ██╗███████╗
██╔════╝ ██║     ██╔══██╗██║██╔════╝
█████╗   ██║     ██████╔╝██║███████╗
██╔══╝   ██║     ██╔═══╝ ██║╚════██║
███████╗ ███████╗██║     ██║███████║
╚══════╝ ╚══════╝╚═╝     ╚═╝╚══════╝`;
const SWEEP_MS = 1600;
/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;

/** The logo as lines of [character, heat]: 2 at the sweep, 1 near it, 0 elsewhere (the website's hot and warm). */
function paintLogo(sweep: number) {
  return LOGO.split("\n").map(line => [...line].map((character, column): [string, number] => {
    const distance = Math.abs(column - sweep);
    return [character, character === " " ? 0 : distance < 4 ? 2 : distance < 11 ? 1 : 0];
  }));
}

export function StartupSplash({ steps, done }: { steps: { label: string; ok: boolean }[]; done: boolean }) {
  const [sweep, setSweep] = useState(-8);
  const [expired, setExpired] = useState(false), [gone, setGone] = useState(false);
  useEffect(() => {
    // A colour sweep, not movement, so it runs even when the system asks to reduce motion (GNOME's animations off).
    const start = performance.now(); let frame = 0;
    const tick = (now: number) => {
      setSweep(Math.round(-8 + 56 * (((now - start) % SWEEP_MS) / SWEEP_MS)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const timer = setTimeout(() => setExpired(true), LONGEST_MS);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  const leaving = done || expired;
  useEffect(() => { if (!leaving) return; const timer = setTimeout(() => setGone(true), FADE_MS); return () => clearTimeout(timer); }, [leaving]);
  if (gone) return null;
  const loaded = Math.round((steps.filter(step => step.ok).length / Math.max(1, steps.length)) * 12);
  return <div className={`startup-splash${leaving ? " leaving" : ""}`} style={{ transitionDuration: `${FADE_MS}ms` }} role="status" aria-label="Elpis is starting">
    <div>
      <pre className="splash-logo" aria-hidden="true">{paintLogo(sweep).map((line, row) => <span key={row}>{line.map(([character, heat], column) => heat ? <span key={column} className={heat === 2 ? "hot" : "warm"}>{character}</span> : character)}{"\n"}</span>)}</pre>
      <p>portable context for terminal coding agents</p>
      <div className="splash-log">
        {steps.map(step => <div key={step.label}><span className={step.ok ? "ok" : "pending"}>{step.ok ? "✓" : "·"}</span> {step.label}</div>)}
        <div>[{"█".repeat(loaded)}{"░".repeat(12 - loaded)}]</div>
      </div>
    </div>
  </div>;
}
