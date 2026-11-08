"use client";

import { ChevronDown, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } from "@/bridge/matilda-face.cts";
import { savePreferences, usePreferences } from "@/lib/preferences";
import { THEME_CHARACTER_LIST, useThemeCharacter } from "@/lib/theme-characters";

/** Love Spot and the companion share the same character and palette choice. */
export function MatildaCharacterPicker({ compact = false }: { compact?: boolean }) {
  const { selectedPalette } = usePreferences(), character = useThemeCharacter();
  const selectedStyle = { background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--primary)", fontWeight: 600 };
  const matilda = <>
    <img src={MATILDA_SHOTS_LIGHT.softSmile} alt="" className="absolute inset-0 size-full object-contain dark:hidden" />
    <img src={MATILDA_SHOTS.softSmile} alt="" className="absolute inset-0 hidden size-full object-contain dark:block" />
  </>;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-xs" : "sm"} aria-label="Character" title={compact ? "Change character" : character ? `${character.name} · ${character.theme}` : "Matilda · Default"} className={compact ? "shrink-0" : "shrink-0 gap-1.5 px-2"} />}>
      {compact ? <UsersRound aria-hidden="true" /> : <span className="relative size-4 shrink-0">{character ? <img src={character.image} alt="" className="size-full object-contain" /> : matilda}</span>}
      {!compact && <><span className="love-spot-label max-w-28 truncate">{character?.name ?? "Matilda"}</span><ChevronDown aria-hidden="true" className="love-spot-label shrink-0" /></>}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto" aria-label="Characters" data-matilda-character-menu>
      <DropdownMenuGroup>
        <DropdownMenuItem data-character-id="elpis" aria-current={!character ? "true" : undefined} style={!character ? selectedStyle : undefined} onClick={() => savePreferences({ selectedPalette: "elpis" })}>
          <span className="relative size-6 shrink-0">{matilda}</span>
          <span className="min-w-0 flex-1 truncate">Matilda</span>
          <span className="text-xs text-muted-foreground">Default</span>
        </DropdownMenuItem>
        {THEME_CHARACTER_LIST.map(item => <DropdownMenuItem key={item.id} data-character-id={item.id} aria-current={selectedPalette === item.id ? "true" : undefined} style={selectedPalette === item.id ? selectedStyle : undefined} onClick={() => savePreferences({ selectedPalette: item.id })}>
          <img src={item.image} alt="" className="size-6 shrink-0 rounded-sm object-contain" />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="text-xs text-muted-foreground">{item.theme}</span>
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
