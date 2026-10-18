"use client";

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, newElementWith, convertToExcalidrawElements, exportToBlob, restoreElements, serializeAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, PointerDownState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dictation } from "@/components/dictation";
import { LoveSpotTalk, type LoveSpotQuote } from "@/components/love-spot-talk";
import { api, chatProvider, providerChoices, unreadable, type Model, type ProviderSettings } from "@/lib/api";
import { agentColor } from "@/lib/love-spot";
import { agentOf, characters, makeAgent, type Character, type LoveAgent } from "@/lib/love-agents";
import { CharacterPicker, LoveAgentPanel } from "./love-agent-panel";
import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";

type Drawing = { elements: readonly ExcalidrawElement[]; files: BinaryFiles; appState: Partial<AppState> };
type Saved = { scene: Drawing; revision: string };
type Screenshot = { id: string; name: string; dataURL: string };
type Update = ({ type: "scene" } & Saved) | { type: "screenshots"; screenshots: Screenshot[] } | { type: "error"; message: string };
const screenshotDrag = "application/x-elpis-screenshot";
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

export default function LoveSpot({ dark, cwd, onOpenChat }: { dark: boolean; cwd?: string; onOpenChat?: (id: string) => void }) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState>();
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const [talk, setTalk] = useState(false), [quote, setQuote] = useState<LoveSpotQuote>();
  const [boardBusy, setBoardBusy] = useState(false), [talkDictating, setTalkDictating] = useState(false);
  const [models, setModels] = useState<Model[]>([]), [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [model, setModel] = useState(""), [choiceId, setChoiceId] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; text: string }>();
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]), [choosing, setChoosing] = useState(false);
  const lastPoint = useRef<{ x: number; y: number }>(undefined);
  const boardArea = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState(false);
  const [agents, setAgents] = useState<readonly ExcalidrawElement[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const converting = useRef(new Set<string>());
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
    Promise.all([api<{ data: Model[] }>("/models"), api<ProviderSettings>("/settings")]).then(([catalog, config]) => {
      if (!Array.isArray(catalog.data) || catalog.data.some(item => !item || typeof item.model !== "string") || !config.main
        || (config.providers !== undefined && !Array.isArray(config.providers))) throw unreadable("Love Spot model settings");
      if (active) { setModels(catalog.data); setSettings(config); setModel(config.main.model || catalog.data[0]?.model || ""); }
    }).catch(report);
    return () => { active = false; };
  }, [report]);
  const choices = providerChoices(models, settings);
  const provider = chatProvider(model, choices.find(c => c.id === choiceId)?.provider, settings?.main.provider);

  useEffect(() => {
    if (!editor || !boardArea.current) return;
    if (talk) editor.updateScene({ appState: { selectedElementIds: {} } });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      editor.refresh(); cancelAnimationFrame(frame);
      if (talk) frame = requestAnimationFrame(() => editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.7, maxZoom: 1 }));
    });
    observer.observe(boardArea.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [editor, talk]);

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
    const reply = data.scene.elements.some(e => !e.isDeleted && e.id.startsWith("love-reply-") && !shown.has(e.id));
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
      } else if (reply) editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.7, maxZoom: 1 });
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
        else if (data.type === "screenshots") setScreenshots(data.screenshots);
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
    const cards = elements.filter(e => agentOf(e));
    setAgents(previous => versions(previous) === versions(cards) ? previous : cards);
    const note = !appState.editingTextElement && elements.find(e => e.type === "text" && !e.containerId && /(?:^|\s)@agent\b/i.test(e.text) && !converting.current.has(e.id));
    if (editor && note && note.type === "text") {
      converting.current.add(note.id);
      const match = /(?:^|\s)@agent\b\s*/i.exec(note.text)!;
      const rest = note.text.slice(match.index + match[0].length).trim();
      const character = characters.find(c => new RegExp(`^${c.name}\\b`, "i").test(rest)) ?? characters[0];
      const task = [note.text.slice(0, match.index).trim(), rest.replace(new RegExp(`^${character.name}\\b\\s*`, "i"), "")].filter(Boolean).join("\n");
      const made = makeAgent(character, note.x, note.y, task);
      // Change the scene after this notification returns; editor updates are synchronous.
      queueMicrotask(() => {
        editor.updateScene({ elements: [...editor.getSceneElementsIncludingDeleted().map(e => e.id === note.id ? newElementWith(e, { isDeleted: true }) : e), ...made.elements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        editor.addFiles([made.file]);
      });
    }
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

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current); clearTimeout(viewTimer.current);
    await saving.current;
    if (!editor) throw new Error("The board is still opening. Try again in a moment.");
    const data = await api<Saved>("/love-spot", snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles()));
    receive(data); await savePicture(data); return data.revision;
  }, [editor, receive]);

  async function chooseScreenshot(id: string, action: "place" | "dismiss") {
    if (choosing) return;
    setChoosing(true);
    try {
      if (action === "place") receive(await api<Saved>("/love-spot/screenshots", { id, action }));
      else await api("/love-spot/screenshots", { id, action });
      setScreenshots(shots => shots.filter(shot => shot.id !== id)); setError("");
    } catch (e) { report(e); }
    finally { setChoosing(false); }
  }

  const add = (character: Character) => {
    if (!editor) return;
    const state = editor.getAppState(), zoom = state.zoom.value;
    const made = makeAgent(character, 260 / zoom - state.scrollX + (agents.length % 2) * 280, 200 / zoom - state.scrollY + Math.floor(agents.length / 2) * 220);
    editor.updateScene({ elements: [...editor.getSceneElementsIncludingDeleted(), ...made.elements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    editor.addFiles([made.file]);
    setSelected(made.id); setPicker(false);
    editor.setActiveTool({ type: "selection" });
  };
  const updateAgent = (change: Partial<LoveAgent>) => {
    if (!editor || !selected) return;
    editor.updateScene({ elements: editor.getSceneElementsIncludingDeleted().map(e => e.id === selected ? newElementWith(e, { customData: { ...e.customData, loveAgent: { ...agentOf(e), ...change } } }) : e), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };
  const run = async () => {
    if (!selected || busy) return;
    setBusy(true); setRunError("");
    try {
      clearTimeout(saveTimer.current); await saving.current;
      if (!editor) return;
      receive(await api<Saved>("/love-spot", snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles())));
      await api("/love-spot/agents/run", { id: selected, ...(cwd ? { cwd } : {}) });
      receive(await api<Saved>("/love-spot"));
    } catch (e) { if (mounted.current) setRunError(e instanceof Error ? e.message : "The agents could not run."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const inspected = agents.find(e => e.id === selected);
  const agent = inspected && agentOf(inspected);

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
    latest.current = snapshot(editor.getSceneElementsIncludingDeleted(), editor.getAppState(), editor.getFiles());
    save(true);
  }

  return <section className="love-spot" aria-label="Love Spot">
    <div className="love-spot-tools">
      {editor && <div className="love-agent-toolbar">
        <Button variant="outline" size="sm" title="Add an agent, or type @agent in a text note" onClick={() => add(characters[0])}>Agent</Button>
        <Button variant="outline" size="sm" aria-expanded={picker} onClick={() => setPicker(p => !p)}>Characters</Button>
        {picker && <CharacterPicker onAdd={add} />}
      </div>}
      <div role="group" aria-label="Voice note"><Dictation provider={provider} disabled={!editor || !settings || talkDictating} onBusy={setBoardBusy} selection={insertion} onTranscript={addVoiceNote} purpose="Adds a note to the board." /></div>
      <Button variant="outline" size="sm" aria-expanded={talk} onClick={() => setTalk(value => !value)}>Talk</Button>
    </div>
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
    {(error || runError) && <div className="love-spot-status" role="alert">{runError || error}<Button variant="ghost" size="sm" onClick={() => { if (runError) setRunError(""); else if (editor) save(); else setAttempt(a => a + 1); }}>{runError ? "Dismiss" : "Retry"}</Button></div>}
    {!!agents.length && <div className="love-agent-list" aria-label="Board agents">{agents.map(e => <Button key={e.id} variant="outline" size="sm" aria-label={`Inspect ${agentOf(e)!.name}`} onClick={() => setSelected(e.id)}>{agentOf(e)!.name}{agentOf(e)!.status === "running" ? " · running" : ""}</Button>)}</div>}
    <div className="love-spot-content"><div className="love-spot-editor" ref={boardArea} onDragOverCapture={event => {
      if (event.dataTransfer.types.includes(screenshotDrag)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }
    }} onDropCapture={event => {
      const id = event.dataTransfer.getData(screenshotDrag);
      if (id) { event.preventDefault(); event.stopPropagation(); void chooseScreenshot(id, "place"); }
    }} onContextMenuCapture={event => {
      if (!editor || !(event.target instanceof HTMLCanvasElement)) return;
      const p = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, editor.getAppState());
      const note = [...editor.getSceneElements()].reverse().find(e => e.type === "text" && !agentColor(e.strokeColor) && p.x >= e.x && p.x <= e.x + e.width && p.y >= e.y && p.y <= e.y + e.height);
      if (note?.type !== "text") return;
      event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, text: note.originalText || note.text });
    }}>
      {initial ? <Excalidraw initialData={initial} excalidrawAPI={setEditor} onChange={changed} onPointerUp={() => {
        if (!editor) return;
        const ids = editor.getAppState().selectedElementIds;
        const clicked = editor.getSceneElements().find(e => ids[e.id] && agentOf(e));
        if (clicked) setSelected(clicked.id);
      }} onPointerDown={(_tool: AppState["activeTool"], state: PointerDownState) => { lastPoint.current = state.origin; }} theme={dark ? "dark" : "light"} /> : !error && <p role="status">Opening Love Spot…</p>}
    </div>
    <div className="love-spot-panels" hidden={!talk && !agent}>
      {agent && <LoveAgentPanel agent={agent} cwd={cwd} busy={busy} onChange={updateAgent} onRun={() => void run()} onClose={() => setSelected(undefined)} onOpenChat={onOpenChat} />}
      <LoveSpotTalk open={talk} onClose={() => setTalk(false)} quote={quote} model={model} choiceId={choiceId} choices={choices} models={models}
        onModel={value => { setModel(value.model); setChoiceId(value.choiceId); }} provider={provider} disabled={!editor || !settings || !model || boardBusy} onDictating={setTalkDictating} beforeSend={flush} />
    </div>
    </div>
    {menu && <DropdownMenu open onOpenChange={open => { if (!open) setMenu(undefined); }}>
      <DropdownMenuTrigger aria-label="Note actions" className="love-spot-menu-anchor" style={{ left: menu.x, top: menu.y }} />
      <DropdownMenuContent align="start"><DropdownMenuItem onClick={() => { setQuote({ id: Date.now(), text: menu.text }); setTalk(true); setMenu(undefined); }}>Ask about this note</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>}
  </section>;
}
