'use strict';

const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBrowser } = require('./browser.cjs');
const { appAudio } = require('./media-policy.cjs');
const { createStateStore, registerState } = require('./state.cjs');
const { registerFiles } = require('./files.cjs');

// The renderer gets only the loopback app, never Node or filesystem access.
let server;
let window;
let closing = false;
let opening;

function openWindow() {
  if (!opening) opening = createOrFocusWindow().finally(() => { opening = null; });
  return opening;
}

async function createOrFocusWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
    return;
  }
  if (!server) {
    const { startDesktopServer } = await import(pathToFileURL(path.join(__dirname, '../bridge/server.mjs')).href);
    const { DesktopClient } = await import(pathToFileURL(path.join(__dirname, '../bridge/client.mjs')).href);
    const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(__dirname, 'runtime.mjs')).href);
    const client = await DesktopClient.connect({ beforeConnect: ensureInstalledRuntime });
    try { server = await startDesktopServer({ client, staticDir: path.join(__dirname, '../out') }); }
    catch (error) { client.close(); throw error; }
  }
  const origin = new URL(server.url).origin;
  window = new BrowserWindow({
    title: 'Elpis', width: 1320, height: 900, minWidth: 600, minHeight: 480,
    // The Elpis website's mark, also used by the .desktop launcher.
    icon: path.join(__dirname, 'elpis-icon.png'),
    backgroundColor: '#151515', show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const browser = createBrowser({ host: window, origin, WebContentsView, session, ipcMain });
  const disposeState = registerState({ host: window, origin, ipcMain, dialog,
    store: createStateStore(path.join(app.getPath('userData'), 'workspace.json')) });
  const disposeFiles = registerFiles({ host: window, origin, ipcMain, shell });
  // Website permissions are handled by the browser's separate session.
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(appAudio(contents, window, permission, details, origin)));
  window.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) => appAudio(contents, window, permission, details, origin));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { browser.open(url); } catch { /* Invalid links remain closed. */ }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window?.show());
  window.once('close', () => { disposeFiles(); disposeState(); browser.dispose(); });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(server.url);
}

// WM_CLASS comes from package.json "name" (elpis-desktop) when launched as the app directory;
// elpis-desktop.desktop.in sets StartupWMClass=elpis-desktop to match, so docks show the Elpis icon.
app.setName('Elpis');
app.setPath('userData', path.join(app.getPath('appData'), 'Elpis'));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { void openWindow().catch(showStartupError); });
  app.whenReady().then(async () => {
    // Built once: rebuilding an unchanged menu redraws the Linux menu row (Cloudroom's flicker).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    await openWindow();
  }).catch(showStartupError);
  app.on('activate', () => { void openWindow().catch(showStartupError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server || closing) return;
    event.preventDefault();
    closing = true;
    // Detach this UI only. The shared Elpis runtime owns running conversations.
    Promise.resolve(server.close()).finally(() => app.quit());
  });
}

function showStartupError(error) {
  console.error('Elpis startup failed:', error?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(error?.message || error));
  app.quit();
}
