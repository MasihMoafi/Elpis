import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

/** A marked-up page that has not reached the composer: the screenshot, where it came from and, once the editor has run, the drawn scene. */
export type DrawingDraft = { shot: string; url: string; title: string; width: number; height: number; elements?: readonly ExcalidrawElement[]; files?: BinaryFiles };

// Kept outside React so a drawing survives the side panel closing (a failed attach on a narrow window closes it).
let held: DrawingDraft | null = null;
export const heldDrawing = () => held;
export const holdDrawing = (draft: DrawingDraft | null) => { held = draft; };
