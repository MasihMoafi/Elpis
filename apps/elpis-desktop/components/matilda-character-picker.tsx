"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CreateCharacterDialog } from "@/components/create-character-dialog";
import { deleteCustomCharacter, useCustomCharacters } from "@/lib/custom-characters";
import { characterChoice } from "@/lib/character-choice.mts";
import { customCharacterImage } from "@/lib/theme-characters";
import { errorText } from "@/lib/error-text.mts";
import { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } from "@/bridge/matilda-face.cts";
import { savePreferences, usePreferences } from "@/lib/preferences";
import {
  OPEN_CHARACTER_PICKER,
  THEME_CHARACTER_LIST,
  useCompanionName,
  useThemeCharacter,
} from "@/lib/theme-characters";
import { shortcutTitle } from "@/lib/shortcuts";

/** Love Spot and the companion share the same character and palette choice. */
export function MatildaCharacterPicker({ compact = false }: { compact?: boolean }) {
  const preferences = usePreferences(),
    { selectedPalette } = preferences,
    character = useThemeCharacter(),
    companion = useCompanionName();
  const [open, setOpen] = useState(false),
    trigger = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { characters } = useCustomCharacters(),
    selectedId = preferences.selectedCharacter || selectedPalette;
  const custom = characters.find(item => item.id === selectedId);
  useEffect(() => {
    // Several pickers can be mounted; the first one on screen answers the shortcut.
    const answer = (event: Event) => {
      if (!event.defaultPrevented && trigger.current?.getClientRects().length) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_CHARACTER_PICKER, answer);
    return () => window.removeEventListener(OPEN_CHARACTER_PICKER, answer);
  }, []);
  const selectedStyle = {
    background: "color-mix(in srgb, var(--primary) 14%, transparent)",
    color: "var(--primary)",
    fontWeight: 600,
  };
  const matilda = (
    <>
      <img
        src={MATILDA_SHOTS_LIGHT.softSmile}
        alt=""
        className="absolute inset-0 size-full object-contain dark:hidden"
      />
      <img
        src={MATILDA_SHOTS.softSmile}
        alt=""
        className="absolute inset-0 hidden size-full object-contain dark:block"
      />
    </>
  );
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              variant={compact ? "ghost" : "outline"}
              size={compact ? "icon-xs" : "sm"}
              aria-label="Character"
              title={
                compact
                  ? shortcutTitle("Change character", "theme", preferences)
                  : character
                    ? `${character.name} · ${character.theme}`
                    : "Matilda · Default"
              }
              className={compact ? "shrink-0" : "shrink-0 gap-1.5 px-2"}
            />
          }
        >
          {compact ? (
            <UsersRound aria-hidden="true" />
          ) : (
            <span className="relative size-4 shrink-0">
              {character ? <img src={character.image} alt="" className="size-full object-contain" /> : matilda}
            </span>
          )}
          {!compact && (
            <>
              <span className="love-spot-label max-w-28 truncate">{companion}</span>
              <ChevronDown aria-hidden="true" className="love-spot-label shrink-0" />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-96 w-56 overflow-y-auto"
          aria-label="Characters"
          data-matilda-character-menu
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              data-character-id="elpis"
              aria-current={!character ? "true" : undefined}
              style={!character ? selectedStyle : undefined}
              onClick={() => savePreferences(characterChoice("elpis", characters))}
            >
              <span className="relative size-6 shrink-0">{matilda}</span>
              <span className="min-w-0 flex-1 truncate">Matilda</span>
              <span className="text-xs text-muted-foreground">Default</span>
            </DropdownMenuItem>
            {[
              ...THEME_CHARACTER_LIST.map(item => ({ id: item.id, name: item.name, image: item.image, note: item.theme })),
              ...characters.map(item => ({ id: item.id, name: item.name, image: customCharacterImage(item), note: "Custom" })),
            ].map(item => (
              <DropdownMenuItem
                key={item.id}
                data-character-id={item.id}
                aria-current={selectedId === item.id ? "true" : undefined}
                style={selectedId === item.id ? selectedStyle : undefined}
                onClick={() => savePreferences(characterChoice(item.id, characters))}
              >
                <img src={item.image} alt="" className="size-6 shrink-0 rounded-sm object-contain" />
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                <span className="text-xs text-muted-foreground">{item.note}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {custom && (
            <DropdownMenuItem
              onClick={() => {
                setError("");
                setDeleting(true);
              }}
            >
              Delete {custom.name}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setCreating(true)}>Create your own</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && <CreateCharacterDialog onClose={() => setCreating(false)} />}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent role="dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {custom?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Chats using her will return to Matilda. Your theme stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!custom) return;
                setBusy(true);
                void deleteCustomCharacter(custom.id)
                  .then(() => setDeleting(false))
                  .catch(cause => setError(errorText(cause, "Character could not be deleted.")))
                  .finally(() => setBusy(false));
              }}
            >
              Delete character
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
