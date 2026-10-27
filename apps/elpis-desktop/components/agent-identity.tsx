/** One stable neutral mark per agent; callers supply only observed runtime model/provider values. */
export function AgentIdentity({ id, name, model, provider, compact = false, nameClassName }: {
  id: string; name: string; model?: string | null; provider?: string | null; compact?: boolean; nameClassName?: string;
}) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const mark = (hash >>> 0).toString(36).padStart(3, "0").slice(-3).toUpperCase();
  const runtime = [provider?.trim(), model?.trim()].filter(Boolean).join(" · ");
  return <span className="agent-identity inline-flex min-w-0 max-w-full items-center gap-2" data-compact={compact || undefined}>
    <span className={`agent-mark inline-flex shrink-0 items-center justify-center rounded border border-border bg-muted font-mono text-xs leading-none ${compact ? "size-7" : "size-8"}`} role="img" aria-label={`Agent mark ${mark}`}><svg aria-hidden="true" viewBox="0 0 9 9" className="size-5" fill="currentColor">{Array.from({ length: 28 }, (_, bit) => {
      if (!((hash >>> bit) & 1)) return null;
      const x = bit % 4, y = Math.floor(bit / 4);
      return <g key={bit}><rect x={x + 1} y={y + 1} width="0.8" height="0.8" />{x !== 3 && <rect x={7 - x} y={y + 1} width="0.8" height="0.8" />}</g>;
    })}</svg></span>
    <span className="agent-identity-text flex min-w-0 flex-col">
      <span className={`agent-name block truncate font-medium ${nameClassName || ""}`}>{name}</span>
      {runtime && <span className="agent-model block truncate text-xs text-muted-foreground" title={runtime}>{runtime}</span>}
    </span>
  </span>;
}
