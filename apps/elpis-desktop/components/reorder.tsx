"use client";

import { cloneElement, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type ReactElement, type Ref } from "react";

type Mark = "before" | "after" | "into";
type Place = { target: string; after: boolean; into: boolean };
type Options = {
  dragType: string;
  order: (id: string) => readonly string[];
  onMove: (id: string, place: Place) => void | Promise<void>;
  canDrop?: (id: string, target: string) => boolean;
  dropInto?: (id: string, target: string) => boolean;
};

/** The chat list's native drag interaction. Lists own their membership and save transaction; every row shares
 * the preview, insertion line, cancellation and keyboard movement. No wrapper changes the row or its menu. */
export function useReorder({ dragType, order, onMove, canDrop = () => true, dropInto = () => false }: Options) {
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; mark: Mark } | null>(null);
  const clear = () => { dragging.current = null; setDrop(null); };
  const allowed = (id: string, target: string) => id !== target && canDrop(id, target);
  function targetProps(key: string, into = false) {
    const over = (event: DragEvent<HTMLElement>) => {
      const id = dragging.current;
      if (!id || !event.dataTransfer.types.includes(dragType) || !allowed(id, key)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect();
      const mark = into || dropInto(id, key) ? "into" : event.clientY > box.top + box.height / 2 ? "after" : "before";
      setDrop(previous => previous?.id === key && previous.mark === mark ? previous : { id: key, mark });
    };
    return {
      "data-reorder": "target",
      "data-drop": drop?.id === key ? drop.mark : undefined,
      "data-drop-target": (into || drop?.mark === "into") && drop?.id === key || undefined,
      onDragEnter: over, onDragOver: over,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(previous => previous?.id === key ? null : previous);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const id = dragging.current, mark = drop?.id === key ? drop.mark : null;
        const accept = !!id && event.dataTransfer.types.includes(dragType) && allowed(id, key);
        clear();
        if (!id || !accept) return;
        event.preventDefault(); event.stopPropagation();
        onMove(id, { target: key, after: mark === "after", into: into || dropInto(id, key) });
      },
    };
  }
  function itemProps(id: string) {
    return {
      ...targetProps(id), "data-reorder": "item",
      "data-dragging": dragging.current === id && drop ? "" : undefined,
      draggable: true,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      onDragStart: (event: DragEvent<HTMLElement>) => {
        dragging.current = id; event.stopPropagation();
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, id);
      },
      onDragEnd: clear,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault(); event.stopPropagation();
        const ids = order(id), at = ids.indexOf(id), by = event.key === "ArrowUp" ? -1 : 1;
        const target = at < 0 ? undefined : ids[at + by];
        if (!target || !allowed(id, target)) return;
        const focused = document.activeElement;
        const saved = onMove(id, { target, after: by > 0, into: dropInto(id, target) });
        void Promise.resolve(saved).then(() => requestAnimationFrame(() => {
          if (focused instanceof HTMLElement && document.activeElement === document.body) {
            const next = focused.isConnected ? focused : focused.id ? document.getElementById(focused.id) : null;
            next?.focus();
          }
        }));
      },
    };
  }
  return { targetProps, itemProps };
}

export function ReorderItem({ reorder, itemId, enabled = true, render, ...props }: {
  reorder: ReturnType<typeof useReorder>; itemId: string; enabled?: boolean;
  render: ReactElement<HTMLAttributes<HTMLElement>>; ref?: Ref<HTMLElement>;
} & HTMLAttributes<HTMLElement>) {
  const bindings = enabled ? reorder.itemProps(itemId) : undefined;
  return cloneElement(render, {
    ...props, ...bindings,
    style: { ...render.props.style, ...props.style },
    className: [render.props.className, props.className].filter(Boolean).join(" "),
    onKeyDown: event => {
      bindings?.onKeyDown(event);
      if (!event.defaultPrevented) (props.onKeyDown ?? render.props.onKeyDown)?.(event);
    },
  });
}
