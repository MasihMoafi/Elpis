import { useId } from "react";

const edges = [
  [32, 4, 56.25, 18],
  [56.25, 18, 56.25, 46],
  [56.25, 46, 32, 60],
  [32, 60, 7.75, 46],
  [7.75, 46, 7.75, 18],
  [7.75, 18, 32, 4],
] as const;

const shapes = ["hexagon", "pentagon", "circle", "square", "octagon", "triangle"] as const;
type Shape = (typeof shapes)[number];

const spokes: Record<Shape, readonly (readonly [number, number])[]> = {
  hexagon: edges.map(([x, y]) => [x, y] as const),
  pentagon: [[32, 4], [58.6, 23.3], [48.5, 54.5], [15.5, 54.5], [5.4, 23.3]],
  circle: [[32, 5], [59, 32], [32, 59], [5, 32]],
  square: [[10, 10], [54, 10], [54, 54], [10, 54]],
  octagon: [[21, 5], [43, 5], [59, 21], [59, 43], [43, 59], [21, 59], [5, 43], [5, 21]],
  triangle: [[32, 4], [56.25, 46], [7.75, 46]],
};

function shapeFor(threadId: string | undefined): Shape {
  if (threadId === undefined) return "hexagon";
  let hash = 0;
  for (let index = 0; index < threadId.length; index++) hash = (Math.imul(hash, 31) + threadId.charCodeAt(index)) >>> 0;
  return shapes[hash % shapes.length]!;
}

export function WorkingMark({
  className = "",
  animatedEdges = true,
  threadId,
}: { className?: string; animatedEdges?: boolean; threadId?: string | undefined }) {
  const shape = shapeFor(threadId);
  const maskId = `working-edges-${useId().replace(/:/g, "")}`;
  return (
    <svg className={`elpis-working-mark ${className}`} data-shape={shape} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {shape === "hexagon" && animatedEdges && (
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" style={{ maskType: "alpha" }}>
            {edges.map(([x1, y1, x2, y2], index) => (
              <line
                key={index}
                className="elpis-working-edge"
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="white"
                strokeWidth="8"
                strokeLinecap="round"
                style={{ animationDelay: `${(-index * 2) / 3}s` }}
              />
            ))}
          </mask>
        </defs>
      )}
      <g className="elpis-working-rotor">
        <g stroke="currentColor" strokeWidth="2.5">
          {spokes[shape].map(([x, y], index) => <line key={index} x1={x} y1={y} x2="32" y2="32" />)}
        </g>
        {shape === "hexagon" ? (
          <path d="M32 4 56.25 18V46L32 60 7.75 46V18Z" mask={animatedEdges ? `url(#${maskId})` : undefined} />
        ) : shape === "pentagon" ? (
          <path d="M32 4 58.6 23.3 48.5 54.5 15.5 54.5 5.4 23.3Z" />
        ) : shape === "circle" ? (
          <circle cx="32" cy="32" r="27" />
        ) : shape === "square" ? (
          <rect x="7" y="7" width="50" height="50" rx="8" />
        ) : shape === "octagon" ? (
          <path d="M21 5H43L59 21V43L43 59H21L5 43V21Z" />
        ) : (
          <path d="M32 4 56.25 46 7.75 46Z" />
        )}
      </g>
      <circle className="elpis-working-dot" cx="32" cy="32" r="7" />
    </svg>
  );
}
