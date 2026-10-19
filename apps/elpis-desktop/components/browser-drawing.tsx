"use client";

import "@/lib/love-spot-assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, MainMenu, convertToExcalidrawElements, exportToCanvas, getCommonBounds, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { AttachToChat } from "@/components/browser-annotations";
import { holdDrawing, type DrawingDraft } from "@/lib/browser-drawing-store";
import "@excalidraw/excalidraw/index.css";

const BACKGROUND = "page-shot";
const IMAGE_LIMIT = 3.8 * 1024 * 1024;
const bytes = (dataUrl: string) => Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);

/** The captured page as a locked image at the scene's origin, ready to be Excalidraw's initial data. */
function backgroundScene(shot: string, width: number, height: number): { elements: readonly ExcalidrawElement[]; files: BinaryFiles } {
  const fileId = "page-shot-file" as BinaryFiles[string]["id"];
  // The converter assigns its own ids; the backdrop is found by its fixed one.
  const elements = restoreElements(convertToExcalidrawElements([{ type: "image", fileId, x: 0, y: 0, width, height, status: "saved", locked: true }]).map(element => ({ ...element, id: BACKGROUND })), null);
  return { elements, files: { [fileId]: { id: fileId, mimeType: "image/jpeg", dataURL: shot as BinaryFiles[string]["dataURL"], created: Date.now() } } };
}

const TABBABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
const tabbable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(element => !(element as HTMLButtonElement).disabled && element.tabIndex >= 0 && element.getClientRects().length > 0);

const marks = (elements: readonly ExcalidrawElement[]) => elements.filter(element => !element.isDeleted && element.id !== BACKGROUND);

