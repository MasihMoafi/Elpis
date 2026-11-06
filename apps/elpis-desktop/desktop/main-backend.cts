'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { pathToFileURL }: typeof import('node:url') = require('node:url');
const { startBrowserAgentSocket }: typeof import('./browser-agent.cjs') = require('./browser-agent.cjs');
const { closeNeedsConfirmation, seedShippedDefaults }: typeof import('./preferences.cts') = require('./preferences.cts');
const { createSessionWindows }: typeof import('./session-windows.cjs') = require('./session-windows.cjs');
const { createSleepBlocker }: typeof import('./sleep-blocker.cts') = require('./sleep-blocker.cts');

export type MainServer = {
    url: string,
    automationAccess?: unknown,
    canRestart?: () => Promise<boolean> | boolean,
    close: () => Promise<void> | void
};
export type BrowserAgentSocket = {
    path: string,
    connectionFile: string,
    scope: (id: string) => unknown,
    rebind: (from: string, to: string) => void,
    revoke: (id: string) => void,
    close: () => Promise<void> | void
};
export type StateStore = ReturnType<typeof import('./state.cts').createStateStore>;
export type WindowOpeners = {
    loveSpot?: boolean,
    workflows?: boolean,
    threads: { queue: (id: string | null) => void },
    newChats: { queue: (text: string) => void }
};
export type SessionWindows = {
    windows: Set<import('electron').BrowserWindow>,
    openersFor: (host: import('electron').BrowserWindow | undefined) => WindowOpeners | undefined,
    open: (options?: { newSession?: boolean, loveSpot?: boolean, workflows?: boolean, onPrimary?: (openers: WindowOpeners) => void }) => Promise<import('electron').BrowserWindow>,
    openLoveSpot: () => Promise<import('electron').BrowserWindow>,
    openWorkflows: () => Promise<import('electron').BrowserWindow>,
    closeBrowser: (id: string) => void,
    flushText: () => Promise<boolean> | boolean,
    flushBrowsers: () => Promise<void> | void,
    cancelQuit?: () => void
};
export type QuickEntry = {
    start: (shortcut: string) => Promise<unknown>,
    toggle: () => Promise<unknown> | void,
    flush?: () => Promise<unknown> | void,
    cancelQuit?: () => void,
    dispose?: () => void
};
export type ScreenshotPopup = { dispose?: () => void };
export type MainState = {
    getServer: () => MainServer | undefined,
    setServer: (value: MainServer | undefined) => void,
    getBrowserAgentSocket: () => BrowserAgentSocket | undefined,
    setBrowserAgentSocket: (value: BrowserAgentSocket | undefined) => void,
    isClosing: () => boolean,
    setClosing: (value: boolean) => void,
    getStore: () => StateStore | undefined,
    setStore: (value: StateStore | undefined) => void,
    getPrimaryOpeners: () => WindowOpeners | undefined,
    setPrimaryOpeners: (value: WindowOpeners | undefined) => void,
    getSessionWindows: () => SessionWindows | undefined,
    setSessionWindows: (value: SessionWindows | undefined) => void,
    getTray: () => import('electron').Tray | undefined,
    getQuickEntry: () => QuickEntry | undefined,
    getScreenshotPopup: () => ScreenshotPopup | undefined,
    getSleepBlocker: () => { dispose: () => void } | undefined,
    setSleepBlocker: (value: { dispose: () => void } | undefined) => void,
    setDarkTheme: (value: boolean) => void,
    takeInitialThread: () => string | null
};

