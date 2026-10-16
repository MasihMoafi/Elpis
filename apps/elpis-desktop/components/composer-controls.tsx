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

/** The share of the context window in use, as ChatGPT's composer ring. */
export function ContextRing({ used, window }: { used: number; window: number }) {
  const share = Math.min(1, Math.max(0, used / window));
  const radius = 7, circumference = 2 * Math.PI * radius;
  const label = `Context: ${formatTokens(used)} of ${formatTokens(window)} (${Math.round(share * 100)}%)`;
  return <span className="context-ring" role="img" aria-label={label} title={label}>
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} className="context-ring-track" />
      <circle cx="9" cy="9" r={radius} className="context-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - share)} transform="rotate(-90 9 9)" />
    </svg>
  </span>;
}

const formatTokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
