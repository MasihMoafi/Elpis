import type { KeyboardEvent } from "react";

/** Ctrl+A in a content pane (an open file, its preview, a diff) selects that pane's content and nothing else of the app (Masih, 23 Oct:
 * "inside of files in elpis when I press ctrl a it should only select all of that file"). One handler for every such pane: put it on the pane's
 * root as `onKeyDown` with `tabIndex={-1}`, so a click anywhere in the pane gives the pane focus. A text field keeps its own select-all;
 * `data-pane-content` marks the part to select (a textarea is selected as a field), and without it the whole pane is. */
export function selectPaneContent(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key" | "target" | "currentTarget" | "preventDefault">) {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "a") return;
  const pane = event.currentTarget as HTMLElement, target = event.target as HTMLElement, field = pane.querySelector<HTMLTextAreaElement>("textarea[data-pane-content]");
  if (target !== field && target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
  if (field) { field.focus(); field.select(); return; }
  selectElementContent(pane.querySelector("[data-pane-content]") ?? pane);
}

/** Select a readable content scope while excluding the rest of the application. */
export function selectElementContent(pane: Element) {
  const range = document.createRange(), selection = window.getSelection();
  range.selectNodeContents(pane); selection?.removeAllRanges(); selection?.addRange(range);
}
