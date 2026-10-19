// What the Files tab keeps (components/files-pane.tsx draws it): per project folder the open files, the folders opened in
// the tree and what is selected; per file its text and its unsaved edits; per folder its listing. One store for the page, so
// a path clicked in a reply (components/file-ref.tsx) can open a file here, and so open files and edits survive another tab
// being shown. The bridge reads one folder at a time and one file at a time (bridge/files.mjs).
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { resolveRef, type FileRef } from "@/lib/file-refs";

export type Entry = { name: string; dir: boolean; link?: boolean };
export type Listing = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; entries: Entry[] };
export type Doc =
  | { status: "loading" } | { status: "error"; message: string } | { status: "binary" | "large"; size: number; limit?: number } | { status: "image" | "pdf"; src: string }
  | { status: "ready"; text: string; saved: string; mtimeMs: number; eol: "\n" | "\r\n"; saving: boolean; saveError: string };
/** A file in the tab strip. A preview is replaced by the next file previewed; `focus` counts the times the lines were asked for. */
export type OpenFile = { path: string; preview: boolean; line?: number; endLine?: number; focus: number; view?: "source" | "preview" };
export type Pane = { open: OpenFile[]; active: string | null; showTree: boolean; expanded: string[]; selected: string | null; reveal: number; hidden: boolean; treeWidth: number };
export type Names = "loading" | "error" | string[];
export type FilesState = { host: { attached: boolean; cwd: string }; panes: Record<string, Pane>; docs: Record<string, Doc>; dirs: Record<string, Listing>; names: Record<string, Names> };

type State = FilesState;
const blank = (): Pane => ({ open: [], active: null, showTree: true, expanded: [], selected: null, reveal: 0, hidden: false, treeWidth: 236 });
let state: State = { host: { attached: false, cwd: "" }, panes: {}, docs: {}, dirs: {}, names: {} };
const listeners = new Set<() => void>(), requests = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const enc = encodeURIComponent;

export const docKey = (cwd: string, path: string) => `${cwd}\0${path}`;
export const dirKey = (cwd: string, dir: string, hidden: boolean) => `${cwd}\0${dir}\0${hidden ? 1 : 0}`;
export const isDirty = (doc: Doc | undefined) => doc?.status === "ready" && doc.text !== doc.saved;
// Quit inspects every project, even when its Files pane is hidden or detached. Source files are never autosaved here.
if (typeof window !== "undefined") Object.defineProperty(window, "__elpisHasUnsavedFiles", { configurable: true,
  get: () => Object.values(state.docs).some(doc => isDirty(doc) || (doc.status === "ready" && doc.saving)),
});
const idle = blank();
const paneOf = (cwd: string): Pane => state.panes[cwd] ?? idle;
/** The Files tab's state for a folder (what a folder not opened yet starts with). */
export const paneIn = (files: FilesState, cwd: string): Pane => files.panes[cwd] ?? idle;
const patchPane = (cwd: string, patch: Partial<Pane> | ((pane: Pane) => Partial<Pane>)) => {
  const pane = paneOf(cwd);
  set({ panes: { ...state.panes, [cwd]: { ...pane, ...(typeof patch === "function" ? patch(pane) : patch) } } });
};
const patchDoc = (key: string, patch: (doc: Doc) => Doc) => { const doc = state.docs[key]; if (doc) set({ docs: { ...state.docs, [key]: patch(doc) } }); };

/** The page's view of the store. */
export function useFiles() { return useSyncExternalStore(subscribe, () => state, () => state); }
/** Whether there is a Files tab to open files in, and the folder of the open chat: changes only when those do. */
export function useHost() { return useSyncExternalStore(subscribe, () => state.host, () => state.host); }
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const snapshot = () => state;

/** The side panel says which folder the open chat works in, and that there is a Files tab to open files in. */
export function attach(cwd: string) { if (!state.host.attached || state.host.cwd !== cwd) set({ host: { attached: true, cwd } }); }
export function detach() { set({ host: { attached: false, cwd: state.host.cwd } }); }
/** The side panel opens its Files tab when a file is asked for. */
export function onRequest(listener: () => void) { requests.add(listener); return () => { requests.delete(listener); }; }

