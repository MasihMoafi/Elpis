"use client";

import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { AskIcon, AttachIcon, AutoApproveIcon, BypassIcon, FullAccessIcon, PlanIcon, PlusIcon } from "@/components/elpis-icons";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type PermissionMode = "ask" | "auto" | "full" | "bypass";

/** ChatGPT's three approval modes plus Elpis's Bypass permissions; the bridge maps each to Elpis
 * approval and sandbox settings. */
const MODES: { id: PermissionMode; label: string; description: string; Icon: typeof AskIcon }[] = [
  { id: "ask", label: "Ask for approval", description: "Always ask to edit files outside the workspace and to use the internet", Icon: AskIcon },
  { id: "auto", label: "Approve for me", description: "Only ask for actions a reviewer judges potentially unsafe", Icon: AutoApproveIcon },
  { id: "full", label: "Full access", description: "Unrestricted access to the internet and any file on this computer", Icon: FullAccessIcon },
  { id: "bypass", label: "Bypass permissions", description: "Run anything without asking, even commands Elpis would otherwise refuse", Icon: BypassIcon },
];
/** A mode's name, as the permissions menu words it. */
export const permissionLabel = (mode: PermissionMode) => (MODES.find(item => item.id === mode) ?? MODES[0]).label;
/** Bypass permissions is root access: red wherever it is offered or active. `!` outranks the pill's own colour. */
const dangerous = (id: PermissionMode) => id === "bypass" ? "text-destructive!" : "";

export function PermissionsMenu({ mode, disabled, onChange }: { mode: PermissionMode; disabled?: boolean; onChange: (mode: PermissionMode) => void }) {
  const [confirming, setConfirming] = useState(false);
  const current = MODES.find(item => item.id === mode) ?? MODES[0];
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger className={`composer-pill permissions-${mode} ${dangerous(mode)}`} disabled={disabled} aria-label="Change permissions" title="Change permissions (Shift+Tab in the message box cycles Ask, Approve for me and Plan)">
        <current.Icon size={14} aria-hidden="true" /><span>{current.label}</span><ChevronDown size={13} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hud-menu w-80">
        <p className="hud-menu-title">How should Elpis's actions be approved?</p>
        {MODES.map(item => <DropdownMenuItem key={item.id} onClick={() => item.id === "bypass" && mode !== "bypass" ? setConfirming(true) : onChange(item.id)} className={`hud-menu-item ${dangerous(item.id)}`}>
          <item.Icon aria-hidden="true" className={dangerous(item.id)} />
          <span className="grid gap-0.5"><span>{item.label}</span><small>{item.description}</small></span>
          {item.id === mode && <Check className="ml-auto" aria-label="Current" />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    {/* Asked every time Bypass is chosen; Cancel has the focus. */}
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">Bypass permissions?</AlertDialogTitle>
          <AlertDialogDescription>
            Elpis will run anything without asking: any command, any file on this computer, the internet. It also runs commands it would otherwise refuse, such as rm -rf, and in new chats it runs enabled hooks you have not reviewed. Only your own rules, hooks and managed policy can still stop it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" autoFocus />}>Cancel</AlertDialogClose>
          <Button type="button" variant="destructive" onClick={() => { setConfirming(false); onChange("bypass"); }}>Bypass permissions</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

/** The ChatGPT app's "+" menu, limited to what Elpis runs: files and Plan mode. */
export function PlusMenu({ disabled, attachDisabled, plan, onAttach, onPlan }: { disabled?: boolean; attachDisabled?: boolean; plan: boolean; onAttach: () => void; onPlan: (on: boolean) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="composer-plus" aria-label="Add files and more" title="Add files and more" disabled={disabled} />}><PlusIcon className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80">
      <p className="hud-menu-title">Add</p>
      <DropdownMenuItem className="hud-menu-item" disabled={attachDisabled} onClick={onAttach}><AttachIcon aria-hidden="true" /><span className="grid gap-0.5"><span>Files</span><small>Images, PDF or text, up to 3</small></span></DropdownMenuItem>
      <DropdownMenuItem className="hud-menu-item" onClick={() => onPlan(!plan)}><PlanIcon aria-hidden="true" /><span className="grid gap-0.5"><span>Plan mode</span><small>{plan ? "Turn plan mode off" : "Turn plan mode on"}</small></span>{plan && <Check className="ml-auto" aria-label="On" />}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Shown beside "+" while Plan mode is on; its button turns it off. */
export function PlanPill({ disabled, onOff }: { disabled?: boolean; onOff: () => void }) {
  return <span className="composer-pill plan-pill"><PlanIcon size={14} aria-hidden="true" /><span>Plan</span><button type="button" aria-label="Turn plan mode off" title="Turn plan mode off" disabled={disabled} onClick={onOff}><X size={12} /></button></span>;
}
