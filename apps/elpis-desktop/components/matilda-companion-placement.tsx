"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { appStorage } from "@/lib/projects";
import { errorText } from "@/lib/error-text.mts";
import type { CompanionState } from "./matilda-companion-state";
import { savedPlace, chromeBottom, BEHIND, sized, FLOAT_KEY, SIZE } from "./matilda-companion-shared";

export function useCompanionPlacement(previous: CompanionState) {
  const { setError, suppressClick, state } = previous;
  // `place` is where she was put, and is what is saved. `shown` fits it to the window and keeps her off native browser
  // pages (they sit above the app renderer); fitting never rewrites `place`, so she goes back to it when there is room.
  const [place, setPlace] = useState(savedPlace),
    [shown, setShown] = useState({ left: 0, top: 0 });
  const placeRef = useRef(place);
  placeRef.current = place;
  const shownRef = useRef(shown);
  // A Workflows side panel goes over her: she stays where she was put and is cut off at its edge, so its Done and Run
  // buttons stay clickable (1 Nov: she covered them). Pages keep her place (the stays-put rule).
  const [hidden, setHidden] = useState(0);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    size: number;
    resize: boolean;
    moved: boolean;
  } | null>(null);
  // While she is held her chat keeps the side it opened on, so it moves with her instead of jumping across her.
  const [heldSide, setHeldSide] = useState<"top" | "bottom" | null>(null);
  const fit = () => {
    const { right, bottom, size } = placeRef.current;
    const whole = (value: number, min: number, max: number) =>
      Math.min(Math.max(Math.round(value), min), Math.max(min, Math.floor(max)));
    const chrome = chromeBottom();
    let left = whole(innerWidth - right - size, 0, innerWidth - size);
    const top = whole(innerHeight - bottom - size, chrome, innerHeight - size);
    // While she is dragged the page steps aside (browser-panel.tsx), so she follows the pointer over it; on release she
    // settles beside it (10 Nov recording: she jumped away from the pointer and slid under the page).
    // She keeps clear of the whole panel: above its page is the panel's own toolbar, where she sat half-hidden (10 Nov).
    const pages = drag.current?.moved ? [] : document.querySelectorAll(".browser-panel");
    for (const element of pages) {
      const pane = element.getBoundingClientRect();
      if (
        !pane.width ||
        !pane.height ||
        left >= pane.right ||
        left + size <= pane.left ||
        top >= pane.bottom ||
        top + size <= pane.top
      )
        continue;
      left = Math.max(0, Math.floor(pane.left - size - 4));
    }
    let under = 0;
    for (const element of document.querySelectorAll(BEHIND)) {
      const pane = element.getBoundingClientRect();
      if (
        !pane.width ||
        !pane.height ||
        left >= pane.right ||
        left + size <= pane.left ||
        top >= pane.bottom ||
        top + size <= pane.top
      )
        continue;
      under = Math.max(under, Math.ceil(left + size - pane.left));
    }
    setHidden(Math.min(under, size));
    if (left === shownRef.current.left && top === shownRef.current.top) return;
    shownRef.current = { left, top };
    setShown(shownRef.current);
  };
  // A drag or a key puts her somewhere new (or makes her bigger), starting from where she is shown.
  const put = (left: number, top: number, size = placeRef.current.size) => {
    const next = { right: Math.round(innerWidth - left - size), bottom: Math.round(innerHeight - top - size), size };
    placeRef.current = next;
    setPlace(next);
    fit();
  };
  const move = (x: number, y: number) => put(shownRef.current.left + x, shownRef.current.top + y);
  // Resizing keeps her bottom-right corner where it is, so she grows up and to the left, towards the handle.
  const resize = (size: number) => {
    const { left, top } = shownRef.current,
      now = placeRef.current.size,
      next = sized(size);
    put(left + now - next, top + now - next, next);
  };
  const save = async () => {
    try {
      const value = JSON.stringify(placeRef.current),
        storage = window.elpisDesktop?.storage;
      if (storage?.saveItem) await storage.saveItem(FLOAT_KEY, value);
      else appStorage().setItem(FLOAT_KEY, value);
    } catch {
      setError("Matilda's place could not be saved.");
    }
  };
  const grab = (resizing: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ...shownRef.current,
      size: placeRef.current.size,
      resize: resizing,
      moved: false,
    };
  };
  const pull = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    // A release the window never passed on (over its title bar, or outside it) ends the drag; she never follows a free pointer.
    if (!(event.buttons & 1)) {
      release();
      return;
    }
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) >= 4) {
      start.moved = true;
      setHeldSide(side);
      document.documentElement.classList.add("matilda-dragging");
    }
    if (!start.moved) return;
    event.stopPropagation();
    if (!start.resize) {
      put(start.left + dx, start.top + dy, start.size);
      return;
    }
    const next = sized(start.size - (dx + dy) / 2);
    put(start.left + start.size - next, start.top + start.size - next, next);
  };
  const release = () => {
    const start = drag.current;
    drag.current = null;
    if (!start?.moved) return;
    setHeldSide(null);
    document.documentElement.classList.remove("matilda-dragging");
    fit();
    suppressClick.current = true;
    requestAnimationFrame(() => {
      suppressClick.current = false;
    });
    void save();
  };
  const keys = (resizing: boolean) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 3 : 1,
      grow = (
        {
          "+": 1,
          "=": 1,
          "-": -1,
          _: -1,
          ...(resizing ? { ArrowUp: 1, ArrowLeft: 1, ArrowDown: -1, ArrowRight: -1 } : {}),
        } as Record<string, number>
      )[event.key];
    const delta = resizing
      ? undefined
      : (
          { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] } as Record<
            string,
            [number, number]
          >
        )[event.key];
    if (!grow && !delta) return;
    event.preventDefault();
    event.stopPropagation();
    if (grow) resize(placeRef.current.size + grow * SIZE.step * step);
    else move(delta![0] * step, delta![1] * step);
    void save();
  };
  useLayoutEffect(() => {
    if (state?.pinned) fit();
  }, [state?.pinned]);
  useEffect(() => {
    const resized = () => fit();
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  useEffect(() => {
    if (!state?.pinned) return;
    let panes: Element[] = [];
    const resized = new ResizeObserver(() => fit());
    const discover = () => {
      const next = [...document.querySelectorAll(`.browser-panel, ${BEHIND}`)];
      if (next.length === panes.length && next.every((pane, i) => pane === panes[i])) return;
      panes = next;
      resized.disconnect();
      panes.forEach(pane => resized.observe(pane));
      fit();
    };
    const changed = new MutationObserver(discover);
    changed.observe(document.body, { childList: true, subtree: true });
    discover();
    return () => {
      changed.disconnect();
      resized.disconnect();
    };
  }, [state?.pinned]);
  useEffect(() => {
    const capture = window.elpisDesktop?.screenCapture;
    if (!capture) return;
    void capture
      .setSession(state?.pinned ? (state.threadId ?? null) : null)
      .catch(cause => setError(errorText(cause, "Page capture could not connect.")));
    return () => {
      void capture.setSession(null).catch(() => {});
    };
  }, [state?.pinned, state?.threadId]);
  useEffect(() => () => document.documentElement.classList.remove("matilda-dragging"), []);
  const track = state?.music;
  const size = place.size,
    chrome = chromeBottom();
  const side = heldSide ?? (shown.top - chrome < 300 ? "bottom" : "top");
  // Her chat sits above her (below her near the top), right edges together, inside the window and below the title bar.
  const chatPlace = () => {
    const width = Math.min(340, innerWidth - 24),
      gap = 6,
      edge = 4;
    const left = Math.min(Math.max(shown.left + size - width, edge), innerWidth - edge - width) - shown.left;
    return side === "top"
      ? { left, width, bottom: size + gap, maxHeight: shown.top - gap - chrome - edge }
      : { left, width, top: size + gap, maxHeight: innerHeight - shown.top - size - gap - edge };
  };
  return { ...previous, shown, hidden, drag, put, grab, pull, release, keys, track, size, chrome, side, chatPlace };
}

export type CompanionPlacement = ReturnType<typeof useCompanionPlacement>;
