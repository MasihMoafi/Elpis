'use strict';
const path = require('node:path');
const { createBrowserSessions } = require('./browser-sessions.cjs');
const { registerState } = require('./state.cjs');
const { registerFiles } = require('./files.cjs');
const { registerTerminal } = require('./terminal.cjs');
const { attachContextMenu } = require('./context-menu.cjs');
const { registerTheme } = require('./theme.cjs');
const { appPermission } = require('./media-policy.cjs');
const { trustedBrowserSender } = require('./browser-policy.cjs');
const { createThreadOpener, createNewChatOpener, threadId: validThreadId } = require('./open-thread.cjs');
const { createWindowIpc } = require('./window-ipc.cjs');
const { registerImprove } = require('./improve.cjs');
const ICON = path.join(__dirname, 'elpis-icon.png');
const ZOOM = 1.1;
const TITLE_BAR = { dark: { color: '#0d0e11', symbolColor: '#e6e0d3' }, light: { color: '#f2f2f1', symbolColor: '#252524' } };

/** All session windows use one bridge URL and one workspace store. No window owns the engine. */
function createSessionWindows({ electron, url, store, browserAgentSocket, quickEntry, closeToTray, improvements, mayClose, onDark, onClosed, onFocused }) {
  const { BrowserWindow, WebContentsView, session, ipcMain: globalIpc, Menu, clipboard, shell, dialog, nativeTheme } = electron;
  const windows = new Set();
  const savedText = new WeakSet();
  const openers = new Map();
  const windowIpc = createWindowIpc(globalIpc);
  const browsers = createBrowserSessions({ store, browserAgentSocket });
  let loveSpotWindow, openingLoveSpot;
  async function openLoveSpot() {
    if (loveSpotWindow && !loveSpotWindow.isDestroyed()) {
      if (loveSpotWindow.isMinimized()) loveSpotWindow.restore();
      if (!loveSpotWindow.isVisible()) loveSpotWindow.show();
      loveSpotWindow.focus();
      return loveSpotWindow;
    }
    if (!openingLoveSpot) openingLoveSpot = open({ loveSpot: true }).then(host => { loveSpotWindow = host; return host; }).finally(() => { openingLoveSpot = null; });
    return openingLoveSpot;
  }
  async function open({ threadId, newSession = false, onPrimary, loveSpot = false } = {}) {
    const origin = new URL(url).origin;
    const window = new BrowserWindow({
      title: loveSpot ? 'Love Spot · Elpis' : 'Elpis', width: 1320, height: 900, minWidth: 600, minHeight: 480,
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
    const ipcMain = windowIpc(window);
    windows.add(window);
    const browser = browsers.attach({ host: window, origin, WebContentsView, session, ipcMain, Menu, clipboard, openExternal: url => shell.openExternal(url) });
    window.on('focus', () => { onFocused?.(window, openers.get(window)); });
    const threads = createThreadOpener(threadId);
    const newChats = createNewChatOpener();
    openers.set(window, { threads, newChats, loveSpot });
    if (newSession) newChats.queue('');
    if (onPrimary) onPrimary({ threads, newChats });
    const disposeState = registerState({ host: window, origin, ipcMain, dialog, store });
    const disposeFiles = registerFiles({ host: window, origin, ipcMain, shell });
    const disposeTerminal = registerTerminal({ host: window, origin, ipcMain, clipboard });
    const disposeImprove = registerImprove({ host: window, origin, ipcMain, improvements });
    const disposeThreads = threads.attach({ host: window, origin, ipcMain });
    const disposeNewChats = newChats.attach({ host: window, origin, ipcMain });
    const disposeQuickEntry = quickEntry?.attach({ host: window, origin, ipcMain }) ?? (() => {});
    // The app's theme colours the window buttons, Quick Entry, the browser's pages and nativeTheme; only the app's own page may report it.
    const host = window;
    const disposeTheme = registerTheme({ host, ipcMain, nativeTheme, titleBar: TITLE_BAR, browser, onDark });
    // Website permissions are handled by the browser's separate session.
    const permits = (contents, permission, details) => {
      const host = [...windows].find(host => !host.isDestroyed() && host.webContents === contents);
      return !!host && appPermission(contents, host, permission, details, origin);
    };
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(permits(contents, permission, details)));
    window.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) => permits(contents, permission, details));
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== origin) event.preventDefault();
    });
    const openInBrowser = url => { try { browser.open(url); } catch { /* Invalid links remain closed. */ } };
    window.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: 'deny' }; });
    const detachContextMenu = attachContextMenu(window.webContents, { Menu, clipboard, openLink: openInBrowser, origin, window, changeThis: point => window.webContents.send('elpis:improve:point', point) });
    window.once('ready-to-show', () => window.show());
    ipcMain.handle('elpis:session-window', async (event, id) => {
      if (!trustedBrowserSender(event, window.webContents, origin)) throw Error('Elpis application frame required');
      if (id !== undefined && !validThreadId(id)) throw Error('Invalid session');
      await open({ threadId: id, newSession: id === undefined });
      return { opened: true };
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return; disposed = true;
      ipcMain.removeHandler('elpis:session-window');
      detachContextMenu(); disposeImprove(); disposeFiles(); disposeTerminal(); disposeThreads(); disposeNewChats(); disposeQuickEntry(); disposeState(); browser.dispose(); disposeTheme();
    };
    let flushingText = false;
    window.on('close', event => {
      if (windows.size === 1 && closeToTray.hides(event, host)) return;
      if (!mayClose(host)) { event.preventDefault(); return; }
      if (!savedText.has(window) && window.webContents.executeJavaScript) {
        event.preventDefault();
        if (!flushingText) {
          flushingText = true;
          window.webContents.executeJavaScript('window.__elpisFlushLoveSpot?.() ?? true').then(saved => {
            if (saved !== false && !window.isDestroyed()) { savedText.add(window); window.close(); }
          }).catch(error => console.error('Could not save before closing:', error)).finally(() => { flushingText = false; });
        }
        return;
      }
      dispose();
    });
    window.on('closed', () => { dispose(); windows.delete(window); openers.delete(window); onClosed?.(window); if (!windows.size) closeToTray.closed(); });
    const target = new URL(url);
    if (loveSpot) target.pathname = '/love-spot.html';
    if (threadId || newSession) target.searchParams.set('session', threadId || '');
    await window.loadURL(target.href);
    return window;
  }
  const flushText = async () => {
    const results = await Promise.all([...windows].filter(host => !host.isDestroyed()).map(async host => {
      const saved = await host.webContents.executeJavaScript?.('window.__elpisFlushLoveSpot?.() ?? true');
      if (saved !== false) savedText.add(host);
      return saved !== false;
    }));
    return results.every(Boolean);
  };
  return { open, openLoveSpot, windows, flushText, openersFor: host => openers.get(host), closeBrowser: browsers.drop, flushBrowsers: browsers.flush };
}
const sessionWindowMenu = open => ({ label: 'New Session in New Window', accelerator: 'CommandOrControl+Shift+N', click: () => { void open(); } });
module.exports = { createSessionWindows, sessionWindowMenu };
