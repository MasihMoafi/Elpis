import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { MenuRow } from "@/components/ui/menu-row";
import { Textarea } from "@/components/ui/textarea";
import { commandParts, parseCommand, type CatalogModel, type Command } from "@/lib/canvas";
import type * as React from "react";
import { Adding, Provider } from "./types";
import { useFitted } from "./menu";

export const lines = (text: string) =>
  text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

export type Level =
  { name: "providers" } | { name: "models"; provider: string | null } | { name: "efforts"; model: CatalogModel };

export type Row = {
  key: string;
  label: string;
  hint?: string | undefined;
  more?: boolean;
  take: () => void;
  open?: (() => void) | undefined;
};

export const providerToken = (model: CatalogModel) => `${model.provider ? `@${model.provider} ` : ""}${model.model}`;

/** The command bar, AutoCAD-style and keyboard first, as Houdini's and Nuke's Tab menu, Blender's Shift+A and
 * ComfyUI's search box. Type a prompt and Enter to add an agent with it (Shift+Enter starts the next agent's prompt),
 * or `3 sol high: prompt; prompt`. The list offers a model: ↑↓ choose, → opens a provider or a model's thinking
 * levels, ← goes back, Tab or Enter takes the choice. Without a prompt, Enter asks for one per agent. */
