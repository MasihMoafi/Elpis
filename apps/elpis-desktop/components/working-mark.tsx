import { useId } from "react";

const edges = [
  [32, 4, 56.25, 18],
  [56.25, 18, 56.25, 46],
  [56.25, 46, 32, 60],
  [32, 60, 7.75, 46],
  [7.75, 46, 7.75, 18],
  [7.75, 18, 32, 4],
] as const;

const shapes = ["hexagon", "pentagon", "circle", "square", "octagon", "hourglass"] as const;

function shapeFor(threadId: string | undefined) {
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
        {shape === "hexagon" ? (
          <>
            <g stroke="currentColor" strokeWidth="2.5">
              {edges.map(([x, y], index) => <line key={index} x1={x} y1={y} x2="32" y2="32" />)}
            </g>
            <path d="M32 4 56.25 18V46L32 60 7.75 46V18Z" mask={animatedEdges ? `url(#${maskId})` : undefined} />
          </>
        ) : shape === "pentagon" ? (
          <path d="M32 4 58.6 23.3 48.5 54.5 15.5 54.5 5.4 23.3Z" />
        ) : shape === "circle" ? (
          <circle cx="32" cy="32" r="27" strokeDasharray="135 35" />
        ) : shape === "square" ? (
          <rect x="7" y="7" width="50" height="50" rx="8" />
        ) : shape === "octagon" ? (
          <path d="M21 5H43L59 21V43L43 59H21L5 43V21Z" />
        ) : (
          <path d="M16 10 L48 10 L32 32 L48 54 L16 54 L32 32 Z M12 10H52 M12 54H52" />
        )}
      </g>
      <circle className="elpis-working-dot" cx="32" cy="32" r="7" />
    </svg>
  );
}
