'use strict';

const electron = require('electron');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, dialog } = electron;
const path = require('node:path');
const { closesToTray, quickEntryShortcut } = require('./preferences.cjs');
const { createStateStore } = require('./state.cts');
const { openThreadArgument } = require('./open-thread.cjs');
const { createTray, createCloseToTray } = require('./tray.cts');
const { startQuickEntry } = require('./quick-entry.cjs');
const { createScreenshotPopup } = require('./screenshot-popup.cjs');
const { createAppMenu } = require('./app-menu.cjs');
const { createAppUpdates, executableLauncher } = require('./app-updates.cjs');
const { configureMainProfile } = require('./main-profile.cjs');
const { createMainBackend } = require('./main-backend.cjs');
const { createMainQuit } = require('./main-quit.cjs');

// The renderer gets only the loopback app, never Node or filesystem access.
let server;
let browserAgentSocket;
let closing = false;
let store;
let primaryOpeners;
let sessionWindows;
let tray, quickEntry, screenshotPopup, darkTheme = true, sleepBlocker; // `tray` stays referenced so it is not collected.
// The Elpis website's mark: the window, the .desktop launcher and the tray.
const ICON = path.join(__dirname, 'elpis-icon.png');
const profile = configureMainProfile({ app, argv: process.argv, env: process.env });
const { loveSpotApp, workflowsApp } = profile;
// The chat the Elpis TUI's /app asked for (`--open-thread <id>`), at start-up or from a second launch.
let initialThread = profile.initialThread;
// Settings → General → Close to tray, off by default: closing the window quits. On, it hides and the tray keeps Elpis.
const closeToTray = createCloseToTray({ app, enabled: () => !!store && closesToTray(store), quitting: () => closing });
const updates = createAppUpdates({ app, runningApp: path.resolve(__dirname, '..'), restart: async target => {
  if (!await quitApp(target)) throw Error('Restart cancelled. Your windows and drafts are kept open.');
} });
const state = {
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
const { mayClose, prepareWindows, openWindow } = createMainBackend({ electron, appDir: __dirname, state, createStateStore, closeToTray, updates });
const { quitApp, isQuitting } = createMainQuit({ app, loveSpotApp, workflowsApp, executableLauncher, mayClose, state });

if (!app.requestSingleInstanceLock(profile.lockData)) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, data) => {
    const loveSpot = loveSpotApp || data?.loveSpot === true || argv.includes('--love-spot');
    const workflows = workflowsApp || data?.workflows === true || argv.includes('--workflows');
    void openWindow(loveSpot, workflows).then(() => { if (!loveSpot && !workflows) primaryOpeners.threads.queue(data?.openThread ?? openThreadArgument(argv)); }).catch(showStartupError);
  });
  app.whenReady().then(async () => {
    // Built once: rebuilding an unchanged menu redraws the Linux menu row (Cloudroom's flicker).
    const appMenu = createAppMenu({ ipcMain, windows: () => sessionWindows?.windows ?? [], origin: () => server && new URL(server.url).origin,
      newWindow: async () => { await prepareWindows(); await sessionWindows.open({ newSession: true }); }, quit: () => quitApp() });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      ...appMenu.template(),
    ]));
    if (loveSpotApp) return void await openWindow(true);
    if (workflowsApp) return void await openWindow(false, true);
    const showWindow = () => void openWindow().catch(showStartupError);
    screenshotPopup = createScreenshotPopup({ BrowserWindow, screen, ipcMain, dark: () => darkTheme });
    quickEntry = startQuickEntry({ app, globalShortcut, BrowserWindow, screen, ipcMain, dark: () => darkTheme,
      drafts: { read: () => store?.read()['elpis-draft-v1:quick-entry'] ?? '', save: text => store.set('elpis-draft-v1:quick-entry', text) },
      onSubmit: text => { void openWindow().then(() => primaryOpeners.newChats.queue(text)).catch(showStartupError); } });
    await openWindow(process.argv.includes('--love-spot'), process.argv.includes('--workflows'));
    await quickEntry.start(quickEntryShortcut(store));
    tray = createTray({ Tray, Menu, nativeImage, icon: ICON, actions: {
      open: showWindow, newChat: () => { void openWindow().then(() => primaryOpeners.newChats.queue('')).catch(showStartupError); }, quickEntry: () => void quickEntry.toggle(), quit: () => app.quit(),
    } });
  }).catch(showStartupError);
  app.on('activate', () => { void openWindow(loveSpotApp, workflowsApp).catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server || closing) return;
    event.preventDefault();
    if (isQuitting()) return;
    void quitApp().catch(error => { console.error('Could not save before quitting:', error); dialog.showErrorBox('Elpis is still open', error.message); });
  });
}

function showStartupError(error) {
  console.error('Elpis startup failed:', error?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(error?.message || error));
  app.quit();
}
