'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startBrowserAgentSocket } = require('./browser-agent.cjs');
const { closeNeedsConfirmation, closesToTray, quickEntryShortcut } = require('./preferences.cjs');
const { createStateStore } = require('./state.cjs');
const { openThreadArgument } = require('./open-thread.cjs');
const { createTray, createCloseToTray } = require('./tray.cjs');
const { startQuickEntry } = require('./quick-entry.cjs');
const { createSessionWindows, sessionWindowMenu } = require('./session-windows.cjs');
const { enableWaylandIme } = require('./wayland-ime.cjs');

// The renderer gets only the loopback app, never Node or filesystem access.
let server;
let browserAgentSocket;
let window;
let closing = false;
let opening;
let openingChat;
let store;
const confirmedClose = new WeakSet();
// The chat the Elpis TUI's /app asked for (`--open-thread <id>`), at start-up or from a second launch.
let initialThread = openThreadArgument(process.argv);
let primaryOpeners;
let sessionWindows;
let tray, quickEntry, darkTheme = true; // `tray` stays referenced so it is not collected.
// The Elpis website's mark: the window, the .desktop launcher and the tray.
const ICON = path.join(__dirname, 'elpis-icon.png');
// Settings → General → Close to tray, off by default: closing the window quits. On, it hides and the tray keeps Elpis.
const closeToTray = createCloseToTray({ app, enabled: () => !!store && closesToTray(store), quitting: () => closing });
// Settings → General → Confirm before closing. Returns false when the person keeps the window.
function mayClose(host = window) {
  if (!host || confirmedClose.has(host) || host.isDestroyed() || !store || !closeNeedsConfirmation(store)) return true;
  if (!host.isVisible()) host.show(); // Quit from the tray asks over the window, not a hidden one.
  const choice = dialog.showMessageBoxSync(host, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Close Elpis?', message: 'Close Elpis?', detail: 'Running conversations continue in Elpis and stay available when you reopen it.' });
  if (choice === 0) confirmedClose.add(host);
  return choice === 0;
}

async function openWindow(loveSpot = false) {
  if (!opening) opening = prepareWindows().finally(() => { opening = null; });
  await opening;
  if (loveSpot) return sessionWindows.openLoveSpot();
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  } else {
    if (!openingChat) openingChat = sessionWindows.open({ onPrimary: openers => { primaryOpeners = openers; } }).finally(() => { openingChat = null; });
    window = await openingChat;
  }
  if (initialThread) { primaryOpeners.threads.queue(initialThread); initialThread = null; }
}

async function prepareWindows() {
  if (!server) {
    const { startDesktopServer } = await import(pathToFileURL(path.join(__dirname, '../bridge/server.mjs')).href);
    const { DesktopClient } = await import(pathToFileURL(path.join(__dirname, '../bridge/client.mjs')).href);
    const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(__dirname, 'runtime.mjs')).href);
    const { browserMcpConfig } = await import(pathToFileURL(path.join(__dirname, '../bridge/browser-mcp.mjs')).href);
    browserAgentSocket = await startBrowserAgentSocket();
    try {
      const client = await DesktopClient.connect({ beforeConnect: ensureInstalledRuntime, browserConfig: browserMcpConfig(browserAgentSocket.path) });
      // Chats deleted from the sidebar wait in this file until the app quits (Ctrl+Z brings them back until then).
      try { server = await startDesktopServer({ client, staticDir: path.join(__dirname, '../out'), trashFile: path.join(app.getPath('userData'), 'deleted-chats.json') }); }
      catch (error) { client.close(); throw error; }
    } catch (error) { await browserAgentSocket.close(); browserAgentSocket = undefined; throw error; }
  }
  if (!sessionWindows) {
    store = createStateStore(path.join(app.getPath('userData'), 'workspace.json'));
    sessionWindows = createSessionWindows({ electron: require('electron'), url: server.url, store, browserAgentSocket, quickEntry, closeToTray, improvements: server.improvements,
      mayClose, onDark: dark => { darkTheme = dark; }, onClosed: host => { if (window === host) { window = [...sessionWindows.windows].find(host => !sessionWindows.openersFor(host)?.loveSpot); primaryOpeners = sessionWindows.openersFor(window); } },
      onFocused: (host, openers) => { if (!openers?.loveSpot) { window = host; primaryOpeners = openers; } } });
  }
}

