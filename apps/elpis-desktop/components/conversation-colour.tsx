"use client";
import { useState, useSyncExternalStore } from "react";
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
export function useConversationColour(id: string) {
  const { colours, error: readError } = useSyncExternalStore(subscribe, () => snapshot, () => empty);
  const colour = colours[id];
  const [error, setError] = useState("");
  async function choose(value: WorkflowColour | null) {
    setError("");
    try { await saveColour(id, value); }
    catch { setError("Could not save conversation colour. Try again."); }
  }
  return { colour, choose, error: error || readError };
}
