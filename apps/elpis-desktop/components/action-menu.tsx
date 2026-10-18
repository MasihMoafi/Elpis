"use client";

import { cloneElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** One thing to do with an object. An object defines its list once; its "…" button and its right-click menu both draw it.
 * `items` makes it a submenu of more actions; `checked` makes it one choice of a set (the actions beside it that also
 * have `checked`), drawn with a check when chosen; `separated` draws a line above it. */
export type MenuAction = { id: string; label: string; icon?: ReactNode; hint?: string; destructive?: boolean; run: () => void; items?: MenuAction[]; checked?: boolean; separated?: boolean };

/** Neighbouring choices (actions with `checked`) are one radio group; every other action stands alone. */
function runs(actions: MenuAction[]) {
  const out: MenuAction[][] = [];
  for (const action of actions) {
    const last = out.at(-1);
    if (action.checked !== undefined && last?.[0].checked !== undefined && !action.separated) last.push(action); else out.push([action]);
  }
  return out;
}

function ActionItems({ actions }: { actions: MenuAction[] }) {
  return <>{runs(actions).map(run => {
    const [first] = run, line = first.separated ? <DropdownMenuSeparator /> : null;
    if (first.checked !== undefined) return <DropdownMenuRadioGroup key={first.id} value={run.find(action => action.checked)?.id ?? null} onValueChange={id => run.find(action => action.id === id)?.run()}>
      {line}{run.map(action => <DropdownMenuRadioItem key={action.id} value={action.id} closeOnClick>{action.icon}{action.label}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>;
    if (first.items) return <DropdownMenuSub key={first.id}>{line}
      <DropdownMenuSubTrigger>{first.icon}{first.label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56"><ActionItems actions={first.items} /></DropdownMenuSubContent>
    </DropdownMenuSub>;
    return <ActionItem key={first.id} action={first} line={line} />;
  })}</>;
}

function ActionItem({ action, line }: { action: MenuAction; line: ReactNode }) {
  return <>{line}<DropdownMenuItem variant={action.destructive ? "destructive" : "default"} onClick={action.run} data-hint={action.hint?.toLowerCase()}>
    {action.icon}{action.label}{action.hint && <kbd aria-hidden="true" className="kbd-hint">{action.hint}</kbd>}
  </DropdownMenuItem></>;
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
