/** The side panel lists terminals (kept by the page) and browser pages (kept by Electron) as one row of tabs.
 * Tabs keep their mixed order; newly inserted browser pages follow the native browser’s neighbours. */
export function mergeOrder(previous: readonly string[], keys: readonly string[], pages: readonly string[] = []): string[] {
  const known = new Set(keys), kept = previous.filter(key => known.has(key)), seen = new Set(kept);
  for (const key of keys.filter(key => !seen.has(key))) {
    const at = pages.indexOf(key), previousPage = at > 0 ? pages.slice(0, at).findLast(page => kept.includes(page)) : undefined;
    const nextPage = at >= 0 ? pages.slice(at + 1).find(page => kept.includes(page)) : undefined;
    const insert = previousPage ? kept.indexOf(previousPage) + 1 : nextPage ? kept.indexOf(nextPage) : kept.length;
    kept.splice(insert, 0, key);
  }
  return kept;
}

/** The tab to show after `key` closes: the one to its right, else the one to its left. */
export function neighbour(order: readonly string[], key: string): string | null {
  const at = order.indexOf(key), rest = order.filter(item => item !== key);
  return at < 0 ? rest.at(-1) ?? null : rest[Math.min(at, rest.length - 1)] ?? null;
}
