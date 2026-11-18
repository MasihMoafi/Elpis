/** Selection by visible order, shared by chat rows, chat tabs and browser tabs. */
export function selectInOrder(keys: string[], selected: string[], anchor: string | null, key: string,
  event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  const toggle = event.ctrlKey || event.metaKey;
  if (event.shiftKey) {
    const to = keys.indexOf(key), at = anchor === null ? -1 : keys.indexOf(anchor), from = at < 0 ? to : at;
    const range = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
    return toggle ? [...new Set([...selected, ...range])] : range;
  }
  if (!toggle) return [key];
  return selected.includes(key) ? selected.filter(id => id !== key) : [...selected, key];
}