// WM_CLASS comes from package.json "name" (elpis-desktop) when launched as the app directory;
// elpis-desktop.desktop.in sets StartupWMClass=elpis-desktop to match, so docks show the Elpis icon.
// --love-spot-app (the Love Spot dock icon): Love Spot as its own app, so its window groups under that icon. Wayland
// takes the app id from the desktop name; its own profile gives it its own single-instance lock.
const loveSpotApp = process.argv.includes('--love-spot-app');
app.setName(loveSpotApp ? 'Love Spot' : 'Elpis');
if (loveSpotApp) app.setDesktopName('excalidraw.desktop');
app.setPath('userData', process.env.ELPIS_DESKTOP_PROFILE || path.join(app.getPath('appData'), loveSpotApp ? 'Elpis Love Spot' : 'Elpis'));
enableWaylandIme(app.commandLine, process.env);
// Wayland gives apps global shortcuts only through the desktop portal; Claude's app turns on Chromium's portal support the same way.
app.commandLine.appendSwitch('enable-features', [app.commandLine.getSwitchValue('enable-features'), 'GlobalShortcutsPortal'].filter(Boolean).join(','));
if (!app.requestSingleInstanceLock({ openThread: openThreadArgument(process.argv), loveSpot: process.argv.includes('--love-spot') })) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, data) => {
    const loveSpot = loveSpotApp || data?.loveSpot === true || argv.includes('--love-spot');
    void openWindow(loveSpot).then(() => { if (!loveSpot) primaryOpeners.threads.queue(data?.openThread ?? openThreadArgument(argv)); }).catch(showStartupError);
  });
  app.whenReady().then(async () => {
    // Built once: rebuilding an unchanged menu redraws the Linux menu row (Cloudroom's flicker).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [sessionWindowMenu(() => sessionWindows.open({ newSession: true }).catch(showStartupError)), { role: 'close' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    if (loveSpotApp) return void await openWindow(true);
    const showWindow = () => void openWindow().catch(showStartupError);
    quickEntry = startQuickEntry({ app, globalShortcut, BrowserWindow, screen, ipcMain, dark: () => darkTheme,
      onSubmit: text => { void openWindow().then(() => primaryOpeners.newChats.queue(text)).catch(showStartupError); } });
    await openWindow(process.argv.includes('--love-spot'));
    await quickEntry.start(quickEntryShortcut(store));
    tray = createTray({ Tray, Menu, nativeImage, icon: ICON, actions: {
      open: showWindow, newChat: () => { void openWindow().then(() => primaryOpeners.newChats.queue('')).catch(showStartupError); }, quickEntry: () => void quickEntry.toggle(), quit: () => app.quit(),
    } });
  }).catch(showStartupError);
  app.on('activate', () => { void openWindow(loveSpotApp).catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server || closing) return;
    event.preventDefault();
    if (sessionWindows && ![...sessionWindows.windows].every(host => mayClose(host))) return;
    closing = true;
    // The renderer must save live text while its board server is still open.
    Promise.resolve(sessionWindows?.flushText()).then(async saved => {
      if (saved === false) { closing = false; return; }
      await Promise.all([store?.flush(), server.close(), browserAgentSocket?.close()]);
      app.quit();
    }).catch(error => { closing = false; console.error('Could not save before quitting:', error); });
  });
}

function showStartupError(error) {
  console.error('Elpis startup failed:', error?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(error?.message || error));
  app.quit();
}
