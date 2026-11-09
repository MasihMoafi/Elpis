"use client";

import { useCanvasState } from "./use-canvas-state";
import { useCanvasBoardModel } from "./use-canvas-board-model";
import { useCanvasInteractions } from "./use-canvas-interactions";
import { useCanvasRunPanel } from "./use-canvas-run-panel";

export function useCanvasController(props: Parameters<typeof useCanvasState>[0]) {
  return useCanvasRunPanel(useCanvasInteractions(useCanvasBoardModel(useCanvasState(props))));
}

export type CanvasController = ReturnType<typeof useCanvasController>;
