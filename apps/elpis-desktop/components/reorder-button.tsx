"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { move } from "@/lib/nav-order";

type Props = Omit<ComponentProps<typeof Button>, "onDragStart" | "onDragOver" | "onDrop" | "onKeyDown"> & {
  itemId: string;
  order: readonly string[];
  dragType: string;
  onReorder: (ids: string[]) => void;
};

/** One interaction for arranged navigation: native drag (Escape cancels), or Alt+Up/Down with focus kept on the item.
 * Plain arrows belong to the app's shared arrow navigation. Each list has its own drag type and persistence owner. */
export function ReorderButton({ itemId, order, dragType, onReorder, title, ...props }: Props) {
  return <Button {...props} draggable aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title={`${title ?? "Move"} (drag, or Alt+Up/Down, to reorder)`}
    onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, itemId); }}
    onDragOver={event => { if (event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
    onDrop={event => {
      const id = event.dataTransfer.getData(dragType);
      if (!order.includes(id) || id === itemId) return;
      event.preventDefault(); event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect();
      onReorder(move(order, id, { target: itemId, after: event.clientY > box.top + box.height / 2 }));
    }}
    onKeyDown={event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault(); event.stopPropagation();
      const control = event.currentTarget;
      onReorder(move(order, itemId, { by: event.key === "ArrowUp" ? -1 : 1 }));
      requestAnimationFrame(() => control.focus());
    }} />;
}
