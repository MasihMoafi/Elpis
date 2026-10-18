import { flushSync } from "react-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** Excalidraw filters uncommitted local IDs out of NEVER snapshot updates.
 * Detach only replaced IDs first, within one render, so the winning remote
 * elements enter the snapshot instead of the next local Undo entry. */
export function applyRemoteScene(editor: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], appState?: Partial<AppState>) {
  const local = editor.getSceneElementsIncludingDeleted();
  const incoming = new Map(elements.map(element => [element.id, element]));
  const replaced = new Set(local.filter(element => incoming.has(element.id) && incoming.get(element.id) !== element).map(element => element.id));
  flushSync(() => {
    if (replaced.size) editor.updateScene({ elements: local.filter(element => !replaced.has(element.id)), captureUpdate: CaptureUpdateAction.NEVER });
    editor.updateScene({ elements, ...(appState ? { appState: { ...editor.getAppState(), ...appState } } : {}), captureUpdate: CaptureUpdateAction.NEVER });
  });
}
