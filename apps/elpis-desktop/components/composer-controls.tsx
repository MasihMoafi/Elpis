"use client";

import { Check, ChevronDown } from "lucide-react";
import { ShieldIcon } from "@/components/elpis-icons";
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
