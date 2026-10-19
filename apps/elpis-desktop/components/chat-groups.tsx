"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ListFilter, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { groupNameProblem, isDefaultView, type ChatGroup, type ChatGroups, type GroupBy, type SortBy } from "@/lib/chat-groups";

const GROUP_BY: [GroupBy, string][] = [["custom", "Custom groups"], ["none", "None"]];
const SORT_BY: [SortBy, string][] = [["recency", "Last activity"], ["created", "Date created"], ["name", "Name"], ["manual", "Manual (drag or Alt+Up/Down)"]];

/** The sidebar's "Group and sort" button (Claude's filter button): Group by Custom groups or None, Sort by Last activity,
 * Date created or Name. The menu stays open while choosing, as Claude's does; away from the defaults the button is
 * marked and the menu offers Reset to defaults. */
export function GroupAndSortMenu({ state, onChange }: { state: ChatGroups; onChange: (change: Partial<Pick<ChatGroups, "groupBy" | "sortBy">>) => void }) {
  const changed = !isDefaultView(state), label = "Group and sort";
  const current = `${GROUP_BY.find(([value]) => value === state.groupBy)?.[1]} · ${SORT_BY.find(([value]) => value === state.sortBy)?.[1]}`;
  // Match the drawing width of the sidebar's filled plus icons inside the same 16px icon box.
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="group-sort" aria-label={label} title={changed ? `${label}: ${current}` : label} data-active={changed ? "true" : undefined} />}><ListFilter size={13} viewBox="-2 -2 28 28" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52" aria-label={label}>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.groupBy} onValueChange={value => onChange({ groupBy: value as GroupBy })}>
          {GROUP_BY.map(([value, name]) => <DropdownMenuRadioItem key={value} value={value}>{name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.sortBy} onValueChange={value => onChange({ sortBy: value as SortBy })}>
          {SORT_BY.map(([value, name]) => <DropdownMenuRadioItem key={value} value={value}>{name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {changed && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onChange({ groupBy: "none", sortBy: "recency" })}>Reset to defaults</DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Names a new group (`group` null) or renames one. A name must be new, in any case; `switches` says that creating it
 * shows the list by groups, as Claude's dialog does. Closed while `open` is false. */
export function GroupNameDialog({ open, state, group, switches, onSave, onClose }: {
  open: boolean; state: ChatGroups; group: ChatGroup | null; switches?: boolean; onSave: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(group?.name ?? ""); }, [open, group]);
  const problem = groupNameProblem(state, name, group?.id), shown = name.trim() && problem;
  return <AlertDialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{group ? "Rename group" : "New group"}</AlertDialogTitle>
        <AlertDialogDescription>{group ? "The group's chats stay in it." : switches ? "The list will switch to Custom groups to show it." : "Groups are kept on this computer."}</AlertDialogDescription>
      </AlertDialogHeader>
      <form aria-label={group ? "Rename group" : "New group"} className="grid gap-4" onSubmit={event => { event.preventDefault(); if (!problem) onSave(name.trim()); }}>
        <Input aria-label="Group name" placeholder="Group name" maxLength={80} value={name} onChange={event => setName(event.target.value)} autoFocus aria-invalid={shown ? true : undefined} aria-describedby={shown ? "group-name-problem" : undefined} />
        {shown && <p id="group-name-problem" role="alert" className="text-sm text-destructive">{problem}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
          <Button type="submit" disabled={!!problem}>{group ? "Save" : "Create group"}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}

/** A group's menu, on right-click of its row and on its "…" button: Rename group and Delete group. Deleting asks first;
 * the group's chats (`count` of them listed) go back under Recents, and no chat is archived or deleted. */
export function GroupActions({ group, state, count, area, children, onRename, onDelete }: {
  group: ChatGroup; state: ChatGroups; count: number; area: ReactElement; children: (menu: ReactNode) => ReactNode; onRename: (name: string) => void; onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false), [deleting, setDeleting] = useState(false);
  const actions: MenuAction[] = [
    { id: "rename", label: "Rename group", icon: <Pencil size={14} />, run: () => setRenaming(true) },
    { id: "delete", label: "Delete group", icon: <Trash2 size={14} />, destructive: true, run: () => setDeleting(true) },
  ];
  const contents = count === 0 ? "Nothing is in it." : count === 1 ? "The 1 chat in it will no longer be grouped." : `The ${count} chats in it will no longer be grouped.`;
  return <>
    <RightClickMenu actions={actions} area={area} menuClassName="w-48">
      {children(<MoreMenu actions={actions} label={`Group actions for ${group.name}`} title="Rename or delete this group" size={13} align="start" menuClassName="w-48" />)}
    </RightClickMenu>
    <GroupNameDialog open={renaming} state={state} group={group} onSave={name => { onRename(name); setRenaming(false); }} onClose={() => setRenaming(false)} />
    <AlertDialog open={deleting} onOpenChange={value => { if (!value) setDeleting(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete group?</AlertDialogTitle>
          <AlertDialogDescription>“{group.name}” will be removed. {contents}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => { setDeleting(false); onDelete(); }}>Delete group</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
