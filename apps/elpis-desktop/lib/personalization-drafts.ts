import { appStorage } from "@/lib/projects";

export type PersonalizationDraft = { content: string; version: string };
// Retain drafts even if Settings unmounts while the native store is unavailable.
const drafts = new Map<string, PersonalizationDraft>();
export function readPersonalizationDraft(key: string) {
  if (drafts.has(key)) return drafts.get(key)!;
  const raw = appStorage().getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("content" in value) || typeof value.content !== "string" || !("version" in value) || typeof value.version !== "string") throw Error("The saved draft could not be read. Keep the original workspace file.");
  const draft = { content: value.content, version: value.version }; drafts.set(key, draft); return draft;
}
export function writePersonalizationDraft(key: string, value: PersonalizationDraft | null) {
  if (value) drafts.set(key, value); else drafts.delete(key);
  if (value) appStorage().setItem(key, JSON.stringify(value)); else appStorage().removeItem(key);
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", event => { if (drafts.size) { event.preventDefault(); event.returnValue = ""; } });
  window.__elpisFlushSettings = () => {
    try { for (const [key, draft] of drafts) appStorage().setItem(key, JSON.stringify(draft)); return true; }
    catch { return false; }
  };
}
