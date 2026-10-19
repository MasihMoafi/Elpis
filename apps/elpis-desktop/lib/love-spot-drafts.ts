import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {} from "./desktop";

export type DraftPage = { name: string; session: string };
type TextElement = Extract<ExcalidrawElement, { type: "text" }>;
type Entry = { page: DraftPage; element: TextElement; recoveryId: string; written: number; cleared?: boolean };
const key = "elpis-draft-v1:love-spot-text-journal";
function journalValues(text: string | null | undefined): Record<string, string> {
  const value: unknown = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(entry => typeof entry !== "string")) throw new Error("Text draft journal could not be read. It was left untouched.");
  return value as Record<string, string>;
}
function written(value: string): number {
  const entry: unknown = JSON.parse(value);
  if (!entry || typeof entry !== "object" || !("written" in entry) || typeof entry.written !== "number" || !Number.isSafeInteger(entry.written)) throw new Error("Text draft journal could not be read. It was left untouched.");
  return entry.written;
}

/** Each writer owns its own per-element entry. Native patchItem merges those
 * entries atomically across windows; localStorage also journals synchronously,
 * before an asynchronous save or window shutdown can interrupt the edit. */
export function createTextJournal(report: (error: unknown) => void) {
  const writer = crypto.randomUUID();
  const owned = new Map<string, Entry>();
  const read = (): Record<string, string> => {
    const native = window.elpisDesktop?.storage?.getItem(key);
    const result = journalValues(native), local = journalValues(localStorage.getItem(key));
    for (const [id, value] of Object.entries(local)) {
      if (!result[id] || written(value) > written(result[id])) result[id] = value;
    }
    return result;
  };
  const patch = (changes: Record<string, string>) => {
    try {
      const value = JSON.stringify({ ...read(), ...changes });
      localStorage.setItem(key, value);
      const storage = window.elpisDesktop?.storage;
      if (storage?.patchItem) storage.patchItem(key, changes);
      else storage?.setItem(key, value);
    } catch (error) { report(new Error(`Text draft could not be journaled: ${error instanceof Error ? error.message : error}`)); }
  };
  const entries = (): [string, Entry][] => {
    try {
      return Object.entries(read()).filter(([, value]) => !!value).map(([id, value]) => [id, JSON.parse(value)] as [string, Entry])
        .filter(([, entry]) => !entry.cleared && entry.page?.name && entry.element?.type === "text" && typeof entry.element.originalText === "string");
    } catch (error) { report(error); return []; }
  };
  return {
    record(element: ExcalidrawElement, page: DraftPage) {
      if (element.type !== "text") return;
      const id = `${page.session}:${element.id}:${writer}`;
      const previous = owned.get(id);
      if (previous && JSON.stringify(previous.element) === JSON.stringify(element)) return;
      let last: string | undefined;
      try { last = read()[id]; } catch (error) { report(error); }
      const entry = { page, element: structuredClone(element), recoveryId: previous?.recoveryId ?? `draft-${crypto.randomUUID()}`,
        written: Math.max(Date.now(), last ? written(last) + 1 : 0) };
      owned.set(id, entry); patch({ [id]: JSON.stringify(entry) });
    },
    protectedIds(elements: readonly ExcalidrawElement[], page?: DraftPage) {
      return new Set([...owned.values()].filter(entry => entry.page.session === page?.session && elements.some(e => e.id === entry.element.id
        && e.type === "text" && e.originalText === entry.element.originalText)).map(entry => entry.element.id));
    },
    capture(editor: ExcalidrawImperativeAPI, page: DraftPage) {
      const input = document.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg");
      const editing = editor.getAppState().editingTextElement;
      const element = editing && editor.getSceneElementsIncludingDeleted().find(e => e.id === editing.id);
      if (input && element?.type === "text") {
        const text = input.value.replace(/\r\n?/g, "\n");
        const draft = element.originalText === text ? element : newElementWith(element, { originalText: text, text, isDeleted: false });
        this.record(draft, page);
        return draft;
      }
    },
    recover(elements: readonly ExcalidrawElement[], page: DraftPage): readonly ExcalidrawElement[] {
      const result = new Map(elements.map(element => [element.id, element]));
      for (const [, entry] of entries()) {
        if (entry.page.name !== page.name && entry.page.session !== page.session) continue;
        const draft = entry.element, current = result.get(draft.id), copy = result.get(entry.recoveryId);
        if (current?.type === "text" && current.originalText === draft.originalText && !current.isDeleted) continue;
        if (copy?.type === "text" && copy.originalText === draft.originalText && !copy.isDeleted) continue;
        // An interrupted empty edit must not erase a saved note. Nonempty
        // conflicting drafts become separate notes, preserving both versions.
        if (!draft.originalText.trim()) continue;
        if (!current || (!current.isDeleted && current.version <= draft.version)) {
          result.set(draft.id, newElementWith({ ...draft, version: Math.max(draft.version, current?.version ?? 0) }, { isDeleted: false }));
        } else {
          result.set(entry.recoveryId, { ...draft, id: entry.recoveryId, version: 1, versionNonce: 0, isDeleted: false,
            y: draft.y + draft.height + 40, containerId: null, boundElements: null });
        }
      }
      return [...result.values()];
    },
    acknowledge(elements: readonly ExcalidrawElement[], page: DraftPage, editingId?: string) {
      const changes: Record<string, string> = {};
      for (const [id, entry] of entries()) {
        if (entry.page.name !== page.name && entry.page.session !== page.session) continue;
        if (entry.element.id === editingId) continue;
        if (elements.some(e => (e.id === entry.element.id || e.id === entry.recoveryId) && e.type === "text"
          && e.originalText === entry.element.originalText && (entry.element.originalText.trim() ? !e.isDeleted : true))) {
          changes[id] = JSON.stringify({ cleared: true, written: Math.max(Date.now(), entry.written + 1) }); owned.delete(id);
        }
      }
      if (Object.keys(changes).length) patch(changes);
    },
  };
}

/** A stale window may have published a higher element version while this edit
 * was in progress. Save this writer's actual text above that version, without
 * replacing unrelated remote edits. Never acknowledge a losing save as Saved. */
export async function saveWithTextDrafts<T extends { elements: readonly ExcalidrawElement[] }, S extends { scene: T }>(
  drawing: T, protectedIds: Set<string>, persist: (drawing: T) => Promise<S>,
): Promise<S> {
  let outgoing = drawing;
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await persist(outgoing);
    const wanted = drawing.elements.filter(e => protectedIds.has(e.id));
    const missing = wanted.filter(e => !saved.scene.elements.some(s => s.id === e.id && s.type === "text" && e.type === "text"
      && s.originalText === e.originalText && s.isDeleted === e.isDeleted));
    if (!missing.length) return saved;
    const elements = new Map(saved.scene.elements.map(e => [e.id, e]));
    for (const element of missing) elements.set(element.id, newElementWith({ ...element,
      version: Math.max(element.version, elements.get(element.id)?.version ?? 0) }, { isDeleted: element.isDeleted }));
    outgoing = { ...drawing, elements: [...elements.values()] };
  }
  throw new Error("Text is changing in another window. Your draft is kept here. Press Ctrl+S to retry.");
}
