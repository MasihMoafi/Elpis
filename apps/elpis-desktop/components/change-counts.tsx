/** Added and removed lines, shared by Changes and the rewind preview. */
export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="change-counts whitespace-nowrap font-mono text-xs"><span className="add text-[var(--success)]">+{added}</span> <span className="del text-destructive">−{removed}</span></span>;
}
