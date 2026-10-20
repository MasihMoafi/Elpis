/** Rule R12, one behaviour for the whole app: the arrow keys move between the buttons of a group, Home and End go to its
 * first and last. The group is the nearest element around the focused control that holds another control, never wider
 * than the landmark the control sits in (a dialog, region, menu, toolbar, nav, aside, main, header, footer, form or
 * labelled section). Both axes move: Down and Right go forward, Up and Left back, in page order; at an end nothing moves.
 * Controls that read the arrows themselves keep them: a component that handles a key marks it handled
 * (preventDefault), and text fields, sliders, the board, the drawing, editors and terminals are never entered.
 * A closed drop-down list is an ordinary button here, as in Claude Code's /config: Enter and Space open it
 * (components/ui/select.tsx stops it opening on the arrows). */
export const ARROW_CONTROL = 'button, a[href], summary, [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="switch"], [role="treeitem"], [role="radio"]:not(input), [role="checkbox"]:not(input)';
const OWN_KEYS = '[role="combobox"]:not([aria-haspopup="listbox"]), [role="slider"], [role="spinbutton"]';
const SKIP = '.xterm, .excalidraw, .react-flow, .cm-editor, [data-arrows="off"]';
const LANDMARK = 'dialog, [role="dialog"], [role="alertdialog"], [role="region"], [role="menu"], [role="listbox"], [role="toolbar"], [role="tablist"], [role="radiogroup"], [role="tree"], nav, aside, main, header, footer, form, section[aria-label]';
const STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 0, End: 0 };

/** Whether a control can take focus from the arrows: shown, enabled, and outside the zones that keep their own keys. */
export function arrowUsable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || element.closest(SKIP) || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
}

/** The controls the focused one moves among, in page order, or null when it is alone in its landmark. */
export function arrowGroup(control: HTMLElement): HTMLElement[] | null {
  const limit = control.parentElement?.closest(LANDMARK) ?? control.ownerDocument.body;
  for (let at = control.parentElement; at; at = at.parentElement) {
    const items = [...at.querySelectorAll(ARROW_CONTROL)].filter(arrowUsable);
    if (items.length > 1 && items.includes(control)) return items;
    if (at === limit) break;
  }
  return null;
}

/** The document's keydown listener (components/arrow-keys.tsx installs it once). */
export function onArrowKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.key in STEP)) return;
  const control = event.target instanceof HTMLElement ? event.target : null;
  if (!control || !control.matches(ARROW_CONTROL) || control.matches(OWN_KEYS) || !arrowUsable(control)) return;
  const items = arrowGroup(control);
  if (!items) return;
  const at = items.indexOf(control);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + STEP[event.key]));
  if (next === at) return;
  event.preventDefault();
  items[next].focus();
  items[next].scrollIntoView({ block: "nearest", inline: "nearest" });
}
