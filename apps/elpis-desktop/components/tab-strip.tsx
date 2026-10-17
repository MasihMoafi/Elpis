"use client";

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RightClickMenu, type MenuAction } from "@/components/action-menu";

/** A row of tabs with a button after them (the strip scrolls to the shown tab; the button stays). The one tab style of
 * the top strip (chats) and the side panel (terminals and pages), as in the ChatGPT app and Obsidian. */
export function TabStrip({ label, add, activeKey, children }: { label: string; add: ReactNode; /** Changes when another tab is shown. */ activeKey: string | null; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[role="tab"][aria-selected="true"]')?.closest(".task-tab")?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [activeKey]);
  return <div className="tab-strip">
    <div ref={list} className="task-tabs" role="tablist" aria-label={label}>{children}</div>
    {add}
  </div>;
}

/** One tab: an icon and a title that select it, an optional "…" (`trailing`), and a close button.
 * Right-click opens `actions`, or `wrap` draws the menu around the tab (a chat's `ThreadActions`). */
export function Tab({ icon, label, title, active, chat, preview, closeLabel, actions, wrap, trailing, onSelect, onClose }: {
  icon: ReactNode; label: string; title?: string; active: boolean; chat?: boolean; /** A tab the next one replaces (a file previewed from the tree): drawn in italics. */ preview?: boolean; closeLabel: string;
  actions?: MenuAction[];
  wrap?: (area: ReactElement, content: (menu: ReactNode) => ReactNode) => ReactNode;
  trailing?: boolean;
  onSelect: () => void; onClose: () => void;
}) {
  const area = <div className={`task-tab${chat ? " chat-tab" : ""}${preview ? " preview" : ""}${active ? " active" : ""}`} />;
  const content = (menu: ReactNode) => <>
    <button type="button" role="tab" aria-selected={active} title={title ?? label} onClick={onSelect}>{icon}<span title={label}>{label}</span></button>
    {trailing && menu}
    <Button type="button" variant="ghost" size="icon-xs" aria-label={closeLabel} onClick={onClose}><X size={12} /></Button>
  </>;
  return wrap ? wrap(area, content) : <RightClickMenu actions={actions ?? []} area={area}>{content(null)}</RightClickMenu>;
}
