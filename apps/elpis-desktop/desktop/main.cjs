'use strict';

const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, dialog, shell, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBrowser } = require('./browser.cjs');
const { startBrowserAgentSocket } = require('./browser-agent.cjs');
const { appPermission } = require('./media-policy.cjs');
const { closeNeedsConfirmation, closesToTray, quickEntryShortcut } = require('./preferences.cjs');
const { createStateStore, registerState } = require('./state.cjs');
const { registerFiles } = require('./files.cjs');
const { attachContextMenu } = require('./context-menu.cjs');
const { registerTerminal } = require('./terminal.cjs');
const { openThreadArgument, createThreadOpener, createNewChatOpener } = require('./open-thread.cjs');
const { createTray, createCloseToTray } = require('./tray.cjs');
const { startQuickEntry } = require('./quick-entry.cjs');
const { registerTheme } = require('./theme.cjs');

// The renderer gets only the loopback app, never Node or filesystem access.
let server;
let browserAgentSocket;
let window;
let closing = false;
let opening;
let store;
let closeConfirmed = false;
// The chat the Elpis TUI's /app asked for (`--open-thread <id>`), at start-up or from a second launch.
const threads = createThreadOpener(openThreadArgument(process.argv));
// A new chat from Quick Entry (with its text) or the tray's New chat; the tray and Quick Entry start once the window is up.
const newChats = createNewChatOpener();
let tray, quickEntry, darkTheme = true; // `tray` stays referenced so it is not collected.
// The Elpis website's mark: the window, the .desktop launcher and the tray.
const ICON = path.join(__dirname, 'elpis-icon.png');
// Settings → General → Close to tray, off by default: closing the window quits. On, it hides and the tray keeps Elpis.
const closeToTray = createCloseToTray({ app, enabled: () => !!store && closesToTray(store), quitting: () => closing });
// As in the ChatGPT app on Linux: no system title bar (white under a light system theme); the app draws its own
// 36px bar in its sidebar colour and the window buttons sit over its right end. Everything is shown 10% larger.
const ZOOM = 1.1;
const TITLE_BAR = { dark: { color: '#0d0e11', symbolColor: '#e6e0d3' }, light: { color: '#f2f2f1', symbolColor: '#252524' } };

// Settings → General → Confirm before closing. Returns false when the person keeps the window.
function mayClose() {
  if (closeConfirmed || !window || window.isDestroyed() || !store || !closeNeedsConfirmation(store)) return true;
  if (!window.isVisible()) window.show(); // Quit from the tray asks over the window, not a hidden one.
  const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Close Elpis?', message: 'Close Elpis?', detail: 'Running conversations continue in Elpis and stay available when you reopen it.' });
  closeConfirmed = choice === 0;
  return closeConfirmed;
}

function openWindow() {
  if (!opening) opening = createOrFocusWindow().finally(() => { opening = null; });
  return opening;
}