/** The page screenshot under Excalidraw's own editor: draw on it, then add the marked picture and its address to the composer. */
export default function BrowserDrawing({ draft: given, dark, onAttach, onClose, onAdded }: { draft: DrawingDraft; dark: boolean; onAttach: AttachToChat; onClose: () => void; onAdded: () => void }) {
  const [draft] = useState(() => ({ ...given, ...(given.elements ? {} : backgroundScene(given.shot, given.width, given.height)) }) as DrawingDraft & { elements: readonly ExcalidrawElement[]; files: BinaryFiles });
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const [marked, setMarked] = useState(() => marks(draft.elements).length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const scene = useRef<DrawingDraft>(draft);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<ExcalidrawElement>(draft.elements.find(element => element.id === BACKGROUND)!);

  // The window is modal: focus starts inside it, Tab wraps within it, and focus that lands on the page underneath is brought back.
  // The discard question is its own dialog with its own focus handling, so it is left alone while it is open.
  useEffect(() => {
    const element = root.current; if (!element) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (element.contains(target) || !!(target instanceof Element && target.closest('[role="alertdialog"]')));
    const pull = () => { if (!asking && !inside(document.activeElement)) (tabbable(element)[0] ?? element).focus(); };
    pull(); document.addEventListener("focusin", pull);
    return () => document.removeEventListener("focusin", pull);
  }, [asking]);
  useEffect(() => { if (editor) editor.scrollToContent(first.current, { fitToViewport: true, viewportZoomFactor: 0.95 }); }, [editor]);

  // The unsent drawing is held until it is added or discarded, so closing the panel never loses it.
  const changed = useCallback((elements: readonly ExcalidrawElement[], _state: unknown, files: BinaryFiles) => {
    const all = editor?.getSceneElementsIncludingDeleted() ?? elements;
    const shot = all.find(element => element.id === BACKGROUND), origin = first.current;
    // The screenshot is a fixed backdrop: restore it if anything (unlock all, clear canvas) moved or removed it.
    if (editor && (!shot || shot.isDeleted || !shot.locked || shot.x !== origin.x || shot.y !== origin.y || shot.width !== origin.width || shot.height !== origin.height)) {
      editor.updateScene({ elements: [origin, ...all.filter(element => element.id !== BACKGROUND)] }); return;
    }
    scene.current = { ...scene.current, elements: all, files: { ...files } };
    holdDrawing(scene.current);
    setMarked(marks(all).length > 0);
  }, [editor]);

  const close = () => { holdDrawing(null); onClose(); };
  const cancel = () => { if (busy) return; if (marked) setAsking(true); else close(); };

  async function add() {
    if (!editor || busy) return;
    setBusy(true); setError("");
    try {
      const elements = editor.getSceneElements(), files = editor.getFiles();
      // Marks that run off the page are cut at its edge, so the picture is exactly the page that was captured.
      const sheet = await exportToCanvas({ elements, files, exportPadding: 0, appState: { exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: "#ffffff" } });
      const [left, top] = getCommonBounds(elements), scale = Math.min(1, 2048 / Math.max(draft.width, draft.height));
      const page = document.createElement("canvas"); page.width = Math.round(draft.width * scale); page.height = Math.round(draft.height * scale);
      const context = page.getContext("2d"); if (!context) throw Error("The drawing cannot be exported on this computer.");
      context.drawImage(sheet, Math.max(0, -left), Math.max(0, -top), draft.width, draft.height, 0, 0, page.width, page.height);
      let url = "";
      for (const quality of [0.85, 0.7, 0.55, 0.4]) { url = page.toDataURL("image/jpeg", quality); if (bytes(url) <= IMAGE_LIMIT) break; url = ""; }
      if (!url) throw Error("The marked picture is too large to attach.");
      const note = `The attached image "Page drawing.jpg" is a screenshot of the browser page ${draft.url}${draft.title ? ` (“${draft.title}”)` : ""}, ${draft.width}×${draft.height} px, with the user's own marks drawn on top: arrows, pen strokes, shapes and text. Read the marks as the changes or questions the user wants about that page.`;
      const added = await onAttach([{ id: crypto.randomUUID(), name: "Page drawing context", type: "text", mimeType: "text/plain", text: note }, { id: crypto.randomUUID(), name: "Page drawing.jpg", type: "image", mimeType: "image/jpeg", dataUrl: url }], false);
      if (added) { holdDrawing(null); onAdded(); } else setError("The drawing could not be added to your message. It is still here: try again.");
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} Your drawing is still here: try again.`); }
    finally { setBusy(false); }
  }

  return createPortal(<div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Draw on the page" className="fixed inset-0 z-40 flex flex-col bg-background text-foreground outline-none"
    onKeyDownCapture={event => {
      if (event.key === "Tab" && !asking && root.current) {
        const stops = tabbable(root.current), index = stops.indexOf(document.activeElement as HTMLElement);
        if (stops.length) {
          event.preventDefault(); event.stopPropagation();
          stops[index < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
        }
        return;
      }
      if (event.key !== "Escape" || asking) return;
      const state = editor?.getAppState();
      // Escape belongs to the editor while it has a tool, a selection, a text box or a menu open.
      if (!state || state.activeTool.type !== "selection" || state.editingTextElement || state.openDialog || state.openPopup || state.openMenu || Object.keys(state.selectedElementIds).length) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    }}>
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Draw on the page</h2>
        <p className="truncate text-xs text-muted-foreground" title={draft.url}>{draft.title ? `${draft.title} · ` : ""}{draft.url}</p>
      </div>
      {error && <p role="alert" className="max-w-[40%] text-xs text-destructive">{error}</p>}
      <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</Button>
      <Button type="button" size="sm" onClick={() => void add()} disabled={!marked || busy} title={marked ? "Add the marked picture and the page address to your message" : "Draw something first"}>{busy ? "Adding…" : "Add to message"}</Button>
    </header>
    <div className="browser-drawing-editor relative min-h-0 flex-1">
      <Excalidraw initialData={{ elements: draft.elements, files: draft.files, appState: { collaborators: new Map() } }} excalidrawAPI={setEditor} onChange={changed}
        theme={dark ? "dark" : "light"} handleKeyboardGlobally={false} autoFocus
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: false, changeViewBackgroundColor: false } }}>
        {/* Without the default menu's file actions and its links to other sites. */}
        <MainMenu><MainMenu.DefaultItems.SearchMenu /><MainMenu.DefaultItems.Help /></MainMenu>
      </Excalidraw>
    </div>
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this drawing?</AlertDialogTitle>
          <AlertDialogDescription>Your marks on the page are removed and cannot be brought back.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" size="sm" />}>Keep drawing</AlertDialogClose>
          <Button type="button" variant="destructive" size="sm" onClick={() => { setAsking(false); close(); }}>Discard</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>, document.body);
}
