"use client";

import { versions, snapshot, lightDrawing, savePicture } from "./love-spot-scene.ts";
import type { Saved, Update } from "./love-spot-types.ts";
import { useCallback, useEffect } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { api } from "@/lib/api";
import { saveWithTextDrafts } from "@/lib/love-spot-drafts";
import { subscribeLoveSpotEvents } from "@/lib/love-spot-events";
import { noticed } from "@/lib/matilda";
import type { LoveSpotSaveState } from "./use-love-spot-save-state";

export function useLoveSpotBoardSync(previous: LoveSpotSaveState) {
  const {
    saveTimer,
    capture,
    journal,
    pendingSaves,
    mounted,
    setSaveStatus,
    saving,
    editorRef,
    currentPage,
    receive,
    setError,
    report,
    deferred,
    saveLatest,
    editor,
    setScreenshots,
    revision,
    viewTimer,
    latest,
    recoveryPending,
    editingId,
    remote,
    schedulePicture,
  } = previous;
  const save = useCallback(
    (picture = false, finishEdit = false) => {
      clearTimeout(saveTimer.current);
      const drawing = capture();
      if (!drawing) return Promise.resolve(false);
      const protectedIds = journal.current!.protectedIds(drawing.elements, drawing.page);
      pendingSaves.current++;
      if (mounted.current) setSaveStatus("Saving…");
      let succeeded = false;
      saving.current = saving.current
        .catch(() => {})
        .then(async () => {
          const data = await saveWithTextDrafts(drawing, protectedIds, async outgoing =>
            api<Saved>("/love-spot", await lightDrawing(outgoing)).catch(async e => {
              if (!(e instanceof Error) || !e.message.includes("page changed")) throw e;
              return api<Saved>("/love-spot/text", {
                page: outgoing.page,
                elements: outgoing.elements.filter(e => e.type === "text"),
              });
            }),
          );
          journal.current!.acknowledge(
            data.scene.elements,
            data.scene.page,
            finishEdit ? undefined : editorRef.current?.getAppState().editingTextElement?.id,
          );
          if (mounted.current && drawing.page?.session === currentPage.current?.session) {
            const unchanged =
              versions(editorRef.current?.getSceneElementsIncludingDeleted() ?? []) === versions(drawing.elements);
            // An archived-page save reply must not replace a deferred remote page
            // switch. The event stream owns remote admission during an edit.
            if (
              !editorRef.current?.getAppState().editingTextElement &&
              !document.querySelector("textarea.excalidraw-wysiwyg")
            )
              receive(data);
            setError("");
            setSaveStatus(unchanged ? "Saved" : "Unsaved");
          }
          succeeded = true;
          if (picture) await savePicture(data);
        })
        .catch(e => {
          if (mounted.current) setSaveStatus("Save failed");
          report(e);
        })
        .then(async () => {
          pendingSaves.current--;
          if (pendingSaves.current || !succeeded || !deferred.current || !mounted.current) return;
          try {
            // Earlier replies can carry a version above the finished local edit.
            // Read once after every queued save, including its retry, has settled.
            const current = await api<Saved>("/love-spot");
            if (mounted.current) {
              deferred.current = undefined;
              receive(current);
            }
          } catch (e) {
            report(e);
          }
        });
      return saving.current.then(() => succeeded);
    },
    [capture, receive, report],
  );
  useEffect(() => {
    saveLatest.current = save;
  }, [save]);
  useEffect(() => {
    if (!editor) return;
    void document.fonts.load("20px Excalifont").catch(report);
    return subscribeLoveSpotEvents(
      event => {
        try {
          const data: Update = JSON.parse(event.data);
          if (data.type === "error") setError(data.message);
          else if (data.type === "screenshots") setScreenshots(data.screenshots);
          else if (data.type === "matilda") return;
          else if (data.revision !== revision.current) receive(data);
        } catch (e) {
          report(e);
        }
      },
      () => setError("Love Spot is reconnecting… Your drawing is still here."),
    );
  }, [editor, receive, report]);
  useEffect(() => {
    const input = (event: Event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches(".excalidraw-wysiwyg")) return;
      capture(); // Synchronous journal before debounce, blur, or unload.
    };
    const flush = () => {
      void saveLatest.current?.();
    };
    const unload = () => {
      const drawing = capture();
      if (drawing?.page) {
        // Text-only keepalive is bounded independently of large board images.
        const elements = drawing.elements.filter(e => e.type === "text");
        void fetch("/api/love-spot/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: drawing.page, elements }),
          keepalive: true,
        }).catch(() => {});
      }
      flush();
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
        flush();
      }
    };
    const storageError = window.elpisDesktop?.storage?.onError(report);
    window.__elpisFlushLoveSpot = () => saveLatest.current?.(false, true) ?? Promise.resolve(true);
    document.addEventListener("input", input);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("input", input);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", unload);
      storageError?.();
      delete window.__elpisFlushLoveSpot;
    };
  }, [capture, report]);
  useEffect(() => {
    mounted.current = true;
    // Acquiring the editor changes `save`; that is not a view unmount.
    return () => {
      mounted.current = false;
      clearTimeout(saveTimer.current);
      clearTimeout(viewTimer.current);
      void saveLatest.current?.(true, true);
    };
  }, []);
  const sendWithBoard = useCallback(
    async (
      send: (revision: string, pageSession: string | undefined) => Promise<boolean>,
      readyToSend: () => boolean,
    ): Promise<"sent" | "wait" | "stale"> => {
      const origin = currentPage.current?.session;
      const isCurrent = () => readyToSend() && currentPage.current?.session === origin;
      clearTimeout(saveTimer.current);
      clearTimeout(viewTimer.current);
      // Keep capture and dispatch in the save queue. A simultaneous save must
      // wait until Matilda accepts the picture before changing its revision.
      const work = saving.current.then(async () => {
        if (!editor || !isCurrent()) return "stale" as const;
        const drawing = await lightDrawing(
          snapshot(
            editor.getSceneElementsIncludingDeleted(),
            editor.getAppState(),
            editor.getFiles(),
            currentPage.current,
          ),
        );
        if (!isCurrent()) return "stale" as const;
        const data = await api<Saved>("/love-spot", drawing);
        if (!isCurrent()) return "stale" as const;
        receive(data);
        try {
          await savePicture(data);
        } catch (cause) {
          if (!isCurrent()) return "stale" as const;
          throw cause;
        }
        if (!isCurrent()) return "stale" as const;
        return (await send(data.revision, origin)) ? ("sent" as const) : ("wait" as const);
      });
      saving.current = work.then(
        () => {},
        () => {},
      );
      return work;
    },
    [editor, receive],
  );
  const changed = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
      notice: (ids: ReturnType<typeof noticed>, ended: boolean) => void,
    ) => {
      const before = latest.current;
      // onChange contains only live elements. Persist the API's tombstones too, or a stale
      // writer would resurrect a shape the user just deleted.
      const all = editorRef.current?.getSceneElementsIncludingDeleted() ?? elements;
      latest.current = snapshot(all, appState, files, currentPage.current);
      if (recoveryPending.current) {
        recoveryPending.current = false;
        queueMicrotask(() => void saveLatest.current?.());
      }
      const editing = appState.editingTextElement && all.find(e => e.id === appState.editingTextElement?.id);
      const editChanged = editingId.current !== editing?.id;
      const endedEdit = editingId.current && !editing;
      editingId.current = editing?.id;
      if (!remote.current && editing && currentPage.current) journal.current!.record(editing, currentPage.current);
      const admitRemote = !editing && !pendingSaves.current && !!deferred.current;
      if (admitRemote) deferred.current = undefined;
      // Loading, selection and pointer movement do not need a save or a new PNG.
      const filesChanged =
        before &&
        (Object.keys(before.files).length !== Object.keys(files).length ||
          Object.entries(files).some(([id, file]) => before.files[id]?.dataURL !== file.dataURL));
      const drawingChanged =
        before &&
        (filesChanged ||
          versions(before.elements) !== versions(all) ||
          JSON.stringify(before.appState) !== JSON.stringify(latest.current.appState));
      if (!remote.current && (drawingChanged || editChanged))
        notice(drawingChanged ? noticed(before.elements, all) : [], !!endedEdit);
      if (!remote.current && drawingChanged) {
        setSaveStatus("Unsaved");
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          void save();
        }, 150);
      }
      if (!remote.current && endedEdit) queueMicrotask(() => void saveLatest.current?.());
      if (admitRemote)
        queueMicrotask(() => {
          // Capture and save the finished edit before admitting remote changes. The
          // deferred snapshot may predate that save, so read the current scene instead.
          void saving.current
            .then(async () => {
              if (!mounted.current) return;
              const current = await api<Saved>("/love-spot");
              if (mounted.current) receive(current);
            })
            .catch(report);
        });
      if (drawingChanged) schedulePicture();
    },
    [editor, receive, report, save, schedulePicture],
  );
  const cancelScheduledSaves = () => {
    clearTimeout(saveTimer.current);
    clearTimeout(viewTimer.current);
  };
  return { ...previous, save, sendWithBoard, changed, cancelScheduledSaves };
}

export type LoveSpotBoardSync = ReturnType<typeof useLoveSpotBoardSync>;
