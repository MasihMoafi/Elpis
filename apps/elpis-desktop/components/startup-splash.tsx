"use client";

import { useEffect, useState } from "react";
import "./startup-splash.css";

/** Never keep the app hidden for longer than this, whatever is still loading. */
const LONGEST_MS = 8000;
const FADE_MS = 240;
/** The boot meter's segments; each ready part lights its share. */
const SEGMENTS = 12;

/** The old send button's hexagon (`polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)`) on a square of `size`
 * centred in the 200-unit dial. */
const hexagon = (size: number) => [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]
  .map(([x, y]) => `${100 - size / 2 + x * size},${100 - size / 2 + y * size}`).join(" ");
const polar = (radius: number, degrees: number) => { const angle = degrees * Math.PI / 180; return [100 + radius * Math.sin(angle), 100 - radius * Math.cos(angle)]; };
/** Sixty ticks round the dial, every fifth one longer, as on the lab's instruments. */
const TICKS = Array.from({ length: 60 }, (_, index) => { const major = index % 5 === 0, [x1, y1] = polar(major ? 83 : 87, index * 6), [x2, y2] = polar(92, index * 6); return { x1, y1, x2, y2, major }; });
const arc = (radius: number, from: number, to: number) => { const [x1, y1] = polar(radius, from), [x2, y2] = polar(radius, to); return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`; };

/** Start-up, in the isometric lab's HUD style: the amber Elpis E (public/branding) on the old send button's hexagon. The
 * plate turns a quarter turn at a time; with the first the E turns a quarter turn clockwise into an M — Elpis by Masih —
 * and with the next it turns back. Tick marks ring it, a line sweeps the plate at each rest, and each boot line ticks
 * when its part (the engine, the models, the chats) is ready. It leaves as soon as the app is, or after eight seconds;
 * while it fades it takes no clicks. Reduced motion holds everything still on the E. */
export function StartupSplash({ steps, done }: { steps: { label: string; ok: boolean }[]; done: boolean }) {
  const [expired, setExpired] = useState(false), [gone, setGone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), LONGEST_MS);
    return () => clearTimeout(timer);
  }, []);
  const leaving = done || expired;
  useEffect(() => { if (!leaving) return; const timer = setTimeout(() => setGone(true), FADE_MS); return () => clearTimeout(timer); }, [leaving]);
  if (gone) return null;
  const lit = Math.round(steps.filter(step => step.ok).length / Math.max(1, steps.length) * SEGMENTS);
  return <div className={`startup-splash${leaving ? " leaving" : ""}`} style={{ transitionDuration: `${FADE_MS}ms` }} role="status" aria-label="Elpis is starting">
    <div className="splash-stage">
      <div className="splash-emblem" aria-hidden="true">
        <svg className="splash-dial" viewBox="0 0 200 200">
          <g className="splash-ticks">{TICKS.map(({ major, ...line }, index) => <line key={index} data-major={major || undefined} {...line} />)}</g>
          <g className="splash-arcs"><path d={arc(97, 300, 350)} /><path d={arc(97, 120, 170)} /></g>
          <g className="splash-hex"><polygon className="splash-hex-plate" points={hexagon(116)} /><polygon className="splash-hex-inner" points={hexagon(100)} /></g>
        </svg>
        <img className="splash-logo" src="/branding/elpis-symbol-amber.svg" alt="" width={60} height={60} draggable={false} />
        <div className="splash-scope"><div className="splash-sweep" /></div>
      </div>
      <p className="splash-name">Elpis</p>
      <div className="splash-boot-panel">
        <ol className="splash-boot" aria-label="Starting">
          {steps.map(step => <li key={step.label} data-ok={step.ok}><span className="splash-glyph" aria-hidden="true">{step.ok ? "✓" : "·"}</span>{step.label}</li>)}
        </ol>
        <div className="splash-meter" aria-hidden="true">{Array.from({ length: SEGMENTS }, (_, index) => <i key={index} data-on={index < lit || undefined} />)}</div>
      </div>
    </div>
  </div>;
}
