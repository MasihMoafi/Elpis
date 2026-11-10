"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Every scrolling list of rows shows its rows whole, never a part-painted first or last one (Masih, 30 Oct: "no
 * half-chat sizes should appear"). Used by the sidebar's chat list and the Settings navigation. */
/** Neither edge of a row list moves while it scrolls (Masih, 9 Nov recording). Every row in the list is a
 * whole number of `--row-h` (`.thread-list` in foundation.css) and the list's height is too, so each scroll stop starts and
 * ends on a row. The height changes only when the window or the rows do. */
export function useSteadyRowList(ref: RefObject<HTMLElement | null>, targets: string) {
  useLayoutEffect(() => {
    const list = ref.current,
      sidebar = list?.parentElement;
    if (!list || !sidebar) return;
    let frame = 0;
    const size = () => {
      frame = 0;
      const scrolled = list.scrollTop;
      list.style.maxHeight = "";
      list.style.marginBottom = "";
      const heights = [...list.querySelectorAll<HTMLElement>(targets)]
        .map(row => row.getBoundingClientRect().height)
        .filter(height => height > 0);
      if (!heights.length) return;
      const row = Math.min(...heights);
      // Reserve the tallest row: a growing nav must scroll instead of shrinking the list below a whole row.
      list.style.minHeight = `${Math.max(...heights)}px`;
      const whole = Math.floor((list.getBoundingClientRect().height + 0.5) / row) * row;
      if (whole > 0) {
        list.style.maxHeight = `${whole}px`;
        list.style.marginBottom = "auto";
      }
      list.scrollTop = scrolled;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(size);
    };
    const layout = new ResizeObserver(schedule);
    layout.observe(sidebar);
    if (list.nextElementSibling) layout.observe(list.nextElementSibling);
    const rows = new MutationObserver(schedule);
    rows.observe(list, { childList: true, subtree: true, characterData: true });
    size();
    return () => {
      window.cancelAnimationFrame(frame);
      layout.disconnect();
      rows.disconnect();
    };
  }, [ref, targets]);
}
