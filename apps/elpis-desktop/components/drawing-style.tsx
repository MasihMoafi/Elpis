"use client";

import { useCallback, useState } from "react";
import { Palette } from "lucide-react";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";

/** One control for the board and the browser drawing: the palette icon of Excalidraw's own Edit button (its `toggleEditMenu` action), which keeps the style panel hidden until it is shown again (Masih, 23 Oct: "I wanted it to be able to stay hidden. like excalidraw does it"). It says nothing like ON or OFF: a pressed icon is a shown panel. */
export function useDrawingStyle(editor?: ExcalidrawImperativeAPI) {
  const [open, setOpen] = useState(true);
  const notice = useCallback((state: Pick<AppState, "openMenu">) => {
    if (state.openMenu === "shape") setOpen(true);
  }, []);
  const button = <Button type="button" variant="ghost" size="icon-sm" className={open ? "bg-muted" : undefined} aria-label="Drawing style" title={open ? "Hide the style panel" : "Show the style panel"} aria-pressed={open} disabled={!editor} onClick={() => {
    const next = !open; setOpen(next);
    editor?.updateScene({ appState: { openMenu: next ? "shape" : null, openPopup: null } });
  }}><Palette size={16} aria-hidden="true" /></Button>;
  return { notice, button, className: open ? "" : "[&_.selected-shape-actions]:hidden [&_.App-mobile-menu]:hidden" };
}
