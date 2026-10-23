"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Palette } from "lucide-react";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";

// Excalidraw's style panel: the Island under its menu button (Stroke, Background, Opacity, Layers).
const PANEL = ".selected-shape-actions .App-menu__left";

/** Puts the toggle in the top-right corner of the style panel itself (Masih, 23 Oct: "this should be somewhere in this"), finding the panel inside the drawing that contains this marker whenever Excalidraw shows it. */
function PanelCorner({ children }: { children: ReactElement }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = marker.current?.parentElement;
    if (!host) return;
    const find = () => setPanel(host.querySelector<HTMLElement>(PANEL));
    find();
    const observer = new MutationObserver(find);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <><span ref={marker} hidden />{panel && createPortal(children, panel)}</>;
}

/** One control for the board and the browser drawing: the palette icon of Excalidraw's own Edit button (its `toggleEditMenu` action), which keeps the style panel hidden until it is shown again (Masih, 23 Oct: "I wanted it to be able to stay hidden. like excalidraw does it"). It sits in the panel's corner; a hidden panel keeps only this icon where it was, so the same control opens it again (R17). A pressed icon is a shown panel.
 * The panel is hidden with visibility, not display: Excalidraw places the opacity value under the slider's thumb from the slider's width, and a panel taken out of the layout measures zero, leaving "100" cut off at its left edge. */
export function useDrawingStyle(editor?: ExcalidrawImperativeAPI) {
  const [open, setOpen] = useState(true);
  const notice = useCallback((state: Pick<AppState, "openMenu">) => {
    if (state.openMenu === "shape") setOpen(true);
  }, []);
  const toggle = <PanelCorner><Button type="button" variant="ghost" size="icon-sm" className={`visible absolute right-1.5 top-1.5 z-10${open ? " bg-muted" : ""}`} aria-label="Drawing style" title={open ? "Hide the style panel" : "Show the style panel"} aria-pressed={open} disabled={!editor} onClick={() => {
    const next = !open; setOpen(next);
    editor?.updateScene({ appState: { openMenu: next ? "shape" : null, openPopup: null } });
  }}><Palette size={16} aria-hidden="true" /></Button></PanelCorner>;
  // Excalidraw's narrow layout has this very button in its bottom bar and no such panel, so the corner stays empty there.
  return { notice, toggle, className: open ? "" : "drawing-style-hidden [&_.App-mobile-menu]:hidden" };
}
