"use client";

import { Check, ChevronDown, Lightbulb, Paperclip, X } from "lucide-react";
import { PlusIcon, ShieldIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type PermissionMode = "ask" | "auto" | "full";

/** ChatGPT's three approval modes; the bridge maps each to Elpis approval and sandbox settings. */
const MODES: { id: PermissionMode; label: string; description: string; Icon: typeof ShieldIcon }[] = [
  { id: "ask", label: "Ask for approval", description: "Always ask to edit files outside the workspace and to use the internet", Icon: ShieldIcon },
  { id: "auto", label: "Approve for me", description: "Only ask for actions a reviewer judges potentially unsafe", Icon: ShieldIcon },
  { id: "full", label: "Full access", description: "Unrestricted access to the internet and any file on this computer", Icon: ShieldIcon },
];

export function PermissionsMenu({ mode, disabled, onChange }: { mode: PermissionMode; disabled?: boolean; onChange: (mode: PermissionMode) => void }) {
  const current = MODES.find(item => item.id === mode) ?? MODES[0];
  return <DropdownMenu>
    <DropdownMenuTrigger className={`composer-pill permissions-${mode}`} disabled={disabled} aria-label="Change permissions">
      <current.Icon size={14} aria-hidden="true" /><span>{current.label}</span><ChevronDown size={13} aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80">
      <p className="hud-menu-title">How should Elpis's actions be approved?</p>
      {MODES.map(item => <DropdownMenuItem key={item.id} onClick={() => onChange(item.id)} className="hud-menu-item">
        <item.Icon aria-hidden="true" />
        <span className="grid gap-0.5"><span>{item.label}</span><small>{item.description}</small></span>
        {item.id === mode && <Check className="ml-auto" aria-label="Current" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The ChatGPT app's "+" menu, limited to what Elpis runs: files and Plan mode. */
export function PlusMenu({ disabled, attachDisabled, plan, onAttach, onPlan }: { disabled?: boolean; attachDisabled?: boolean; plan: boolean; onAttach: () => void; onPlan: (on: boolean) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="composer-plus" aria-label="Add files and more" title="Add files and more" disabled={disabled} />}><PlusIcon className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80">
      <p className="hud-menu-title">Add</p>
      <DropdownMenuItem className="hud-menu-item" disabled={attachDisabled} onClick={onAttach}><Paperclip aria-hidden="true" /><span className="grid gap-0.5"><span>Files</span><small>Images, PDF or text, up to 3</small></span></DropdownMenuItem>
      <DropdownMenuItem className="hud-menu-item" onClick={() => onPlan(!plan)}><Lightbulb aria-hidden="true" /><span className="grid gap-0.5"><span>Plan mode</span><small>{plan ? "Turn plan mode off" : "Turn plan mode on"}</small></span>{plan && <Check className="ml-auto" aria-label="On" />}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Shown beside "+" while Plan mode is on; its button turns it off. */
export function PlanPill({ disabled, onOff }: { disabled?: boolean; onOff: () => void }) {
  return <span className="composer-pill plan-pill"><Lightbulb size={14} aria-hidden="true" /><span>Plan</span><button type="button" aria-label="Turn plan mode off" title="Turn plan mode off" disabled={disabled} onClick={onOff}><X size={12} /></button></span>;
}
