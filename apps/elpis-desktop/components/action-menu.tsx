"use client";

import { cloneElement, type ReactElement, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** One thing to do with an object. An object defines its list once; its "…" button and its right-click menu both draw it. */
export type MenuAction = { id: string; label: string; icon?: ReactNode; hint?: string; destructive?: boolean; run: () => void };

function ActionItems({ actions }: { actions: MenuAction[] }) {
  return <>{actions.map(action => <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run}>
    {action.icon}{action.label}{action.hint && <kbd aria-hidden="true" className="kbd-hint">{action.hint}</kbd>}
  </DropdownMenuItem>)}</>;
}

/** Right-click anywhere in `area` (an element such as `<div className="row" />`, given its children here) opens `actions` at the pointer. */
export function RightClickMenu({ actions, area, menuClassName, children }: { actions: MenuAction[]; area: ReactElement; menuClassName?: string; children: ReactNode }) {
  if (!actions.length) return cloneElement(area, undefined, children);
  return <ContextMenu>
    <ContextMenuTrigger render={area}>{children}</ContextMenuTrigger>
    <ContextMenuContent className={menuClassName}><ActionItems actions={actions} /></ContextMenuContent>
  </ContextMenu>;
}

/** The "…" button that opens `actions` under itself. */
export function MoreMenu({ actions, label, title, className, size = 14, align, menuClassName }: {
  actions: MenuAction[]; label: string; title: string; className?: string; size?: number; align?: "start" | "end"; menuClassName?: string;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className={className} aria-label={label} title={title} />}><MoreHorizontal size={size} /></DropdownMenuTrigger>
    <DropdownMenuContent align={align} className={menuClassName}><ActionItems actions={actions} /></DropdownMenuContent>
  </DropdownMenu>;
}
