"use client";

import { scrollOffsets } from "./love-spot-scene.ts";
import type { Saved } from "./love-spot-types.ts";
import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { appStorage } from "@/lib/projects";
import { useMatilda } from "@/components/love-spot-matilda";
import { api, chatProvider, providerChoices } from "@/lib/api";
import { MATILDA_CHANGED } from "@/lib/matilda";
import { useMatildaSettings, type MatildaSettings } from "@/lib/matilda-settings";
import { lightImage } from "@/lib/love-spot";
import { told } from "@/lib/matilda";
import type { LoveBoardPages } from "./love-board-pages";
import { standaloneApp, SUBSCRIPTION_CHOICE, REPLIES_KEY } from "./love-board-shared";
import type { MatildaVoice } from "./love-board-shared";

export function useLoveBoardMatilda(previous: LoveBoardPages) {
  const {
    settings,
    models,
    pick,
    editor,
    opening,
    boardArea,
    report,
    page,
    placingAll,
    editorRef,
    calling,
    pageBusy,
    speech,
    setError,
    sendWithBoard,
    voiceVersion,
    mounted,
    voiceEnabled,
    noticeStyle,
    persistChange,
    choosing,
    setChoosing,
    placingScreenshot,
    screenshots,
    receive,
    setScreenshots,
    setPageBusy,
    cancelScheduledSaves,
    save,
    currentPage,
    setRenaming,
    loadPages,
    lastPoint,
    pages,
    queuedPage,
  } = previous;
  const provider = chatProvider(settings?.main.model, undefined, settings?.main.provider);
  // Any connected model: a model from another connection starts her a new chat (bridge/love-spot-talk.mts).
  // The standalone app may not route Claude or Gemini subscriptions (bridge/love-spot-talk.mts), so it does not offer them.
  const choices = providerChoices(models, settings).filter(
    choice => !standaloneApp || !SUBSCRIPTION_CHOICE.test(choice.id),
  );
  const pickedProvider = choices.find(choice => choice.id === pick.choiceId)?.provider;
  useEffect(() => {
    if (!editor || !opening.current.length) return;
    const ids = new Set(opening.current);
    opening.current = [];
    // Excalidraw hands over its API before it has loaded the initial scene; wait (at most about a second) for the note to arrive.
    let frame = 0,
      tries = 60;
    const show = () => {
      const target = editor.getSceneElements().filter(e => ids.has(e.id));
      if (target.length)
        editor.scrollToContent(target, {
          fitToViewport: true,
          viewportZoomFactor: 0.8,
          maxZoom: 1,
          ...scrollOffsets(boardArea.current),
        });
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
  const shared = useMatildaSettings(),
    replies = shared.settings?.replies !== false;
  const repliesRef = useRef(replies);
  repliesRef.current = replies;
  // Until 31 Oct the board kept its own switch and model; carry them into the one shared setting once.
  const migrated = useRef(false);
  useEffect(() => {
    if (!shared.settings || migrated.current) return;
    migrated.current = true;
    const change: Partial<MatildaSettings> = {};
    if (appStorage().getItem(REPLIES_KEY) === "off" && shared.settings.replies) change.replies = false;
    if (!shared.settings.model && pick.model)
      Object.assign(change, { model: pick.model, provider: pickedProvider ?? null });
    try {
      appStorage().removeItem(REPLIES_KEY);
    } catch {
      /* nothing to carry next time either way */
    }
    if (Object.keys(change).length) void shared.update(change).catch(report);
  }, [shared, pick.model, pickedProvider, report]);
  const chooseReplies = (on: boolean) => {
    repliesRef.current = on;
    if (!on) void matilda.quiet();
    void shared.update({ replies: on }).catch(report);
  };
  const matilda = useMatilda({
    ...(page?.session === undefined ? {} : { context: page.session }),
    enabled: () => repliesRef.current,
    ready: () =>
      repliesRef.current &&
      !placingAll.current &&
      !!editorRef.current &&
      !!settings &&
      !calling &&
      !pageBusy &&
      !speech?.active &&
      !editorRef.current.getAppState().editingTextElement &&
      !document.querySelector("textarea.excalidraw-wysiwyg"),
    onError: setError,
    told: ids => told(editorRef.current?.getSceneElements() ?? [], ids),
    drawingOnly: ids => {
      const elements = (editorRef.current?.getSceneElements() ?? []).filter(
        element => ids.has(element.id) && !element.isDeleted,
      );
      return (
        elements.some(element => element.type !== "text") &&
        elements.every(element => element.type !== "text" || !(element.originalText || element.text).trim())
      );
    },
    send: (text, persona, isCurrent, drawingOnly) =>
      sendWithBoard(async (revision, pageSession) => {
        const version = voiceVersion.current;
        // 5 Nov: a board change must not cut her voice. `ready` holds the next turn until she has finished speaking.
        // Her model is the one shared setting (lib/matilda-settings.ts); the bridge applies it to every message.
        const reply = await api<{ voice: MatildaVoice; waitingForPicture?: boolean }>("/love-spot/talk", {
          text,
          persona,
          revision,
          drawingOnly,
          ...(pageSession ? { pageSession } : {}),
        });
        window.dispatchEvent(new Event(MATILDA_CHANGED));
        if (mounted.current && version === voiceVersion.current) {
          voiceEnabled.current = reply.voice.enabled;
        }
        if (mounted.current && !reply.waitingForPicture && voiceEnabled.current && reply.voice.enabled)
          speech?.stream("matilda");
        return !reply.waitingForPicture;
      }, isCurrent),
  });
  const wakeMatilda = matilda.wake;
  useEffect(() => {
    wakeMatilda();
  }, [wakeMatilda, shared.settings?.model, shared.settings?.provider]);
  const changed = useCallback(
    (elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) => {
      noticeStyle(state);
      persistChange(elements, state, files, matilda.notice);
    },
    [noticeStyle, persistChange, matilda],
  );
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
      } else await api("/love-spot/screenshots", { id, action });
      setScreenshots(shots => shots.filter(shot => shot.id !== id));
      setError("");
    } catch (e) {
      report(e);
    } finally {
      placingScreenshot.current = undefined;
      setChoosing(false);
    }
  }
  /** Every new screenshot at once, in the order they were taken, one below the other; Matilda looks only once all are on the
   * board (Masih, 31 Oct: "when I take multiple screenshots there is no option to paste them all one after the other"). */
  async function placeAllScreenshots() {
    if (choosing || placingAll.current) return;
    placingAll.current = true;
    try {
      for (const shot of [...screenshots].reverse()) await chooseScreenshot(shot.id, "place");
    } finally {
      placingAll.current = false;
    }
  }
  async function changePage(
    action: "new" | "switch" | "rename" | "delete" | "keep" | "release" | "clear",
    name?: string,
  ) {
    if (pageBusy || !editor) {
      if (action === "delete") throw new Error("The page is not ready to delete.");
      return;
    }
    setPageBusy(true);
    try {
      cancelScheduledSaves();
      if (!(await save())) {
        if (action === "delete") throw new Error("Could not save the current page before deleting.");
        return;
      }
      receive(
        await api<Saved>("/love-spot/pages", {
          action,
          ...(name === undefined ? {} : { name }),
          page: currentPage.current,
        }),
      );
      setRenaming(false);
      setError("");
      loadPages();
    } catch (e) {
      if (action === "delete") throw e;
      report(e);
    } finally {
      setPageBusy(false);
    }
  }
  function insertion() {
    if (!editor) return { text: "", start: 0, end: 0 };
    const state = editor.getAppState();
    const point =
      lastPoint.current ??
      viewportCoordsToSceneCoords(
        { clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 },
        state,
      );
    return { text: JSON.stringify({ ...point, color: state.currentItemStrokeColor }), start: 0, end: 0 };
  }
  function addVoiceNote(selection: { text: string }, text: string) {
    if (!editor || !text.trim()) return;
    const point: { x: number; y: number; color: string } = JSON.parse(selection.text);
    const note = convertToExcalidrawElements([
      { type: "text", x: point.x, y: point.y, text: text.trim(), strokeColor: point.color, fontSize: 20 },
    ]);
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
    event.preventDefault();
    event.preventBaseUIHandler?.();
    const row = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-page-name]")].find(
      element => element.dataset.pageName === next.name,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
    // A key pressed while a page is still opening is not lost: the page it reached opens next.
    if (pageBusy) queuedPage.current = next.name;
    else void changePage("switch", next.name);
  }
  useEffect(() => {
    const name = queuedPage.current;
    if (pageBusy || !name) return;
    queuedPage.current = undefined;
    if (name !== page?.name) void changePage("switch", name);
  });
  return {
    ...previous,
    provider,
    choices,
    shared,
    chooseReplies,
    matilda,
    changed,
    chooseScreenshot,
    placeAllScreenshots,
    changePage,
    insertion,
    addVoiceNote,
    stepPage,
  };
}

export type LoveBoardMatilda = ReturnType<typeof useLoveBoardMatilda>;
