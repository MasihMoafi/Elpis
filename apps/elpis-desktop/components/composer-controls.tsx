"use client";

import { useEffect, useRef, useState, type ElementType, type RefObject } from "react";
import { AtSign, Check, ChevronDown, SquareSlash, Terminal, X, Zap } from "lucide-react";
import { AskIcon, AttachIcon, AutoApproveIcon, BypassIcon, FullAccessIcon, PlanIcon, PlusIcon } from "@/components/elpis-icons";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { FollowUpChoice } from "@/lib/preferences";
import type { PermissionRequirements } from "@/lib/api";
import { permissionAllowed } from "../bridge/permission-presets.mjs";

export type PermissionMode = "ask" | "auto" | "full" | "bypass";

/** ChatGPT's three approval modes plus Elpis's Bypass permissions; the bridge maps each to Elpis
 * approval and sandbox settings. */
export const PERMISSION_MODES: { id: PermissionMode; label: string; /** What the button says when room is short. */ short: string; description: string; Icon: typeof AskIcon }[] = [
  { id: "ask", label: "Ask for approval", short: "Ask", description: "Always ask to edit files outside the workspace and to use the internet", Icon: AskIcon },
  { id: "auto", label: "Approve for me", short: "Auto", description: "Only ask for actions a reviewer judges potentially unsafe", Icon: AutoApproveIcon },
  { id: "full", label: "Full access", short: "Full", description: "Unrestricted access to the internet and any file on this computer", Icon: FullAccessIcon },
  { id: "bypass", label: "Bypass permissions", short: "Bypass", description: "Run anything without asking, even commands Elpis would otherwise refuse", Icon: BypassIcon },
];
/** A mode's name, as the permissions menu words it. */
export const permissionLabel = (mode: PermissionMode) => (PERMISSION_MODES.find(item => item.id === mode) ?? PERMISSION_MODES[0]).label;
/** Bypass permissions is root access: red wherever it is offered or active. `!` outranks the pill's own colour. */
const dangerous = (id: PermissionMode) => id === "bypass" ? "text-destructive!" : "";

export function PermissionsMenu({ mode, disabled, managed, onChange }: { mode: PermissionMode; disabled?: boolean; managed?: PermissionRequirements; onChange: (mode: PermissionMode) => void }) {
  const [confirming, setConfirming] = useState(false);
  const current = PERMISSION_MODES.find(item => item.id === mode) ?? PERMISSION_MODES[0];
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger data-slot="composer-chip" className={`composer-pill permissions-${mode} ${dangerous(mode)}`} disabled={disabled} aria-label="Change permissions" aria-description={current.label} title={`${current.label}. Change permissions (Shift+Tab in the message box cycles Ask, Approve for me and Plan)`}>
        <current.Icon size={14} aria-hidden="true" /><span className="pill-long">{current.label}</span><span className="pill-short">{current.short}</span><ChevronDown size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hud-menu w-80">
        {PERMISSION_MODES.map(item => <DropdownMenuItem key={item.id} disabled={!permissionAllowed(item.id, managed)} title={!permissionAllowed(item.id, managed) ? "Restricted by managed settings" : undefined} onClick={() => item.id === "bypass" && mode !== "bypass" ? setConfirming(true) : onChange(item.id)} className={`hud-menu-item ${dangerous(item.id)}`}>
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
type PlusActions = { onAttach: () => void; onMention: () => void; onSlash: () => void; onPlan: (on: boolean) => void; onShell: () => void };

/** The "+" menu, as in the ChatGPT and Claude apps, limited to what Elpis runs: files (a picture is a file), an @ mention,
 * the slash commands and Plan mode. Closing it returns the focus to the message box (`returnFocus`). */
export function PlusMenu({ disabled, attachDisabled, slashDisabled, plan, returnFocus, onAttach, onMention, onSlash, onPlan, onShell, fast }: PlusActions & {
  disabled?: boolean; attachDisabled?: boolean;
  slashDisabled?: boolean; plan: boolean; returnFocus: RefObject<HTMLElement | null>;
  fast?: { on: boolean; disabled: boolean; onChange: () => void };
}) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const composer = returnFocus.current?.closest(".composer");
    if (!composer) return;
    const observer = new ResizeObserver(entries => setCompact(entries[0].contentRect.width <= 640));
    observer.observe(composer);
    return () => observer.disconnect();
  }, [returnFocus]);
  // An item that changes the message box (Mention, Slash commands) acts once the menu has closed and given the focus back.
  const afterClose = useRef<(() => void) | null>(null);
  const item = (Icon: ElementType, name: string, hint: string, props: { disabled?: boolean; onClick: () => void }, on?: boolean) =>
    <DropdownMenuItem className="hud-menu-item" {...props}><Icon aria-hidden="true" /><span className="grid gap-0.5"><span>{name}</span><small>{hint}</small></span>{on && <Check className="ml-auto" aria-label="On" />}</DropdownMenuItem>;
  return <DropdownMenu onOpenChangeComplete={open => { if (!open) { const run = afterClose.current; afterClose.current = null; run?.(); } }}>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="composer-plus" aria-label="Add files and more" title="Add files and more" disabled={disabled} />}><PlusIcon className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80" finalFocus={returnFocus}>
      <p className="hud-menu-title">Add</p>
      {item(AttachIcon, "Add files or photos", "Pictures, PDFs and text", { disabled: attachDisabled, onClick: onAttach })}
      {item(AtSign, "Mention", "A file in this project or another chat", { onClick: () => { afterClose.current = onMention; } })}
      {item(SquareSlash, "Slash commands", slashDisabled ? "Clear the message box first" : "Run a command such as /model or /review", { disabled: slashDisabled, onClick: () => { afterClose.current = onSlash; } })}
      {item(PlanIcon, "Plan mode", plan ? "Turn plan mode off" : "Turn plan mode on", { onClick: () => onPlan(!plan) }, plan)}
      {item(Terminal, "Run as a shell command", "Run a command directly in this project's shell", { onClick: () => { afterClose.current = onShell; } })}
      {compact && fast && item(Zap, "Fast mode", fast.on ? "Fast is on" : "Fast is off", { disabled: fast.disabled, onClick: fast.onChange }, fast.on)}


    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Shown beside "+" while Plan mode is on; its button turns it off. */
export function PlanPill({ disabled, onOff }: { disabled?: boolean; onOff: () => void }) {
  return <span className="composer-pill plan-pill"><PlanIcon size={14} aria-hidden="true" /><span>Plan</span><button data-slot="pill-remove" type="button" aria-label="Turn plan mode off" title="Turn plan mode off" disabled={disabled} onClick={onOff}><X size={12} /></button></span>;
}

/** Beside Send while a turn runs, as Claude's "More send options": sends this one message the way the send key does not
 * (Queue for later, or Send now when Settings queue by default). `choice` is that other way, with its key. Hidden in a
 * workspace under 680px wide, where the row of controls has no room for it; the keys still work. */
export function SendOptionsMenu({ choice, disabled, returnFocus, onChoose }: { choice: FollowUpChoice; disabled?: boolean; returnFocus: RefObject<HTMLElement | null>; onChoose: (follow: FollowUpChoice["follow"]) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="@max-[680px]/workspace:hidden" aria-label="More send options" title="More send options" disabled={disabled} />}><ChevronDown size={14} /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="top" finalFocus={returnFocus}>
      <DropdownMenuItem onClick={() => onChoose(choice.follow)}>{choice.label}<kbd aria-hidden="true" className="kbd-hint">{choice.keys}</kbd></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
