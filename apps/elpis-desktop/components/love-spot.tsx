"use client";
import { LoveSpotControls } from "./love-spot-controls";
import { useLoveSpotPersistence } from "./use-love-spot-persistence";
import { scrollOffsets } from './love-spot-scene.ts';
import type { BoardPage, Saved, PageList, Screenshot } from './love-spot-types.ts';

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Heart, ImagePlus, X } from "lucide-react";
import { ModelsIcon } from "@/components/elpis-icons";
import { ProvidersSettings } from "@/components/providers-settings";
import { Excalidraw, MainMenu, convertToExcalidrawElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, PointerDownState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { appStorage } from "@/lib/projects";
import { ReadAloud, useReadAloud } from "@/components/read-aloud";
import { useDrawingStyle } from "@/components/drawing-style";

import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ConfirmDelete } from "@/components/confirm-delete";

import { MatildaWho, useMatilda } from "@/components/love-spot-matilda";

import { api, chatProvider, providerChoices, unreadable, type ProviderSettings } from "@/lib/api";
import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";
import { keepModel, savedModel, MATILDA_CHANGED } from "@/lib/matilda";
import { useMatildaSettings, type MatildaSettings } from "@/lib/matilda-settings";

import { lightImage } from "@/lib/love-spot";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { told } from "@/lib/matilda";

import { usePreferences } from "@/lib/preferences";
import { useThemeCharacter } from "@/lib/theme-characters";

import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";
import { errorText } from "@/lib/error-text.mts";
const REPLIES_KEY = "elpis-matilda-replies";
const screenshotDrag = "application/x-elpis-screenshot";

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
  const placingAll = useRef(false);
  const onPage = useCallback((value: BoardPage) => { setPage(value); loadPages(); }, []);
  const { initial, error, setError, saveStatus, report, mounted, currentPage, save, receive, sendWithBoard, opening, placingScreenshot, persistChange, cancelScheduledSaves } = useLoveSpotPersistence({ editor, editorRef, boardArea, dark, attempt, onPage, setScreenshots, setRenaming });
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

  const changed = useCallback((elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) => {
    noticeStyle(state); persistChange(elements, state, files, matilda.notice);
  }, [noticeStyle, persistChange, matilda]);

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
      cancelScheduledSaves();
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
    void save(true);
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
  const tools = <LoveSpotControls pageControls={{ page, pages, pagesOpen, setPagesOpen, loadPages, pageBusy, editorReady: !!editor, pagesMenu, restoringPages, pagesScroll, stepPage, setPageName, setRenaming, currentKept, changePage, setClearing, reopenPages, setPageToDelete, pagesError, renaming, pageName }}
    model={{ choices, models, model: shared.settings?.model || pick.model || settings?.main.model || '', choiceId: pick.choiceId, disabled: !choices.length, allowCustom: false,
      onConfigure: () => setAccountsOpen(true), onKeySaved: () => void reloadAccounts(), onChange: value => { setPick(value); keepModel(value); void shared.update({ model: value.model, provider: choices.find(choice => choice.id === value.choiceId)?.provider ?? null }).catch(report); } }}
    dictation={{ provider, disabled: !editor || !settings, onBusy: () => {}, selection: insertion, onTranscript: addVoiceNote, purpose: 'Adds a note to the board.' }}
    replies={{ settings: shared.settings, onChange: chooseReplies }} appearance={{ dark, character, selectedPalette }}
    accountsButton={!toolbarHost} onAccounts={() => setAccountsOpen(true)} replying={matilda.replying} saveStatus={saveStatus} />;
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