async function createOrFocusWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    return;
  }
  if (!server) {
    const { startDesktopServer } = await import(pathToFileURL(path.join(__dirname, '../bridge/server.mjs')).href);
    const { DesktopClient } = await import(pathToFileURL(path.join(__dirname, '../bridge/client.mjs')).href);
    const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(__dirname, 'runtime.mjs')).href);
    const { browserMcpConfig } = await import(pathToFileURL(path.join(__dirname, '../bridge/browser-mcp.mjs')).href);
    browserAgentSocket = await startBrowserAgentSocket();
    try {
      const client = await DesktopClient.connect({ beforeConnect: ensureInstalledRuntime, browserConfig: browserMcpConfig(browserAgentSocket.path) });
      try { server = await startDesktopServer({ client, staticDir: path.join(__dirname, '../out') }); }
      catch (error) { client.close(); throw error; }
    } catch (error) { await browserAgentSocket.close(); browserAgentSocket = undefined; throw error; }
  }
  const origin = new URL(server.url).origin;
  window = new BrowserWindow({
    title: 'Elpis', width: 1320, height: 900, minWidth: 600, minHeight: 480,
    icon: ICON,
    backgroundColor: '#151515', show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { ...TITLE_BAR.dark, height: Math.round(36 * ZOOM) },
    webPreferences: {
      zoomFactor: ZOOM,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const browser = createBrowser({ host: window, origin, WebContentsView, session, ipcMain, Menu, clipboard, openExternal: url => shell.openExternal(url) });
  browserAgentSocket.setAgent(browser.agent);
  store = createStateStore(path.join(app.getPath('userData'), 'workspace.json')); closeConfirmed = false;
  const disposeState = registerState({ host: window, origin, ipcMain, dialog, store });
  const disposeFiles = registerFiles({ host: window, origin, ipcMain, shell });
  const disposeTerminal = registerTerminal({ host: window, origin, ipcMain, clipboard });
  const disposeThreads = threads.attach({ host: window, origin, ipcMain });
  const disposeNewChats = newChats.attach({ host: window, origin, ipcMain });
  const disposeQuickEntry = quickEntry?.attach({ host: window, origin }) ?? (() => {});
  // The app's theme colours the window buttons, Quick Entry, the browser's pages and nativeTheme; only the app's own page may report it.
  const host = window;
  const disposeTheme = registerTheme({ host, ipcMain, nativeTheme, titleBar: TITLE_BAR, browser, onDark: dark => { darkTheme = dark; } });
  // Website permissions are handled by the browser's separate session.
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(appPermission(contents, window, permission, details, origin)));
  window.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) => appPermission(contents, window, permission, details, origin));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  const openInBrowser = url => { try { browser.open(url); } catch { /* Invalid links remain closed. */ } };
  window.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: 'deny' }; });
  const detachContextMenu = attachContextMenu(window.webContents, { Menu, clipboard, openLink: openInBrowser, origin, window });
  window.once('ready-to-show', () => window?.show());
  let disposed = false;
  window.on('close', event => {
    if (closeToTray.hides(event, host)) return;
    if (!mayClose()) { event.preventDefault(); return; }
    if (disposed) return; disposed = true;
    detachContextMenu(); disposeFiles(); disposeTerminal(); disposeThreads(); disposeNewChats(); disposeQuickEntry(); disposeState(); browser.dispose(); disposeTheme();
  });
  window.on('closed', () => { window = undefined; closeToTray.closed(); });
  await window.loadURL(server.url);
}

// WM_CLASS comes from package.json "name" (elpis-desktop) when launched as the app directory;
// elpis-desktop.desktop.in sets StartupWMClass=elpis-desktop to match, so docks show the Elpis icon.
app.setName('Elpis');
app.setPath('userData', path.join(app.getPath('appData'), 'Elpis'));
// Wayland gives apps global shortcuts only through the desktop portal; Claude's app turns on Chromium's portal support the same way.
app.commandLine.appendSwitch('enable-features', [app.commandLine.getSwitchValue('enable-features'), 'GlobalShortcutsPortal'].filter(Boolean).join(','));
if (!app.requestSingleInstanceLock({ openThread: openThreadArgument(process.argv) })) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, data) => { threads.queue(data?.openThread ?? openThreadArgument(argv)); void openWindow().catch(showStartupError); });
  app.whenReady().then(async () => {
    // Built once: rebuilding an unchanged menu redraws the Linux menu row (Cloudroom's flicker).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    const showWindow = () => void openWindow().catch(showStartupError);
    quickEntry = startQuickEntry({ app, globalShortcut, BrowserWindow, screen, ipcMain, dark: () => darkTheme,
      onSubmit: text => { newChats.queue(text); showWindow(); } });
    await openWindow();
    await quickEntry.start(quickEntryShortcut(store));
    tray = createTray({ Tray, Menu, nativeImage, icon: ICON, actions: {
      open: showWindow, newChat: () => { newChats.queue(''); showWindow(); }, quickEntry: () => void quickEntry.toggle(), quit: () => app.quit(),
    } });
  }).catch(showStartupError);
  app.on('activate', () => { void openWindow().catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server || closing) return;
    event.preventDefault();
    if (!mayClose()) return;
    closing = true;
    // Detach this UI only. The shared Elpis runtime owns running conversations.
    Promise.all([server.close(), browserAgentSocket?.close()]).finally(() => app.quit());
  });
}

function showStartupError(error) {
  console.error('Elpis startup failed:', error?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(error?.message || error));
  app.quit();
}
