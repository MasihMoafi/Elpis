/**
 * Opens a composer control (the model picker, the reasoning list, the permissions menu) the way a click does, for a slash command.
 * The control takes the focus as it opens. As it closes, Elpis's pickers put the focus back on their button, where typing opens
 * the picker again and Enter picks from it; so the focus goes to the composer instead.
 */
export function openControl(trigger: HTMLElement, composer: () => HTMLElement | null) {
  if (trigger.hasAttribute("disabled") || trigger.getAttribute("aria-disabled") === "true") return;
  let opened = false, timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => { observer.disconnect(); document.removeEventListener("focusin", onFocus, true); clearTimeout(timer); };
  const handBack = () => { finish(); composer()?.focus(); };
  // The picker returned the focus to its button as it closed.
  function onFocus(event: FocusEvent) { if (opened && event.target === trigger) handBack(); }
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    if (trigger.getAttribute("aria-expanded") === "true") { opened = true; return; }
    if (!opened) return;
    // Closed without the focus coming back to the button (it is nowhere, or still on the button): the composer has it.
    timer = setTimeout(() => { const active = document.activeElement; if (!active || active === document.body || active === trigger) handBack(); else finish(); }, 150);
  });
  observer.observe(trigger, { attributes: true, attributeFilter: ["aria-expanded"] });
  document.addEventListener("focusin", onFocus, true);
  trigger.click();
  timer = setTimeout(() => { if (!opened) finish(); }, 1500); // it never opened
}
