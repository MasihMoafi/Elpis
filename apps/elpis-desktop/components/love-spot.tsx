"use client";

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Heart, ImagePlus, Pin, Trash2, X } from "lucide-react";
import { PlusIcon, ModelsIcon } from "@/components/elpis-icons";
import { ProvidersSettings } from "@/components/providers-settings";
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, PointerDownState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { appStorage } from "@/lib/projects";
import { ReadAloud, useReadAloud } from "@/components/read-aloud";
import { useDrawingStyle } from "@/components/drawing-style";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Dictation } from "@/components/dictation";
import { MatildaWho, useMatilda } from "@/components/love-spot-matilda";
import { ModelPicker } from "@/components/model-picker";
import { api, chatProvider, providerChoices, unreadable, type ProviderSettings } from "@/lib/api";
import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";
import { keepModel, savedModel, MATILDA_CHANGED } from "@/lib/matilda";
import { useMatildaSettings, type MatildaSettings } from "@/lib/matilda-settings";
import { MatildaSwitch } from "@/components/matilda-switch";
import { applyRemoteScene, mergeRemoteElements, restoreRemoteElements } from "@/lib/love-spot-history";
import { createTextJournal, saveWithTextDrafts } from "@/lib/love-spot-drafts";
import { subscribeLoveSpotEvents } from "@/lib/love-spot-events";
import { MASIH_PEN, latestMessage, lightFiles, lightImage } from "@/lib/love-spot";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { noticed, told } from "@/lib/matilda";
import { newer } from "@/bridge/love-spot-order.cts";
import { BOARD_THEMED, MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } from "@/bridge/matilda-face.cts";
import { savePreferences, usePreferences } from "@/lib/preferences";
import { THEME_CHARACTER_LIST, useThemeCharacter } from "@/lib/theme-characters";
import { upgradeAgentArt } from "@/lib/love-agents";
import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";
import { errorText } from "@/lib/error-text.mts";
const REPLIES_KEY = "elpis-matilda-replies";

type BoardPage = { name: string; session: string };
type Drawing = { elements: readonly ExcalidrawElement[]; files: BinaryFiles; appState: Partial<AppState>; page?: BoardPage };
type Saved = { scene: Drawing & { page: BoardPage }; revision: string };
type PageList = { pages: { name: string; modified: number; kept?: boolean; expires?: number }[] };
type Screenshot = { id: string; name: string; dataURL: string };
type Update = ({ type: "scene" } & Saved) | { type: "screenshots"; screenshots: Screenshot[] } | { type: "error"; message: string } | { type: "matilda" };
const screenshotDrag = "application/x-elpis-screenshot";
const versions = (elements: readonly ExcalidrawElement[]) => JSON.stringify(elements.map(e => [e.id, e.version, e.versionNonce, e.isDeleted]));
function snapshot(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles, page?: BoardPage): Drawing {
  // Excalidraw's file serializer drops deleted elements even when they are supplied.
  // Use it only to filter app state. Embedded image bytes are immutable and must not
  // be stringified and parsed again on every pointer move or keystroke.
  return { ...JSON.parse(serializeAsJSON([], appState, {}, "local")), elements: JSON.parse(JSON.stringify(elements)), files: { ...files }, page };
}
/** The part of the board Excalidraw's own toolbar, style panel and zoom bar leave clear (29 Oct: her notes ran under the
 * toolbar). Showing a note or the drawing fits it there, so the board's chrome never covers what it shows. */
