"use client";

import { versions, snapshot, scrollOffsets, boardFiles, lightDrawing, savePicture } from "./love-spot-scene.ts";
import type { BoardPage, Drawing, Saved, Screenshot } from "./love-spot-types.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { api } from "@/lib/api";
import { applyRemoteScene, mergeRemoteElements, restoreRemoteElements } from "@/lib/love-spot-history";
import { createTextJournal } from "@/lib/love-spot-drafts";
import { MASIH_PEN, latestMessage } from "@/lib/love-spot";
import { newer } from "@/bridge/love-spot-order.cts";
import { upgradeAgentArt } from "@/lib/love-agents";
import { errorText } from "@/lib/error-text.mts";
import type { RefObject, Dispatch, SetStateAction } from "react";

export function useLoveSpotSaveState({
  editor,
  editorRef,
  boardArea,
  dark,
  attempt,
  onPage,
  setScreenshots,
  setRenaming,
}: {
  editor: ExcalidrawImperativeAPI | undefined;
  editorRef: RefObject<ExcalidrawImperativeAPI | undefined>;
  boardArea: RefObject<HTMLDivElement | null>;
  dark: boolean;
  attempt: number;
  onPage(page: BoardPage): void;
  setScreenshots: Dispatch<SetStateAction<Screenshot[]>>;
  setRenaming: Dispatch<SetStateAction<boolean>>;
}) {
  const placingScreenshot = useRef<string>(undefined);
  const [initial, setInitial] = useState<ExcalidrawInitialDataState>();
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const currentPage = useRef<BoardPage>(undefined);
  const latest = useRef<Drawing | undefined>(undefined);
  const revision = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const viewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const saveLatest = useRef<((picture?: boolean, finishEdit?: boolean) => Promise<boolean>) | undefined>(undefined);
  const journal = useRef<ReturnType<typeof createTextJournal>>(undefined);
  const deferred = useRef<Saved>(undefined);
  const editingId = useRef<string>(undefined);
  const recoveryPending = useRef(false);
  const mounted = useRef(true);
  const remote = useRef(false);
  const opening = useRef<string[]>([]);
  const report = useCallback((e: unknown) => {
    if (mounted.current) setError(errorText(e, "Love Spot could not save the drawing."));
  }, []);
  if (!journal.current && typeof window !== "undefined") journal.current = createTextJournal(report);
  useEffect(() => {
    let active = true;
    api<Saved>("/love-spot")
      .then(async data => {
        if (!active) return;
        const art = upgradeAgentArt(data.scene.elements, data.scene.files);
        if (art) data = await api<Saved>("/love-spot", await lightDrawing({ ...data.scene, ...art }));
        if (!active) return;
        revision.current = data.revision;
        currentPage.current = data.scene.page;
        onPage(data.scene.page);
        journal.current!.acknowledge(data.scene.elements, data.scene.page);
        const recovered = journal.current!.recover(data.scene.elements, data.scene.page);
        const elements = restoreRemoteElements(recovered);
        // Opening Love Spot shows the newest note, as a chat opens at its last message; a board without notes (a screenshot's page) fits everything.
        // Read before restoring: index repair stamps every unindexed element (her replies) with the time of opening.
        const note = latestMessage(recovered);
        opening.current = (note.length ? note : recovered.filter(e => !e.isDeleted)).map(e => e.id);
        setInitial({
          elements,
          files: boardFiles(data.scene.files, dark),
          scrollToContent: false,
          appState: { ...data.scene.appState, currentItemStrokeColor: MASIH_PEN, collaborators: new Map() },
        });
        recoveryPending.current = versions(recovered) !== versions(data.scene.elements);
        setError("");
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [attempt, dark, onPage, report]);
  const schedulePicture = useCallback(() => {
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await saving.current;
          if (!editor || !mounted.current) return;
          await savePicture({
            scene: {
              ...snapshot(
                editor.getSceneElementsIncludingDeleted(),
                editor.getAppState(),
                editor.getFiles(),
                currentPage.current,
              ),
              page: currentPage.current!,
            },
            revision: revision.current,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("drawing changed"))) report(e);
        }
      })();
    }, 900);
  }, [editor, report]);
  const receive = useCallback(
    (data: Saved) => {
      // Updating any scene can detach Excalidraw's live textarea. Admit the
      // newest complete remote scene only after the local edit is committed.
      if (
        pendingSaves.current ||
        editor?.getAppState().editingTextElement ||
        document.querySelector("textarea.excalidraw-wysiwyg")
      ) {
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
      if (switching || renamed) {
        onPage(data.scene.page);
      }
      if (!editor) return;
      if (switching) {
        clearTimeout(saveTimer.current);
        clearTimeout(viewTimer.current);
        remote.current = true;
        try {
          editor.resetScene();
          editor.addFiles(Object.values(boardFiles(data.scene.files, dark)));
          applyRemoteScene(editor, restoreRemoteElements(data.scene.elements), {
            ...editor.getAppState(),
            ...data.scene.appState,
            selectedElementIds: {},
            collaborators: new Map(),
          });
        } finally {
          remote.current = false;
        }
        latest.current = snapshot(
          editor.getSceneElementsIncludingDeleted(),
          editor.getAppState(),
          editor.getFiles(),
          currentPage.current,
        );
        setRenaming(false);
        editor.scrollToContent(editor.getSceneElements(), {
          fitToViewport: true,
          viewportZoomFactor: 0.9,
          maxZoom: 1,
          ...scrollOffsets(boardArea.current),
        });
        if (hasRecovery || art || Object.keys(data.scene.files).length)
          queueMicrotask(() => void saveLatest.current?.());
        return;
      }
      const shown = new Map(editor.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
      const placed = data.scene.elements.find(
        e => e.id === placingScreenshot.current && !e.isDeleted && !shown.has(e.id),
      );
      const screenshot =
        placed ??
        data.scene.elements.find(
          e => e.type === "image" && !e.isDeleted && e.id.startsWith("shot-") && !shown.has(e.id),
        );
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
            applyRemoteScene(
              editor,
              [...shown.values()].filter(e => e.id !== placed?.id),
            );
            if (placed)
              editor.updateScene({ elements: [...shown.values()], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          }
        } finally {
          remote.current = false;
        }
        // A remote merge is included if a local debounce is waiting to save.
        latest.current = snapshot(
          editor.getSceneElementsIncludingDeleted(),
          editor.getAppState(),
          editor.getFiles(),
          currentPage.current,
        );
        if (screenshot) {
          editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } });
          editor.scrollToContent(screenshot, {
            fitToViewport: true,
            viewportZoomFactor: 0.9,
            ...scrollOffsets(boardArea.current),
          });
        }
        // Her reply never moves his view (5 Nov: it zoomed the board out; the switch that offered it is gone).
        // Inbox images and older pages also pass through the same pixel limit once they arrive.
        if (hasRecovery || art || files.length) queueMicrotask(() => void saveLatest.current?.());
        // Excalidraw may notify after the merged snapshot is already current.
        schedulePicture();
      }
    },
    [dark, editor, onPage, schedulePicture],
  );
  const capture = useCallback(() => {
    const value = editorRef.current,
      page = currentPage.current;
    if (!value || !page) return latest.current;
    const draft = journal.current!.capture(value, page);
    const elements = value.getSceneElementsIncludingDeleted();
    return snapshot(
      draft ? elements.map(e => (e.id === draft.id ? draft : e)) : elements,
      value.getAppState(),
      value.getFiles(),
      page,
    );
  }, []);
  return {
    placingScreenshot,
    initial,
    error,
    setError,
    saveStatus,
    setSaveStatus,
    currentPage,
    latest,
    revision,
    saveTimer,
    viewTimer,
    saving,
    pendingSaves,
    saveLatest,
    journal,
    deferred,
    editingId,
    recoveryPending,
    mounted,
    remote,
    opening,
    report,
    schedulePicture,
    receive,
    capture,
    editor,
    editorRef,
    setScreenshots,
  };
}

export type LoveSpotSaveState = ReturnType<typeof useLoveSpotSaveState>;
