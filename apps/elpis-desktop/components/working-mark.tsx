const triangles = [
  "M32 4 56.25 46 7.75 46Z",
  "M7.75 18 56.25 18 32 60Z",
  "M7.75 18 56.25 46 7.75 46Z",
];

export function WorkingMark({ className = "", animatedEdges = true }: { className?: string; animatedEdges?: boolean }) {
  return (
    <svg className={`elpis-working-mark ${className}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {triangles.map((d, index) => (
        <path key={d} d={d} className={animatedEdges ? "elpis-working-triangle" : undefined}
          style={animatedEdges ? { animationDelay: `${(-index * 4) / 3}s` } : undefined} />
      ))}
    </svg>
  );
}
