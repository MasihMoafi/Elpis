"use client";

import { useRef, useState } from "react";

/** Resizes its parent by pointer or Left/Right; a double-click restores the default. `grows` is the direction
 * that widens it. Releasing at the opposite window edge closes it, keeping its width from before the drag. */
export function ResizeEdge({ label, width, min, max = Infinity, initial, grows, onResize, onClose, className = "resize-edge", step = 16, onDraggingChange }: {
  label: string; width: number | null; min: number; max?: number; initial: number; grows: "left" | "right"; onResize: (width: number) => void;
  onClose?: () => void; className?: string; step?: number; onDraggingChange?: (dragging: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null), [dragging, setDragging] = useState(false);
  const sign = grows === "right" ? 1 : -1;
  const set = (next: number) => onResize(Math.min(max, Math.max(min, Math.round(next))));
  const currentWidth = (element: HTMLDivElement) => element.parentElement?.getBoundingClientRect().width ?? width ?? initial;
  const end = () => { drag.current = null; setDragging(false); onDraggingChange?.(false); };
  return <div className={className} role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={width ?? undefined} aria-valuemin={min} aria-valuemax={Number.isFinite(max) ? max : undefined} tabIndex={0} data-dragging={dragging || undefined}
    onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); set(currentWidth(event.currentTarget) + (event.key === "ArrowRight" ? step : -step) * sign); } }}
    onDoubleClick={() => set(initial)}
    onPointerDown={event => { if (event.button !== 0 || drag.current) return; drag.current = { x: event.clientX, width: currentWidth(event.currentTarget) }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); onDraggingChange?.(true); }}
    onPointerMove={event => { if (drag.current) set(drag.current.width + (event.clientX - drag.current.x) * sign); }}
    onPointerUp={event => {
      const start = drag.current, edge = grows === "left" ? event.clientX >= event.currentTarget.ownerDocument.documentElement.clientWidth - 1 : event.clientX <= 1;
      end();
      if (start && edge && onClose) { onResize(start.width); onClose(); }
    }} onPointerCancel={end} onLostPointerCapture={end} />;
}
