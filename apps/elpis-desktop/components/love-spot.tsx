"use client";

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Heart, Plus, Trash2, X } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, MainMenu, newElementWith, convertToExcalidrawElements, exportToBlob, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, PointerDownState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dictation } from "@/components/dictation";
import { MatildaWho, useMatilda } from "@/components/love-spot-matilda";
import { MovableBars } from "@/components/love-spot-bars";
import { api, chatProvider, unreadable, type ProviderSettings } from "@/lib/api";
import { applyRemoteScene, mergeRemoteElements, restoreRemoteElements } from "@/lib/love-spot-history";
import { createTextJournal, saveWithTextDrafts } from "@/lib/love-spot-drafts";
import { subscribeLoveSpotEvents } from "@/lib/love-spot-events";
import { MASIH_PEN, lightFiles, lightImage } from "@/lib/love-spot";
import { noticed, told } from "@/lib/matilda";
import { newer } from "@/bridge/love-spot-order.cjs";
import { upgradeAgentArt } from "@/lib/love-agents";
import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";

type BoardPage = { name: string; session: string };
type Drawing = { elements: readonly ExcalidrawElement[]; files: BinaryFiles; appState: Partial<AppState>; page?: BoardPage };
type Saved = { scene: Drawing & { page: BoardPage }; revision: string };
type PageList = { pages: { name: string; modified: number }[] };
type Screenshot = { id: string; name: string; dataURL: string };
type Update = ({ type: "scene" } & Saved) | { type: "screenshots"; screenshots: Screenshot[] } | { type: "error"; message: string };
const screenshotDrag = "application/x-elpis-screenshot";
const versions = (elements: readonly ExcalidrawElement[]) => JSON.stringify(elements.map(e => [e.id, e.version, e.versionNonce, e.isDeleted]));
function snapshot(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles, page?: BoardPage): Drawing {
  // Excalidraw's file serializer drops deleted elements even when they are supplied.
  // Use it only to filter app state. Embedded image bytes are immutable and must not
  // be stringified and parsed again on every pointer move or keystroke.
  return { ...JSON.parse(serializeAsJSON([], appState, {}, "local")), elements: JSON.parse(JSON.stringify(elements)), files: { ...files }, page };
}
async function lightDrawing(drawing: Drawing) { return { ...drawing, files: await lightFiles(drawing.elements, drawing.files) }; }
async function savePicture(data: Saved) {
  const blob = await exportToBlob({ elements: restoreRemoteElements(data.scene.elements).filter(e => !e.isDeleted),
    appState: { ...data.scene.appState, exportBackground: true }, files: data.scene.files, mimeType: "image/png", exportPadding: 24, maxWidthOrHeight: 2400 });
  const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  await api("/love-spot/picture", { revision: data.revision, png: dataURL.split(",")[1] });
}

