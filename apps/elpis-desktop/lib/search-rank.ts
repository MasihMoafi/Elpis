/** How well a chat matches a search, ranked as Zed's file finder ranks: the whole name, then the name's start, then the start of
 * a word in it, then anywhere in it, then the chat's other text (first message, folder). Higher is better; 0 is no match. */
export function searchScore(name: string, other: string, query: string): number {
  const q = query.trim().toLowerCase(), n = name.trim().toLowerCase();
  if (!q) return 0;
  if (n === q) return 1000;
  // A shorter name is the closer match among names that start the same way.
  if (n.startsWith(q)) return 900 - Math.min(n.length, 99);
  for (let at = n.indexOf(q); at > 0; at = n.indexOf(q, at + 1)) if (!/[\p{L}\p{N}]/u.test(n[at - 1])) return 700 - Math.min(n.length, 99);
  if (n.includes(q)) return 500 - Math.min(n.indexOf(q), 99);
  return other.toLowerCase().includes(q) ? 100 : 0;
}

/** The chats in order of how well they match; equal matches keep their given order (the list's recency). */
export function rankBySearch<T>(items: T[], query: string, name: (item: T) => string, other: (item: T) => string): T[] {
  const scores = new Map(items.map(item => [item, searchScore(name(item), other(item), query)]));
  return [...items].sort((a, b) => scores.get(b)! - scores.get(a)!);
}
