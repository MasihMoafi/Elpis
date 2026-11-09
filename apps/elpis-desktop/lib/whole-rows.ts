"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Every scrolling list of rows shows its rows whole, never a part-painted first or last one (Masih, 30 Oct: "no
 * half-chat sizes should appear"). The list's scrollport is kept on row boundaries through scrolling, resizing and rows
 * arriving late: the first row is snapped whole, and the height is capped at the last whole row. `rowSelector` names the
 * rows that must be whole; `targets` the boundaries the scrollport may rest on (rows, headings). Used by the Settings
 * navigation; the sidebar's chat list uses useSteadyRowList. */
export function useWholeRows(ref: RefObject<HTMLElement | null>, rowSelector: string, targets: string) {
  useLayoutEffect(() => {
    const list = ref.current,
      sidebar = list?.parentElement;
    if (!list || !sidebar) return;
    let frame = 0,
      scrollTimer = 0;
    const fitRows = () => {
      frame = 0;
      const wasAtEnd = list.scrollTop >= list.scrollHeight - list.clientHeight - 0.5;
      list.style.maxHeight = "";
      list.style.marginTop = "";
      list.style.marginBottom = "";
      list.style.minHeight = "";
      const rows = [...list.querySelectorAll<HTMLElement>(rowSelector)].filter(
        row => row.getBoundingClientRect().height > 0,
      );
      // Reserve a row before measuring: a growing nav must scroll instead of
      // shrinking the chat list to zero and covering its click targets.
      if (rows[0]) list.style.minHeight = `${rows[0].getBoundingClientRect().height}px`;
      let viewport = list.getBoundingClientRect();
      if (viewport.height <= 0) return;

      const firstChat = rows.find(row => row.getBoundingClientRect().bottom > viewport.top + 0.5);
      if (firstChat) {
        let box = firstChat.getBoundingClientRect();
        const required = box.top < viewport.top - 0.5 ? box.height : box.bottom - viewport.top;
        if (required > viewport.height + 0.5) {
          list.style.minHeight = `${required}px`;
          viewport = list.getBoundingClientRect();
          box = firstChat.getBoundingClientRect();
        }
        if (box.top < viewport.top - 0.5) {
          if (wasAtEnd) {
            const firstFull = [...list.querySelectorAll<HTMLElement>(targets)].find(target => {
              const targetBox = target.getBoundingClientRect();
              return (
                targetBox.height > 0 && targetBox.top >= viewport.top - 0.5 && targetBox.bottom <= viewport.bottom + 0.5
              );
            });
            if (firstFull) {
              const offset = firstFull.getBoundingClientRect().top - viewport.top;
              const cap = viewport.height - offset;
              if (offset > 0.5 && cap >= firstFull.getBoundingClientRect().height - 0.5) {
                list.style.marginTop = `${offset}px`;
                list.style.maxHeight = `${cap}px`;
                list.style.marginBottom = "auto";
                list.scrollTop = list.scrollHeight;
                viewport = list.getBoundingClientRect();
              }
            }
          } else list.scrollTop = Math.max(0, list.scrollTop + box.top - viewport.top);
          viewport = list.getBoundingClientRect();
        }
      }

      const boundaries = [...list.querySelectorAll<HTMLElement>(targets)];
      const bottomPartial = boundaries.some(row => {
        const box = row.getBoundingClientRect();
        return box.top < viewport.bottom - 0.5 && box.bottom > viewport.bottom + 0.5;
      });
      if (!bottomPartial) return;
      const lastFull = boundaries
        .filter(target => {
          const box = target.getBoundingClientRect();
          return box.height > 0 && box.top >= viewport.top - 0.5 && box.bottom <= viewport.bottom + 0.5;
        })
        .at(-1);
      if (!lastFull) return;
      const cap = lastFull.getBoundingClientRect().bottom - viewport.top;
      if (cap > 0 && cap < viewport.height - 0.5) {
        list.style.maxHeight = `${cap}px`;
        list.style.marginBottom = "auto";
        if (wasAtEnd) list.scrollTop = list.scrollHeight;
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(fitRows);
    };
    const onScroll = () => {
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(schedule, 160);
    };
    const onScrollEnd = () => {
      window.clearTimeout(scrollTimer);
      schedule();
    };
    const rowSizes = new ResizeObserver(schedule);
    const observedRows = new Set<HTMLElement>();
    const observeRows = () => {
      const currentRows = new Set(list.querySelectorAll<HTMLElement>(targets));
      for (const row of observedRows)
        if (!currentRows.has(row)) {
          rowSizes.unobserve(row);
          observedRows.delete(row);
        }
      for (const row of currentRows)
        if (!observedRows.has(row)) {
          rowSizes.observe(row);
          observedRows.add(row);
        }
    };
    const layoutSizes = new ResizeObserver(schedule);
    layoutSizes.observe(sidebar);
    const usage = list.nextElementSibling;
    if (usage) layoutSizes.observe(usage);
    const mutations = new MutationObserver(() => {
      observeRows();
      schedule();
    });
    mutations.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observeRows();
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("scrollend", onScrollEnd);
    window.addEventListener("resize", schedule);
    fitRows();
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(scrollTimer);
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("scrollend", onScrollEnd);
      window.removeEventListener("resize", schedule);
      rowSizes.disconnect();
      layoutSizes.disconnect();
      mutations.disconnect();
    };
  }, [ref, rowSelector, targets]);
}

/** Neither edge of the sidebar's chat list moves while it scrolls (Masih, 9 Nov recording). Every row in the list is a
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