export default function LoveSpot({ dark, cwd, onOpenChat, toolbarHost }: { dark: boolean; cwd?: string; onOpenChat?: (id: string) => void; toolbarHost?: HTMLElement | null }) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState>();
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const editorRef = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const ready = useCallback((value: ExcalidrawImperativeAPI) => { editorRef.current = value; setEditor(value); }, []);
  const [settings, setSettings] = useState<ProviderSettings | null>(null), [whoOpen, setWhoOpen] = useState(false);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]), [choosing, setChoosing] = useState(false);
  const [page, setPage] = useState<BoardPage>(), [pages, setPages] = useState<PageList["pages"]>([]), [pagesError, setPagesError] = useState("");
  const [pageToDelete, setPageToDelete] = useState<string>();
  const [pageBusy, setPageBusy] = useState(false), [renaming, setRenaming] = useState(false), [pageName, setPageName] = useState("");
  const currentPage = useRef<BoardPage>(undefined);
  const lastPoint = useRef<{ x: number; y: number }>(undefined);
  const boardArea = useRef<HTMLDivElement>(null);
  const latest = useRef<Drawing | undefined>(undefined);
  const revision = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const viewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const saveLatest = useRef<((picture?: boolean, finishEdit?: boolean) => Promise<boolean>) | undefined>(undefined);
  const journal = useRef<ReturnType<typeof createTextJournal>>(undefined);
  const deferred = useRef<Saved>(undefined);
  const editingId = useRef<string>(undefined);
  const recoveryPending = useRef(false);
  const mounted = useRef(true);
  const remote = useRef(false);
  const placingScreenshot = useRef<string>(undefined);
  const report = useCallback((e: unknown) => { if (mounted.current) setError(e instanceof Error ? e.message : "Love Spot could not save the drawing."); }, []);
  if (!journal.current && typeof window !== "undefined") journal.current = createTextJournal(report);
  // A page list that fails is shown in the Pages menu it belongs to; the shared message line is cleared by every save.
  const loadPages = useCallback(() => { void api<PageList>("/love-spot/pages").then(data => {
    if (!Array.isArray(data?.pages)) throw unreadable("Love Spot pages");
    if (mounted.current) { setPages(data.pages); setPagesError(""); }
  }).catch(e => { if (mounted.current) setPagesError(e instanceof Error ? e.message : String(e)); }); }, []);

  useEffect(() => {
    let active = true;
    api<ProviderSettings>("/settings").then(config => {
      if (!config.main || (config.providers !== undefined && !Array.isArray(config.providers))) throw unreadable("Love Spot settings");
      if (active) setSettings(config);
    }).catch(report);
    return () => { active = false; };
  }, [report]);
  const provider = chatProvider(settings?.main.model, undefined, settings?.main.provider);

  useEffect(() => {
    if (!editor || !boardArea.current) return;
    const observer = new ResizeObserver(() => editor.refresh());
    observer.observe(boardArea.current);
    return () => observer.disconnect();
  }, [editor]);

  useEffect(() => {
    let active = true;
    api<Saved>("/love-spot").then(async data => {
      if (!active) return;
      const art = upgradeAgentArt(data.scene.elements, data.scene.files);
      if (art) data = await api<Saved>("/love-spot", await lightDrawing({ ...data.scene, ...art }));
      if (!active) return;
      revision.current = data.revision;
      currentPage.current = data.scene.page; setPage(data.scene.page); loadPages();
      journal.current!.acknowledge(data.scene.elements, data.scene.page);
      const recovered = journal.current!.recover(data.scene.elements, data.scene.page);
      const elements = restoreRemoteElements(recovered);
      setInitial({ elements, files: data.scene.files, scrollToContent: true,
        appState: { ...data.scene.appState, currentItemStrokeColor: MASIH_PEN, collaborators: new Map() } });
      recoveryPending.current = versions(recovered) !== versions(data.scene.elements);
      setError("");
    }).catch(report);
    return () => { active = false; };
  }, [attempt, loadPages, report]);

  const schedulePicture = useCallback(() => {
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(async () => {
      try {
        await saving.current;
        if (!editor || !mounted.current) return;
        await savePicture({ scene: { ...snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current), page: currentPage.current! }, revision: revision.current });
      } catch (e) { if (!(e instanceof Error && e.message.includes("drawing changed"))) report(e); }
    }, 900);
  }, [editor, report]);

  const receive = useCallback((data: Saved) => {
    // Updating any scene can detach Excalidraw's live textarea. Admit the
    // newest complete remote scene only after the local edit is committed.
    if (editor?.getAppState().editingTextElement || document.querySelector("textarea.excalidraw-wysiwyg")) {
      deferred.current = data; return;
    }
    const recovered = journal.current!.recover(data.scene.elements, data.scene.page);
    const hasRecovery = versions(recovered) !== versions(data.scene.elements);
    if (hasRecovery) data = { ...data, scene: { ...data.scene, elements: recovered } };
    const art = upgradeAgentArt(data.scene.elements, data.scene.files);
    if (art) data = { ...data, scene: { ...data.scene, ...art } };
    revision.current = data.revision;
    const switching = currentPage.current?.session !== data.scene.page.session;
    const renamed = currentPage.current?.name !== data.scene.page.name;
    currentPage.current = data.scene.page;
    if (switching || renamed) { setPage(data.scene.page); loadPages(); }
    if (!editor) return;
    if (switching) {
      clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
      remote.current = true;
      try {
        editor.resetScene();
        editor.addFiles(Object.values(data.scene.files));
        applyRemoteScene(editor, restoreRemoteElements(data.scene.elements),
          { ...editor.getAppState(), ...data.scene.appState, selectedElementIds: {}, collaborators: new Map() });
      } finally { remote.current = false; }
      latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
      setRenaming(false);
      editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
      if (hasRecovery || art || Object.keys(data.scene.files).length) queueMicrotask(() => void saveLatest.current?.());
      return;
    }
    const shown = new Map(editor.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
    const placed = data.scene.elements.find(e => e.id === placingScreenshot.current && !e.isDeleted && !shown.has(e.id));
    const screenshot = placed ?? data.scene.elements.find(e => e.type === "image" && !e.isDeleted && e.id.startsWith("shot-") && !shown.has(e.id));
    const reply = data.scene.elements.some(e => !e.isDeleted && e.id.startsWith("love-reply-") && !shown.has(e.id));
    const changed = mergeRemoteElements(shown, data.scene.elements, newer);
    // File IDs are immutable in Excalidraw: addFiles only accepts missing IDs.
    // Keep originals for undo instead of repeatedly resaving a normalized copy.
    const files = Object.values(data.scene.files).filter(f => !editor.getFiles()[f.id]);
    if (files.length || changed) {
      remote.current = true;
      try {
        if (files.length) editor.addFiles(files);
        if (changed) {
          // Admit remote changes before recording only the user's placement.
          applyRemoteScene(editor, [...shown.values()].filter(e => e.id !== placed?.id));
          if (placed) editor.updateScene({ elements: [...shown.values()], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        }
      } finally { remote.current = false; }
      // A remote merge is included if a local debounce is waiting to save.
      latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
      if (screenshot) {
        editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } });
        editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9 });
      } else if (reply) editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.7, maxZoom: 1 });
      // Inbox images and older pages also pass through the same pixel limit once they arrive.
      if (hasRecovery || art || files.length) queueMicrotask(() => void saveLatest.current?.());
      // Excalidraw may notify after the merged snapshot is already current.
      schedulePicture();
    }
  }, [editor, loadPages, schedulePicture]);

  const capture = useCallback(() => {
    const value = editorRef.current, page = currentPage.current;
    if (!value || !page) return latest.current;
    const draft = journal.current!.capture(value, page);
    const elements = value.getSceneElementsIncludingDeleted();
    return snapshot(draft ? elements.map(e => e.id === draft.id ? draft : e) : elements, value.getAppState(), value.getFiles(), page);
  }, []);

  const save = useCallback((picture = false, finishEdit = false) => {
    clearTimeout(saveTimer.current);
    const drawing = capture();
    if (!drawing) return Promise.resolve(false);
    const protectedIds = journal.current!.protectedIds(drawing.elements, drawing.page);
    if (mounted.current) setSaveStatus("Saving…");
    let succeeded = false;
    saving.current = saving.current.catch(() => {}).then(async () => {
      const data = await saveWithTextDrafts(drawing, protectedIds, async outgoing => api<Saved>("/love-spot", await lightDrawing(outgoing)).catch(async e => {
        if (!(e instanceof Error) || !e.message.includes("page changed")) throw e;
        return api<Saved>("/love-spot/text", { page: outgoing.page, elements: outgoing.elements.filter(e => e.type === "text") });
      }));
      journal.current!.acknowledge(data.scene.elements, data.scene.page, finishEdit ? undefined : editorRef.current?.getAppState().editingTextElement?.id);
      if (mounted.current && drawing.page?.session === currentPage.current?.session) {
        const unchanged = versions(editorRef.current?.getSceneElementsIncludingDeleted() ?? []) === versions(drawing.elements);
        // An archived-page save reply must not replace a deferred remote page
        // switch. The event stream owns remote admission during an edit.
        if (!editorRef.current?.getAppState().editingTextElement && !document.querySelector("textarea.excalidraw-wysiwyg")) receive(data);
        setError("");
        setSaveStatus(unchanged ? "Saved" : "Unsaved");
      }
      succeeded = true;
      if (picture) await savePicture(data);
    }).catch(e => { if (mounted.current) setSaveStatus("Save failed"); report(e); });
    return saving.current.then(() => succeeded);
  }, [capture, receive, report]);
  useEffect(() => { saveLatest.current = save; }, [save]);

  useEffect(() => {
    if (!editor) return;
    void document.fonts.load("20px Excalifont").catch(report);
    return subscribeLoveSpotEvents(event => {
      try {
        const data: Update = JSON.parse(event.data);
        if (data.type === "error") setError(data.message);
        else if (data.type === "screenshots") setScreenshots(data.screenshots);
        else if (data.revision !== revision.current) receive(data);
      } catch (e) { report(e); }
    }, () => setError("Love Spot is reconnecting… Your drawing is still here."));
  }, [editor, receive, report]);

  useEffect(() => {
    const input = (event: Event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches(".excalidraw-wysiwyg")) return;
      capture(); // Synchronous journal before debounce, blur, or unload.
    };
    const flush = () => { void saveLatest.current?.(); };
    const unload = () => {
      const drawing = capture();
      if (drawing?.page) {
        // Text-only keepalive is bounded independently of large board images.
        const elements = drawing.elements.filter(e => e.type === "text");
        void fetch("/api/love-spot/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: drawing.page, elements }), keepalive: true }).catch(() => {});
      }
      flush();
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopImmediatePropagation(); flush();
      }
    };
    const storageError = window.elpisDesktop?.storage?.onError(report);
    window.__elpisFlushLoveSpot = () => saveLatest.current?.(false, true) ?? Promise.resolve(true);
    document.addEventListener("input", input);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("input", input); document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", flush); window.removeEventListener("beforeunload", unload); storageError?.();
      delete window.__elpisFlushLoveSpot;
    };
  }, [capture, report]);

  useEffect(() => {
    mounted.current = true;
    // Acquiring the editor changes `save`; that is not a view unmount.
    return () => { mounted.current = false; clearTimeout(saveTimer.current); clearTimeout(viewTimer.current); saveLatest.current?.(true, true); };
  }, []);

  const sendWithBoard = useCallback(async (send: (revision: string) => Promise<void>) => {
    clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
    // Keep capture and dispatch in the save queue. A simultaneous save must
    // wait until Matilda accepts the picture before changing its revision.
    const work = saving.current.then(async () => {
      if (!editor) throw new Error("The board is still opening. Try again in a moment.");
      const data = await api<Saved>("/love-spot", await lightDrawing(snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current)));
      receive(data); await savePicture(data); await send(data.revision);
    });
    saving.current = work.then(() => {}, () => {});
    return work;
  }, [editor, receive]);

  // Matilda answers what he writes or draws; the board is the conversation. `told` reads the notes as they stand when she looks.
  const matilda = useMatilda({ ready: !!editor && !!settings, onError: setError,
    told: ids => told(editorRef.current?.getSceneElements() ?? [], ids),
    send: (text, persona) => sendWithBoard(async revision => { await api("/love-spot/talk", { text, persona, revision }); }) });

  const changed = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const before = latest.current;
    // onChange contains only live elements. Persist the API's tombstones too, or a stale
    // writer would resurrect a shape the user just deleted.
    const all = editorRef.current?.getSceneElementsIncludingDeleted() ?? elements;
    latest.current = snapshot(all, appState, files, currentPage.current);
    if (recoveryPending.current) { recoveryPending.current = false; queueMicrotask(() => void saveLatest.current?.()); }
    const editing = appState.editingTextElement && all.find(e => e.id === appState.editingTextElement?.id);
    const endedEdit = editingId.current && !editing;
    editingId.current = editing?.id;
    if (!remote.current && editing && currentPage.current) journal.current!.record(editing, currentPage.current);
    if (!editing && deferred.current) {
      const pending = deferred.current; deferred.current = undefined;
      queueMicrotask(() => { if (mounted.current) receive(pending); });
    }
    // Loading, selection and pointer movement do not need a save or a new PNG.
    const filesChanged = before && (Object.keys(before.files).length !== Object.keys(files).length || Object.entries(files).some(([id, file]) => before.files[id]?.dataURL !== file.dataURL));
    const drawingChanged = before && (filesChanged || versions(before.elements) !== versions(all) || JSON.stringify(before.appState) !== JSON.stringify(latest.current.appState));
    if (!remote.current && drawingChanged) {
      matilda.notice(noticed(before.elements, all));
      setSaveStatus("Unsaved");
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(), 150);
    }
    if (!remote.current && endedEdit) queueMicrotask(() => void saveLatest.current?.());
    if (drawingChanged) schedulePicture();
  }, [editor, matilda, receive, save, schedulePicture]);

  async function chooseScreenshot(id: string, action: "place" | "dismiss") {
    if (choosing) return;
    setChoosing(true);
    try {
      if (action === "place") {
        placingScreenshot.current = id;
        const shot = screenshots.find(s => s.id === id);
        if (!shot) return;
        const file = await lightImage({ dataURL: shot.dataURL, mimeType: "image/png" });
        receive(await api<Saved>("/love-spot/screenshots", { id, action, dataURL: file.dataURL }));
      }
      else await api("/love-spot/screenshots", { id, action });
      setScreenshots(shots => shots.filter(shot => shot.id !== id)); setError("");
    } catch (e) { report(e); }
    finally { placingScreenshot.current = undefined; setChoosing(false); }
  }

  async function changePage(action: "new" | "switch" | "rename" | "delete", name?: string) {
    if (pageBusy || !editor) return;
    setPageBusy(true);
    try {
      clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
      if (!await save()) return;
      receive(await api<Saved>("/love-spot/pages", { action, ...(name === undefined ? {} : { name }), page: currentPage.current }));
      setRenaming(false); setError(""); loadPages();
    } catch (e) { report(e); }
    finally { setPageBusy(false); }
  }


  function insertion() {
    if (!editor) return { text: "", start: 0, end: 0 };
    const state = editor.getAppState();
    const point = lastPoint.current ?? viewportCoordsToSceneCoords({ clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 }, state);
    return { text: JSON.stringify({ ...point, color: state.currentItemStrokeColor }), start: 0, end: 0 };
  }
  function addVoiceNote(selection: { text: string }, text: string) {
    if (!editor || !text.trim()) return;
    const point: { x: number; y: number; color: string } = JSON.parse(selection.text);
    const note = convertToExcalidrawElements([{ type: "text", x: point.x, y: point.y, text: text.trim(), strokeColor: point.color, fontSize: 20 }]);
    editor.updateScene({ elements: [...editor.getSceneElementsIncludingDeleted(), ...note] });
    latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
    save(true);
  }

  const tools = <div className="navbar love-spot-tools">
      <div className="love-spot-pages">
        <DropdownMenu onOpenChange={open => { if (open) loadPages(); }}>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Pages" disabled={!editor || pageBusy} />}>
            <span className="truncate max-w-40">{page?.name ?? "Pages"}</span><ChevronDown aria-hidden="true" size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 max-w-80 overflow-y-auto">
            <DropdownMenuItem onClick={() => { setPageName(page?.name ?? ""); setRenaming(true); }}>Rename page</DropdownMenuItem>
            {pages.map(item => <DropdownMenuItem key={item.name} onClick={() => void changePage("switch", item.name)}>
              <Check aria-hidden="true" className={item.name === page?.name ? "shrink-0" : "invisible shrink-0"} />
              <span className="min-w-0"><span className="block truncate">{item.name}</span><time className="block text-xs text-muted-foreground" dateTime={new Date(item.modified).toISOString()}>{new Date(item.modified).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time></span>
            </DropdownMenuItem>)}
            {pagesError && <DropdownMenuItem disabled className="whitespace-normal text-muted-foreground">{pagesError}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" disabled={!editor || pageBusy} onClick={() => void changePage("new")}><Plus aria-hidden="true" />New page</Button>
        <Button variant="ghost" size="sm" aria-label="Delete current page" title="Delete current page" disabled={!editor || pageBusy || !page} onClick={() => setPageToDelete(page?.name)}><Trash2 aria-hidden="true" />Delete</Button>
        {renaming && <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); void changePage("rename", pageName.trim()); }}>
          <Input autoFocus aria-label="Page name" value={pageName} maxLength={100} className="max-w-48" onChange={event => setPageName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(false); }} />
          <Button variant="outline" size="sm" type="submit" disabled={pageBusy || !pageName.trim()}>Save</Button>
          <Button variant="ghost" size="sm" type="button" onClick={() => setRenaming(false)}>Cancel</Button>
        </form>}
      </div>
      <div role="group" aria-label="Voice note"><Dictation provider={provider} disabled={!editor || !settings} onBusy={() => {}} selection={insertion} onTranscript={addVoiceNote} purpose="Adds a note to the board." /></div>
      {matilda.replying && <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Matilda status">Matilda is writing…</span>}
      {saveStatus && <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Drawing save status">{saveStatus}</span>}
    </div>;
  return <section className="love-spot" aria-label="Love Spot">
    {toolbarHost ? createPortal(tools, toolbarHost) : tools}
    <AlertDialog open={!!pageToDelete} onOpenChange={open => { if (!open) setPageToDelete(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{pageToDelete}”?</AlertDialogTitle>
          <AlertDialogDescription>This page moves to Trash. A blank page opens so you can keep drawing.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
          <Button type="button" variant="destructive" disabled={pageBusy} onClick={() => { const name = pageToDelete; setPageToDelete(undefined); if (name) void changePage("delete", name); }}>Delete page</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {screenshots.length > 0 && <section className="love-spot-screenshots" aria-label="New screenshots">
      <div className="love-spot-screenshots-heading"><strong>New screenshots</strong><span>Only shared when you add them. Click or drag onto the drawing.</span></div>
      <ul className="love-spot-screenshots-list">{screenshots.map(shot => <li key={shot.id}>
        <Button variant="outline" className="love-spot-screenshot" aria-label={`Add ${shot.name} to drawing`} title={`Add ${shot.name} to drawing`} disabled={choosing} draggable onDragStart={event => {
          event.dataTransfer.setData(screenshotDrag, shot.id); event.dataTransfer.effectAllowed = "copy";
        }} onClick={() => void chooseScreenshot(shot.id, "place")}>
          {/* Private previews stay outside Excalidraw and its exported scene. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shot.dataURL} alt="" draggable={false} /><span>{shot.name}</span>
        </Button>
        <Button variant="outline" size="icon-xs" className="love-spot-screenshot-dismiss" aria-label={`Dismiss ${shot.name}`} title={`Dismiss ${shot.name}`} disabled={choosing} onClick={() => void chooseScreenshot(shot.id, "dismiss")}><X aria-hidden="true" /></Button>
      </li>)}</ul>
    </section>}
    <MatildaWho open={whoOpen} onOpenChange={setWhoOpen} persona={matilda.persona} onSave={matilda.keep} />
    {error && <div className="love-spot-status" role="alert">{error}<Button variant="ghost" size="sm" onClick={() => { if (editor) save(); else setAttempt(a => a + 1); }}>Retry</Button></div>}
    <div className="love-spot-content"><div className="love-spot-editor" ref={boardArea} onDragOverCapture={event => {
      if (event.dataTransfer.types.includes(screenshotDrag)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }
    }} onDropCapture={event => {
      const id = event.dataTransfer.getData(screenshotDrag);
      if (id) { event.preventDefault(); event.stopPropagation(); void chooseScreenshot(id, "place"); }
    }}>
      {initial && <MovableBars board={boardArea} />}
      {initial ? <Excalidraw initialData={initial} excalidrawAPI={ready} onChange={changed} onPointerDown={(_tool: AppState["activeTool"], state: PointerDownState) => { lastPoint.current = state.origin; }} theme={dark ? "dark" : "light"}>
        {/* Excalidraw's own menu without its links to GitHub, X and Discord and without live collaboration. */}
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.CommandPalette className="highlighted" />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.Item icon={<Heart size={16} aria-hidden="true" />} onSelect={() => setWhoOpen(true)}>Who Matilda is…</MainMenu.Item>
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw> : !error && <p role="status">Opening Love Spot…</p>}
    </div>
    </div>
  </section>;
}
