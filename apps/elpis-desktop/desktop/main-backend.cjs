'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startBrowserAgentSocket } = require('./browser-agent.cjs');
const { closeNeedsConfirmation, seedShippedDefaults } = require('./preferences.cts');
const { createSessionWindows } = require('./session-windows.cjs');
const { createSleepBlocker } = require('./sleep-blocker.cts');

/**
 * @typedef {{
 *   url: string,
 *   automationAccess?: unknown,
 *   canRestart?: () => Promise<boolean> | boolean,
 *   close: () => Promise<void> | void
 * }} MainServer
 */
/**
 * @typedef {{
 *   path: string,
 *   connectionFile: string,
 *   scope: (id: string) => unknown,
 *   rebind: (from: string, to: string) => void,
 *   revoke: (id: string) => void,
 *   close: () => Promise<void> | void
 * }} BrowserAgentSocket
 */
/** @typedef {ReturnType<typeof import('./state.cts').createStateStore>} StateStore */
/**
 * @typedef {{
 *   loveSpot?: boolean,
 *   workflows?: boolean,
 *   threads: { queue: (id: string | null) => void },
 *   newChats: { queue: (text: string) => void }
 * }} WindowOpeners
 */
/**
 * @typedef {{
 *   windows: Set<import('electron').BrowserWindow>,
 *   openersFor: (host: import('electron').BrowserWindow | undefined) => WindowOpeners | undefined,
 *   open: (options?: { newSession?: boolean, loveSpot?: boolean, workflows?: boolean, onPrimary?: (openers: WindowOpeners) => void }) => Promise<import('electron').BrowserWindow>,
 *   openLoveSpot: () => Promise<import('electron').BrowserWindow>,
 *   openWorkflows: () => Promise<import('electron').BrowserWindow>,
 *   closeBrowser: (id: string) => void,
 *   flushText: () => Promise<boolean> | boolean,
 *   flushBrowsers: () => Promise<void> | void,
 *   cancelQuit?: () => void
 * }} SessionWindows
 */
/**
 * @typedef {{
 *   start: (shortcut: string) => Promise<unknown>,
 *   toggle: () => Promise<unknown> | void,
 *   flush?: () => Promise<unknown> | void,
 *   cancelQuit?: () => void,
 *   dispose?: () => void
 * }} QuickEntry
 */
/** @typedef {{ dispose?: () => void }} ScreenshotPopup */
/**
 * @typedef {{
 *   getServer: () => MainServer | undefined,
 *   setServer: (value: MainServer | undefined) => void,
 *   getBrowserAgentSocket: () => BrowserAgentSocket | undefined,
 *   setBrowserAgentSocket: (value: BrowserAgentSocket | undefined) => void,
 *   isClosing: () => boolean,
 *   setClosing: (value: boolean) => void,
 *   getStore: () => StateStore | undefined,
 *   setStore: (value: StateStore | undefined) => void,
 *   getPrimaryOpeners: () => WindowOpeners | undefined,
 *   setPrimaryOpeners: (value: WindowOpeners | undefined) => void,
 *   getSessionWindows: () => SessionWindows | undefined,
 *   setSessionWindows: (value: SessionWindows | undefined) => void,
 *   getTray: () => import('electron').Tray | undefined,
 *   getQuickEntry: () => QuickEntry | undefined,
 *   getScreenshotPopup: () => ScreenshotPopup | undefined,
 *   getSleepBlocker: () => { dispose: () => void } | undefined,
 *   setSleepBlocker: (value: { dispose: () => void } | undefined) => void,
 *   setDarkTheme: (value: boolean) => void,
 *   takeInitialThread: () => string | null
 * }} MainState
 */

/**
 * @param {{
 *   electron: typeof import('electron'),
 *   appDir: string,
 *   state: MainState,
 *   createStateStore: typeof import('./state.cts').createStateStore,
 *   closeToTray: ReturnType<typeof import('./tray.cts').createCloseToTray>,
 *   updates: { setRunningEngine: (engine: string) => void } & Record<string, unknown>
 * }} options
 */
