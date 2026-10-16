"use client";

import { useState, type KeyboardEvent } from "react";

/** A terminal slash command the app performs (codex-rs/tui/src/slash_command.rs); unavailable ones are left out of the menu. */
export type SlashCommand = { name: string; description: string; available?: boolean; run: () => void };
const MENU_ID = "slash-menu";

/** The command menu a leading "/" opens, as in the ChatGPT app's Codex composer: names that start with the typed text first, then names that contain it. */
export function useSlashMenu(text: string, commands: SlashCommand[], clear: () => void) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  // Escape or leaving the composer closes the menu until the text changes.
  if (dismissed !== null && dismissed !== text) setDismissed(null);
  const query = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const usable = query === undefined || dismissed === text ? [] : commands.filter(command => command.available !== false);
  const matches = query === undefined ? [] : [...usable.filter(command => command.name.startsWith(query)), ...usable.filter(command => !command.name.startsWith(query) && command.name.includes(query))];
  const open = matches.length > 0;
  const active = cursor.query === query ? Math.min(cursor.index, matches.length - 1) : 0;
  const select = (index: number) => setCursor({ query: query ?? "", index });
  const run = (command: SlashCommand) => { clear(); setDismissed(null); command.run(); };
  /** Handles the key while the menu is open; true when the composer should not handle it too. */
  function onKeyDown(event: KeyboardEvent) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") select((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") run(matches[active]);
    else if (event.key === "Escape") setDismissed(text);
    else return false;
    event.preventDefault(); return true;
  }
  return { open, matches, active, select, run, onKeyDown, close: () => setDismissed(text),
    inputProps: { "aria-autocomplete": "list" as const, "aria-controls": open ? MENU_ID : undefined, "aria-activedescendant": open ? `${MENU_ID}-${matches[active].name}` : undefined } };
}

export function SlashMenu({ menu }: { menu: ReturnType<typeof useSlashMenu> }) {
  if (!menu.open) return null;
  return <div className="slash-menu" role="listbox" id={MENU_ID} aria-label="Slash commands">
    {menu.matches.map((command, index) => <div key={command.name} id={`${MENU_ID}-${command.name}`} role="option" aria-selected={index === menu.active} className="slash-option"
      ref={index === menu.active ? element => element?.scrollIntoView({ block: "nearest" }) : undefined}
      onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== menu.active) menu.select(index); }} onClick={() => menu.run(command)}>
      <span className="slash-name">/{command.name}</span><span className="slash-description">{command.description}</span>
    </div>)}
  </div>;
}
