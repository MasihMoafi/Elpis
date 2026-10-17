"use client";

import { useState, type KeyboardEvent } from "react";
import { splitCommand } from "@/lib/slash";

/** A terminal slash command the app performs (codex-rs/tui/src/slash_command.rs); unavailable ones are left out of the menu.
 * `args` marks a command that also takes text after its name (`/effort high`), which Enter then runs it with. */
export type SlashCommand = { name: string; description: string; available?: boolean; args?: boolean; run: (args?: string) => void };
const MENU_ID = "slash-menu";

/** The command menu a leading "/" opens, as in the ChatGPT app's Codex composer: the name typed in full, then names that start with the typed text, then names that contain it. */
export function useSlashMenu(text: string, commands: SlashCommand[], clear: () => void) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  // Escape or leaving the composer closes the menu until the text changes.
  if (dismissed !== null && dismissed !== text) setDismissed(null);
  const query = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const usable = query === undefined || dismissed === text ? [] : commands.filter(command => command.available !== false);
  // The name typed in full comes first, so Enter on "/prune" runs /prune and not /pruner-model.
  const matches = query === undefined ? [] : [...usable.filter(command => command.name === query), ...usable.filter(command => command.name !== query && command.name.startsWith(query)), ...usable.filter(command => !command.name.startsWith(query) && command.name.includes(query))];
  const open = matches.length > 0;
  const active = cursor.query === query ? Math.min(cursor.index, matches.length - 1) : 0;
  const select = (index: number) => setCursor({ query: query ?? "", index });
  const run = (command: SlashCommand, args?: string) => { clear(); setDismissed(null); command.run(args); };
  // "/effort high": the menu is closed by then, but Enter still runs a command that takes arguments.
  const typed = query === undefined ? splitCommand(text) : null;
  const withArgs = typed ? commands.find(command => command.args && command.available !== false && command.name === typed.name) : undefined;
  /** Handles the key while the menu is open (or a command with its arguments is typed); true when the composer should not handle it too. */
  function onKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return false;
    if (!open) {
      if (!withArgs || !typed || event.key !== "Enter" || event.shiftKey) return false;
      run(withArgs, typed.args); event.preventDefault(); return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") select((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") run(matches[active]);
    else if (event.key === "Escape") setDismissed(text);
    else return false;
    event.preventDefault(); return true;
  }
  return { open, matches, active, select, run, onKeyDown, close: () => setDismissed(text),
    inputProps: { "aria-autocomplete": "list" as const, "aria-controls": open ? MENU_ID : undefined, "aria-activedescendant": open ? `${MENU_ID}-${matches[active].name}` : undefined } };
}

/** One line of an option list above the message box: a name and what it is. */
export type ListOption = { key: string; name: string; description: string };

/** The list the slash commands and the @ picker both draw above the message box: one look, mouse and scroll behaviour.
 * The message box keeps the focus; the keys are the owner's (`aria-activedescendant` names `${id}-${key}`). */
export function OptionList({ id, label, options, active, onHover, onPick, kind }: { id: string; label: string; options: ListOption[]; active: number; onHover: (index: number) => void; onPick: (index: number) => void; /** The description is a kind (File, Chat), set at the right edge. */ kind?: boolean }) {
  return <div className={`slash-menu hud-menu${kind ? " option-list-kind" : ""}`} role="listbox" id={id} aria-label={label}>
    {options.map((option, index) => <div key={option.key} id={`${id}-${option.key}`} role="option" aria-selected={index === active} className="slash-option hud-menu-item"
      ref={index === active ? element => element?.scrollIntoView({ block: "nearest" }) : undefined}
      onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== active) onHover(index); }} onClick={() => onPick(index)}>
      <span className="slash-name">{option.name}</span><span className="slash-description">{option.description}</span>
    </div>)}
  </div>;
}

export function SlashMenu({ menu }: { menu: ReturnType<typeof useSlashMenu> }) {
  if (!menu.open) return null;
  return <OptionList id={MENU_ID} label="Slash commands" options={menu.matches.map(command => ({ key: command.name, name: `/${command.name}`, description: command.description }))}
    active={menu.active} onHover={menu.select} onPick={index => menu.run(menu.matches[index])} />;
}
