"use strict";
const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");
import type { BrowserWindow as Window, IpcMain, IpcMainEvent, Screen } from "electron";
const path = require("node:path");
const {
  trustedBrowserSender,
  popupWebPreferences,
  lockPopup,
}: typeof import("./browser-policy.cts") = require("./browser-policy.cts");

// The macOS screenshot thumbnail (A239, 24 Oct: "whenever I take a screenshot … pops up and if I press it it does it"):
// while Elpis runs, each new screenshot shows a small thumbnail in the bottom-right corner, above every window and without
// taking focus, for about six seconds (longer while the pointer is on it). Clicking it adds the screenshot to the open
// Love Spot page in the window that reported it (5 Nov: "it shouldn't open a new page"); ignoring it does nothing (it stays
// in Love Spot's screenshot tray).
const SIZE = { width: 292, height: 224 },
  MARGIN = 6; // The page draws a 10px shadow margin inside the window.

function createScreenshotPopupImpl({
  BrowserWindow,
  screen,
  ipcMain,
  dark,
}: {
  BrowserWindow: typeof Window;
  screen: Screen;
  ipcMain: IpcMain;
  dark: () => boolean;
}) {
  let window: Window | null = null,
    ready: Promise<void> | null = null,
    shown: { id: string; host: Window } | null = null; // shown: { id, host }
  const open = () => !!window && !window.isDestroyed();
  const close = () => {
    shown = null;
    if (open()) window!.destroy();
    window = null;
    ready = null;
  };
  function create() {
    const { workArea } = screen.getPrimaryDisplay();
    window = new BrowserWindow({
      ...SIZE,
      x: workArea.x + workArea.width - SIZE.width - MARGIN,
      y: workArea.y + workArea.height - SIZE.height - MARGIN,
      show: false,
      title: "Elpis screenshot",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: popupWebPreferences(preloadPath("screenshot-popup-preload")),
    });
    lockPopup(window);
    const own = window;
    own.on("closed", () => {
      if (window === own) {
        window = null;
        ready = null;
        shown = null;
      }
    });
    ready = new Promise<void>(resolve => own.webContents.once("did-finish-load", resolve));
    void own.loadFile(path.join(__dirname, "screenshot-popup.html"));
  }
  async function show(host: Window, shot: { id: string; dataURL: string; name: string; count: number }) {
    if (!open()) create();
    const own = window!;
    await ready;
    if (window !== own || own.isDestroyed()) return;
    shown = { id: shot.id, host };
    own.webContents.send("elpis:screenshot-popup:show", {
      image: shot.dataURL,
      name: shot.name,
      dark: dark(),
      count: shot.count,
    });
    own.showInactive();
  }
  const fromPopup = (event: IpcMainEvent) => open() && event.sender === window!.webContents;
  const choose = (event: IpcMainEvent) => {
    if (!fromPopup(event) || !shown) return;
    const { id, host } = shown;
    close();
    if (host.isDestroyed()) return;
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    host.webContents.send("elpis:screenshot-popup:open", id);
  };
  const dismiss = (event: IpcMainEvent) => {
    if (fromPopup(event)) close();
  };
  ipcMain.on("elpis:screenshot-popup:choose", choose);
  ipcMain.on("elpis:screenshot-popup:dismiss", dismiss);
  return {
    /** Only the app's own page may ask for a thumbnail; a click goes back to that window. */
    attach({
      host,
      origin,
      ipcMain: windowIpc,
    }: {
      host: Window;
      origin: string;
      ipcMain: import("./browser-policy.cts").IpcListeners;
    }) {
      const request = (event: IpcMainEvent, raw: unknown) => {
        const shot = raw as { id?: unknown; name?: unknown; dataURL?: unknown; count?: number } | null | undefined;
        if (!trustedBrowserSender(event, host.webContents, origin)) return;
        if (
          typeof shot?.id !== "string" ||
          typeof shot.name !== "string" ||
          typeof shot.dataURL !== "string" ||
          !shot.dataURL.startsWith("data:image/png;base64,")
        )
          return;
        const count =
          Number.isInteger(shot.count) && (shot.count as number) > 0 && (shot.count as number) <= 50
            ? (shot.count as number)
            : 1;
        void show(host, { id: shot.id, name: shot.name.slice(0, 200), dataURL: shot.dataURL, count });
      };
      windowIpc.on("elpis:screenshot-popup:request", request);
      return () => {
        windowIpc.removeListener("elpis:screenshot-popup:request", request);
        if (shown?.host === host) close();
      };
    },
    dispose() {
      ipcMain.removeListener("elpis:screenshot-popup:choose", choose);
      ipcMain.removeListener("elpis:screenshot-popup:dismiss", dismiss);
      close();
    },
  };
}

export declare const createScreenshotPopup: typeof createScreenshotPopupImpl;
module.exports = { createScreenshotPopup: createScreenshotPopupImpl };
