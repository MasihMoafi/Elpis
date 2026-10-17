// The editors "Open in" offers (desktop/editors.cjs lists the ones installed; VS Code is never among them) and the one the
// person chose last, kept on this computer. With none chosen a file opens in the system's default app.
import { useEffect, useSyncExternalStore } from "react";
import { appStorage } from "./projects";

export type EditorInfo = { id: string; name: string };
const KEY = "elpis-editor-v1";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = () => { for (const listener of listeners) listener(); };

let choice: string | null | undefined;
/** The editor id chosen last, or null for the default app. */
export function editorChoice(): string | null {
  if (choice === undefined) { try { choice = appStorage().getItem(KEY) || null; } catch { choice = null; } }
  return choice;
}
export function chooseEditor(id: string | null) {
  choice = id;
  try { if (id) appStorage().setItem(KEY, id); else appStorage().removeItem(KEY); } catch { /* The choice holds until the app closes. */ }
  changed();
}
export const useEditorChoice = () => useSyncExternalStore(subscribe, editorChoice, () => null);

let installed: EditorInfo[] | undefined, asked = false;
const NONE: EditorInfo[] = [];
/** The editors installed, read once from the desktop app (empty until it answers, and in a plain browser). */
export function useEditors(): EditorInfo[] {
  useEffect(() => {
    const ask = window.elpisDesktop?.editors;
    if (asked || !ask) return;
    asked = true;
    ask().then(list => { installed = list; changed(); }, () => { installed = []; changed(); });
  }, []);
  return useSyncExternalStore(subscribe, () => installed ?? NONE, () => NONE);
}