// Folders (the tree) and the flat list of names (the filter).
export async function loadDir(cwd: string, dir: string, hidden: boolean, force = false) {
  const key = dirKey(cwd, dir, hidden), known = state.dirs[key];
  if (known && !force && known.status !== "error") return;
  if (!known || known.status === "error") set({ dirs: { ...state.dirs, [key]: { status: "loading" } } });
  try {
    const result = await api<{ data: Entry[] }>(`/files/dir?cwd=${enc(cwd)}&dir=${enc(dir)}&hidden=${hidden ? 1 : 0}`);
    set({ dirs: { ...state.dirs, [key]: { status: "ready", entries: result.data } } });
  } catch (cause) { set({ dirs: { ...state.dirs, [key]: { status: "error", message: message(cause) } } }); }
}
export async function loadNames(cwd: string, force = false) {
  if (state.names[cwd] && !force && state.names[cwd] !== "error") return;
  set({ names: { ...state.names, [cwd]: "loading" } });
  try { set({ names: { ...state.names, [cwd]: (await api<{ data: string[] }>(`/files?cwd=${enc(cwd)}`)).data } }); }
  catch { set({ names: { ...state.names, [cwd]: "error" } }); }
}
const parents = (path: string) => path.split("/").slice(0, -1).map((_, index, all) => all.slice(0, index + 1).join("/"));
/** Opens a folder of the tree, or closes it. */
export function toggleDir(cwd: string, dir: string) {
  const pane = paneOf(cwd), open = pane.expanded.includes(dir);
  patchPane(cwd, { expanded: open ? pane.expanded.filter(item => item !== dir) : [...pane.expanded, dir] });
  if (!open) void loadDir(cwd, dir, pane.hidden);
}
/** Reads the tree and the names again (the agent adds and removes files). */
export function refresh(cwd: string) {
  const pane = paneOf(cwd);
  for (const dir of ["", ...pane.expanded]) void loadDir(cwd, dir, pane.hidden, true);
  if (state.names[cwd]) void loadNames(cwd, true);
}
export function setHidden(cwd: string, hidden: boolean) {
  patchPane(cwd, { hidden });
  for (const dir of ["", ...paneOf(cwd).expanded]) void loadDir(cwd, dir, hidden);
}
export const collapseAll = (cwd: string) => patchPane(cwd, { expanded: [] });
export const setShowTree = (cwd: string, showTree: boolean) => patchPane(cwd, { showTree });
export const setTreeWidth = (cwd: string, treeWidth: number) => patchPane(cwd, { treeWidth });
export const select = (cwd: string, selected: string | null) => patchPane(cwd, { selected });
/** Opens the folders on the way to `path`, selects it and asks the tree to bring it into view. */
export function reveal(cwd: string, path: string) {
  const pane = paneOf(cwd), need = parents(path).filter(dir => !pane.expanded.includes(dir));
  patchPane(cwd, { expanded: [...pane.expanded, ...need], selected: path, reveal: pane.reveal + 1, showTree: true });
  for (const dir of ["", ...parents(path)]) void loadDir(cwd, dir, pane.hidden);
}

// Files.
/** Outside references share the chat's tabs; reads and writes stay scoped to the file's own folder. */
const location = (cwd: string, path: string) => path.startsWith("/")
  ? { cwd: path.slice(0, path.lastIndexOf("/")) || "/", path: path.slice(path.lastIndexOf("/") + 1) }
  : { cwd, path };