export function CommandBar({
  adding,
  room,
  limit,
  catalog,
  providers,
  onAgents,
  onNote,
  onAsk,
  onClose,
}: {
  adding: Adding;
  room: number;
  limit: number;
  catalog: CatalogModel[];
  providers: Provider[];
  onAgents: (command: Command) => void;
  onNote: (text: string) => void;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  // A command line opened by typing on the board starts with what was typed (`seed`), the caret after it.
  const [text, setText] = useState(adding.seed ?? ""),
    [active, setActive] = useState(0),
    [level, setLevel] = useState<Level | null>(null);
  const [asking, setAsking] = useState<Command | null>(null),
    [tasks, setTasks] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const end = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(end, end);
  }, []);
  const command = parseCommand(text, catalog),
    { head, rest } = commandParts(text);
  const lastWord = head.split(/\s+/).at(-1) ?? "";
  // A choice goes into the command's first part, replacing a half-typed word it couldn't place; prompts stay.
  const put = (token: string) => {
    if (command.prompted) setText(`${token}: ${text}`);
    else {
      const words = head.trimEnd().split(/\s+/).filter(Boolean);
      if (words.length && command.unknown.includes(words.at(-1)!.toLowerCase())) words.pop();
      const next = [...words, token].join(" ");
      setText(rest ? `${next}${rest}` : `${next} `);
    }
    setLevel(null);
    setActive(0);
    field.current?.focus();
  };
  // Free text that is no command goes to Elpis, which acts on the board ("let Elpis handle it"); opened from a dot or a
  // wire, it is the new agent's prompt instead.
  const asks = command.prompted && !adding.from && !adding.between;
  const submit = (current: Command) => {
    if (current.note) {
      onNote(current.tasks.join("\n"));
      return;
    }
    if (current === command && asks) {
      onAsk(text.trim());
      return;
    }
    // As in the prompts step, more prompts than agents adds agents.
    if (current.tasks.length) onAgents({ ...current, count: Math.max(current.count ?? 1, current.tasks.length) });
    else {
      setAsking(current);
      setTasks("");
    }
  };
  const shown: Level =
    level ??
    (command.model?.efforts.length && !command.effort
      ? { name: "efforts", model: command.model }
      : providers.length === 1 && providers[0]
        ? { name: "models", provider: providers[0].id }
        : { name: "providers" });
  const defaultRow: Row = {
    key: "default",
    label: "Default model",
    hint: "Whatever the run's chat uses",
    take: () => submit(command),
  };
  const modelRow = (model: CatalogModel): Row => ({
    key: `${model.provider}:${model.model}`,
    label: model.label,
    hint: model.efforts.length ? `${model.model} · → thinking` : model.model,
    more: model.efforts.length > 0,
    take: () => put(providerToken(model)),
    open: model.efforts.length
      ? () => {
          put(providerToken(model));
          setLevel({ name: "efforts", model });
        }
      : undefined,
  });
  const rows: Row[] =
    shown.name === "providers"
      ? [
          defaultRow,
          ...providers.map(provider => ({
            key: provider.id ?? "main",
            label: provider.label,
            more: true,
            hint:
              provider.state === "key"
                ? "Needs an API key: add it in Settings"
                : provider.state === "loading"
                  ? "Loading models…"
                  : provider.state === "error"
                    ? provider.error
                    : `${catalog.filter(model => model.provider === provider.id).length} models · →`,
            take: () => setLevel({ name: "models", provider: provider.id }),
            open: () => setLevel({ name: "models", provider: provider.id }),
          })),
        ]
      : shown.name === "models"
        ? [
            ...(providers.length === 1 ? [defaultRow] : []),
            ...catalog.filter(model => model.provider === shown.provider).map(modelRow),
          ]
        : shown.model.efforts.map(effort => ({
            key: effort,
            label: `${effort.charAt(0).toUpperCase()}${effort.slice(1)} thinking`,
            hint: effort === shown.model.defaultEffort ? "The model's default" : undefined,
            take: () => put(effort),
          }));
  const current = rows[Math.min(active, rows.length - 1)];
  const back = () => {
    if (shown.name === "efforts") setLevel({ name: "models", provider: shown.model.provider });
    else if (shown.name === "models" && providers.length > 1) setLevel({ name: "providers" });
    else setLevel(null);
    setActive(0);
  };
  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const atEnd = event.currentTarget.selectionStart === text.length;
    // Shift+Enter starts the next agent's prompt, as in the prompts step.
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!level) setLevel(shown);
      setActive(
        index =>
          (Math.min(index, rows.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          Math.max(1, rows.length),
      );
    } else if (event.key === "ArrowRight" && atEnd && current?.open) {
      event.preventDefault();
      setActive(0);
      current.open();
    } else if (event.key === "ArrowLeft" && atEnd && level) {
      event.preventDefault();
      back();
    } else if (event.key === "Tab") {
      event.preventDefault();
      current?.take();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (level) current?.take();
      else submit(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  const close = (event: React.FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose();
  };
  const count = Math.max(1, command.count ?? 1, command.tasks.length);
  const [fit, fitted] = useFitted(adding, asking, text);

  if (asking) {
    // The prompts: line n is agent n's; lines past the count add agents, up to the limit.
    const typed = lines(tasks),
      total = Math.min(room, Math.max(asking.count ?? 1, typed.length)),
      given = Math.min(typed.length, total);
    return (
      <div
        ref={fit}
        className="quick-add hud-menu nodrag nowheel"
        role="dialog"
        aria-label="Add agents"
        style={fitted}
        onBlur={close}
      >
        <p className="hud-menu-title quick-add-title">
          <span>{total === 1 ? "Prompt for the new agent" : `Prompts for the ${total} new agents`}</span>
          <span>{asking.model?.label ?? "Default model"}</span>
        </p>
        <Textarea
          autoFocus
          className="min-h-0"
          aria-label="Prompts, one per line"
          rows={Math.min(8, Math.max(3, total))}
          value={tasks}
          placeholder={Array.from({ length: Math.min(3, total) }, (_, index) => `Prompt for agent ${index + 1}`).join(
            "\n",
          )}
          onChange={event => setTasks(event.target.value)}
          onKeyDown={event => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onAgents({ ...asking, count: total, tasks: typed.slice(0, total) });
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Backspace" && !tasks) {
              event.preventDefault();
              setAsking(null);
            }
          }}
        />
        <p className="quick-add-note" role="status">
          {total} {total === 1 ? "agent" : "agents"}:{" "}
          {given === total
            ? "each with its prompt"
            : given
              ? `${given} with a prompt, ${total - given} still to write`
              : "prompts can be written later, before the run"}
          {typed.length > room ? `. Only ${room} fit under the limit of ${limit}.` : ""}
        </p>
        <p className="quick-add-help">
          One prompt per line · Shift+Enter new line · Enter add · Esc close · Backspace back
        </p>
      </div>
    );
  }
  return (
    <div
      ref={fit}
      className="quick-add hud-menu nodrag nowheel"
      role="dialog"
      aria-label="Add agents"
      style={fitted}
      onBlur={close}
    >
      <p className="hud-menu-title quick-add-title">
        <span>{room ? "Add agents" : "No room for more agents"}</span>
        <span>
          {room} of {limit} left
        </span>
      </p>
      <Textarea
        ref={field}
        autoFocus
        className="min-h-0 resize-none"
        aria-label="Command"
        value={text}
        spellCheck={false}
        placeholder="Tell Elpis what to do, or 3 sol high: prompt; prompt"
        rows={Math.min(6, text.split("\n").length)}
        onChange={event => {
          setText(event.target.value);
          setActive(0);
          setLevel(null);
        }}
        onKeyDown={keys}
      />
      <p className="quick-add-plan" aria-label="Will add">
        {command.note ? (
          <b>Note</b>
        ) : asks ? (
          <>
            <b>Elpis</b>
            <span>will do it: design or change the team from what you wrote</span>
          </>
        ) : text.trim() ? (
          <>
            <b>{`${Math.min(count, room) || count} × Agent`}</b>
            <span>{command.model ? `${command.model.label} · ${command.model.providerLabel}` : "Default model"}</span>
            {command.effort && <span>{command.effort} thinking</span>}
            {command.tasks.length > 0 && (
              <span>
                {command.tasks.length} {command.tasks.length === 1 ? "prompt" : "prompts"}
              </span>
            )}
          </>
        ) : (
          <span>Type a prompt, or choose a model below</span>
        )}
        {command.unknown.length > 0 && <em>Not understood: {command.unknown.join(", ")}</em>}
        {count > room && room > 0 && (
          <em>
            Only {room} fit under the limit of {limit}
          </em>
        )}
      </p>
      <p className="quick-add-crumb">
        {shown.name === "providers"
          ? "Providers"
          : shown.name === "models"
            ? `Models · ${providers.find(provider => provider.id === shown.provider)?.label ?? ""}`
            : `Thinking · ${shown.model.label}`}
        {level && <span>← back</span>}
      </p>
      <div
        role="listbox"
        aria-label={shown.name === "providers" ? "Providers" : shown.name === "models" ? "Models" : "Thinking levels"}
        className="quick-add-list"
      >
        {rows.map((row, index) => (
          <MenuRow
            key={row.key}
            role="option"
            aria-selected={row === current}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              setActive(index);
              (row.open ?? row.take)();
            }}
          >
            <span className="select-option">
              {row.label}
              {row.hint && <small>{row.hint}</small>}
            </span>
            {row.more && <ChevronRight size={14} className="quick-add-more" />}
          </MenuRow>
        ))}
        {!rows.length && <p className="quick-add-note">Nothing to choose here.</p>}
      </div>
      <p className="quick-add-help">
        {lastWord && command.unknown.includes(lastWord.toLowerCase()) ? "Tab takes the highlighted choice · " : ""}↑↓ ·
        → open · ← back · Tab take · Shift+Enter next prompt · Enter {level ? "take" : asks ? "ask Elpis" : "add"} · Esc
      </p>
    </div>
  );
}
