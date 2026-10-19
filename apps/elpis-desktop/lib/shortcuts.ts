/** The ChatGPT app's shortcuts that Elpis implements. One list for the handler's documentation,
 * the Ctrl+/ dialog and Settings › Keyboard shortcuts; add a row only with its handler. */
export type Shortcut = { id: string; group: "Chat" | "Navigation" | "App"; label: string; keys: string[] };

export const SHORTCUTS: Shortcut[] = [
  { id: "new-chat", group: "Chat", label: "New chat", keys: ["Ctrl+N"] },
  { id: "side-chat", group: "Chat", label: "Toggle side chat", keys: ["Ctrl+;"] },
  // Native File menu and the split surface own these handlers.
  { id: "new-window", group: "Chat", label: "New Session in New Window", keys: ["Ctrl+Shift+N"] },
  { id: "next-pane", group: "Navigation", label: "Focus next split view", keys: ["Ctrl+]"] },
  { id: "previous-pane", group: "Navigation", label: "Focus previous split view", keys: ["Ctrl+["] },
  { id: "open-split", group: "Navigation", label: "Open session in split view", keys: ["Alt+click"] },
  { id: "rename", group: "Chat", label: "Rename chat (F2 on a focused chat in the sidebar)", keys: ["Ctrl+Alt+R", "F2"] },
  { id: "archive", group: "Chat", label: "Archive chat", keys: ["Ctrl+Shift+A"] },
  { id: "pin", group: "Chat", label: "Toggle pin", keys: ["Ctrl+Alt+P"] },
  // Handled by the sidebar's chat list (app/page.tsx), where the row has focus.
  { id: "delete", group: "Chat", label: "Delete the selected chats in the sidebar", keys: ["D"] },
  { id: "select-chats", group: "Chat", label: "Select several chats in the sidebar (Esc clears)", keys: ["Ctrl+click", "Shift+click"] },
  { id: "undo-delete", group: "Chat", label: "Bring back the last deleted chat (outside text fields)", keys: ["Ctrl+Z"] },
  { id: "command-menu", group: "Navigation", label: "Command menu", keys: ["Ctrl+K"] },
  { id: "search", group: "Navigation", label: "Search chats", keys: ["Ctrl+Shift+K"] },
  { id: "previous-chat", group: "Navigation", label: "Previous chat", keys: ["Ctrl+Shift+[", "Ctrl+PageUp"] },
  { id: "next-chat", group: "Navigation", label: "Next chat", keys: ["Ctrl+Shift+]", "Ctrl+PageDown"] },
  { id: "go-to-chat", group: "Navigation", label: "Go to chat 1–9", keys: ["Alt+1…9"] },
  { id: "list-chat", group: "Navigation", label: "Previous or next chat in the sidebar", keys: ["↑", "↓"] },
  // Handled by the message box (app/page.tsx), as in Claude Code.
  { id: "cycle-mode", group: "Chat", label: "Cycle Ask for approval, Approve for me and Plan mode (in the message box)", keys: ["Shift+Tab"] },
  // Handled by the message box and the chat (app/page.tsx, lib/prompt-history.ts), as in Claude.
  { id: "stop", group: "Chat", label: "Stop the response", keys: ["Esc"] },
  { id: "edit-last", group: "Chat", label: "Edit your last message (in an empty message box)", keys: ["Esc Esc"] },
  { id: "prompt-history", group: "Chat", label: "Step through the messages you sent (in the message box)", keys: ["↑", "↓"] },
  { id: "search-history", group: "Chat", label: "Search the messages you sent (in the message box)", keys: ["Ctrl+R"] },
  { id: "new-tab", group: "Chat", label: "New chat tab", keys: ["Ctrl+T"] },
  { id: "close-tab", group: "Chat", label: "Close chat tab", keys: ["Ctrl+W"] },
  { id: "next-tab", group: "Navigation", label: "Next chat tab", keys: ["Ctrl+Tab"] },
  { id: "previous-tab", group: "Navigation", label: "Previous chat tab", keys: ["Ctrl+Shift+Tab"] },
  { id: "back", group: "Navigation", label: "Back to the previous chat or page", keys: ["Alt+←"] },
  { id: "forward", group: "Navigation", label: "Forward again", keys: ["Alt+→"] },
  { id: "terminal", group: "App", label: "Toggle terminal", keys: ["Ctrl+`"] },
  { id: "full-view", group: "App", label: "Toggle full view", keys: ["Ctrl+Shift+F"] },
  // Claude opens its Files pane with Ctrl+Shift+F, which here is the full view; Files takes the next free letter (VS Code's Explorer key).
  { id: "files", group: "App", label: "Toggle Files", keys: ["Ctrl+Shift+E"] },
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
    if (key === ";") return { id: "side-chat" };
    // In a text field Ctrl+Z stays the field's own undo.
    if (key === "z" && !typing) return { id: "undo-delete" };
    if (key === "k") return { id: "command-menu" };
    if (key === "b") return { id: "sidebar" };
    if (key === "t") return { id: "new-tab" };
    if (key === "w") return { id: "close-tab" };
    if (key === "tab") return { id: "next-tab" };
    if (event.code === "Backquote") return { id: "terminal" };
    if (key === ",") return { id: "settings" };
    if (key === "/") return { id: "shortcuts" };
    if (key === "pageup") return { id: "previous-chat" };
    if (key === "pagedown") return { id: "next-chat" };
  }
  if (ctrl && event.shiftKey && !event.altKey) {
    if (key === "k") return { id: "search" };
    if (key === "s") return { id: "sidebar" };
    if (key === "tab") return { id: "previous-tab" };
    if (key === "a") return { id: "archive" };
    if (key === "c" && !typing) return { id: "copy-folder" };
    if (key === "f") return { id: "full-view" };
    if (key === "e") return { id: "files" };
    if (event.code === "BracketLeft") return { id: "previous-chat" };
    if (event.code === "BracketRight") return { id: "next-chat" };
  }
  if (ctrl && event.altKey && !event.shiftKey) {
    if (key === "r") return { id: "rename" };
    if (key === "p") return { id: "pin" };
  }
  if (event.altKey && !ctrl && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return { id: event.key === "ArrowLeft" ? "back" : "forward" };
  if (event.altKey && !ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) return { id: "go-to-chat", index: Number(event.code.slice(5)) - 1 };
  return null;
}
