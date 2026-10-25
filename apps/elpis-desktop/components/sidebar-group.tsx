"use client";

import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The class names each kind adds beside the shared `sidebar-group*` ones (a project's are the ones it always had). */
const KIND = {
  project: { group: "project-group", row: "project-row", toggle: "project-toggle", actions: "project-row-actions", items: "project-chats", empty: "project-empty" },
  chat: { group: "chat-group", row: "chat-group-row", toggle: "chat-group-toggle", actions: "chat-group-actions", items: "chat-group-chats", empty: "chat-group-empty" },
};

/** One collapsible group of chats in the sidebar: a project (`kind` "project"), or a group the person made ("chat"). The
 * header row opens and closes it; `wrap` gives the row its menu (right-click on the row and a "…" button, placed by
 * `wrap` as `menu`); `trailing` sits at the row's end (a project's "+"); `note` follows the name inside the toggle (a
 * group's waiting dot). Open, it lists `children`, or "No chats yet". `title` is the toggle's hover text (a project's
 * folder); without it the name shows itself in full on hover, since a long one is cut. */
export function SidebarGroup({ kind, name, title, icon, open, active, onToggle, wrap, trailing, note, children, empty, dropProps }: {
  dropProps?: HTMLAttributes<HTMLDivElement>;
  kind: keyof typeof KIND; name: string; title?: string; icon: ReactNode; open: boolean; active?: boolean; onToggle: () => void;
  wrap: (area: ReactElement, content: (menu: ReactNode) => ReactNode) => ReactNode; trailing?: ReactNode; note?: ReactNode; children: ReactNode; empty: boolean;
}) {
  const own = KIND[kind];
  return <div className={`sidebar-group ${own.group}`} role="group" aria-label={name} {...dropProps}>
    {wrap(<div className={`sidebar-group-row ${own.row}${active ? " active" : ""}`} />, menu => <>
      <button data-slot="group-toggle" type="button" className={`sidebar-group-toggle ${own.toggle}`} aria-expanded={open} title={title} onClick={onToggle}>
        <ChevronRight size={13} className="sidebar-group-chevron" aria-hidden="true" />{icon}<span className="sidebar-group-name" title={title === undefined ? name : undefined}>{name}</span>{note}
      </button>
      <span className={`sidebar-group-actions ${own.actions}`}>{menu}</span>{trailing}
    </>)}
    {open && <div className={`sidebar-group-items ${own.items}`}>{children}{empty && <p className={`sidebar-group-empty ${own.empty}`}>No chats yet</p>}</div>}
  </div>;
}

/** A section heading (Projects, Pinned, Recents) that folds its list, with the chevron a project row has. */
export function SectionToggle({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return <div className="section-label"><Button type="button" variant="ghost" size="logo" className="section-toggle" aria-expanded={open} onClick={onToggle}><ChevronRight size={14} className="section-chevron" aria-hidden="true" />{name}</Button></div>;
}
