import { useId } from "react";

const edges = [[32, 4, 56.25, 18], [56.25, 18, 56.25, 46], [56.25, 46, 32, 60],
  [32, 60, 7.75, 46], [7.75, 46, 7.75, 18], [7.75, 18, 32, 4]] as const;

export function WorkingMark({ className = "" }: { className?: string }) {
  const maskId = `working-edges-${useId().replace(/:/g, "")}`;
  return <svg className={`elpis-working-mark ${className}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" style={{ maskType: "alpha" }}>
      {edges.map(([x1, y1, x2, y2], index) => <line key={index} className="elpis-working-edge"
        x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth="8" strokeLinecap="round"
        style={{ animationDelay: `${-index * 2 / 3}s` }} />)}
    </mask></defs>
    <path className="elpis-working-rotor" d="M32 4 56.25 18V46L32 60 7.75 46V18Z" mask={`url(#${maskId})`} />
    <circle className="elpis-working-dot" cx="32" cy="32" r="7" />
  </svg>;
}