function createMainBackend({ electron, appDir, state, createStateStore, closeToTray, updates }) {
  const { app, dialog, powerSaveBlocker } = electron;
  const confirmedClose = new WeakSet();
  /** @type {import('electron').BrowserWindow | undefined} */
  let window;
  /** @type {Promise<void> | null | undefined} */
  let opening;
  /** @type {Promise<import('electron').BrowserWindow> | null | undefined} */
  let openingChat;

  // Settings → General → Confirm before closing. Returns false when the person keeps the window.
  /** @param {import('electron').BrowserWindow | undefined} [host] */
  function mayClose(host = window) {
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
      const browserAgentSocket = /** @type {BrowserAgentSocket} */ (await startBrowserAgentSocket({ connectionFile: path.join(app.getPath('userData'), 'browser-connection.json') }));
      state.setBrowserAgentSocket(browserAgentSocket);
      try {
        // The window opens without waiting for the runtime (24 Oct: a runtime still starting kept the app closed for 20 s).
        const client = await DesktopClient.connect({ background: true, beforeConnect: ensureInstalledRuntime, browserConfig: {
          // Every chat gets the browser tools and, once the app's server is up, the Automations tools (bridge/schedule-mcp.mts).
          forSession: (/** @type {string} */ id) => ({ ...browserMcpConfig(browserAgentSocket.path, undefined, browserAgentSocket.scope(id), browserAgentSocket.connectionFile),
            ...(state.getServer()?.automationAccess ? scheduleMcpConfig(state.getServer()?.automationAccess) : {}) }),
          bind: (/** @type {string} */ from, /** @type {string} */ to) => browserAgentSocket.rebind(from, to),
          close: (/** @type {string} */ id) => { browserAgentSocket.revoke(id); state.getSessionWindows()?.closeBrowser(id); },
        } });
        state.setSleepBlocker(createSleepBlocker({ powerSaveBlocker, client, store }));
        // A connected terminal may keep the previous bridge and engine alive after an install.
        const noteEngine = () => { try { updates.setRunningEngine(JSON.parse(fs.readFileSync(path.join(path.dirname(existingSocket()), 'state.json'), 'utf8')).engine); } catch {} };
        client.on('event', (/** @type {{ type?: string, data?: { connected?: boolean } }} */ event) => { if (event.type === 'connection' && event.data?.connected) noteEngine(); });
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
      const server = /** @type {MainServer} */ (state.getServer());
      /** @type {SessionWindows} */
      const sessionWindows = createSessionWindows({ electron, url: server.url, store: state.getStore(), browserAgentSocket: state.getBrowserAgentSocket(), quickEntry: state.getQuickEntry(), screenshotPopup: state.getScreenshotPopup(), closeToTray, updates,
        mayClose, quitting: () => state.isClosing(), onDark: (/** @type {boolean} */ dark) => state.setDarkTheme(dark),
        onClosed: (/** @type {import('electron').BrowserWindow} */ host) => { if (window === host) { window = [...sessionWindows.windows].find(item => !sessionWindows.openersFor(item)?.loveSpot && !sessionWindows.openersFor(item)?.workflows); state.setPrimaryOpeners(sessionWindows.openersFor(window)); } },
        onFocused: (/** @type {import('electron').BrowserWindow} */ host, /** @type {WindowOpeners | undefined} */ openers) => { if (!openers?.loveSpot && !openers?.workflows) { window = host; state.setPrimaryOpeners(openers); } } });
      state.setSessionWindows(sessionWindows);
    }
  }

  /** @param {boolean} [loveSpot] @param {boolean} [workflows] */
  async function openWindow(loveSpot = false, workflows = false) {
    if (!opening) opening = prepareWindows().finally(() => { opening = null; });
    await opening;
    const sessionWindows = /** @type {SessionWindows} */ (state.getSessionWindows());
    if (loveSpot) return sessionWindows.openLoveSpot();
    if (workflows) return sessionWindows.openWorkflows();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    } else {
      if (!openingChat) openingChat = sessionWindows.open({ onPrimary: (/** @type {WindowOpeners} */ openers) => state.setPrimaryOpeners(openers) }).finally(() => { openingChat = null; });
      window = await openingChat;
    }
    const initialThread = state.takeInitialThread();
    if (initialThread) state.getPrimaryOpeners()?.threads.queue(initialThread);
  }

  return { mayClose, prepareWindows, openWindow };
}

module.exports = { createMainBackend };
