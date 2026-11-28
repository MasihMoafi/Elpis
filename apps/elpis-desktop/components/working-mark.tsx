import { useId } from "react";

const edges = [
  [32, 4, 56.25, 18],
  [56.25, 18, 56.25, 46],
  [56.25, 46, 32, 60],
  [32, 60, 7.75, 46],
  [7.75, 46, 7.75, 18],
  [7.75, 18, 32, 4],
] as const;

const shapes = ["hexagon", "pentagon", "circle", "square", "octagon"] as const;
type Shape = (typeof shapes)[number];

const spokes: Record<Shape, readonly (readonly [number, number])[]> = {
  hexagon: edges.map(([x, y]) => [x, y] as const),
  pentagon: [[32, 4], [58.63, 23.35], [48.46, 54.65], [15.54, 54.65], [5.37, 23.35]],
  circle: [[32, 5.5], [58.5, 32], [32, 58.5], [5.5, 32]],
  square: [[12, 12], [52, 12], [52, 52], [12, 52]],
  octagon: [
    [21.28, 6.13], [42.72, 6.13], [57.87, 21.28], [57.87, 42.72],
    [42.72, 57.87], [21.28, 57.87], [6.13, 42.72], [6.13, 21.28],
  ],
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
          <path d="M32 4 58.63 23.35 48.46 54.65 15.54 54.65 5.37 23.35Z" />
        ) : shape === "circle" ? (
          <circle cx="32" cy="32" r="26.5" />
        ) : shape === "square" ? (
          <rect x="10" y="10" width="44" height="44" rx="6" />
        ) : (
          <path d="M21.28 6.13H42.72L57.87 21.28V42.72L42.72 57.87H21.28L6.13 42.72V21.28Z" />
        )}
      </g>
      <circle className="elpis-working-dot" cx="32" cy="32" r="7" />
    </svg>
  );
}
