"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Every scrolling list of rows shows its rows whole, never a part-painted first or last one (Masih, 30 Oct: "no
 * half-chat sizes should appear"). The list's scrollport is kept on row boundaries through scrolling, resizing and rows
 * arriving late: the first row is snapped whole, and the height is capped at the last whole row. `rowSelector` names the
 * rows that must be whole; `targets` the boundaries the scrollport may rest on (rows, headings). Used by the Settings
 * navigation; the sidebar's chat list uses useSteadyRowList. */
export function useWholeRows(
  ref: RefObject<HTMLElement | null>,
  rowSelector: string,
  targets: string,
) {
  useLayoutEffect(() => {
    const list = ref.current,
      sidebar = list?.parentElement;
    if (!list || !sidebar) return;
    let frame = 0,
      scrollTimer = 0;
    const fitRows = () => {
      frame = 0;
      const wasAtEnd =
        list.scrollTop >= list.scrollHeight - list.clientHeight - 0.5;
      list.style.maxHeight = "";
      list.style.marginTop = "";
      list.style.marginBottom = "";
      list.style.minHeight = "";
      const rows = [...list.querySelectorAll<HTMLElement>(rowSelector)].filter(
        (row) => row.getBoundingClientRect().height > 0,
      );
      // Reserve a row before measuring: a growing nav must scroll instead of
      // shrinking the chat list to zero and covering its click targets.
      if (rows[0])
        list.style.minHeight = `${rows[0].getBoundingClientRect().height}px`;
      let viewport = list.getBoundingClientRect();
      if (viewport.height <= 0) return;

      const firstChat = rows.find(
        (row) => row.getBoundingClientRect().bottom > viewport.top + 0.5,
      );
      if (firstChat) {
        let box = firstChat.getBoundingClientRect();
        const required =
          box.top < viewport.top - 0.5 ? box.height : box.bottom - viewport.top;
        if (required > viewport.height + 0.5) {
          list.style.minHeight = `${required}px`;
          viewport = list.getBoundingClientRect();
          box = firstChat.getBoundingClientRect();
        }
        if (box.top < viewport.top - 0.5) {
          if (wasAtEnd) {
            const firstFull = [
              ...list.querySelectorAll<HTMLElement>(targets),
            ].find((target) => {
              const targetBox = target.getBoundingClientRect();
              return (
                targetBox.height > 0 &&
                targetBox.top >= viewport.top - 0.5 &&
                targetBox.bottom <= viewport.bottom + 0.5
              );
            });
            if (firstFull) {
              const offset =
                firstFull.getBoundingClientRect().top - viewport.top;
              const cap = viewport.height - offset;
              if (
                offset > 0.5 &&
                cap >= firstFull.getBoundingClientRect().height - 0.5
              ) {
                list.style.marginTop = `${offset}px`;
                list.style.maxHeight = `${cap}px`;
                list.style.marginBottom = "auto";
                list.scrollTop = list.scrollHeight;
                viewport = list.getBoundingClientRect();
              }
            }
          } else
            list.scrollTop = Math.max(
              0,
              list.scrollTop + box.top - viewport.top,
            );
          viewport = list.getBoundingClientRect();
        }
      }

      const boundaries = [...list.querySelectorAll<HTMLElement>(targets)];
      const bottomPartial = boundaries.some((row) => {
        const box = row.getBoundingClientRect();
        return (
          box.top < viewport.bottom - 0.5 && box.bottom > viewport.bottom + 0.5
        );
      });
      if (!bottomPartial) return;
      const lastFull = boundaries
        .filter((target) => {
          const box = target.getBoundingClientRect();
          return (
            box.height > 0 &&
            box.top >= viewport.top - 0.5 &&
            box.bottom <= viewport.bottom + 0.5
          );
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

/** The sidebar's chat list keeps one height while it scrolls, so its bottom edge stays put (Masih, 9 Nov recording: the
 * list grew and shrank by a row at every stop). The height is set only when the window or the rows change: it ends on the
 * last row that fits from the top of the list. Rows snap to that edge (`.thread-list` in foundation.css), which keeps the
 * last row whole; a row cut by the top edge is hidden with a clip, which needs no layout and so cannot move the rows. */
export function useSteadyRowList(
  ref: RefObject<HTMLElement | null>,
  targets: string,
) {
  useLayoutEffect(() => {
    const list = ref.current,
      sidebar = list?.parentElement;
    if (!list || !sidebar) return;
    let sizeFrame = 0,
      clipFrame = 0,
      scrollTimer = 0;
    const boxes = () =>
      [...list.querySelectorAll<HTMLElement>(targets)]
        .map((row) => row.getBoundingClientRect())
        .filter((box) => box.height > 0);
    const clipTop = () => {
      clipFrame = 0;
      const top = list.getBoundingClientRect().top;
      const cut = Math.max(
        0,
        ...boxes()
          .filter((box) => box.top < top - 0.5 && box.bottom > top + 0.5)
          .map((box) => box.bottom - top),
      );
      list.style.clipPath = cut ? `inset(${cut}px 0 0 0)` : "";
    };
    const size = () => {
      sizeFrame = 0;
      const scrolled = list.scrollTop;
      list.style.maxHeight = "";
      list.style.marginBottom = "";
      const rows = boxes();
      // Reserve the tallest row: a growing nav must scroll instead of shrinking the list below a whole row.
      if (rows[0])
        list.style.minHeight = `${Math.max(...rows.map((box) => box.height))}px`;
      const view = list.getBoundingClientRect();
      const fromTop = rows.map((box) => box.bottom - view.top + scrolled);
      const fits = Math.max(
        0,
        ...fromTop.filter((bottom) => bottom <= view.height + 0.5),
      );
      if (
        fits > 0 &&
        fits < view.height - 0.5 &&
        Math.max(...fromTop) > view.height + 0.5
      ) {
        list.style.maxHeight = `${fits}px`;
        list.style.marginBottom = "auto";
      }
      list.scrollTop = scrolled;
      clipTop();
    };
    const scheduleSize = () => {
      if (!sizeFrame) sizeFrame = window.requestAnimationFrame(size);
    };
    const scheduleClip = () => {
      if (!clipFrame) clipFrame = window.requestAnimationFrame(clipTop);
    };
    const onScroll = () => {
      list.style.clipPath = "";
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(scheduleClip, 160);
    };
    const onScrollEnd = () => {
      window.clearTimeout(scrollTimer);
      scheduleClip();
    };
    const layout = new ResizeObserver(scheduleSize);
    layout.observe(sidebar);
    if (list.nextElementSibling) layout.observe(list.nextElementSibling);
    const rows = new MutationObserver(scheduleSize);
    rows.observe(list, { childList: true, subtree: true, characterData: true });
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("scrollend", onScrollEnd);
    size();
    return () => {
      window.cancelAnimationFrame(sizeFrame);
      window.cancelAnimationFrame(clipFrame);
      window.clearTimeout(scrollTimer);
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("scrollend", onScrollEnd);
      layout.disconnect();
      rows.disconnect();
    };
  }, [ref, targets]);
}
