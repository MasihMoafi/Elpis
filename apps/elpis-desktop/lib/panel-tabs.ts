/** The side panel lists terminals (kept by the page) and browser pages (kept by Electron) as one row of tabs.
 * Tabs stay in the order they first appeared, whichever kind they are; new ones go to the end. */
export function mergeOrder(previous: readonly string[], keys: readonly string[]): string[] {
  const known = new Set(keys), kept = previous.filter(key => known.has(key)), seen = new Set(kept);
  return [...kept, ...keys.filter(key => !seen.has(key))];
}

/** The tab to show after `key` closes: the one to its right, else the one to its left. */
export function neighbour(order: readonly string[], key: string): string | null {
  const at = order.indexOf(key), rest = order.filter(item => item !== key);
  return at < 0 ? rest.at(-1) ?? null : rest[Math.min(at, rest.length - 1)] ?? null;
}
