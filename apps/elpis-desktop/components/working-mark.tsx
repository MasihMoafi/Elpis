export function WorkingMark({ className = "" }: { className?: string }) {
  return <svg className={`elpis-working-mark ${className}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <g className="elpis-working-rotor">
      <path d="M32 4 60 32 32 60 4 32Z" />
      <path className="elpis-working-light" d="M32 4V32H4Z" />
      <path className="elpis-working-shade" d="M32 32H60L32 60Z" />
    </g>
  </svg>;
}
