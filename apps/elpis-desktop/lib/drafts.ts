// Desktop drafts use the app's private store, independent of its loopback port.
// The optional web renderer retains the existing per-window session behavior.
import type {} from "./desktop";
const prefix = "elpis-draft-v1:";
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readDraft(id: string, storage?: DraftStorage): string {
  try { return (storage ?? window.elpisDesktop?.storage ?? window.sessionStorage).getItem(prefix + id) ?? ""; }
  catch { return ""; }
}

export function writeDraft(id: string, text: string, storage?: DraftStorage): boolean {
  try {
    const target = storage ?? window.elpisDesktop?.storage ?? window.sessionStorage;
    if (text) target.setItem(prefix + id, text);
    else target.removeItem(prefix + id);
    return true;
  } catch { return false; }
}
