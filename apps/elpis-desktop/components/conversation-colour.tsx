"use client";
import { useId, useState, useSyncExternalStore } from "react";
import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { appStorage } from "@/lib/projects";
import { WORKFLOW_COLOURS, type WorkflowColour } from "@/lib/workflow-identity";

const KEY = "elpis-conversation-colours-v1";
type Colours = Record<string, WorkflowColour>;
const empty = { colours: {} as Colours, error: "" };
let snapshot = empty, pending = Promise.resolve(), disconnect: (() => void) | undefined;
const listeners = new Set<() => void>();
function readColours(): Colours {
  const raw: unknown = JSON.parse(appStorage().getItem(KEY) || "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid conversation colours");
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, WorkflowColour] =>
    WORKFLOW_COLOURS.some(colour => colour === entry[1])));
}
function refresh() {
  try { snapshot = { colours: readColours(), error: "" }; }
  catch { snapshot = { ...snapshot, error: "Could not read saved conversation colours." }; }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!disconnect) {
    const changed = (event: StorageEvent) => { if (event.key === KEY || event.key === null) refresh(); };
    window.addEventListener("storage", changed);
    const stop = window.elpisDesktop?.storage?.onChange?.(key => { if (key === KEY) refresh(); });
    disconnect = () => { window.removeEventListener("storage", changed); stop?.(); disconnect = undefined; };
    refresh();
  }
  return () => { listeners.delete(listener); if (!listeners.size) disconnect?.(); };
}
function saveColour(id: string, colour: WorkflowColour | null) {
  // Re-read inside the queue so assigning colours to separate rows preserves both changes.
  const task = pending.catch(() => {}).then(async () => {
    const colours = readColours();
    if (colour) colours[id] = colour; else delete colours[id];
    const value = JSON.stringify(colours), desktop = window.elpisDesktop?.storage;
    if (desktop?.saveItem) await desktop.saveItem(KEY, value);
    else appStorage().setItem(KEY, value);
    refresh();
  });
  pending = task;
  return task;
}

/** A manual conversation colour, independent of agent identity and live status. */
export function ConversationColour({ id, name }: { id: string; name: string }) {
  const { colours, error: readError } = useSyncExternalStore(subscribe, () => snapshot, () => empty);
  const colour = colours[id], radioName = useId();
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  async function choose(value: WorkflowColour | null) {
    setSaving(true); setError("");
    try { await saveColour(id, value); setOpen(false); }
    catch { setError("Could not save conversation colour. Try again."); }
    finally { setSaving(false); }
  }
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value) setError(""); }}>
    <PopoverTrigger render={<Button variant="ghost" size="icon-xs" className="conversation-colour-trigger" aria-label={`Colour for ${name}`} title={colour ? `Conversation colour: ${colour}` : "Choose conversation colour"} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} />}>
      <Palette size={14} aria-hidden="true" /><span className="conversation-colour-swatch" data-colour={colour} aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent role="dialog" aria-label="Conversation colour" className="w-56 space-y-2" onKeyDown={event => event.stopPropagation()}>
      <fieldset disabled={saving} className="space-y-1">
        <legend className="mb-2 text-sm font-medium">Conversation colour</legend>
        {WORKFLOW_COLOURS.map(value => <label key={value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
          <input type="radio" name={radioName} value={value} checked={colour === value} onChange={() => void choose(value)} />
          <span className="conversation-colour-swatch" data-colour={value} aria-hidden="true" />{value[0].toUpperCase() + value.slice(1)}
        </label>)}
      </fieldset>
      <Button variant="ghost" size="sm" disabled={saving || !colour} onClick={() => void choose(null)}>Reset colour</Button>
      {(error || readError) && <p role="alert" className="text-xs text-destructive">{error || readError}</p>}
    </PopoverContent>
  </Popover>;
}
