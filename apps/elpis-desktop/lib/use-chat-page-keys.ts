import { useEffect, type RefObject } from "react";
import { announceScrollIntent } from "@/lib/scroll-intent";

/** The step PageUp/PageDown move a chat: one screen less one line, so the line read last stays in view
 * (specs/chat-scrolling.md C6). */
export function pageStep(clientHeight: number, lineHeight: number) {
  return Math.max(clientHeight - lineHeight, clientHeight / 2);
}

function lineHeightOf(element: Element) {
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight);
  return Number.isFinite(line) ? line : parseFloat(style.fontSize) * 1.5 || 20;
}

/** Whether a key belongs to the focused element rather than the chat: a text field keeps Home/End (caret moves), and a
 * message box keeps PageUp/PageDown only once its own text scrolls. Menus, dialogs and lists handle their own keys. */
function keptByFocus(target: EventTarget | null, key: string) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tree"], [role="grid"]'))
    return true;
  const editable =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  if (!editable) return false;
  if (key === "Home" || key === "End") return true;
  return target.scrollHeight > target.clientHeight + 1;
}

/** PageUp/PageDown move the open chat by one screen less one line and Home/End reach its ends, from anywhere in the
 * window but a field that needs the key (10 Nov, Masih: every aspect of chat scrolling as in the ChatGPT app). */
export function useChatPageKeys(scroll: RefObject<HTMLDivElement | null>, onMove: (toBottom: boolean) => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const scroller = scroll.current;
      if (!scroller || event.defaultPrevented || event.altKey || event.metaKey || event.shiftKey) return;
      if (!["PageUp", "PageDown", "Home", "End"].includes(event.key) || !scroller.getClientRects().length) return;
      // Only for the chat: focus on nothing, in the transcript or in the message box. Other panes keep their keys.
      const at = event.target;
      if (at !== document.body && !(at instanceof Element && at.closest(".chat-scroll-wrap, form.composer"))) return;
      // Ctrl+Home/End reach the ends even from the message box; plain Home/End there move its caret.
      if (event.ctrlKey ? !["Home", "End"].includes(event.key) : keptByFocus(event.target, event.key)) return;
      event.preventDefault();
      announceScrollIntent();
      const step = pageStep(scroller.clientHeight, lineHeightOf(scroller.querySelector(".message") ?? scroller));
      const top =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? scroller.scrollHeight
            : scroller.scrollTop + (event.key === "PageDown" ? step : -step);
      onMove(event.key === "End");
      scroller.scrollTo({ top });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scroll, onMove]);
}
