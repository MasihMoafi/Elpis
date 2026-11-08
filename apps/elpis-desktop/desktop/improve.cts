"use strict";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
const { trustedBrowserSender }: typeof import("./browser-policy.cts") = require("./browser-policy.cts");

type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };
function regionRectImpl(bounds: Rect | null, viewport: Size) {
  if (!bounds || !["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key as keyof Rect])))
    throw Error("Choose a visible region");
  const x = Math.max(0, Math.floor(bounds.x)),
    y = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(Math.ceil(bounds.width), viewport.width - x),
    height = Math.min(Math.ceil(bounds.height), viewport.height - y);
  if (width < 1 || height < 1 || bounds.width < 1 || bounds.height < 1) throw Error("Choose a visible region");
  return { x, y, width, height };
}
function registerImproveImpl({
  host,
  origin,
  ipcMain,
}: {
  host: BrowserWindow;
  origin: string;
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
    removeHandler: (channel: string) => void;
  };
}) {
  const guard = (event: IpcMainInvokeEvent) => {
    if (!trustedBrowserSender(event, host.webContents, origin)) throw Error("Elpis application frame required");
  };
  ipcMain.handle("elpis:improve:capture", async (event, bounds) => {
    guard(event);
    // DOM rectangles are CSS pixels; capturePage takes device-independent window pixels, including zoom.
    const zoom = host.webContents.getZoomFactor();
    const rect = regionRectImpl(
      Object.fromEntries(
        Object.entries((bounds ?? {}) as Record<string, number>).map(([key, value]) => [key, value * zoom]),
      ) as Rect,
      host.getContentBounds(),
    );
    return { image: (await host.webContents.capturePage(rect)).toDataURL() };
  });
  return () => ipcMain.removeHandler("elpis:improve:capture");
}
export declare const registerImprove: typeof registerImproveImpl;
export declare const regionRect: typeof regionRectImpl;
module.exports = { registerImprove: registerImproveImpl, regionRect: regionRectImpl };
