// Generated from skills/web-dev/behavior/history-shortcut.ts; sync.mjs --write; sha256=b956273d98648a796803633373d883bfc693918a76d2d7dceee685317eb5cc3c
/** Keyboard history uses the native modifier and remains usable on non-Latin layouts. */
export type HistoryKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> &
  Partial<Pick<KeyboardEvent, "defaultPrevented" | "isComposing">>;

export const isMacPlatform = (platform: string) => /^(Mac|iPhone|iPad|iPod)/i.test(platform);

// Prefer a logical Latin key (including Dvorak punctuation); use the physical
// key only when the current keyboard emits a non-Latin letter or mark.
export function shortcutLetter(event: HistoryKey, value: string): boolean {
  return (
    event.key.toLowerCase() === value ||
    // On the standard Arabic layout Shift+physical Z produces an ASCII tilde.
    (value === "z" && event.code === "KeyZ" && event.shiftKey && event.key === "~") ||
    (/^[\p{L}\p{M}]$/u.test(event.key) &&
      !/^\p{Script_Extensions=Latin}$/u.test(event.key) &&
      event.code === `Key${value.toUpperCase()}`)
  );
}

export function historyShortcut(event: HistoryKey, platform: string): "undo" | "redo" | null {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  const mac = isMacPlatform(platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  if (shortcutLetter(event, "z")) return event.shiftKey ? "redo" : "undo";
  return !mac && !event.shiftKey && shortcutLetter(event, "y") ? "redo" : null;
}
