import { CONTEXT_GAUGE } from "@/components/elpis-icons";

/** While a turn runs: the collection's context gauge (context--animation.svg), its ring turning once every 8 s around the
 * hexagon core, and still under reduced motion, as the file animates (Masih, 29 Oct: "use its animation from the
 * collection as the waiting animation, just so I can compare"). */
export function WorkingMark({ className = "" }: { className?: string }) {
  return <svg className={`elpis-working-mark ${className}`} viewBox={CONTEXT_GAUGE.viewBox} aria-hidden="true" focusable="false">
    <g className="elpis-working-rotor">{CONTEXT_GAUGE.ring.map(d => <path key={d} d={d} />)}</g>
    <path className="elpis-working-core" d={CONTEXT_GAUGE.core} />
  </svg>;
}
