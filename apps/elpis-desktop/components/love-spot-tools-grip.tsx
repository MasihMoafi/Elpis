"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { GripHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

const KEY = "elpis-love-tools-offset";
const MARGIN = 8, STEP = 24, GRIP_WIDTH = 28, GRIP_HEIGHT = 15;

const saved = () => { try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; } };

/** Excalidraw centres its tool bar in the board, so with Talk open or in a narrow window the bar spills past an edge and
 * its tools cannot be reached. This handle slides the bar sideways by mouse or arrow keys; the offset is kept, and the bar
 * can always be brought back inside the board (double-click or Home puts it back in the middle). */
export function ToolsGrip({ board }: { board: RefObject<HTMLDivElement | null> }) {
  const [offset, setOffset] = useState(saved);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const current = useRef(offset); current.current = offset;
  const drag = useRef<{ x: number; start: number } | null>(null);

  /** The section around the tool bar: Excalidraw names it `shapes-section` on a wide board but not on a narrow one. */
  const bar = () => board.current?.querySelector<HTMLElement>(".App-toolbar")?.closest("section") ?? null;
  /** The offsets that keep the bar's ends in the board; a bar wider than the board can slide until either end shows. */
  const range = useCallback(() => {
    const area = board.current?.getBoundingClientRect(), section = bar()?.getBoundingClientRect();
    if (!area || !section) return null;
    const natural = { left: section.left - current.current, right: section.right - current.current };
    const a = area.left + MARGIN - natural.left, b = area.right - MARGIN - natural.right;
    return { min: Math.min(a, b), max: Math.max(a, b), area };
  }, [board]);
  const clamp = useCallback((value: number) => { const r = range(); return r ? Math.round(Math.min(r.max, Math.max(r.min, value))) : value; }, [range]);

  /** The handle sits in the free strip above the bar, over the part of the bar that shows, so it never covers a tool. */
  const measure = useCallback(() => {
    const area = board.current?.getBoundingClientRect(), section = bar()?.getBoundingClientRect();
    if (!area || !section) return;
    const shownLeft = Math.max(section.left, area.left), shownRight = Math.min(section.right, area.right);
    const left = Math.round(Math.max(4, Math.min(area.width - GRIP_WIDTH - 4, (shownLeft + shownRight) / 2 - area.left - GRIP_WIDTH / 2)));
    const top = Math.round(Math.max(0, section.top - area.top - GRIP_HEIGHT - 1));
    setSpot(previous => previous && previous.left === left && previous.top === top ? previous : { left, top });
  }, [board]);

  useEffect(() => {
    const area = board.current; if (!area) return;
    area.style.setProperty("--love-tools-x", `${offset}px`);
    measure();
  }, [board, offset, measure]);
  useEffect(() => {
    const area = board.current; if (!area) return;
    let frame = 0;
    const settle = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const next = clamp(current.current); if (next !== current.current) setOffset(next); else measure(); }); };
    const resize = new ResizeObserver(settle), mutations = new MutationObserver(settle);
    resize.observe(area); mutations.observe(area, { childList: true, subtree: true });
    settle();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); };
  }, [board, clamp, measure]);

  const keep = (value: number) => { setOffset(value); try { localStorage.setItem(KEY, String(value)); } catch { /* The position is a convenience. */ } };
  const down = (event: PointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, start: current.current }; };
  const move = (event: PointerEvent<HTMLButtonElement>) => { if (drag.current) setOffset(clamp(drag.current.start + event.clientX - drag.current.x)); };
  const up = () => { if (drag.current) { drag.current = null; keep(current.current); } };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    if (step) { event.preventDefault(); event.stopPropagation(); keep(clamp(current.current + step)); }
    else if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); keep(clamp(0)); }
  };

  if (!spot) return null;
  return <Button variant="ghost" size="icon-xs" className="love-tools-grip h-[15px] w-7 min-h-0 min-w-0 p-0" aria-label="Move tools" title="Drag to move the tools (double-click to put them back)"
    style={{ left: spot.left, top: spot.top }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onDoubleClick={() => keep(clamp(0))}>
    <GripHorizontal size={12} />
  </Button>;
}
