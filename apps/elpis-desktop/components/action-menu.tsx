"use client";

import { cloneElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** One thing to do with an object. An object defines its list once; its "…" button and its right-click menu both draw it. */
export type MenuAction = { id: string; label: string; icon?: ReactNode; hint?: string; destructive?: boolean; run: () => void };

function ActionItems({ actions }: { actions: MenuAction[] }) {
  return <>{actions.map(action => <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run} data-hint={action.hint?.toLowerCase()}>
    {action.icon}{action.label}{action.hint && <kbd aria-hidden="true" className="kbd-hint">{action.hint}</kbd>}
  </DropdownMenuItem>)}</>;
}

/** The letter key pressed, by its place on the keyboard, so D is D in a Persian layout too. */
export const letterKey = (event: KeyboardEvent<HTMLElement>) => /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();

/** The key shown beside an item picks it, as a click does (D for Delete, as in Claude's chat menu). */
function hintKeys(event: KeyboardEvent<HTMLElement>) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
  const item = event.currentTarget.querySelector<HTMLElement>(`[data-hint="${CSS.escape(letterKey(event))}"]`);
  if (!item) return;
  event.preventDefault(); item.click();
}

/** Right-click anywhere in `area` (an element such as `<div className="row" />`, given its children here) opens `actions` at the pointer. */
export function RightClickMenu({ actions, area, menuClassName, children }: { actions: MenuAction[]; area: ReactElement; menuClassName?: string; children: ReactNode }) {
  if (!actions.length) return cloneElement(area, undefined, children);
  return <ContextMenu>
    <ContextMenuTrigger render={area}>{children}</ContextMenuTrigger>
    <ContextMenuContent className={menuClassName} onKeyDown={hintKeys}><ActionItems actions={actions} /></ContextMenuContent>
  </ContextMenu>;
}

/** The "…" button that opens `actions` under itself. */
export function MoreMenu({ actions, label, title, className, size = 14, align, menuClassName }: {
  actions: MenuAction[]; label: string; title: string; className?: string; size?: number; align?: "start" | "end"; menuClassName?: string;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className={className} aria-label={label} title={title} />}><MoreHorizontal size={size} /></DropdownMenuTrigger>
    <DropdownMenuContent align={align} className={menuClassName} onKeyDown={hintKeys}><ActionItems actions={actions} /></DropdownMenuContent>
  </DropdownMenu>;
}
