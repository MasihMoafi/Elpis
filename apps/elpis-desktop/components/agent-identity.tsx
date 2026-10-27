/** One stable neutral mark per agent; callers supply only observed runtime model/provider values. */
export function AgentIdentity({ id, name, model, provider, compact = false, nameClassName }: {
  id: string; name: string; model?: string | null; provider?: string | null; compact?: boolean; nameClassName?: string;
}) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const mark = (hash >>> 0).toString(36).padStart(3, "0").slice(-3).toUpperCase();
  const runtime = [provider?.trim(), model?.trim()].filter(Boolean).join(" · ");
  return <span className="agent-identity inline-flex min-w-0 max-w-full items-center gap-2" data-compact={compact || undefined}>
    <span className={`agent-mark inline-flex shrink-0 items-center justify-center rounded border border-border bg-muted font-mono text-xs leading-none ${compact ? "size-7" : "size-8"}`} role="img" aria-label={`Agent mark ${mark}`}>{mark}</span>
    <span className="agent-identity-text flex min-w-0 flex-col">
      <span className={`agent-name block truncate font-medium ${nameClassName || ""}`}>{name}</span>
      {runtime && <span className="agent-model block truncate text-xs text-muted-foreground" title={runtime}>{runtime}</span>}
    </span>
  </span>;
}