function clearOfTools(area: HTMLElement | null) {
  const board = area?.querySelector(".excalidraw")?.getBoundingClientRect();
  if (!area || !board) return undefined;
  const part = (selector: string) => area.querySelector(selector)?.getBoundingClientRect();
  const tools = part(".App-toolbar"), panel = part(".App-menu__left"), footer = part(".layer-ui__wrapper__footer-left"), gap = 16;
  return { top: (tools ? tools.bottom - board.top : 0) + gap, left: (panel?.width ? panel.right - board.left : 0) + gap, right: gap, bottom: (footer ? board.bottom - footer.top : 0) + gap };
}
const scrollOffsets = (area: HTMLElement | null) => { const offsets = clearOfTools(area); return offsets ? { canvasOffsets: offsets } : {}; };
// Her faces on the board wear the theme's clothes: the saved scene keeps the dark-clothed picture, display swaps it.
const boardFiles = (files: BinaryFiles, dark: boolean) => Object.fromEntries(Object.entries(files).map(([id, file]) => {
  const themed = (BOARD_THEMED as Record<string, { dark: string; light: string }>)[file.dataURL];
  if (!themed) return [id, file];
  const dataURL = dark ? themed.dark : themed.light;
  return [id, { ...file, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")) }];
})) as BinaryFiles;
const savedBoardFiles = (files: BinaryFiles) => boardFiles(files, true);
async function lightDrawing(drawing: Drawing) { const files = savedBoardFiles(drawing.files); return { ...drawing, files: await lightFiles(drawing.elements, files) }; }
async function savePicture(data: Saved) {
  const blob = await exportToBlob({ elements: restoreRemoteElements(data.scene.elements).filter(e => !e.isDeleted),
    appState: { ...data.scene.appState, exportBackground: true }, files: data.scene.files, mimeType: "image/png", exportPadding: 24, maxWidthOrHeight: 2400 });
  const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  await api("/love-spot/picture", { revision: data.revision, png: dataURL.split(",")[1] });
}

type LoveSpotProps = { dark: boolean; toolbarHost?: HTMLElement | null };
type MatildaVoice = { enabled: boolean; available: boolean; reason: string; error: string };
export default function LoveSpot(props: LoveSpotProps) {
  // Inside Elpis the app provides her voice, so it outlives the board; the standalone Love Spot brings its own.
  const app = useReadAloud();
  if (app) return <LoveSpotBoard {...props} />;
  return <ReadAloud threadId="love-spot" enabled available={LOVE_SPOT_AUDIO.readAloudAvailable} {...(LOVE_SPOT_AUDIO.available ? {} : { unavailableReason: LOVE_SPOT_AUDIO.reason })}><LoveSpotBoard {...props} /></ReadAloud>;
}
const SUBSCRIPTION_CHOICE = /^(claude|agy)\//;
const standaloneApp = typeof location !== "undefined" && new URLSearchParams(location.search).get("app") === "love-spot";

function LoveSpotBoard({ dark, toolbarHost }: LoveSpotProps) {
  const speech = useReadAloud();
  const { selectedPalette } = usePreferences();
  const character = useThemeCharacter();
  const voiceEnabled = useRef(false);
  const voiceVersion = useRef(0);
  const calling = false; // no voice call with her any more (1 Nov)
  const [initial, setInitial] = useState<ExcalidrawInitialDataState>();
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const { notice: noticeStyle, toggle: styleToggle, className: styleClassName } = useDrawingStyle(editor);
  const editorRef = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const ready = useCallback((value: ExcalidrawImperativeAPI) => { editorRef.current = value; setEditor(value); }, []);
  const [settings, setSettings] = useState<ProviderSettings | null>(null), [whoOpen, setWhoOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false), [accountRefresh, setAccountRefresh] = useState(0);
  const { models } = useModelCatalog(), [pick, setPick] = useState(savedModel);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]), [choosing, setChoosing] = useState(false);
  const [page, setPage] = useState<BoardPage>(), [pages, setPages] = useState<PageList["pages"]>([]), [pagesError, setPagesError] = useState("");
  const [pageToDelete, setPageToDelete] = useState<string>(), [clearing, setClearing] = useState(false), [pagesOpen, setPagesOpen] = useState(false);
  const [pageBusy, setPageBusy] = useState(false), [renaming, setRenaming] = useState(false), [pageName, setPageName] = useState("");
  const currentPage = useRef<BoardPage>(undefined);
  const pagesScroll = useRef(0), reopenPages = useRef(false), queuedPage = useRef<string>(undefined);
  const pagesMenu = useRef<HTMLDivElement>(null);
  // The page list opens where it was left, with the page shown in view (Masih, 5 Nov: "it should remember my position w.r.t. the
  // scroll (so if I'm in the middle, I wouldn't have to scroll again only to find the next note)").
  // Each time the list opens it has no height for a frame or two, and restoring then would land at the top; the scrolling
  // done by the restore itself is not recorded. The shown page's row takes focus, so Up and Down step from it.
  const restoringPages = useRef(false);
  useEffect(() => {
    if (!pagesOpen) return;
    restoringPages.current = true;
    let frames = 0, frame = 0;
    const restore = () => {
      const node = pagesMenu.current;
      if ((!node || node.scrollHeight <= node.clientHeight) && frames++ < 30) { frame = requestAnimationFrame(restore); return; }
      if (node) {
        node.scrollTop = pagesScroll.current;
        const row = [...node.querySelectorAll<HTMLElement>("[data-page-name]")].find(item => item.dataset.pageName === currentPage.current?.name);
        row?.scrollIntoView({ block: "nearest" }); row?.focus({ preventScroll: true });
        pagesScroll.current = node.scrollTop;
      }
      restoringPages.current = false;
    };
    frame = requestAnimationFrame(restore);
    return () => { cancelAnimationFrame(frame); restoringPages.current = false; };
  }, [pagesOpen]);
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
  const placingScreenshot = useRef<string>(undefined), placingAll = useRef(false);
  const opening = useRef<string[]>([]);
  const report = useCallback((e: unknown) => { if (mounted.current) setError(errorText(e, "Love Spot could not save the drawing.")); }, []);
  if (!journal.current && typeof window !== "undefined") journal.current = createTextJournal(report);
  // A page list that fails is shown in the Pages menu it belongs to; the shared message line is cleared by every save.
  const loadPages = useCallback(() => { void api<PageList>("/love-spot/pages").then(data => {
    if (!Array.isArray(data?.pages)) throw unreadable("Love Spot pages");
    if (mounted.current) { setPages(data.pages); setPagesError(""); }
  }).catch(e => { if (mounted.current) setPagesError(errorText(e)); }); }, []);

  const reloadAccounts = useCallback(async () => {
    setAccountRefresh(value => value + 1);
    void refreshModelCatalog();
    try {
      const config = await api<ProviderSettings>("/settings");
      if (!config.main || (config.providers !== undefined && !Array.isArray(config.providers))) throw unreadable("Love Spot settings");
      if (mounted.current) setSettings(config);
    } catch (e) { report(e); }
  }, [report]);

  useEffect(() => {
    let active = true;
    void refreshModelCatalog();
    api<ProviderSettings>("/settings").then(config => {
      if (!config.main || (config.providers !== undefined && !Array.isArray(config.providers))) throw unreadable("Love Spot settings");
      if (active) setSettings(config);
    }).catch(report);
    return () => { active = false; };
  }, [report]);
  useEffect(() => {
    if (!LOVE_SPOT_AUDIO.available) return;
    let active = true;
    void api<MatildaVoice>("/love-spot/voice/settings").then(value => {
      if (active) { voiceEnabled.current = value.enabled; }
    }).catch(cause => { if (active) report(cause); });
    return () => { active = false; };
  }, []);
  const provider = chatProvider(settings?.main.model, undefined, settings?.main.provider);
  // Any connected model: a model from another connection starts her a new chat (bridge/love-spot-talk.mts).
  // The standalone app may not route Claude or Gemini subscriptions (bridge/love-spot-talk.mts), so it does not offer them.
  const choices = providerChoices(models, settings).filter(choice => !standaloneApp || !SUBSCRIPTION_CHOICE.test(choice.id));
  const pickedProvider = choices.find(choice => choice.id === pick.choiceId)?.provider;

  useEffect(() => {
    if (!editor || !opening.current.length) return;
    const ids = new Set(opening.current); opening.current = [];
    // Excalidraw hands over its API before it has loaded the initial scene; wait (at most about a second) for the note to arrive.
    let frame = 0, tries = 60;
    const show = () => {
      const target = editor.getSceneElements().filter(e => ids.has(e.id));
      if (target.length) editor.scrollToContent(target, { fitToViewport: true, viewportZoomFactor: 0.8, maxZoom: 1, ...scrollOffsets(boardArea.current) });
      else if (--tries > 0) frame = requestAnimationFrame(show);
    };
    frame = requestAnimationFrame(show);
    return () => cancelAnimationFrame(frame);
  }, [editor]);
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
      // Opening Love Spot shows the newest note, as a chat opens at its last message; a board without notes (a screenshot's page) fits everything.
      // Read before restoring: index repair stamps every unindexed element (her replies) with the time of opening.
      const note = latestMessage(recovered);
      opening.current = (note.length ? note : recovered.filter(e => !e.isDeleted)).map(e => e.id);
      setInitial({ elements, files: boardFiles(data.scene.files, dark), scrollToContent: false,
        appState: { ...data.scene.appState, currentItemStrokeColor: MASIH_PEN, collaborators: new Map() } });
      recoveryPending.current = versions(recovered) !== versions(data.scene.elements);
      setError("");
    }).catch(report);
    return () => { active = false; };
  }, [attempt, dark, loadPages, report]);

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
      deferred.current = data;
      return;
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
        editor.addFiles(Object.values(boardFiles(data.scene.files, dark)));
        applyRemoteScene(editor, restoreRemoteElements(data.scene.elements),
          { ...editor.getAppState(), ...data.scene.appState, selectedElementIds: {}, collaborators: new Map() });
      } finally { remote.current = false; }
      latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
      setRenaming(false);
      editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, ...scrollOffsets(boardArea.current) });
      if (hasRecovery || art || Object.keys(data.scene.files).length) queueMicrotask(() => void saveLatest.current?.());
      return;
    }
    const shown = new Map(editor.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
    const placed = data.scene.elements.find(e => e.id === placingScreenshot.current && !e.isDeleted && !shown.has(e.id));
    const screenshot = placed ?? data.scene.elements.find(e => e.type === "image" && !e.isDeleted && e.id.startsWith("shot-") && !shown.has(e.id));
    const changed = mergeRemoteElements(shown, data.scene.elements, newer);
    // File IDs are immutable in Excalidraw: addFiles only accepts missing IDs.
    // Keep originals for undo instead of repeatedly resaving a normalized copy.
    const files = Object.values(boardFiles(data.scene.files, dark)).filter(f => !editor.getFiles()[f.id]);
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
        editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9, ...scrollOffsets(boardArea.current) });
      }
      // Her reply never moves his view (5 Nov: it zoomed the board out; the switch that offered it is gone).
      // Inbox images and older pages also pass through the same pixel limit once they arrive.
      if (hasRecovery || art || files.length) queueMicrotask(() => void saveLatest.current?.());
      // Excalidraw may notify after the merged snapshot is already current.
      schedulePicture();
    }
  }, [dark, editor, loadPages, schedulePicture]);

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
        else if (data.type === "matilda") return;
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

  const sendWithBoard = useCallback(async (send: (revision: string, pageSession: string | undefined) => Promise<boolean>, readyToSend: () => boolean): Promise<"sent" | "wait" | "stale"> => {
    const origin = currentPage.current?.session;
    const isCurrent = () => readyToSend() && currentPage.current?.session === origin;
    clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
    // Keep capture and dispatch in the save queue. A simultaneous save must
    // wait until Matilda accepts the picture before changing its revision.
    const work = saving.current.then(async () => {
      if (!editor || !isCurrent()) return "stale" as const;
      const drawing = await lightDrawing(snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current));
      if (!isCurrent()) return "stale" as const;
      const data = await api<Saved>("/love-spot", drawing);
      if (!isCurrent()) return "stale" as const;
      receive(data);
      try { await savePicture(data); }
      catch (cause) { if (!isCurrent()) return "stale" as const; throw cause; }
      if (!isCurrent()) return "stale" as const;
      return await send(data.revision, origin) ? "sent" as const : "wait" as const;
    });
    saving.current = work.then(() => {}, () => {});
    return work;
  }, [editor, receive]);

  // Matilda answers what he writes or draws; the board is the conversation. `told` reads the notes as they stand when she looks.
  // Masih, 31 Oct: "the agent keeps talking in the love-spot; I was drawing that for you; there should be a disable button there."
  const shared = useMatildaSettings(), replies = shared.settings?.replies !== false;
  const repliesRef = useRef(replies); repliesRef.current = replies;
  // Until 31 Oct the board kept its own switch and model; carry them into the one shared setting once.
  const migrated = useRef(false);
  useEffect(() => {
    if (!shared.settings || migrated.current) return;
    migrated.current = true;
    const change: Partial<MatildaSettings> = {};
    if (appStorage().getItem(REPLIES_KEY) === "off" && shared.settings.replies) change.replies = false;
    if (!shared.settings.model && pick.model) Object.assign(change, { model: pick.model, provider: pickedProvider ?? null });
    try { appStorage().removeItem(REPLIES_KEY); } catch { /* nothing to carry next time either way */ }
    if (Object.keys(change).length) void shared.update(change).catch(report);
  }, [shared, pick.model, pickedProvider, report]);
  const chooseReplies = (on: boolean) => {
    repliesRef.current = on;
    if (!on) void matilda.quiet();
    void shared.update({ replies: on }).catch(report);
  };
  const matilda = useMatilda({ ...(page?.session === undefined ? {} : { context: page.session }), enabled: () => repliesRef.current, ready: () => repliesRef.current && !placingAll.current && !!editorRef.current && !!settings && !calling && !pageBusy && !speech?.active && !editorRef.current.getAppState().editingTextElement && !document.querySelector("textarea.excalidraw-wysiwyg"), onError: setError,
    told: ids => told(editorRef.current?.getSceneElements() ?? [], ids),
    drawingOnly: ids => {
      const elements = (editorRef.current?.getSceneElements() ?? []).filter(element => ids.has(element.id) && !element.isDeleted);
      return elements.some(element => element.type !== "text") && elements.every(element => element.type !== "text" || !(element.originalText || element.text).trim());
    },
    send: (text, persona, isCurrent, drawingOnly) => sendWithBoard(async (revision, pageSession) => {
      const version = voiceVersion.current;
      // 5 Nov: a board change must not cut her voice. `ready` holds the next turn until she has finished speaking.
      // Her model is the one shared setting (lib/matilda-settings.ts); the bridge applies it to every message.
      const reply = await api<{ voice: MatildaVoice; waitingForPicture?: boolean }>("/love-spot/talk", { text, persona, revision, drawingOnly, ...(pageSession ? { pageSession } : {}) });
      window.dispatchEvent(new Event(MATILDA_CHANGED));
      if (mounted.current && version === voiceVersion.current) { voiceEnabled.current = reply.voice.enabled; }
      if (mounted.current && !reply.waitingForPicture && voiceEnabled.current && reply.voice.enabled) speech?.stream("matilda");
      return !reply.waitingForPicture;
    }, isCurrent) });
  const wakeMatilda = matilda.wake;
  useEffect(() => { wakeMatilda(); }, [wakeMatilda, shared.settings?.model, shared.settings?.provider]);

  const changed = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    noticeStyle(appState);
    const before = latest.current;
    // onChange contains only live elements. Persist the API's tombstones too, or a stale
    // writer would resurrect a shape the user just deleted.
    const all = editorRef.current?.getSceneElementsIncludingDeleted() ?? elements;
    latest.current = snapshot(all, appState, files, currentPage.current);
    if (recoveryPending.current) { recoveryPending.current = false; queueMicrotask(() => void saveLatest.current?.()); }
    const editing = appState.editingTextElement && all.find(e => e.id === appState.editingTextElement?.id);
    const editChanged = editingId.current !== editing?.id;
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
    if (!remote.current && (drawingChanged || editChanged)) matilda.notice(drawingChanged ? noticed(before.elements, all) : [], !!endedEdit);
    if (!remote.current && drawingChanged) {
      setSaveStatus("Unsaved");
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(), 150);
    }
    if (!remote.current && endedEdit) queueMicrotask(() => void saveLatest.current?.());
    if (drawingChanged) schedulePicture();
  }, [editor, matilda, receive, save, schedulePicture, noticeStyle]);

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

  /** Every new screenshot at once, in the order they were taken, one below the other; Matilda looks only once all are on the
   * board (Masih, 31 Oct: "when I take multiple screenshots there is no option to paste them all one after the other"). */
  async function placeAllScreenshots() {
    if (choosing || placingAll.current) return;
    placingAll.current = true;
    try { for (const shot of [...screenshots].reverse()) await chooseScreenshot(shot.id, "place"); }
    finally { placingAll.current = false; }
  }

  async function changePage(action: "new" | "switch" | "rename" | "delete" | "keep" | "release" | "clear", name?: string) {
    if (pageBusy || !editor) { if (action === "delete") throw new Error("The page is not ready to delete."); return; }
    setPageBusy(true);
    try {
      clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
      if (!await save()) { if (action === "delete") throw new Error("Could not save the current page before deleting."); return; }
      receive(await api<Saved>("/love-spot/pages", { action, ...(name === undefined ? {} : { name }), page: currentPage.current }));
      setRenaming(false); setError(""); loadPages();
    } catch (e) { if (action === "delete") throw e; report(e); }
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
    // updateScene's onChange arrives after this snapshot; explicitly admit the dictated notes before it can hide them.
    matilda.notice(note.map(element => element.id));
    latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
    save(true);
  }

  /** Up and Down open the page above or below the one shown, and the list stays open on it (Masih, 5 Nov: "make the pages
   * changeable via the arrow keys"). Past either end, and on the Rename and Keep rows, the menu's own keys apply. */
  function stepPage(event: ReactKeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void }) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && !target.dataset.pageName) return;
    const at = pages.findIndex(item => item.name === (target.dataset.pageName ?? page?.name));
    const next = pages[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault(); event.preventBaseUIHandler?.();
    const row = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-page-name]")].find(element => element.dataset.pageName === next.name);
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest" });
    // A key pressed while a page is still opening is not lost: the page it reached opens next.
    if (pageBusy) queuedPage.current = next.name; else void changePage("switch", next.name);
  }
  useEffect(() => {
    const name = queuedPage.current;
    if (pageBusy || !name) return;
    queuedPage.current = undefined;
    if (name !== page?.name) void changePage("switch", name);
  });
  // Pages not kept go to the system trash after a week untouched (bridge/love-spot-store.cts, "Page lifecycle").
  const currentKept = !!pages.find(item => item.name === page?.name)?.kept;
  const tools = <div className="navbar love-spot-tools accent-scope">
      <div className="love-spot-pages">
        <DropdownMenu open={pagesOpen} onOpenChange={open => { setPagesOpen(open); if (open) loadPages(); }}>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Pages" className="max-w-full min-w-20 shrink justify-between" disabled={!editor || pageBusy} />}>
            <span className="min-w-0 truncate" title={page?.name ?? "Pages"}>{page?.name ?? "Pages"}</span><ChevronDown aria-hidden="true" size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent ref={pagesMenu} onScroll={event => { if (pagesOpen && !restoringPages.current) pagesScroll.current = event.currentTarget.scrollTop; }} onKeyDown={stepPage} align="start" className="max-h-96 max-w-80 overflow-y-auto">
            <DropdownMenuItem onClick={() => { setPageName(page?.name ?? ""); setRenaming(true); }}>Rename page</DropdownMenuItem>
            {page && <DropdownMenuItem onClick={() => void changePage(currentKept ? "release" : "keep", page.name)}><Pin aria-hidden="true" fill={currentKept ? "currentColor" : "none"} />{currentKept ? "Kept" : "Keep this page"}</DropdownMenuItem>}
            {pages.some(item => item.name !== page?.name && !item.kept) && <DropdownMenuItem variant="destructive" onClick={() => setClearing(true)}><Trash2 aria-hidden="true" />Delete all pages</DropdownMenuItem>}
            {pages.map(item => <DropdownMenuItem key={item.name} data-page-name={item.name} closeOnClick={false} onClick={() => void changePage("switch", item.name)}>
              <Check aria-hidden="true" className={item.name === page?.name ? "shrink-0" : "invisible shrink-0"} />
              <span className="min-w-0 flex-1"><span className="block whitespace-normal break-words">{item.name}</span><time className="block text-xs text-muted-foreground" dateTime={new Date(item.modified).toISOString()}>{new Date(item.modified).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}{item.kept ? "" : item.expires && item.name !== page?.name ? ` · to trash in ${Math.max(1, Math.ceil((item.expires - Date.now()) / 86400000))} d` : ""}</time></span>
              {item.kept && <Pin aria-label="Kept" className="shrink-0" fill="currentColor" />}
              <Button variant="ghost" size="icon-xs" aria-label="Delete page" title={`Delete ${item.name}`} onClick={event => { event.stopPropagation(); reopenPages.current = true; setPagesOpen(false); setPageToDelete(item.name); }} onKeyDown={event => event.stopPropagation()}><Trash2 size={14} /></Button>
            </DropdownMenuItem>)}
            {pagesError && <DropdownMenuItem disabled className="whitespace-normal text-muted-foreground">{pagesError}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" disabled={!editor || pageBusy} aria-label="New page" title="New page" onClick={() => void changePage("new")}><PlusIcon aria-hidden="true" /><span className="love-spot-label">New page</span></Button>
        <Button variant="ghost" size="sm" aria-label="Delete current page" title="Delete current page" disabled={!editor || pageBusy || !page} onClick={() => setPageToDelete(page?.name)}><span className="inline-flex flex-row items-center gap-1"><Trash2 aria-hidden="true" />Delete</span></Button>
        {renaming && <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); void changePage("rename", pageName.trim()); }}>
          <Input autoFocus aria-label="Page name" value={pageName} maxLength={100} className="max-w-48" onChange={event => setPageName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(false); }} />
          <Button variant="outline" size="sm" type="submit" disabled={pageBusy || !pageName.trim()}>Save</Button>
          <Button variant="ghost" size="sm" type="button" onClick={() => setRenaming(false)}>Cancel</Button>
        </form>}
      </div>
      {/* Masih, 23 Oct: "I can't change her model!" It sat inside the ☰ menu's dialog; it belongs on the bar, beside the page. */}
      <div role="group" aria-label="Matilda's model"><ModelPicker choices={choices} models={models} model={shared.settings?.model || pick.model || settings?.main.model || ""} choiceId={pick.choiceId} disabled={!choices.length} allowCustom={false} onConfigure={() => setAccountsOpen(true)} onKeySaved={() => void reloadAccounts()} onChange={value => { setPick(value); keepModel(value); void shared.update({ model: value.model, provider: choices.find(choice => choice.id === value.choiceId)?.provider ?? null }).catch(report); }} /></div>
      <div role="group" aria-label="Voice note"><Dictation provider={provider} disabled={!editor || !settings} onBusy={() => {}} selection={insertion} onTranscript={addVoiceNote} purpose="Adds a note to the board." /></div>
      <MatildaSwitch settings={shared.settings} onChange={chooseReplies} />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Character" title={character ? `${character.name} · ${character.theme}` : "Matilda · Default"} className="shrink-0 gap-1.5 px-2" />}>
          <img src={character?.image ?? (dark ? MATILDA_SHOTS.softSmile : MATILDA_SHOTS_LIGHT.softSmile)} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
          <span className="love-spot-label max-w-28 truncate">{character?.name ?? "Matilda"}</span>
          <ChevronDown aria-hidden="true" size={12} className="love-spot-label shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto" aria-label="Characters">
          <DropdownMenuItem data-character-id="elpis" onClick={() => savePreferences({ selectedPalette: "elpis" })}>
            <Check aria-hidden="true" className={!character ? "shrink-0" : "invisible shrink-0"} />
            <img src={dark ? MATILDA_SHOTS.softSmile : MATILDA_SHOTS_LIGHT.softSmile} alt="" className="size-6 shrink-0 rounded-sm object-contain" />
            <span className="min-w-0 flex-1 truncate">Matilda</span>
            <span className="text-xs text-muted-foreground">Default</span>
          </DropdownMenuItem>
          {THEME_CHARACTER_LIST.map(item => <DropdownMenuItem key={item.id} data-character-id={item.id} onClick={() => savePreferences({ selectedPalette: item.id })}>
            <Check aria-hidden="true" className={selectedPalette === item.id ? "shrink-0" : "invisible shrink-0"} />
            <img src={item.image} alt="" className="size-6 shrink-0 rounded-sm object-contain" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="text-xs text-muted-foreground">{item.theme}</span>
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      {!toolbarHost && <Button variant="outline" size="sm" aria-label="Models & accounts" title="Models & accounts" className="shrink-0" onClick={() => setAccountsOpen(true)}><ModelsIcon aria-hidden="true" /><span className="love-spot-label">Models &amp; accounts</span></Button>}
      {matilda.replying && <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Matilda status">Matilda is writing…</span>}
      {saveStatus && <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Drawing save status">{saveStatus}</span>}
    </div>;
  return <section className="love-spot accent-scope" aria-label="Love Spot">
    {toolbarHost ? createPortal(tools, toolbarHost) : tools}
    <ConfirmDelete request={pageToDelete ?? null} names={pageToDelete ? [pageToDelete] : []} noun="page"
      description="This page moves to Trash. Deleting the current page opens a blank page so you can keep drawing."
      onDelete={name => changePage("delete", name)} onClose={() => { setPageToDelete(undefined); if (reopenPages.current) { reopenPages.current = false; setPagesOpen(true); } }} />
    <AlertDialog open={clearing} onOpenChange={setClearing}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete all pages?</AlertDialogTitle>
          <AlertDialogDescription>Every page except this one and the ones you keep moves to Trash, where you can restore it.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
          <Button type="button" variant="destructive" disabled={pageBusy} onClick={() => { setClearing(false); void changePage("clear"); }}>Delete all pages</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {screenshots.length > 0 && <section className="love-spot-screenshots" aria-label="New screenshots">
      <div className="love-spot-screenshots-heading"><strong>New screenshots</strong><span>Only shared when you add them. Click or drag onto the drawing.</span>
        {screenshots.length > 1 && <Button variant="outline" size="sm" disabled={choosing} onClick={() => void placeAllScreenshots()}><ImagePlus aria-hidden="true" />Add all</Button>}</div>
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
    <MatildaWho open={whoOpen} onOpenChange={setWhoOpen} persona={matilda.persona} onSave={persona => matilda.keep(persona)} />
    {accountsOpen && <AlertDialog open={accountsOpen} onOpenChange={setAccountsOpen}>
      <AlertDialogContent role="dialog" aria-label="Models & accounts" className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* Settings already frames it as a page; here the dialog does (5 Nov: the class on the component nested two pages in Settings). */}
          <div className="settings-page"><ProvidersSettings refreshKey={accountRefresh} onChanged={reloadAccounts} standalone={standaloneApp} /></div>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Done</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
    {error && <div className="love-spot-status" role="alert">{error}<Button variant="ghost" size="sm" onClick={() => { if (editor) save(); else setAttempt(a => a + 1); }}>Retry</Button></div>}
    <div className="love-spot-content"><div className={`love-spot-editor ${styleClassName}`} ref={boardArea} onDragOverCapture={event => {
      if (event.dataTransfer.types.includes(screenshotDrag)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }
    }} onDropCapture={event => {
      const id = event.dataTransfer.getData(screenshotDrag);
      if (id) { event.preventDefault(); event.stopPropagation(); void chooseScreenshot(id, "place"); }
    }}>
      {styleToggle}
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
          <MainMenu.Item icon={<ModelsIcon size={16} aria-hidden="true" />} onSelect={() => setAccountsOpen(true)}>Models &amp; accounts…</MainMenu.Item>
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw> : !error && <p role="status">Opening Love Spot…</p>}
    </div>
    </div>
  </section>;
}
