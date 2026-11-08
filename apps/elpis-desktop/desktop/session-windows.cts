"use strict";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import type { StateStore, WindowOpeners } from "./main-backend.cts";
const path: typeof import("node:path") = require("node:path");
const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");
const { createBrowserSessions } = require("./browser-sessions.cts");
const { registerState }: typeof import("./state.cts") = require("./state.cts");
const { registerFiles }: typeof import("./files.cts") = require("./files.cts");
const { createDocuments }: typeof import("./documents.cts") = require("./documents.cts");
const { registerTerminal }: typeof import("./terminal.cts") = require("./terminal.cts");
const { attachContextMenu }: typeof import("./context-menu.cts") = require("./context-menu.cts");
const { registerTheme }: typeof import("./theme.cts") = require("./theme.cts");
const { registerCopyKeys }: typeof import("./copy-keys.cts") = require("./copy-keys.cts");
const { appPermission }: typeof import("./media-policy.cts") = require("./media-policy.cts");
const { trustedBrowserSender }: typeof import("./browser-policy.cts") = require("./browser-policy.cts");
const {
  createThreadOpener,
  createNewChatOpener,
  threadId: validThreadId,
}: typeof import("./open-thread.cts") = require("./open-thread.cts");
const { createWindowIpc }: typeof import("./window-ipc.cts") = require("./window-ipc.cts");
const { registerImprove }: typeof import("./improve.cts") = require("./improve.cts");
const { createScreenCapture }: typeof import("./screen-capture.cts") = require("./screen-capture.cts");
const ICON = path.join(__dirname, "elpis-icon.png");
const LOVE_SPOT_ICON = path.join(__dirname, "love-spot-icon.png");
const ZOOM = 1.1;
const TITLE_BAR = {
  dark: { color: "#0d0e11", symbolColor: "#e6e0d3" },
  light: { color: "#f2f2f1", symbolColor: "#252524" },
};

