"use client";

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToBlob, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";

type Drawing = { elements: readonly ExcalidrawElement[]; files: BinaryFiles; appState: Partial<AppState> };
type Saved = { scene: Drawing; revision: string };
type Update = ({ type: "scene" } & Saved) | { type: "error"; message: string };
const newer = (a: ExcalidrawElement, b: ExcalidrawElement) => a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
const versions = (elements: readonly ExcalidrawElement[]) => JSON.stringify(elements.map(e => [e.id, e.version, e.versionNonce, e.isDeleted]));
function snapshot(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles): Drawing {
  // Excalidraw's file serializer drops deleted elements even when they are supplied.
  // Keep its app-state filtering, and explicitly preserve the merge tombstones.
  return { ...JSON.parse(serializeAsJSON(elements, appState, files, "local")), elements: JSON.parse(JSON.stringify(elements)), files: { ...files } };
}
async function savePicture(data: Saved) {
  const blob = await exportToBlob({ elements: restoreElements(data.scene.elements, null).filter(e => !e.isDeleted),
    appState: { ...data.scene.appState, exportBackground: true }, files: data.scene.files, mimeType: "image/png", exportPadding: 24, maxWidthOrHeight: 2400 });
  const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  await api("/love-spot/picture", { revision: data.revision, png: dataURL.split(",")[1] });
}

export default function LoveSpot({ dark }: { dark: boolean }) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const latest = useRef<Drawing | undefined>(undefined);
  const revision = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const viewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const remote = useRef(false);
  const report = useCallback((e: unknown) => { if (mounted.current) setError(e instanceof Error ? e.message : "Love Spot could not save the drawing."); }, []);

  useEffect(() => {
    let active = true;
    api<Saved>("/love-spot").then(data => {
      if (!active) return;
      revision.current = data.revision;
      setInitial({ elements: data.scene.elements, files: data.scene.files, scrollToContent: true,
        appState: { ...data.scene.appState, collaborators: new Map() } });
      setError("");
    }).catch(report);
    return () => { active = false; };
  }, [attempt, report]);

  const receive = useCallback((data: Saved) => {
    revision.current = data.revision;
    if (!editor) return;
    const shown = new Map(editor.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
    const screenshot = data.scene.elements.find(e => e.type === "image" && !e.isDeleted && e.id.startsWith("shot-") && !shown.has(e.id));
    let changed = false;
    for (const e of restoreElements(data.scene.elements, null, { refreshDimensions: true, repairBindings: true })) {
      const mine = shown.get(e.id);
      if (!mine || newer(e, mine)) { shown.set(e.id, e); changed = true; }
    }
    const files = Object.values(data.scene.files).filter(f => !editor.getFiles()[f.id]);
    if (files.length || changed) {
      remote.current = true;
      try {
        if (files.length) editor.addFiles(files);
        if (changed) editor.updateScene({ elements: [...shown.values()] });
      } finally { remote.current = false; }
      // A remote merge is included if a local debounce is waiting to save.
      latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles());
      if (screenshot) {
        editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } });
        editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9 });
      }
    }
  }, [editor]);

  const save = useCallback((picture = false) => {
    const drawing = latest.current;
    if (!drawing) return;
    saving.current = saving.current.catch(() => {}).then(async () => {
      const data = await api<Saved>("/love-spot", drawing);
      if (mounted.current) { receive(data); setError(""); }
      if (picture) await savePicture(data);
    }).catch(report);
  }, [receive, report]);

  useEffect(() => {
    if (!editor) return;
    void document.fonts.load("20px Excalifont").catch(report);
    const events = new EventSource("/api/love-spot/events");
    events.onmessage = event => {
      try {
        const data: Update = JSON.parse(event.data);
        if (data.type === "error") setError(data.message);
        else { receive(data); setError(""); }
      } catch (e) { report(e); }
    };
    events.onerror = () => setError("Love Spot is reconnecting… Your drawing is still here.");
    return () => events.close();
  }, [editor, receive, report]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(saveTimer.current); clearTimeout(viewTimer.current); save(true); };
  }, [save]);

  const changed = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const before = latest.current;
    // onChange contains only live elements. Persist the API's tombstones too, or a stale
    // writer would resurrect a shape the user just deleted.
    const all = editor?.getSceneElementsIncludingDeleted() ?? elements;
    latest.current = snapshot(all, appState, files);
    if (!remote.current && (!before || versions(before.elements) !== versions(all) || JSON.stringify(before.appState) !== JSON.stringify(latest.current.appState))) {
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(), 150);
    }
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(async () => {
      try {
        await saving.current;
        if (!editor || !mounted.current) return;
        await savePicture({ scene: snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles()), revision: revision.current });
      } catch (e) { if (!(e instanceof Error && e.message.includes("drawing changed"))) report(e); }
    }, 900);
  }, [editor, report, save]);

  return <section className="love-spot" aria-label="Love Spot">
    {error && <div className="love-spot-status" role="alert">{error}<Button variant="ghost" size="sm" onClick={() => { if (editor) save(); else setAttempt(a => a + 1); }}>Retry</Button></div>}
    {initial ? <Excalidraw initialData={initial} excalidrawAPI={setEditor} onChange={changed} theme={dark ? "dark" : "light"} /> : !error && <p role="status">Opening Love Spot…</p>}
  </section>;
}
