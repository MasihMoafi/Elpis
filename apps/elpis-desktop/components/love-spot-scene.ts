"use client";
import type { BoardPage, Drawing, Saved } from './love-spot-types.ts';
import { exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { api } from "@/lib/api";
import { restoreRemoteElements } from "@/lib/love-spot-history";
import { lightFiles } from "@/lib/love-spot";
import { BOARD_THEMED } from "@/bridge/matilda-face.cts";
export const versions = (elements: readonly ExcalidrawElement[]) => JSON.stringify(elements.map(e => [e.id, e.version, e.versionNonce, e.isDeleted]));
export function snapshot(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles, page?: BoardPage): Drawing {
    // Excalidraw's file serializer drops deleted elements even when they are supplied.
    // Use it only to filter app state. Embedded image bytes are immutable and must not
    // be stringified and parsed again on every pointer move or keystroke.
    return { ...JSON.parse(serializeAsJSON([], appState, {}, "local")), elements: JSON.parse(JSON.stringify(elements)), files: { ...files }, page };
}
/** The part of the board Excalidraw's own toolbar, style panel and zoom bar leave clear (29 Oct: her notes ran under the
 * toolbar). Showing a note or the drawing fits it there, so the board's chrome never covers what it shows. */
export function clearOfTools(area: HTMLElement | null) {
    const board = area?.querySelector(".excalidraw")?.getBoundingClientRect();
    if (!area || !board)
        return undefined;
    const part = (selector: string) => area.querySelector(selector)?.getBoundingClientRect();
    const tools = part(".App-toolbar"), panel = part(".App-menu__left"), footer = part(".layer-ui__wrapper__footer-left"), gap = 16;
    return { top: (tools ? tools.bottom - board.top : 0) + gap, left: (panel?.width ? panel.right - board.left : 0) + gap, right: gap, bottom: (footer ? board.bottom - footer.top : 0) + gap };
}
export const scrollOffsets = (area: HTMLElement | null) => { const offsets = clearOfTools(area); return offsets ? { canvasOffsets: offsets } : {}; };
// Her faces on the board wear the theme's clothes: the saved scene keeps the dark-clothed picture, display swaps it.
export const boardFiles = (files: BinaryFiles, dark: boolean) => Object.fromEntries(Object.entries(files).map(([id, file]) => {
    const themed = (BOARD_THEMED as Record<string, {
        dark: string;
        light: string;
    }>)[file.dataURL];
    if (!themed)
        return [id, file];
    const dataURL = dark ? themed.dark : themed.light;
    return [id, { ...file, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")) }];
})) as BinaryFiles;
export const savedBoardFiles = (files: BinaryFiles) => boardFiles(files, true);
export async function lightDrawing(drawing: Drawing) { const files = savedBoardFiles(drawing.files); return { ...drawing, files: await lightFiles(drawing.elements, files) }; }
export async function savePicture(data: Saved) {
    const blob = await exportToBlob({ elements: restoreRemoteElements(data.scene.elements).filter(e => !e.isDeleted),
        appState: { ...data.scene.appState, exportBackground: true }, files: data.scene.files, mimeType: "image/png", exportPadding: 24, maxWidthOrHeight: 2400 });
    const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The drawing image could not be read.')); reader.onerror = () => reject(reader.error ?? new Error('The drawing image could not be read.')); reader.readAsDataURL(blob); });
    await api("/love-spot/picture", { revision: data.revision, png: dataURL.split(",")[1] });
}
