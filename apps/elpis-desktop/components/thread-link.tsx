"use client";

import { useCallback, useRef, type ComponentProps } from "react";
import { Tooltip } from "@/components/ui/tooltip";

/** The same full-name label for every sidebar chat, positioned beyond the sidebar's text and controls. */
export function ThreadLink({ name, children, ...props }: Omit<ComponentProps<"button">, "title"> & { name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const anchor = useCallback(() => {
    const element = button.current, sidebar = element?.closest("aside.sidebar");
    if (!element || !sidebar) return element;
    return { contextElement: element, getBoundingClientRect: () => {
      const row = element.getBoundingClientRect(), edge = sidebar.getBoundingClientRect();
      return new DOMRect(edge.x, row.y, edge.width, row.height);
    } };
  }, []);
  return <Tooltip content={name} side="right" anchor={anchor}>
    <button {...props} ref={button}>{children}</button>
  </Tooltip>;
}
