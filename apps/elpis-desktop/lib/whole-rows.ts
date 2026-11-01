"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Every scrolling list of rows shows its rows whole, never a part-painted first or last one (Masih, 30 Oct: "no
 * half-chat sizes should appear"). The list's scrollport is kept on row boundaries through scrolling, resizing and rows
 * arriving late: the first row is snapped whole, and the height is capped at the last whole row. `rowSelector` names the
 * rows that must be whole; `targets` the boundaries the scrollport may rest on (rows, headings). Used by the sidebar's chat
 * list and the Settings navigation. */
export function useWholeRows(ref: RefObject<HTMLElement | null>, rowSelector: string, targets: string) {
  useLayoutEffect(() => {
    const list = ref.current, sidebar = list?.parentElement;
    if (!list || !sidebar) return;
    let frame = 0, scrollTimer = 0;
    const fitRows = () => {
      frame = 0;
      const wasAtEnd = list.scrollTop >= list.scrollHeight - list.clientHeight - .5;
      list.style.maxHeight = "";
      list.style.marginTop = "";
      list.style.marginBottom = "";
      list.style.minHeight = "";
      let viewport = list.getBoundingClientRect();
      if (viewport.height <= 0) return;

      const rows = [...list.querySelectorAll<HTMLElement>(rowSelector)].filter(row => row.getBoundingClientRect().height > 0);
      const firstChat = rows.find(row => row.getBoundingClientRect().bottom > viewport.top + .5);
      if (firstChat) {
        let box = firstChat.getBoundingClientRect();
        const required = box.top < viewport.top - .5 ? box.height : box.bottom - viewport.top;
        if (required > viewport.height + .5) {
          list.style.minHeight = `${required}px`;
          viewport = list.getBoundingClientRect();
          box = firstChat.getBoundingClientRect();
        }
        if (box.top < viewport.top - .5) {
          if (wasAtEnd) {
            const firstFull = [...list.querySelectorAll<HTMLElement>(targets)].find(target => {
              const targetBox = target.getBoundingClientRect();
              return targetBox.height > 0 && targetBox.top >= viewport.top - .5 && targetBox.bottom <= viewport.bottom + .5;
            });
            if (firstFull) {
              const offset = firstFull.getBoundingClientRect().top - viewport.top;
              const cap = viewport.height - offset;
              if (offset > .5 && cap >= firstFull.getBoundingClientRect().height - .5) {
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

      const bottomPartial = rows.some(row => {
        const box = row.getBoundingClientRect();
        return box.top < viewport.bottom - .5 && box.bottom > viewport.bottom + .5;
      });
      if (!bottomPartial) return;
      const lastFull = [...list.querySelectorAll<HTMLElement>(targets)].filter(target => {
        const box = target.getBoundingClientRect();
        return box.height > 0 && box.top >= viewport.top - .5 && box.bottom <= viewport.bottom + .5;
      }).at(-1);
      if (!lastFull) return;
      const cap = lastFull.getBoundingClientRect().bottom - viewport.top;
      if (cap > 0 && cap < viewport.height - .5) {
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
    const onScrollEnd = () => { window.clearTimeout(scrollTimer); schedule(); };
    const rowSizes = new ResizeObserver(schedule);
    const observedRows = new Set<HTMLElement>();
    const observeRows = () => {
      const currentRows = new Set(list.querySelectorAll<HTMLElement>(targets));
      for (const row of observedRows) if (!currentRows.has(row)) { rowSizes.unobserve(row); observedRows.delete(row); }
      for (const row of currentRows) if (!observedRows.has(row)) { rowSizes.observe(row); observedRows.add(row); }
    };
    const layoutSizes = new ResizeObserver(schedule);
    layoutSizes.observe(sidebar);
    const usage = list.nextElementSibling;
    if (usage) layoutSizes.observe(usage);
    const mutations = new MutationObserver(() => { observeRows(); schedule(); });
    mutations.observe(list, { childList: true, subtree: true, characterData: true });
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
