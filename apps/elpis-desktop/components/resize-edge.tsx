"use client";

import { useRef, useState } from "react";

/** A draggable edge that sets the width of the element it sits on: drag it, or focus it and press Left/Right; a
 * double-click restores the default. `grows` is the way the pointer moves to widen the element. */
export function ResizeEdge({ label, width, min, max, initial, grows, onResize }: {
  label: string; width: number; min: number; max: number; initial: number; grows: "left" | "right"; onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null), [dragging, setDragging] = useState(false);
  const sign = grows === "right" ? 1 : -1;
  const set = (next: number) => onResize(Math.min(max, Math.max(min, Math.round(next))));
  const end = () => { drag.current = null; setDragging(false); };
  return <div className="resize-edge" role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0} data-dragging={dragging || undefined}
    onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); set(width + (event.key === "ArrowRight" ? 16 : -16) * sign); } }}
    onDoubleClick={() => set(initial)}
    onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
    onPointerMove={event => { if (drag.current) set(drag.current.width + (event.clientX - drag.current.x) * sign); }}
    onPointerUp={end} onPointerCancel={end} />;
}
