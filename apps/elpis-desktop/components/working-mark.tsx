export function WorkingMark({ className = "" }: { className?: string }) {
  return <svg className={`elpis-working-mark ${className}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path className="elpis-working-rotor" d="M32 4 56.25 18V46L32 60 7.75 46V18Z" />
    <circle className="elpis-working-dot" cx="32" cy="32" r="7" />
  </svg>;
}
