"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Grip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appStorage } from "@/lib/projects";

const KEY = "elpis-love-bars", LEGACY_KEY = "elpis-love-tools-offset";
const MARGIN = 8, GAP = 6, STEP = 24, HANDLE = 24;
/** The board's controls that stay where they are: the main menu, the help button, the shape properties and the library panel. */
const FIXED = ".App-menu_top__left, .layer-ui__wrapper__footer-right, .layer-ui__wrapper__footer-left, .App-bottom-bar > .Island, .App-menu__left, .sidebar";

/** The bars the person can move, each found in Excalidraw's own layout, wide or narrow (a small window makes it narrow). */
const BARS = [
  { id: "tools", label: "Move tools", find: (board: HTMLElement) => board.querySelector<HTMLElement>(".App-toolbar")?.closest("section") ?? null },
  { id: "extras", label: "Move lock and hand", find: (board: HTMLElement) => board.querySelector<HTMLElement>(".mobile-misc-tools-container") },
] as const;
type BarId = (typeof BARS)[number]["id"];
type Offset = { x: number; y: number };
type Offsets = Record<BarId, Offset>;
type Spots = Partial<Record<BarId, { left: number; top: number }>>;

const ORIGIN: Offset = { x: 0, y: 0 };
const same = (a: Offset, b: Offset) => a.x === b.x && a.y === b.y;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
/** Kept as JSON by bar; the first version kept the tool bar's sideways offset alone, as a number. */
const saved = (): Offsets => {
  const offsets: Offsets = { tools: ORIGIN, extras: ORIGIN };
  try {
    const raw = appStorage().getItem(KEY);
    if (raw) { const parsed = JSON.parse(raw); for (const { id } of BARS) offsets[id] = { x: number(parsed?.[id]?.x), y: number(parsed?.[id]?.y) }; }
    else offsets.tools = { x: number(Number(appStorage().getItem(LEGACY_KEY))), y: 0 };
  } catch { /* A position is a convenience. */ }
  return offsets;
};

/** Excalidraw centres its tool bar at the top of the board and keeps its other bars in fixed corners, so in a narrow
 * window they sit on one another or spill past an edge. Each bar has this handle, a 3 by 3 grid of dots to the right of the bar: it
 * moves the bar anywhere in the board, by mouse or arrow keys, and the bar stops against the other controls and bars instead of
 * covering them. The place is kept; double-click or Home puts the bar back where Excalidraw puts it. */