/** All session windows use one bridge URL and one workspace store. No window owns the engine. */
function createSessionWindowsImpl({
  electron,
  url,
  store,
  browserAgentSocket,
  quickEntry,
  screenshotPopup,
  closeToTray,
  updates,
  mayClose,
  quitting = () => false,
  onDark,
  onClosed,
  onFocused,
  loveSpotApp = false,
}: {
  electron: typeof import("electron");
  url: string;
  loveSpotApp?: boolean;
  store: StateStore;
  browserAgentSocket?: ReturnType<typeof import("./browser-agent.cts").startBrowserAgentSocket> extends Promise<infer T>
    ? T
    : never;
  quickEntry?: {
    attach: (options: {
      host: BrowserWindow;
      origin: string;
      ipcMain: ReturnType<ReturnType<typeof createWindowIpc>>;
    }) => () => void;
  };
  screenshotPopup?: {
    attach: (options: {
      host: BrowserWindow;
      origin: string;
      ipcMain: ReturnType<ReturnType<typeof createWindowIpc>>;
    }) => () => void;
  };
  closeToTray: ReturnType<typeof import("./tray.cts").createCloseToTray>;
  updates?: {
    attach: (options: {
      host: BrowserWindow;
      origin: string;
      ipcMain: ReturnType<ReturnType<typeof createWindowIpc>>;
    }) => () => void;
  };
  mayClose: (host: BrowserWindow) => boolean;
  quitting?: () => boolean;
  onDark?: (dark: boolean) => void;
  onClosed?: (host: BrowserWindow) => void;
  onFocused?: (host: BrowserWindow, openers: WindowOpeners | undefined) => void;
}) {
  const {
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain: globalIpc,
    Menu,
    clipboard,
    shell,
    dialog,
    nativeTheme,
  } = electron;
  const windows = new Set<BrowserWindow>();
  const savedText = new WeakSet<BrowserWindow>();
  const openers = new Map<BrowserWindow, WindowOpeners>();
  const windowIpc = createWindowIpc(globalIpc);
  const browsers = createBrowserSessions({ store, browserAgentSocket });
  const documents = createDocuments();
  browserAgentSocket?.setDocuments((id: unknown, name: unknown, args: unknown) => documents.call(id, name, args));
  const screenCapture = createScreenCapture({ desktopCapturer: electron.desktopCapturer, Menu });
  browserAgentSocket?.setScreenCapture((id: unknown, name: unknown, args: unknown) =>
    screenCapture.call(id, name, args),
  );
  let loveSpotWindow: BrowserWindow | undefined,
    openingLoveSpot: Promise<BrowserWindow> | null = null,
    workflowsWindow: BrowserWindow | undefined,
    openingWorkflows: Promise<BrowserWindow> | null = null;
  async function openLoveSpot() {
    if (loveSpotWindow && !loveSpotWindow.isDestroyed()) {
      if (loveSpotWindow.isMinimized()) loveSpotWindow.restore();
      if (!loveSpotWindow.isVisible()) loveSpotWindow.show();
      loveSpotWindow.focus();
      return loveSpotWindow;
    }
    if (!openingLoveSpot)
      openingLoveSpot = open({ loveSpot: true })
        .then(host => {
          loveSpotWindow = host;
          return host;
        })
        .finally(() => {
          openingLoveSpot = null;
        });
    return await openingLoveSpot;
  }
  async function openWorkflows() {
    if (workflowsWindow && !workflowsWindow.isDestroyed()) {
      if (workflowsWindow.isMinimized()) workflowsWindow.restore();
      if (!workflowsWindow.isVisible()) workflowsWindow.show();
      workflowsWindow.focus();
      return workflowsWindow;
    }
    if (!openingWorkflows)
      openingWorkflows = open({ workflows: true })
        .then(host => {
          workflowsWindow = host;
          return host;
        })
        .finally(() => {
          openingWorkflows = null;
        });
    return await openingWorkflows;
  }
  async function open({
    threadId,
    newSession = false,
    onPrimary,
    loveSpot = false,
    workflows = false,
  }: {
    threadId?: string | null | undefined;
    newSession?: boolean;
    onPrimary?: (openers: WindowOpeners) => void;
    loveSpot?: boolean;
    workflows?: boolean;
  } = {}) {
    const origin = new URL(url).origin;
    const window = new BrowserWindow({
      title: loveSpot ? "Love Spot · Elpis" : workflows ? "Workflows · Elpis" : "Elpis",
      width: 1320,
      height: 900,
      minWidth: 600,
      minHeight: 480,
      autoHideMenuBar: true,
      icon: loveSpot ? LOVE_SPOT_ICON : ICON,
      backgroundColor: "#151515",
      show: false,
      titleBarStyle: "hidden",
      titleBarOverlay: { ...TITLE_BAR.dark, height: Math.round(36 * ZOOM) },
      webPreferences: {
        zoomFactor: ZOOM,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        preload: preloadPath("preload"),
      },
    });
    const ipcMain = windowIpc(window);
    windows.add(window);
    const browser = browsers.attach({
      host: window,
      origin,
      WebContentsView,
      session,
      ipcMain,
      Menu,
      clipboard,
      openExternal: (url: string) => shell.openExternal(url),
    });
    window.on("focus", () => {
      onFocused?.(window, openers.get(window));
    });
    const threads = createThreadOpener(threadId);
    const newChats = createNewChatOpener();
    openers.set(window, { threads, newChats, loveSpot, workflows });
    if (newSession) newChats.queue("");
    if (onPrimary) onPrimary({ threads, newChats });
    const disposeState = registerState({ host: window, origin, ipcMain, dialog, store });
    const disposeFiles = registerFiles({ host: window, origin, ipcMain, shell });
    const disposeDocuments = documents.attach({ host: window, origin, ipcMain, session: () => browser.sessionId });
    const disposeScreenCapture = screenCapture.attach({
      host: window,
      origin,
      ipcMain,
      session: () => browser.sessionId,
    });
    const disposeTerminal = registerTerminal({ host: window, origin, ipcMain, clipboard });
    const disposeImprove = registerImprove({ host: window, origin, ipcMain });
    const disposeThreads = threads.attach({ host: window, origin, ipcMain });
    const disposeNewChats = newChats.attach({ host: window, origin, ipcMain });
    const disposeQuickEntry = quickEntry?.attach({ host: window, origin, ipcMain }) ?? (() => {});
    const disposeScreenshotPopup = screenshotPopup?.attach({ host: window, origin, ipcMain }) ?? (() => {});
    const disposeUpdates = updates?.attach({ host: window, origin, ipcMain }) ?? (() => {});
    // The app's theme colours the window buttons, Quick Entry, the browser's pages and nativeTheme; only the app's own page may report it.
    const host = window;
    const disposeTheme = registerTheme({
      host,
      ipcMain,
      nativeTheme,
      titleBar: TITLE_BAR,
      browser,
      onDark,
    } as Parameters<typeof registerTheme>[0]);
    // Website permissions are handled by the browser's separate session.
    const permits = (
      contents: WebContents | null,
      permission: string,
      details: Parameters<typeof appPermission>[3],
    ) => {
      const host = [...windows].find(host => !host.isDestroyed() && host.webContents === contents);
      return !!host && appPermission(contents, host, permission, details, origin);
    };
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(permits(contents, permission, details)),
    );
    window.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
      permits(contents, permission, details),
    );
    registerCopyKeys(window.webContents);
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.on("will-prevent-unload", event => {
      if (quitting()) {
        event.preventDefault();
        return;
      }
      const choice = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["Continue", "Keep editing"],
        defaultId: 1,
        cancelId: 1,
        title: "Unsaved changes",
        message: "Leave with unsaved changes?",
        detail:
          "Save or copy unsaved text before continuing. Personalization drafts are recovered from this device when available.",
      });
      if (choice === 0) event.preventDefault();
    });
    // Local HTML previews may run their own scripts, but never replace their opaque document.
    // Check the source URL too: a preview's script can rename its own browsing context.
    window.webContents.on("will-frame-navigate", event => {
      if (event.isMainFrame || !event.frame) return;
      if (event.frame.name !== "elpis-file-preview" && event.frame.url !== "about:srcdoc") return;
      if (event.url === "about:srcdoc" && event.frame.url !== "about:srcdoc") return;
      event.preventDefault();
    });
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== origin) event.preventDefault();
    });
    const openInBrowser = (url: string) => {
      try {
        browser.open(url);
      } catch {
        /* Invalid links remain closed. */
      }
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url);
      return { action: "deny" };
    });
    const detachContextMenu = attachContextMenu(window.webContents, {
      Menu,
      clipboard,
      openLink: openInBrowser,
      origin,
      window,
      changeThis: point => window.webContents.send("elpis:improve:point", point),
    });
    window.once("ready-to-show", () => window.show());
    ipcMain.handle("elpis:session-window", async (event: IpcMainInvokeEvent, id: unknown) => {
      if (!trustedBrowserSender(event, window.webContents, origin)) throw Error("Elpis application frame required");
      if (id !== undefined && !validThreadId(id)) throw Error("Invalid session");
      await open({ threadId: id as string | undefined, newSession: id === undefined });
      return { opened: true };
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler("elpis:session-window");
      detachContextMenu();
      disposeImprove();
      disposeDocuments();
      disposeScreenCapture();
      disposeFiles();
      disposeTerminal();
      disposeThreads();
      disposeNewChats();
      disposeQuickEntry();
      disposeScreenshotPopup();
      disposeUpdates();
      disposeState();
      browser.dispose();
      disposeTheme();
    };
    let flushingText = false;
    window.on("close", event => {
      if (windows.size === 1 && closeToTray.hides(event, host)) return;
      if (!mayClose(host)) {
        event.preventDefault();
        return;
      }
      if (!savedText.has(window) && window.webContents.executeJavaScript) {
        event.preventDefault();
        if (!flushingText) {
          flushingText = true;
          window.webContents
            .executeJavaScript("window.__elpisFlushLoveSpot?.() ?? true")
            .then(saved => {
              if (saved !== false && !window.isDestroyed()) {
                savedText.add(window);
                window.close();
              }
            })
            .catch(error => console.error("Could not save before closing:", error))
            .finally(() => {
              flushingText = false;
            });
        }
        return;
      }
      dispose();
    });
    window.on("closed", () => {
      dispose();
      windows.delete(window);
      openers.delete(window);
      onClosed?.(window);
      if (!windows.size) closeToTray.closed();
    });
    const target = new URL(url);
    if (loveSpot) target.pathname = "/love-spot.html";
    // The standalone Love Spot (its own app and home) offers only the routes it may use; see bridge/love-spot-talk.mts.
    if (loveSpot && loveSpotApp) target.searchParams.set("app", "love-spot");
    if (workflows) target.searchParams.set("workspace", "canvas");
    if (threadId || newSession) target.searchParams.set("session", threadId || "");
    await window.loadURL(target.href);
    return window;
  }
  const flushText = async () => {
    const hosts = [...windows].filter(host => !host.isDestroyed());
    const results = await Promise.all(
      hosts.map(async host => {
        const saved = await host.webContents.executeJavaScript?.("window.__elpisFlushLoveSpot?.() ?? true");
        return saved !== false;
      }),
    );
    const saved = results.every(Boolean);
    if (saved) for (const host of hosts) savedText.add(host);
    return saved;
  };
  return {
    open,
    openLoveSpot,
    openWorkflows,
    windows,
    flushText,
    cancelQuit: () => {
      for (const host of windows) savedText.delete(host);
    },
    openersFor: (host: BrowserWindow | undefined) => (host ? openers.get(host) : undefined),
    closeBrowser: browsers.drop,
    flushBrowsers: browsers.flush,
  };
}
const sessionWindowMenuImpl = (open: () => Promise<unknown>) => ({
  label: "New Session in New Window",
  accelerator: "CommandOrControl+Shift+N",
  click: () => {
    void open();
  },
});
export declare const createSessionWindows: typeof createSessionWindowsImpl;
export declare const sessionWindowMenu: typeof sessionWindowMenuImpl;
module.exports = { createSessionWindows: createSessionWindowsImpl, sessionWindowMenu: sessionWindowMenuImpl };
