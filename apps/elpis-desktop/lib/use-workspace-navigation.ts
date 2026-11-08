import { useEffect, useRef, type RefObject } from "react";
import { letterKey } from "@/components/action-menu";
import { shortcutFor, shortcutInScope } from "@/lib/shortcuts";
import { selectElementContent } from "@/lib/pane-select";

export function useWorkspaceNavigation(shortcutAction: RefObject<(id: string, index?: number) => void>, view: RefObject<string>) {
  // The mouse's side buttons go back and forward, as in a browser.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup") shortcutAction.current(event.button === 3 ? "back" : "forward");
    };
    const types = ["mousedown", "mouseup", "auxclick"] as const;
    for (const type of types) window.addEventListener(type, onMouse);
    return () => { for (const type of types) window.removeEventListener(type, onMouse); };
  }, [shortcutAction]);
  // The ChatGPT app's shortcuts (lib/shortcuts.ts); the action reads this render's state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const textInput = target?.tagName === "INPUT" && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test((target as HTMLInputElement).type);
      const textField = !!target && (textInput || target.tagName === "TEXTAREA" || target.isContentEditable);
      const readOnly = textField && (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") && (target as HTMLInputElement | HTMLTextAreaElement).readOnly;
      const textContext = textField ? readOnly ? "read-only" : "editable" : "none";
      if (!typing && !event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyA") {
        event.preventDefault();
        const selection = window.getSelection(), anchor = selection?.anchorNode;
        const source = target === document.body ? (anchor instanceof Element ? anchor : anchor?.parentElement) : target;
        const scope = source?.closest(".chat-content, .canvas-error-details, [data-select-all-scope]");
        if (scope) selectElementContent(scope);
        return;
      }
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      const hit = shortcutFor(event, typing, textContext); if (!hit) return;
      if (!shortcutInScope(hit.id, view.current, !!target?.closest("aside.sidebar"), !!target?.closest('.side-panel, [role="menu"], [role="listbox"]'))) return;
      event.preventDefault(); shortcutAction.current(hit.id, hit.index);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [shortcutAction, view]);
}

/** Navigation moves focus; Enter activates the focused control. Menus and text editing keep their own keys. */
export function useSidebarKeys() {
  const arrowSelect = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const cancel = () => { clearTimeout(arrowSelect.current); arrowSelect.current = undefined; };
    document.addEventListener("focusout", cancel);
    return () => { document.removeEventListener("focusout", cancel); cancel(); };
  }, []);
  return function sidebarKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(".nav-list > button, input[aria-label='Search conversations'], .sidebar-group-toggle, .thread-row > .thread-link, [data-sidebar-stop]")]
      .filter(element => !element.matches(":disabled") && element.getClientRects().length > 0);
    const at = stops.indexOf(target);
    if (at < 0 || !event.currentTarget.contains(target)) return;
    if (target instanceof HTMLInputElement && target.value && (event.key === "Home" || event.key === "End")) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : Math.max(0, Math.min(stops.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    const destination = stops[index];
    destination?.focus();
    // Selection follows focus after a pause so holding the key does not open every row on the way.
    clearTimeout(arrowSelect.current);
    if (destination?.matches(".nav-list > button:not(.new-chat), .thread-row > .thread-link")) arrowSelect.current = setTimeout(() => {
      arrowSelect.current = undefined;
      if (destination.isConnected && document.activeElement === destination) destination.click();
    }, 150);
  };
}

/** Keys on a focused chat row: D deletes, U changes attention, and Escape clears the marks. */
export function sidebarListKeys(
  event: React.KeyboardEvent<HTMLDivElement>,
  marked: string[],
  clearMarked: () => void,
  attentionFor: (id: string) => { planReady: boolean; onComplete: () => void; onToggleRead: () => void },
  deleteChats: (ids: string[], focusAt?: number) => void,
  rowLinks: () => HTMLButtonElement[],
) {
  const target = event.target as HTMLElement;
  const id = target.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  if (!id || !event.currentTarget.contains(target) || event.ctrlKey || event.metaKey) return;
  if (event.altKey) return;
  if (event.key === "Escape" && marked.length) clearMarked();
  else if (letterKey(event) === "u") {
    const attention = attentionFor(id);
    if (attention.planReady) attention.onComplete(); else attention.onToggleRead();
  }
  else if (letterKey(event) === "d") deleteChats(marked.length ? marked : [id], rowLinks().findIndex(link => link.parentElement === target.closest(".thread-row")));
  else return;
  event.preventDefault();
}