export function MovableBars({ board }: { board: RefObject<HTMLDivElement | null> }) {
  const [offsets, setOffsets] = useState(saved);
  const [spots, setSpots] = useState<Spots>({});
  const current = useRef(offsets); current.current = offsets;
  const drag = useRef<{ id: BarId; x: number; y: number; start: Offset } | null>(null);

  const element = useCallback((id: BarId) => { const area = board.current; return area ? BARS.find(bar => bar.id === id)!.find(area) : null; }, [board]);
  /** Where the bar would stand with no offset, as a rectangle in the page. */
  const natural = useCallback((id: BarId) => {
    const box = element(id)?.getBoundingClientRect(); if (!box) return null;
    const { x, y } = current.current[id];
    return { left: box.left - x, right: box.right - x, top: box.top - y, bottom: box.bottom - y };
  }, [element]);
  /** The offsets that keep the bar in the board with room for its handle on the right; a bar wider or taller than the board can slide until either end shows. */
  const clamp = useCallback((id: BarId, value: Offset): Offset => {
    const area = board.current?.getBoundingClientRect(), base = natural(id);
    if (!area || !base) return value;
    const span = (low: number, high: number, v: number) => Math.round(Math.min(Math.max(low, high), Math.max(Math.min(low, high), v)));
    return { x: span(area.left + MARGIN - base.left, area.right - MARGIN - HANDLE - GAP - base.right, value.x), y: span(area.top + MARGIN - base.top, area.bottom - MARGIN - base.bottom, value.y) };
  }, [board, natural]);
  /** Whether the bar and its handle, standing at `value`, would touch a fixed control or another bar. */
  const blocked = useCallback((id: BarId, value: Offset) => {
    const base = natural(id); if (!base) return false;
    const left = base.left + value.x - GAP, right = base.right + value.x + GAP + HANDLE + GAP, top = base.top + value.y - GAP, bottom = base.bottom + value.y + GAP;
    const others = [...(board.current?.querySelectorAll<HTMLElement>(FIXED) ?? []), ...BARS.filter(bar => bar.id !== id).map(bar => element(bar.id))];
    return others.some(other => {
      const box = other?.getBoundingClientRect();
      return !!box && box.width > 0 && box.height > 0 && box.left < right && box.right > left && box.top < bottom && box.bottom > top;
    });
  }, [board, element, natural]);
  /** The nearest place to `target` the bar may stand: the target itself, else sliding along one axis, else where it was. */
  const place = (id: BarId, target: Offset) => {
    const from = current.current[id], wanted = clamp(id, target);
    return [wanted, { x: wanted.x, y: from.y }, { x: from.x, y: wanted.y }].find(candidate => !blocked(id, candidate)) ?? from;
  };
  /** One arrow stroke: a step, which stops short of another control; a bar already on one goes on to the first free place. */
  const step = (id: BarId, dx: number, dy: number) => {
    const from = current.current[id], onControl = blocked(id, from);
    for (let k = 1; k <= 60; k++) {
      const next = clamp(id, { x: from.x + dx * k, y: from.y + dy * k });
      if (same(next, from)) break;
      if (!blocked(id, next)) return next;
      if (!onControl) break;
    }
    return from;
  };

  /** Each handle sits to the right of its bar, level with its middle; with no room there it goes to the left. A bar that fills the board gets its handle
   * at the board's right edge, below the bar (above it, or over its end only when neither has room), so it never hides a tool. */
  const measure = useCallback(() => {
    const area = board.current?.getBoundingClientRect(); if (!area) return;
    const next: Spots = {};
    for (const { id } of BARS) {
      const box = element(id)?.getBoundingClientRect(); if (!box || !box.width) continue;
      const level = Math.max(0, Math.min(area.height - HANDLE, box.top - area.top + (box.height - HANDLE) / 2));
      const right = box.right - area.left + GAP, left = box.left - area.left - GAP - HANDLE;
      const below = box.bottom - area.top + GAP, above = box.top - area.top - GAP - HANDLE;
      const spot = right + HANDLE + 4 <= area.width ? { left: right, top: level }
        : left >= 4 ? { left, top: level }
        : { left: area.width - HANDLE - 4, top: below + HANDLE <= area.height ? below : above >= 0 ? above : level };
      next[id] = { left: Math.round(spot.left), top: Math.round(spot.top) };
    }
    setSpots(previous => BARS.every(({ id }) => previous[id]?.left === next[id]?.left && previous[id]?.top === next[id]?.top) ? previous : next);
  }, [board, element]);

  useEffect(() => {
    const area = board.current; if (!area) return;
    for (const { id } of BARS) { area.style.setProperty(`--love-${id}-x`, `${offsets[id].x}px`); area.style.setProperty(`--love-${id}-y`, `${offsets[id].y}px`); }
    measure();
  }, [board, offsets, measure]);
  useEffect(() => {
    const area = board.current; if (!area) return;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = { ...current.current }; let moved = false;
        for (const { id } of BARS) { const fitted = clamp(id, current.current[id]); if (!same(fitted, current.current[id])) { next[id] = fitted; moved = true; } }
        if (moved) setOffsets(next); else measure();
      });
    };
    const resize = new ResizeObserver(settle), mutations = new MutationObserver(settle);
    resize.observe(area); mutations.observe(area, { childList: true, subtree: true });
    settle();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); };
  }, [board, clamp, measure]);

  const keep = (id: BarId, value: Offset) => {
    const next = { ...current.current, [id]: value };
    setOffsets(next);
    try { appStorage().setItem(KEY, JSON.stringify(next)); } catch { /* The position is a convenience. */ }
  };
  const down = (id: BarId) => (event: PointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id, x: event.clientX, y: event.clientY, start: current.current[id] }; };
  const move = (event: PointerEvent<HTMLButtonElement>) => { const from = drag.current; if (from) setOffsets({ ...current.current, [from.id]: place(from.id, { x: from.start.x + event.clientX - from.x, y: from.start.y + event.clientY - from.y }) }); };
  const up = () => { const from = drag.current; if (from) { drag.current = null; keep(from.id, current.current[from.id]); } };
  const key = (id: BarId) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const by = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
    if (by) { event.preventDefault(); event.stopPropagation(); keep(id, step(id, by[0], by[1])); }
    else if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); keep(id, clamp(id, ORIGIN)); }
  };

  return <>{BARS.map(({ id, label }) => spots[id] && <Button key={id} variant="ghost" size="icon-xs" className="love-tools-grip size-6 min-h-0 min-w-0 p-0" aria-label={label}
    title="Drag to move this bar anywhere (double-click to put it back)" style={spots[id]} onPointerDown={down(id)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    onKeyDown={key(id)} onDoubleClick={() => keep(id, clamp(id, ORIGIN))}>
    <Grip size={14} />
  </Button>)}</>;
}
