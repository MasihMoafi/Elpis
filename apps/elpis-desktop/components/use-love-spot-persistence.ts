"use client";
import { versions, snapshot, scrollOffsets, boardFiles, lightDrawing, savePicture } from './love-spot-scene.ts';
import type { BoardPage, Drawing, Saved, Screenshot, Update } from './love-spot-types.ts';
import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { api } from "@/lib/api";
import { applyRemoteScene, mergeRemoteElements, restoreRemoteElements } from "@/lib/love-spot-history";
import { createTextJournal, saveWithTextDrafts } from "@/lib/love-spot-drafts";
import { subscribeLoveSpotEvents } from "@/lib/love-spot-events";
import { MASIH_PEN, latestMessage } from "@/lib/love-spot";
import { noticed } from "@/lib/matilda";
import { newer } from "@/bridge/love-spot-order.cts";
import { upgradeAgentArt } from "@/lib/love-agents";
import { errorText } from "@/lib/error-text.mts";
import type { RefObject, Dispatch, SetStateAction } from 'react';
export function useLoveSpotPersistence({ editor, editorRef, boardArea, dark, attempt, onPage, setScreenshots, setRenaming }: {
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
    const report = useCallback((e: unknown) => { if (mounted.current)
        setError(errorText(e, "Love Spot could not save the drawing.")); }, []);
    if (!journal.current && typeof window !== "undefined")
        journal.current = createTextJournal(report);
    useEffect(() => {
        let active = true;
        api<Saved>("/love-spot").then(async (data) => {
            if (!active)
                return;
            const art = upgradeAgentArt(data.scene.elements, data.scene.files);
            if (art)
                data = await api<Saved>("/love-spot", await lightDrawing({ ...data.scene, ...art }));
            if (!active)
                return;
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
            setInitial({ elements, files: boardFiles(data.scene.files, dark), scrollToContent: false,
                appState: { ...data.scene.appState, currentItemStrokeColor: MASIH_PEN, collaborators: new Map() } });
            recoveryPending.current = versions(recovered) !== versions(data.scene.elements);
            setError("");
        }).catch(report);
        return () => { active = false; };
    }, [attempt, dark, onPage, report]);
    const schedulePicture = useCallback(() => {
        clearTimeout(viewTimer.current);
        viewTimer.current = setTimeout(() => {
            void (async () => {
                try {
                    await saving.current;
                    if (!editor || !mounted.current)
                        return;
                    await savePicture({ scene: { ...snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current), page: currentPage.current! }, revision: revision.current });
                }
                catch (e) {
                    if (!(e instanceof Error && e.message.includes("drawing changed")))
                        report(e);
                }
            })();
        }, 900);
    }, [editor, report]);
    const receive = useCallback((data: Saved) => {
        // Updating any scene can detach Excalidraw's live textarea. Admit the
        // newest complete remote scene only after the local edit is committed.
        if (pendingSaves.current || editor?.getAppState().editingTextElement || document.querySelector("textarea.excalidraw-wysiwyg")) {
            deferred.current = data;
            return;
        }
        const recovered = journal.current!.recover(data.scene.elements, data.scene.page);
        const hasRecovery = versions(recovered) !== versions(data.scene.elements);
        if (hasRecovery)
            data = { ...data, scene: { ...data.scene, elements: recovered } };
        const art = upgradeAgentArt(data.scene.elements, data.scene.files);
        if (art)
            data = { ...data, scene: { ...data.scene, ...art } };
        revision.current = data.revision;
        const switching = currentPage.current?.session !== data.scene.page.session;
        const renamed = currentPage.current?.name !== data.scene.page.name;
        currentPage.current = data.scene.page;
        if (switching || renamed) {
            onPage(data.scene.page);
        }
        if (!editor)
            return;
        if (switching) {
            clearTimeout(saveTimer.current);
            clearTimeout(viewTimer.current);
            remote.current = true;
            try {
                editor.resetScene();
                editor.addFiles(Object.values(boardFiles(data.scene.files, dark)));
                applyRemoteScene(editor, restoreRemoteElements(data.scene.elements), { ...editor.getAppState(), ...data.scene.appState, selectedElementIds: {}, collaborators: new Map() });
            }
            finally {
                remote.current = false;
            }
            latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
            setRenaming(false);
            editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, ...scrollOffsets(boardArea.current) });
            if (hasRecovery || art || Object.keys(data.scene.files).length)
                queueMicrotask(() => void saveLatest.current?.());
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
                if (files.length)
                    editor.addFiles(files);
                if (changed) {
                    // Admit remote changes before recording only the user's placement.
                    applyRemoteScene(editor, [...shown.values()].filter(e => e.id !== placed?.id));
                    if (placed)
                        editor.updateScene({ elements: [...shown.values()], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
                }
            }
            finally {
                remote.current = false;
            }
            // A remote merge is included if a local debounce is waiting to save.
            latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current);
            if (screenshot) {
                editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } });
                editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9, ...scrollOffsets(boardArea.current) });
            }
            // Her reply never moves his view (5 Nov: it zoomed the board out; the switch that offered it is gone).
            // Inbox images and older pages also pass through the same pixel limit once they arrive.
            if (hasRecovery || art || files.length)
                queueMicrotask(() => void saveLatest.current?.());
            // Excalidraw may notify after the merged snapshot is already current.
            schedulePicture();
        }
    }, [dark, editor, onPage, schedulePicture]);
    const capture = useCallback(() => {
        const value = editorRef.current, page = currentPage.current;
        if (!value || !page)
            return latest.current;
        const draft = journal.current!.capture(value, page);
        const elements = value.getSceneElementsIncludingDeleted();
        return snapshot(draft ? elements.map(e => e.id === draft.id ? draft : e) : elements, value.getAppState(), value.getFiles(), page);
    }, []);
    const save = useCallback((picture = false, finishEdit = false) => {
        clearTimeout(saveTimer.current);
        const drawing = capture();
        if (!drawing)
            return Promise.resolve(false);
        const protectedIds = journal.current!.protectedIds(drawing.elements, drawing.page);
        pendingSaves.current++;
        if (mounted.current)
            setSaveStatus("Saving…");
        let succeeded = false;
        saving.current = saving.current.catch(() => { }).then(async () => {
            const data = await saveWithTextDrafts(drawing, protectedIds, async (outgoing) => api<Saved>("/love-spot", await lightDrawing(outgoing)).catch(async (e) => {
                if (!(e instanceof Error) || !e.message.includes("page changed"))
                    throw e;
                return api<Saved>("/love-spot/text", { page: outgoing.page, elements: outgoing.elements.filter(e => e.type === "text") });
            }));
            journal.current!.acknowledge(data.scene.elements, data.scene.page, finishEdit ? undefined : editorRef.current?.getAppState().editingTextElement?.id);
            if (mounted.current && drawing.page?.session === currentPage.current?.session) {
                const unchanged = versions(editorRef.current?.getSceneElementsIncludingDeleted() ?? []) === versions(drawing.elements);
                // An archived-page save reply must not replace a deferred remote page
                // switch. The event stream owns remote admission during an edit.
                if (!editorRef.current?.getAppState().editingTextElement && !document.querySelector("textarea.excalidraw-wysiwyg"))
                    receive(data);
                setError("");
                setSaveStatus(unchanged ? "Saved" : "Unsaved");
            }
            succeeded = true;
            if (picture)
                await savePicture(data);
        }).catch(e => { if (mounted.current)
            setSaveStatus("Save failed"); report(e); }).then(async () => {
            pendingSaves.current--;
            if (pendingSaves.current || !succeeded || !deferred.current || !mounted.current)
                return;
            try {
                // Earlier replies can carry a version above the finished local edit.
                // Read once after every queued save, including its retry, has settled.
                const current = await api<Saved>("/love-spot");
                if (mounted.current) {
                    deferred.current = undefined;
                    receive(current);
                }
            }
            catch (e) {
                report(e);
            }
        });
        return saving.current.then(() => succeeded);
    }, [capture, receive, report]);
    useEffect(() => { saveLatest.current = save; }, [save]);
    useEffect(() => {
        if (!editor)
            return;
        void document.fonts.load("20px Excalifont").catch(report);
        return subscribeLoveSpotEvents(event => {
            try {
                const data: Update = JSON.parse(event.data);
                if (data.type === "error")
                    setError(data.message);
                else if (data.type === "screenshots")
                    setScreenshots(data.screenshots);
                else if (data.type === "matilda")
                    return;
                else if (data.revision !== revision.current)
                    receive(data);
            }
            catch (e) {
                report(e);
            }
        }, () => setError("Love Spot is reconnecting… Your drawing is still here."));
    }, [editor, receive, report]);
    useEffect(() => {
        const input = (event: Event) => {
            if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches(".excalidraw-wysiwyg"))
                return;
            capture(); // Synchronous journal before debounce, blur, or unload.
        };
        const flush = () => { void saveLatest.current?.(); };
        const unload = () => {
            const drawing = capture();
            if (drawing?.page) {
                // Text-only keepalive is bounded independently of large board images.
                const elements = drawing.elements.filter(e => e.type === "text");
                void fetch("/api/love-spot/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: drawing.page, elements }), keepalive: true }).catch(() => { });
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
        return () => { mounted.current = false; clearTimeout(saveTimer.current); clearTimeout(viewTimer.current); void saveLatest.current?.(true, true); };
    }, []);
    const sendWithBoard = useCallback(async (send: (revision: string, pageSession: string | undefined) => Promise<boolean>, readyToSend: () => boolean): Promise<"sent" | "wait" | "stale"> => {
        const origin = currentPage.current?.session;
        const isCurrent = () => readyToSend() && currentPage.current?.session === origin;
        clearTimeout(saveTimer.current);
        clearTimeout(viewTimer.current);
        // Keep capture and dispatch in the save queue. A simultaneous save must
        // wait until Matilda accepts the picture before changing its revision.
        const work = saving.current.then(async () => {
            if (!editor || !isCurrent())
                return "stale" as const;
            const drawing = await lightDrawing(snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles(), currentPage.current));
            if (!isCurrent())
                return "stale" as const;
            const data = await api<Saved>("/love-spot", drawing);
            if (!isCurrent())
                return "stale" as const;
            receive(data);
            try {
                await savePicture(data);
            }
            catch (cause) {
                if (!isCurrent())
                    return "stale" as const;
                throw cause;
            }
            if (!isCurrent())
                return "stale" as const;
            return await send(data.revision, origin) ? "sent" as const : "wait" as const;
        });
        saving.current = work.then(() => { }, () => { });
        return work;
    }, [editor, receive]);
    const changed = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles, notice: (ids: ReturnType<typeof noticed>, ended: boolean) => void) => {
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
        if (!remote.current && editing && currentPage.current)
            journal.current!.record(editing, currentPage.current);
        const admitRemote = !editing && !pendingSaves.current && !!deferred.current;
        if (admitRemote)
            deferred.current = undefined;
        // Loading, selection and pointer movement do not need a save or a new PNG.
        const filesChanged = before && (Object.keys(before.files).length !== Object.keys(files).length || Object.entries(files).some(([id, file]) => before.files[id]?.dataURL !== file.dataURL));
        const drawingChanged = before && (filesChanged || versions(before.elements) !== versions(all) || JSON.stringify(before.appState) !== JSON.stringify(latest.current.appState));
        if (!remote.current && (drawingChanged || editChanged))
            notice(drawingChanged ? noticed(before.elements, all) : [], !!endedEdit);
        if (!remote.current && drawingChanged) {
            setSaveStatus("Unsaved");
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => { void save(); }, 150);
        }
        if (!remote.current && endedEdit)
            queueMicrotask(() => void saveLatest.current?.());
        if (admitRemote)
            queueMicrotask(() => {
                // Capture and save the finished edit before admitting remote changes. The
                // deferred snapshot may predate that save, so read the current scene instead.
                void saving.current.then(async () => {
                    if (!mounted.current)
                        return;
                    const current = await api<Saved>("/love-spot");
                    if (mounted.current)
                        receive(current);
                }).catch(report);
            });
        if (drawingChanged)
            schedulePicture();
    }, [editor, receive, report, save, schedulePicture]);
    const cancelScheduledSaves = () => { clearTimeout(saveTimer.current); clearTimeout(viewTimer.current); };
    return { initial, error, setError, saveStatus, report, mounted, currentPage, save, receive, sendWithBoard, opening, placingScreenshot, persistChange: changed, cancelScheduledSaves };
}
