"use client";

import { useRef, useState, type ElementType, type RefObject } from "react";
import { AtSign, Check, ChevronDown, Image as ImageIcon, SquareSlash, X } from "lucide-react";
import { AskIcon, AttachIcon, AutoApproveIcon, BypassIcon, FullAccessIcon, PlanIcon, PlusIcon } from "@/components/elpis-icons";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type PermissionMode = "ask" | "auto" | "full" | "bypass";

/** ChatGPT's three approval modes plus Elpis's Bypass permissions; the bridge maps each to Elpis
 * approval and sandbox settings. */
const MODES: { id: PermissionMode; label: string; /** What the button says when room is short. */ short: string; description: string; Icon: typeof AskIcon }[] = [
  { id: "ask", label: "Ask for approval", short: "Ask", description: "Always ask to edit files outside the workspace and to use the internet", Icon: AskIcon },
  { id: "auto", label: "Approve for me", short: "Auto", description: "Only ask for actions a reviewer judges potentially unsafe", Icon: AutoApproveIcon },
  { id: "full", label: "Full access", short: "Full", description: "Unrestricted access to the internet and any file on this computer", Icon: FullAccessIcon },
  { id: "bypass", label: "Bypass permissions", short: "Bypass", description: "Run anything without asking, even commands Elpis would otherwise refuse", Icon: BypassIcon },
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
        <current.Icon size={14} aria-hidden="true" /><span className="pill-long">{current.label}</span><span className="pill-short">{current.short}</span><ChevronDown size={14} aria-hidden="true" />
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

/** What the "+" menu does, one function each; the message box owns them. */
type PlusActions = { onAttach: () => void; onImages: () => void; onMention: () => void; onSlash: () => void; onPlan: (on: boolean) => void };

/** The "+" menu, as in the ChatGPT and Claude apps, limited to what Elpis runs: files, pictures, an @ mention, the
 * slash commands and Plan mode. Closing it returns the focus to the message box (`returnFocus`). */
export function PlusMenu({ disabled, attachDisabled, imagesDisabled, slashDisabled, plan, returnFocus, onAttach, onImages, onMention, onSlash, onPlan }: PlusActions & {
  disabled?: boolean; attachDisabled?: boolean; /** Why pictures cannot be added now, in a few words (a text-only model). */ imagesDisabled?: string | false;
  slashDisabled?: boolean; plan: boolean; returnFocus: RefObject<HTMLElement | null>;
}) {
  // An item that changes the message box (Mention, Slash commands) acts once the menu has closed and given the focus back.
  const afterClose = useRef<(() => void) | null>(null);
  const item = (Icon: ElementType, name: string, hint: string, props: { disabled?: boolean; onClick: () => void }, on?: boolean) =>
    <DropdownMenuItem className="hud-menu-item" {...props}><Icon aria-hidden="true" /><span className="grid gap-0.5"><span>{name}</span><small>{hint}</small></span>{on && <Check className="ml-auto" aria-label="On" />}</DropdownMenuItem>;
  return <DropdownMenu onOpenChangeComplete={open => { if (!open) { const run = afterClose.current; afterClose.current = null; run?.(); } }}>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="composer-plus" aria-label="Add files and more" title="Add files and more" disabled={disabled} />}><PlusIcon className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80" finalFocus={returnFocus}>
      <p className="hud-menu-title">Add</p>
      {item(AttachIcon, "Files", "Images, PDF or text, up to 3", { disabled: attachDisabled, onClick: onAttach })}
      {item(ImageIcon, "Images", imagesDisabled || "PNG, JPEG, WebP or GIF", { disabled: attachDisabled || !!imagesDisabled, onClick: onImages })}
      {item(AtSign, "Mention", "A file in this project or another chat", { onClick: () => { afterClose.current = onMention; } })}
      {item(SquareSlash, "Slash commands", slashDisabled ? "Clear the message box first" : "Run a command such as /model or /review", { disabled: slashDisabled, onClick: () => { afterClose.current = onSlash; } })}
      {item(PlanIcon, "Plan mode", plan ? "Turn plan mode off" : "Turn plan mode on", { onClick: () => onPlan(!plan) }, plan)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Shown beside "+" while Plan mode is on; its button turns it off. */
export function PlanPill({ disabled, onOff }: { disabled?: boolean; onOff: () => void }) {
  return <span className="composer-pill plan-pill"><PlanIcon size={14} aria-hidden="true" /><span>Plan</span><button type="button" aria-label="Turn plan mode off" title="Turn plan mode off" disabled={disabled} onClick={onOff}><X size={12} /></button></span>;
}
