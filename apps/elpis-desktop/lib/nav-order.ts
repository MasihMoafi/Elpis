/** The sidebar's pages in the order the person arranged them: saved ids first (unknown ids dropped), then any page
 * not yet placed, in its default place. */
export function arrange<T extends { id: string }>(pages: readonly T[], saved: readonly string[]): T[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  const placed = saved.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  return [...new Set([...placed, ...pages])];
}
/** `ids` with `id` moved before `target` (or after it when `after`), or by `by` places; unchanged when not found. */
export function move(ids: readonly string[], id: string, place: { target: string; after: boolean } | { by: number }): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter(item => item !== id);
  let at: number;
  if ("by" in place) at = Math.max(0, Math.min(rest.length, from + place.by));
  else { const target = rest.indexOf(place.target); if (target < 0) return [...ids]; at = target + (place.after ? 1 : 0); }
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