function createMainBackendImpl({ electron, appDir, state, createStateStore, closeToTray, updates }: {
    electron: typeof import('electron'),
    appDir: string,
    state: MainState,
    createStateStore: typeof import('./state.cts').createStateStore,
    closeToTray: ReturnType<typeof import('./tray.cts').createCloseToTray>,
    updates: { setRunningEngine: (engine: string) => void } & Record<string, unknown>
}) {
  const { app, dialog, powerSaveBlocker } = electron;
  const confirmedClose = new WeakSet<import('electron').BrowserWindow>();
  let window: import('electron').BrowserWindow | undefined;
  let opening: Promise<void> | null | undefined;
  let openingChat: Promise<import('electron').BrowserWindow> | null | undefined;

  // Settings → General → Confirm before closing. Returns false when the person keeps the window.
  function mayClose(host: import('electron').BrowserWindow | undefined = window) {
    const store = state.getStore();
    if (!host || confirmedClose.has(host) || host.isDestroyed() || !store || !closeNeedsConfirmation(store)) return true;
    if (!host.isVisible()) host.show(); // Quit from the tray asks over the window, not a hidden one.
    const choice = dialog.showMessageBoxSync(host, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Close Elpis?', message: 'Close Elpis?', detail: 'Running conversations continue in Elpis and stay available when you reopen it.' });
    if (choice === 0) confirmedClose.add(host);
    return choice === 0;
  }

  async function prepareWindows() {
    if (!state.getServer()) {
      let store = state.getStore();
      if (!store) { store = createStateStore(path.join(app.getPath('userData'), 'workspace.json')); state.setStore(store); }
      await seedShippedDefaults(store);
      const { startDesktopServer } = await import(pathToFileURL(path.join(appDir, '../bridge/server.mts')).href);
      const { DesktopClient, existingSocket } = await import(pathToFileURL(path.join(appDir, '../bridge/client.mts')).href);
      const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(appDir, 'runtime.mts')).href);
      const { browserMcpConfig } = await import(pathToFileURL(path.join(appDir, '../bridge/browser-mcp.mjs')).href);
      const { scheduleMcpConfig } = await import(pathToFileURL(path.join(appDir, '../bridge/schedule-mcp.mts')).href);
      const browserAgentSocket = (await startBrowserAgentSocket({ connectionFile: path.join(app.getPath('userData'), 'browser-connection.json') })) as BrowserAgentSocket;
      state.setBrowserAgentSocket(browserAgentSocket);
      try {
        // The window opens without waiting for the runtime (24 Oct: a runtime still starting kept the app closed for 20 s).
        const client = await DesktopClient.connect({ background: true, beforeConnect: ensureInstalledRuntime, browserConfig: {
          // Every chat gets the browser tools and, once the app's server is up, the Automations tools (bridge/schedule-mcp.mts).
          forSession: (id: string) => ({ ...browserMcpConfig(browserAgentSocket.path, undefined, browserAgentSocket.scope(id), browserAgentSocket.connectionFile),
            ...(state.getServer()?.automationAccess ? scheduleMcpConfig(state.getServer()?.automationAccess) : {}) }),
          bind: (from: string, to: string) => browserAgentSocket.rebind(from, to),
          close: (id: string) => { browserAgentSocket.revoke(id); state.getSessionWindows()?.closeBrowser(id); },
        } });
        state.setSleepBlocker(createSleepBlocker({ powerSaveBlocker, client, store }));
        // A connected terminal may keep the previous bridge and engine alive after an install.
        const noteEngine = () => { try { updates.setRunningEngine(JSON.parse(fs.readFileSync(path.join(path.dirname(existingSocket()), 'state.json'), 'utf8')).engine); } catch {} };
        client.on('event', (event: { type?: string, data?: { connected?: boolean } }) => { if (event.type === 'connection' && event.data?.connected) noteEngine(); });
        // Chats deleted from the sidebar wait in this file until the app quits (Ctrl+Z brings them back until then).
        try { state.setServer(await startDesktopServer({ client, staticDir: path.join(appDir, '../out'), trashFile: path.join(app.getPath('userData'), 'deleted-chats.json'), automations: true })); }
        catch (error) { client.close(); throw error; }
      } catch (error) {
        state.getSleepBlocker()?.dispose(); state.setSleepBlocker(undefined);
        await browserAgentSocket.close(); state.setBrowserAgentSocket(undefined);
        throw error;
      }
    }
    if (!state.getSessionWindows()) {
      const server = state.getServer() as MainServer;
      const sessionWindows: SessionWindows = createSessionWindows({ electron, url: server.url, store: state.getStore(), browserAgentSocket: state.getBrowserAgentSocket(), quickEntry: state.getQuickEntry(), screenshotPopup: state.getScreenshotPopup(), closeToTray, updates,
        mayClose, quitting: () => state.isClosing(), onDark: (dark: boolean) => state.setDarkTheme(dark),
        onClosed: (host: import('electron').BrowserWindow) => { if (window === host) { window = [...sessionWindows.windows].find(item => !sessionWindows.openersFor(item)?.loveSpot && !sessionWindows.openersFor(item)?.workflows); state.setPrimaryOpeners(sessionWindows.openersFor(window)); } },
        onFocused: (host: import('electron').BrowserWindow, openers: WindowOpeners | undefined) => { if (!openers?.loveSpot && !openers?.workflows) { window = host; state.setPrimaryOpeners(openers); } } });
      state.setSessionWindows(sessionWindows);
    }
  }

  async function openWindow(loveSpot = false, workflows = false) {
    if (!opening) opening = prepareWindows().finally(() => { opening = null; });
    await opening;
    const sessionWindows = state.getSessionWindows() as SessionWindows;
    if (loveSpot) return sessionWindows.openLoveSpot();
    if (workflows) return sessionWindows.openWorkflows();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    } else {
      if (!openingChat) openingChat = sessionWindows.open({ onPrimary: (openers: WindowOpeners) => state.setPrimaryOpeners(openers) }).finally(() => { openingChat = null; });
      window = await openingChat;
    }
    const initialThread = state.takeInitialThread();
    if (initialThread) state.getPrimaryOpeners()?.threads.queue(initialThread);
  }

  return { mayClose, prepareWindows, openWindow };
}

export declare const createMainBackend: typeof createMainBackendImpl;
module.exports = { createMainBackend: createMainBackendImpl };
