/** The ChatGPT app's shortcuts that Elpis implements. One list for the handler's documentation,
 * the Ctrl+/ dialog and Settings › Keyboard shortcuts; add a row only with its handler. */
export type Shortcut = { id: string; group: "Chat" | "Navigation" | "App"; label: string; keys: string[] };

export const SHORTCUTS: Shortcut[] = [
  { id: "new-chat", group: "Chat", label: "New chat", keys: ["Ctrl+N"] },
  { id: "rename", group: "Chat", label: "Rename chat", keys: ["Ctrl+Alt+R"] },
  { id: "archive", group: "Chat", label: "Archive chat", keys: ["Ctrl+Shift+A"] },
  { id: "pin", group: "Chat", label: "Toggle pin", keys: ["Ctrl+Alt+P"] },
  // Handled by the sidebar's chat list (app/page.tsx), where the row has focus.
  { id: "delete", group: "Chat", label: "Delete the selected chats in the sidebar", keys: ["D"] },
  { id: "select-chats", group: "Chat", label: "Select several chats in the sidebar (Esc clears)", keys: ["Ctrl+click", "Shift+click"] },
  { id: "search", group: "Navigation", label: "Search chats", keys: ["Ctrl+K"] },
  { id: "previous-chat", group: "Navigation", label: "Previous chat", keys: ["Ctrl+Shift+[", "Ctrl+PageUp"] },
  { id: "next-chat", group: "Navigation", label: "Next chat", keys: ["Ctrl+Shift+]", "Ctrl+PageDown"] },
  { id: "go-to-chat", group: "Navigation", label: "Go to chat 1–9", keys: ["Alt+1…9"] },
  { id: "list-chat", group: "Navigation", label: "Previous or next chat in the sidebar", keys: ["↑", "↓"] },
  { id: "new-tab", group: "App", label: "Open browser tab", keys: ["Ctrl+T"] },
  { id: "sidebar", group: "App", label: "Toggle sidebar", keys: ["Ctrl+Shift+S", "Ctrl+B"] },
  { id: "copy-folder", group: "App", label: "Copy working directory", keys: ["Ctrl+Shift+C"] },
  { id: "settings", group: "App", label: "Settings", keys: ["Ctrl+,"] },
  { id: "shortcuts", group: "App", label: "Show keyboard shortcuts", keys: ["Ctrl+/"] },
];

/** Which shortcut a key event triggers, if any. `typing` is true inside text fields, where only
 * shortcuts with Ctrl apply. */
export function shortcutFor(event: KeyboardEvent, typing: boolean): { id: string; index?: number } | null {
  const ctrl = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (ctrl && !event.altKey && !event.shiftKey) {
    if (key === "n") return { id: "new-chat" };
    if (key === "k") return { id: "search" };
    if (key === "b") return { id: "sidebar" };
    if (key === "t") return { id: "new-tab" };
    if (key === ",") return { id: "settings" };
    if (key === "/") return { id: "shortcuts" };
    if (key === "pageup") return { id: "previous-chat" };
    if (key === "pagedown") return { id: "next-chat" };
  }
  if (ctrl && event.shiftKey && !event.altKey) {
    if (key === "s") return { id: "sidebar" };
    if (key === "a") return { id: "archive" };
    if (key === "c" && !typing) return { id: "copy-folder" };
    if (event.code === "BracketLeft") return { id: "previous-chat" };
    if (event.code === "BracketRight") return { id: "next-chat" };
  }
  if (ctrl && event.altKey && !event.shiftKey) {
    if (key === "r") return { id: "rename" };
    if (key === "p") return { id: "pin" };
  }
  if (event.altKey && !ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) return { id: "go-to-chat", index: Number(event.code.slice(5)) - 1 };
  return null;
}
