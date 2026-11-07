'use strict';

require('./output-errors.cts');

const electron: typeof import('electron') = require('electron');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, dialog } = electron;
const path = require('node:path');
const { closesToTray, quickEntryShortcut }: typeof import('./preferences.cts') = require('./preferences.cts');
const { createStateStore }: typeof import('./state.cts') = require('./state.cts');
const { openThreadArgument }: typeof import('./open-thread.cts') = require('./open-thread.cts');
const { createTray, createCloseToTray }: typeof import('./tray.cts') = require('./tray.cts');
const { startQuickEntry }: typeof import('./quick-entry.cts') = require('./quick-entry.cts');
const { createScreenshotPopup }: typeof import('./screenshot-popup.cts') = require('./screenshot-popup.cts');
const { createAppMenu }: typeof import('./app-menu.cts') = require('./app-menu.cts');
const { createAppUpdates, executableLauncher }: typeof import('./app-updates.cts') = require('./app-updates.cts');
const { configureMainProfile }: typeof import('./main-profile.cts') = require('./main-profile.cts');
const { createMainBackend }: typeof import('./main-backend.cts') = require('./main-backend.cts');
const { createMainQuit }: typeof import('./main-quit.cts') = require('./main-quit.cts');

// The renderer gets only the loopback app, never Node or filesystem access.
let server: import('./main-backend.cts').MainServer | undefined;
let browserAgentSocket: import('./main-backend.cts').BrowserAgentSocket | undefined;
let closing = false;
let store: import('./main-backend.cts').StateStore | undefined;
let primaryOpeners: import('./main-backend.cts').WindowOpeners | undefined;
let sessionWindows: import('./main-backend.cts').SessionWindows | undefined;
let tray: import('electron').Tray | undefined;
let quickEntry: import('./main-backend.cts').QuickEntry | undefined;
let screenshotPopup: import('./main-backend.cts').ScreenshotPopup | undefined;
let darkTheme = true;
let sleepBlocker: { dispose: () => void } | undefined; // `tray` stays referenced so it is not collected.
// The Elpis website's mark: the window, the .desktop launcher and the tray.
const ICON = path.join(__dirname, 'elpis-icon.png');
const profile = configureMainProfile({ app, argv: process.argv, env: process.env });
const { loveSpotApp, workflowsApp } = profile;
// The chat the Elpis TUI's /app asked for (`--open-thread <id>`), at start-up or from a second launch.
let initialThread = profile.initialThread;
// Settings → General → Close to tray, off by default: closing the window quits. On, it hides and the tray keeps Elpis.
const closeToTray = createCloseToTray({ app, enabled: () => !!store && closesToTray(store), quitting: () => closing });
const updates = createAppUpdates({ app, runningApp: path.resolve(__dirname, '..'), restart: async (target: string) => {
  if (!await quitApp(target)) throw Error('Restart cancelled. Your windows and drafts are kept open.');
} });
const state: import('./main-backend.cts').MainState = {
  getServer: () => server, setServer: value => { server = value; },
  getBrowserAgentSocket: () => browserAgentSocket, setBrowserAgentSocket: value => { browserAgentSocket = value; },
  isClosing: () => closing, setClosing: value => { closing = value; },
  getStore: () => store, setStore: value => { store = value; },
  getPrimaryOpeners: () => primaryOpeners, setPrimaryOpeners: value => { primaryOpeners = value; },
  getSessionWindows: () => sessionWindows, setSessionWindows: value => { sessionWindows = value; },
  getTray: () => tray, getQuickEntry: () => quickEntry, getScreenshotPopup: () => screenshotPopup,
  getSleepBlocker: () => sleepBlocker, setSleepBlocker: value => { sleepBlocker = value; },
  setDarkTheme: value => { darkTheme = value; },
  takeInitialThread: () => { const value = initialThread; initialThread = null; return value; },
};
const { mayClose, prepareWindows, openWindow } = createMainBackend({ electron, appDir: __dirname, state, createStateStore, closeToTray, updates, loveSpotApp });
const { quitApp, isQuitting } = createMainQuit({ app, loveSpotApp, workflowsApp, executableLauncher, mayClose, state });

if (!app.requestSingleInstanceLock(profile.lockData)) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, rawData) => {
    const data = rawData as { loveSpot?: boolean; workflows?: boolean; openThread?: string | null } | undefined;
    const loveSpot = loveSpotApp || data?.loveSpot === true || argv.includes('--love-spot');
    const workflows = workflowsApp || data?.workflows === true || argv.includes('--workflows');
    void openWindow(loveSpot, workflows).then(() => { if (!loveSpot && !workflows) primaryOpeners?.threads.queue(data?.openThread ?? openThreadArgument(argv)); }).catch(showStartupError);
  });
  app.whenReady().then(async () => {
    // Built once: rebuilding an unchanged menu redraws the Linux menu row (Cloudroom's flicker).
    const appMenu = createAppMenu({ ipcMain, windows: () => sessionWindows?.windows ?? [], origin: () => server && new URL(server.url).origin,
      newWindow: async () => { await prepareWindows(); await sessionWindows?.open({ newSession: true }); }, quit: () => quitApp() });
    Menu.setApplicationMenu(Menu.buildFromTemplate(([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      ...appMenu.template(),
    ] as import('electron').MenuItemConstructorOptions[])));
    if (loveSpotApp) return void await openWindow(true);
    if (workflowsApp) return void await openWindow(false, true);
    const showWindow = () => void openWindow().catch(showStartupError);
    screenshotPopup = createScreenshotPopup({ BrowserWindow, screen, ipcMain, dark: () => darkTheme });
    const activeQuickEntry = startQuickEntry({ app, globalShortcut, BrowserWindow, screen, ipcMain, dark: () => darkTheme,
      drafts: { read: () => (store?.read() as Record<string, string | undefined> | undefined)?.['elpis-draft-v1:quick-entry'] ?? '', save: (text: string) => store?.set('elpis-draft-v1:quick-entry', text) },
      onSubmit: (text: string) => { void openWindow().then(() => primaryOpeners?.newChats.queue(text)).catch(showStartupError); } });
    quickEntry = activeQuickEntry;
    await openWindow(process.argv.includes('--love-spot'), process.argv.includes('--workflows'));
    await activeQuickEntry.start(quickEntryShortcut(store));
    tray = createTray({ Tray, Menu, nativeImage, icon: ICON, actions: {
      open: showWindow, newChat: () => { void openWindow().then(() => primaryOpeners?.newChats.queue('')).catch(showStartupError); }, quickEntry: () => void activeQuickEntry.toggle(), quit: () => app.quit(),
    } });
  }).catch(showStartupError);
  app.on('activate', () => { void openWindow(loveSpotApp, workflowsApp).catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server || closing) return;
    event.preventDefault();
    if (isQuitting()) return;
    void quitApp().catch((error: unknown) => {
      console.error('Could not save before quitting:', error);
      dialog.showErrorBox('Elpis is still open', error instanceof Error ? error.message : String(error));
    });
  });
}

function showStartupError(error: unknown) {
  const err = error as { stack?: string; message?: string } | null | undefined;
  console.error('Elpis startup failed:', err?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(err?.message || error));
  app.quit();
}
