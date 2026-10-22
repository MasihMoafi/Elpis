'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, dialog, powerSaveBlocker } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startBrowserAgentSocket } = require('./browser-agent.cjs');
const { startSessionManagerAgent, SESSION_MANAGER_ID_KEY, listActive } = require('./session-manager-agent.cjs');
const { closeNeedsConfirmation, closesToTray, quickEntryShortcut, sessionManagerOn } = require('./preferences.cjs');
const { createStateStore } = require('./state.cjs');
const { openThreadArgument } = require('./open-thread.cjs');
const { createTray, createCloseToTray } = require('./tray.cjs');
const { startQuickEntry } = require('./quick-entry.cjs');
const { createSessionWindows, sessionWindowMenu } = require('./session-windows.cjs');
const { enableWaylandIme } = require('./wayland-ime.cjs');
const { createAppUpdates, executableLauncher } = require('./app-updates.cjs');
const fs = require('node:fs');
const { createSleepBlocker } = require('./sleep-blocker.cjs');
let sleepBlocker;

// The renderer gets only the loopback app, never Node or filesystem access.
let server;
let browserAgentSocket;
let sessionManagerAgent;
let sessionManagerMonitor;
let window;
let closing = false;
let opening;
let openingChat;
let store;
let quitAttempt;
let pendingRestartTarget;
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
    store ??= createStateStore(path.join(app.getPath('userData'), 'workspace.json'));
    const { startDesktopServer } = await import(pathToFileURL(path.join(__dirname, '../bridge/server.mjs')).href);
    const { DesktopClient, existingSocket } = await import(pathToFileURL(path.join(__dirname, '../bridge/client.mjs')).href);
    const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(__dirname, 'runtime.mjs')).href);
    const { browserMcpConfig } = await import(pathToFileURL(path.join(__dirname, '../bridge/browser-mcp.mjs')).href);
    const { sessionManagerMcpConfig } = await import(pathToFileURL(path.join(__dirname, '../bridge/session-manager-mcp.mjs')).href);
    const { createSessionManagerMonitor, reviewPrompt, runSessionManagerReview } = await import(pathToFileURL(path.join(__dirname, '../bridge/session-manager-monitor.mjs')).href);
    browserAgentSocket = await startBrowserAgentSocket({ connectionFile: path.join(app.getPath('userData'), 'browser-connection.json') });
    try {
      let client;
      sessionManagerAgent = await startSessionManagerAgent({ store, client: {
        listThreads: (...args) => client.listThreads(...args),
        readThreadMetadata: (...args) => client.readThreadMetadata(...args),
        renameThread: (...args) => client.renameThread(...args),
        archiveThread: (...args) => client.archiveThread(...args),
        sessionHasChildren: (...args) => client.sessionHasChildren(...args),
      } });
      client = await DesktopClient.connect({ beforeConnect: ensureInstalledRuntime, sessionManagerConfig: {
        isManager: id => store.read()[SESSION_MANAGER_ID_KEY] === id,
        forSession: id => sessionManagerMcpConfig(sessionManagerAgent.path, undefined, sessionManagerAgent.scope(id)),
        bind: (from, to) => sessionManagerAgent.bind(from, to),
        close: id => sessionManagerAgent.revoke(id),
      }, browserConfig: {
        forSession: id => browserMcpConfig(browserAgentSocket.path, undefined, browserAgentSocket.scope(id), browserAgentSocket.connectionFile),
        bind: (from, to) => browserAgentSocket.rebind(from, to),
        close: id => { browserAgentSocket.revoke(id); sessionWindows?.closeBrowser(id); },
      } });
      // The Session Manager reviews the chats by itself when three run at once or three start within twenty minutes
      // (Masih, 20–21 October); its chat is made on the background model the first time it is needed.
      sessionManagerMonitor = createSessionManagerMonitor({
        list: () => listActive(client),
        isManager: id => !!id && store.read()[SESSION_MANAGER_ID_KEY] === id,
        review: async reason => {
          let id = store.read()[SESSION_MANAGER_ID_KEY];
          if (!id) { id = (await client.createThread({ sessionManager: true, permissions: 'ask' })).thread.id; await store.set(SESSION_MANAGER_ID_KEY, id); }
          const { background } = await client.settings();
          await runSessionManagerReview(client, id, { text: reviewPrompt(reason), ...(background.model ? { model: background.model } : {}) },
            () => sessionManagerAgent.beginReview(id, reason.cwd));
        },
        log: line => console.warn(line),
      });
      client.on('event', event => { if (event.type === 'message' && sessionManagerOn(store)) sessionManagerMonitor.observe(event.data); });
      sleepBlocker = createSleepBlocker({ powerSaveBlocker, client, store });
      // A connected terminal may keep the previous bridge and engine alive after an install.
      try { updates.setRunningEngine(JSON.parse(fs.readFileSync(path.join(path.dirname(existingSocket()), 'state.json'), 'utf8')).engine); } catch {}
      // Chats deleted from the sidebar wait in this file until the app quits (Ctrl+Z brings them back until then).
      try { server = await startDesktopServer({ client, staticDir: path.join(__dirname, '../out'), trashFile: path.join(app.getPath('userData'), 'deleted-chats.json') }); }
      catch (error) { client.close(); throw error; }
    } catch (error) { sleepBlocker?.dispose(); sleepBlocker = undefined; sessionManagerMonitor?.close(); sessionManagerMonitor = undefined; await sessionManagerAgent?.close(); sessionManagerAgent = undefined; await browserAgentSocket.close(); browserAgentSocket = undefined; throw error; }
  }
  if (!sessionWindows) {
    sessionWindows = createSessionWindows({ electron: require('electron'), url: server.url, store, browserAgentSocket, quickEntry, closeToTray, improvements: server.improvements, updates,
      mayClose, quitting: () => closing, onDark: dark => { darkTheme = dark; }, onClosed: host => { if (window === host) { window = [...sessionWindows.windows].find(host => !sessionWindows.openersFor(host)?.loveSpot); primaryOpeners = sessionWindows.openersFor(window); } },
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
const updates = createAppUpdates({ app, runningApp: path.resolve(__dirname, '..'), restart: async target => {
  if (!await quitApp(target)) throw Error('Restart cancelled. Your windows and drafts are kept open.');
} });

async function quitApp(restartTarget) {
  if (restartTarget) pendingRestartTarget = restartTarget;
  if (quitAttempt) return quitAttempt;
  quitAttempt = (async () => {
    const hosts = [...(sessionWindows?.windows ?? [])].filter(host => !host.isDestroyed());
    if (!hosts.every(host => mayClose(host))) return false;
    try {
      if (pendingRestartTarget && server?.canRestart && !await server.canRestart()) throw Error('Wait for running chats and agents to finish before restarting.');
      // Freeze input until every final draft is acknowledged. Failed saves restore editing below.
      await Promise.all(hosts.map(host => host.webContents.executeJavaScript?.('document.documentElement.inert = true; true')));
      const dirtyFiles = await Promise.all(hosts.map(host => host.webContents.executeJavaScript?.('("__elpisHasUnsavedFiles" in window) ? window.__elpisHasUnsavedFiles : false')));
      if (dirtyFiles.some(dirty => dirty !== false)) throw Error('Save or revert file edits in every window before quitting or restarting.');
      const settingsSaved = await Promise.all(hosts.map(host => host.webContents.executeJavaScript?.('window.__elpisFlushSettings?.() ?? true')));
      if (settingsSaved.some(saved => saved !== true)) throw Error('Personalization drafts could not be saved. Keep this window open and copy your edits before quitting.');
      const workflowsSaved = await Promise.all(hosts.map(host => host.webContents.executeJavaScript?.('("__elpisFlushWorkflow" in window) ? window.__elpisFlushWorkflow() : true')));
      if (workflowsSaved.some(saved => saved !== true)) throw Error('Workflow could not be saved. Keep this window open and retry.');
      await quickEntry?.flush?.();
      if (await sessionWindows?.flushText() === false) throw Error('Text could not be saved. Keep this window open and press Ctrl+S before retrying.');
      await Promise.all(hosts.map(host => host.webContents.executeJavaScript?.('window.elpisDesktop?.storage?.flush?.() ?? true')));
      await sessionWindows?.flushBrowsers();
      await store?.flush();
      if (pendingRestartTarget && server?.canRestart && !await server.canRestart()) throw Error('A chat or agent started while preparing the update. Wait for it to finish before restarting.');
      if (pendingRestartTarget) executableLauncher(pendingRestartTarget);
      closing = true;
      sleepBlocker?.dispose(); sleepBlocker = undefined;
      sessionManagerMonitor?.close();
      await Promise.all([server?.close(), browserAgentSocket?.close(), sessionManagerAgent?.close()]);
      quickEntry?.dispose?.(); tray?.destroy();
      // All editable text is saved. A page's beforeunload must not veto explicit Quit afterward.
      for (const host of hosts) if (!host.isDestroyed()) host.webContents.on('will-prevent-unload', event => event.preventDefault());
      if (pendingRestartTarget) app.relaunch({ execPath: pendingRestartTarget, args: loveSpotApp ? ['--love-spot-app'] : [] });
      app.quit();
      return true;
    } catch (error) {
      closing = false;
      sessionWindows?.cancelQuit?.();
      await Promise.allSettled([Promise.resolve().then(() => quickEntry?.cancelQuit?.()),
        ...hosts.filter(host => !host.isDestroyed()).map(host => host.webContents.executeJavaScript?.('document.documentElement.inert = false; true'))]);
      throw error;
    }
  })();
  try { return await quitAttempt; }
  finally { quitAttempt = null; if (!closing) pendingRestartTarget = null; }
}
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
      { label: 'File', submenu: [sessionWindowMenu(() => sessionWindows.open({ newSession: true }).catch(showStartupError)), { role: 'close' }, { role: 'quit', accelerator: 'CommandOrControl+Q' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    if (loveSpotApp) return void await openWindow(true);
    const showWindow = () => void openWindow().catch(showStartupError);
    quickEntry = startQuickEntry({ app, globalShortcut, BrowserWindow, screen, ipcMain, dark: () => darkTheme,
      drafts: { read: () => store?.read()['elpis-draft-v1:quick-entry'] ?? '', save: text => store.set('elpis-draft-v1:quick-entry', text) },
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
    if (quitAttempt) return;
    void quitApp().catch(error => { console.error('Could not save before quitting:', error); dialog.showErrorBox('Elpis is still open', error.message); });
  });
}

function showStartupError(error) {
  console.error('Elpis startup failed:', error?.stack || String(error));
  dialog.showErrorBox('Elpis could not open', String(error?.message || error));
  app.quit();
}
