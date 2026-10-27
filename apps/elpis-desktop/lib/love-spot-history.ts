import { flushSync } from "react-dom";
import { CaptureUpdateAction, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

function ordered(elements: readonly ExcalidrawElement[]) {
  // Winners were already chosen by Love Spot's conflict policy. With no local
  // candidates, reconciliation only orders indices and repairs legacy ones.
  return reconcileElements([], elements as Parameters<typeof reconcileElements>[1], {} as AppState);
}

export function restoreRemoteElements(elements: readonly ExcalidrawElement[]) {
  // Restoration also repairs indices; order first so a different insertion
  // order cannot turn every received snapshot into a newer local edit.
  // Saved text bounds are valid before webfonts load; measuring the fallback font here clips labels.
  return restoreElements(ordered(elements.map(element => ({ ...element }))), null, { refreshDimensions: false, repairBindings: true });
}

export function mergeRemoteElements(shown: Map<string, ExcalidrawElement>, incoming: readonly ExcalidrawElement[], isNewer: (incoming: ExcalidrawElement, current: ExcalidrawElement) => boolean) {
  // Choose winners from published metadata, before index repair can bump a
  // stale live element above a local deletion with the same version.
  const accepted = new Set(incoming.filter(element => {
    const mine = shown.get(element.id);
    return !mine || isNewer(element, mine);
  }).map(element => element.id));
  if (!accepted.size) return false;
  let changed = false;
  for (const element of restoreRemoteElements(incoming)) {
    if (accepted.has(element.id)) { shown.set(element.id, element); changed = true; }
  }
  return changed;
}

/** Excalidraw filters uncommitted local IDs out of NEVER snapshot updates.
 * Detach only replaced IDs first, within one render, so the winning remote
 * elements enter the snapshot instead of the next local Undo entry. */
export function applyRemoteScene(editor: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], appState?: Partial<AppState>) {
  elements = ordered(elements);
  const local = editor.getSceneElementsIncludingDeleted();
  const incoming = new Map(elements.map(element => [element.id, element]));
  const replaced = new Set(local.filter(element => incoming.has(element.id) && incoming.get(element.id) !== element).map(element => element.id));
  flushSync(() => {
    if (replaced.size) editor.updateScene({ elements: local.filter(element => !replaced.has(element.id)), captureUpdate: CaptureUpdateAction.NEVER });
    editor.updateScene({ elements, ...(appState ? { appState: { ...editor.getAppState(), ...appState } } : {}), captureUpdate: CaptureUpdateAction.NEVER });
  });
}