/** An explicit file tab uses its own folder when outside the project; embedded assets must pass their project scope. */
export function fileAssetUrl(cwd: string, path: string) {
  return `/api/file/asset?cwd=${enc(cwd)}&path=${enc(path)}`;
}
export function fileScope(cwd: string, path: string) { return location(cwd, path); }
const FRESH = (text: string) => text.replace(/\r\n/g, "\n");
/** Reads the file into its tab. A file with unsaved edits is left as it is; one that has not changed keeps its text. */
export async function loadDoc(cwd: string, path: string) {
  const key = docKey(cwd, path), known = state.docs[key];
  if (isDirty(known)) return;
  if (!known || known.status !== "ready") set({ docs: { ...state.docs, [key]: { status: "loading" } } });
  try {
    const source = location(cwd, path);
    const result = await api<{ content?: string; image?: string; preview?: "pdf" | "image"; binary?: boolean; tooLarge?: boolean; size: number; limit?: number; mtimeMs?: number }>(`/file?cwd=${enc(source.cwd)}&path=${enc(source.path)}`);
    if (isDirty(state.docs[key])) return;
    if (result.preview === "pdf" || result.preview === "image") { set({ docs: { ...state.docs, [key]: { status: result.preview, src: fileAssetUrl(source.cwd, source.path) } } }); return; }
    if (typeof result.image === "string" && result.image.startsWith("data:image/")) { set({ docs: { ...state.docs, [key]: { status: "image", src: result.image } } }); return; }
    if (result.tooLarge) { set({ docs: { ...state.docs, [key]: { status: "large", size: result.size, limit: result.limit } } }); return; }
    if (result.binary || typeof result.content !== "string" || typeof result.mtimeMs !== "number") { set({ docs: { ...state.docs, [key]: { status: "binary", size: result.size } } }); return; }
    const text = FRESH(result.content), now = state.docs[key];
    if (now?.status === "ready" && now.saved === text && now.mtimeMs === result.mtimeMs) return;
    set({ docs: { ...state.docs, [key]: { status: "ready", text, saved: text, mtimeMs: result.mtimeMs, eol: result.content.includes("\r\n") ? "\r\n" : "\n", saving: false, saveError: "" } } });
  } catch (cause) { set({ docs: { ...state.docs, [key]: { status: "error", message: message(cause) } } }); }
}
/** Shows `path` in a tab (a preview, unless asked to keep it) and reads it; `lines` marks and scrolls to them. */
export function openFile(cwd: string, path: string, { preview = false, line, endLine, show = false }: { preview?: boolean; line?: number; endLine?: number; show?: boolean } = {}) {
  const pane = paneOf(cwd), at = pane.open.findIndex(file => file.path === path), old = pane.open[at];
  const file: OpenFile = { path, preview: old ? old.preview && preview : preview, line, endLine, focus: (old?.focus ?? 0) + 1, view: line ? "source" : old?.view };
  let open: OpenFile[];
  if (old) open = pane.open.map(item => item === old ? file : item);
  else if (preview && pane.open.some(item => item.preview)) open = pane.open.map(item => item.preview ? file : item);
  else open = [...pane.open, file];
  // A preview that was replaced leaves no text behind.
  const gone = pane.open.filter(item => !open.some(kept => kept.path === item.path) && !isDirty(state.docs[docKey(cwd, item.path)]));
  patchPane(cwd, { open, active: path, selected: path });
  if (gone.length) set({ docs: Object.fromEntries(Object.entries(state.docs).filter(([key]) => !gone.some(item => key === docKey(cwd, item.path)))) });
  void loadDoc(cwd, path);
  if (show && !path.startsWith("/")) reveal(cwd, path);
}
/** Opens a local reference in the chat's Files tab, including files outside its folder. */
/** Where an HTML file opens as a page: the side panel registers the session's built-in browser here. */
let pageOpener: ((abs: string) => void) | null = null;
export function onOpenPage(open: (abs: string) => void) { pageOpener = open; return () => { if (pageOpener === open) pageOpener = null; }; }
export function openRef(ref: FileRef, { asText = false }: { asText?: boolean } = {}): boolean {
  const { attached, cwd } = state.host;
  if (!attached || !cwd) return false;
  const found = resolveRef(ref, cwd);
  if (!asText && pageOpener && /\.html?$/i.test(found.abs) && found.line === undefined) { pageOpener(found.abs); for (const request of requests) request(); return true; }
  openFile(cwd, found.rel, { line: found.line, endLine: found.endLine, show: true });
  for (const request of requests) request();
  return true;
}
export function activate(cwd: string, path: string) {
  patchPane(cwd, { active: path, selected: path, open: paneOf(cwd).open.map(file => file.path === path ? { ...file, focus: file.focus + 1 } : file) });
  void loadDoc(cwd, path);
}
export function setFileView(cwd: string, path: string, view: "source" | "preview") {
  patchPane(cwd, pane => ({ open: pane.open.map(file => file.path === path ? { ...file, view } : file) }));
}
/** The tab stays; a preview that is edited or double-clicked is kept. */
export function keep(cwd: string, path: string) { patchPane(cwd, pane => ({ open: pane.open.map(file => file.path === path ? { ...file, preview: false } : file) })); }
export function closeFiles(cwd: string, paths: string[]) {
  const pane = paneOf(cwd), order = pane.open.map(file => file.path), left = order.filter(path => !paths.includes(path));
  // The tab shown after the one shown closes: the nearest to its right that stays, else the nearest to its left.
  const at = order.indexOf(pane.active ?? ""), stays = (path: string) => left.includes(path);
  const active = pane.active && stays(pane.active) ? pane.active : order.slice(at + 1).find(stays) ?? order.slice(0, Math.max(at, 0)).reverse().find(stays) ?? null;
  patchPane(cwd, { open: pane.open.filter(file => stays(file.path)), active, selected: pane.selected && paths.includes(pane.selected) ? active : pane.selected });
  set({ docs: Object.fromEntries(Object.entries(state.docs).filter(([key]) => !paths.some(path => key === docKey(cwd, path)))) });
}
export function edit(cwd: string, path: string, text: string) {
  patchDoc(docKey(cwd, path), doc => doc.status === "ready" ? { ...doc, text } : doc);
  keep(cwd, path);
}
export function revert(cwd: string, path: string) { patchDoc(docKey(cwd, path), doc => doc.status === "ready" ? { ...doc, text: doc.saved, saveError: "" } : doc); }
export async function save(cwd: string, path: string) {
  const key = docKey(cwd, path), doc = state.docs[key];
  if (doc?.status !== "ready" || doc.saving || doc.text === doc.saved) return;
  const sent = doc.text;
  patchDoc(key, current => current.status === "ready" ? { ...current, saving: true, saveError: "" } : current);
  try {
    const result = await api<{ mtimeMs: number }>("/file", { ...location(cwd, path), content: doc.eol === "\r\n" ? sent.replace(/\n/g, "\r\n") : sent, mtimeMs: doc.mtimeMs });
    patchDoc(key, current => current.status === "ready" ? { ...current, saved: sent, mtimeMs: result.mtimeMs, saving: false } : current);
  } catch (cause) { patchDoc(key, current => current.status === "ready" ? { ...current, saving: false, saveError: message(cause) } : current); }
}

/** The tree as rows: each entry of an opened folder under it, indented by depth, in the order the bridge listed them. */
export type Row =
  | { kind: "entry"; path: string; name: string; depth: number; dir: boolean; link: boolean; expanded: boolean; parent: string }
  | { kind: "note"; key: string; depth: number; text: string };
export function treeRows(cwd: string, pane: Pane, dirs: Record<string, Listing>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = dirs[dirKey(cwd, dir, pane.hidden)];
    if (!listing || listing.status === "loading") { if (dir) rows.push({ kind: "note", key: `${dir}/loading`, depth, text: "Loading…" }); return; }
    if (listing.status === "error") { rows.push({ kind: "note", key: `${dir}/error`, depth, text: "Couldn’t read this folder." }); return; }
    if (!listing.entries.length) { rows.push({ kind: "note", key: `${dir}/empty`, depth, text: "Folder is empty" }); return; }
    for (const entry of listing.entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name, expanded = entry.dir && pane.expanded.includes(path);
      rows.push({ kind: "entry", path, name: entry.name, depth, dir: entry.dir, link: !!entry.link, expanded, parent: dir });
      if (expanded) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}
