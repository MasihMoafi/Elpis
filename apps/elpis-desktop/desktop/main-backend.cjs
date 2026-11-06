'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startBrowserAgentSocket } = require('./browser-agent.cjs');
const { closeNeedsConfirmation, seedShippedDefaults } = require('./preferences.cjs');
const { createSessionWindows } = require('./session-windows.cjs');
const { createSleepBlocker } = require('./sleep-blocker.cjs');

function createMainBackend({ electron, appDir, state, createStateStore, closeToTray, updates }) {
  const { app, dialog, powerSaveBlocker } = electron;
  const confirmedClose = new WeakSet();
  let window;
  let opening;
  let openingChat;

  // Settings → General → Confirm before closing. Returns false when the person keeps the window.
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
      if (!state.getStore()) state.setStore(createStateStore(path.join(app.getPath('userData'), 'workspace.json')));
      const store = state.getStore();
      await seedShippedDefaults(store);
      const { startDesktopServer } = await import(pathToFileURL(path.join(appDir, '../bridge/server.mjs')).href);
      const { DesktopClient, existingSocket } = await import(pathToFileURL(path.join(appDir, '../bridge/client.mjs')).href);
      const { ensureInstalledRuntime } = await import(pathToFileURL(path.join(appDir, 'runtime.mjs')).href);
      const { browserMcpConfig } = await import(pathToFileURL(path.join(appDir, '../bridge/browser-mcp.mjs')).href);
      const { scheduleMcpConfig } = await import(pathToFileURL(path.join(appDir, '../bridge/schedule-mcp.mts')).href);
      const browserAgentSocket = await startBrowserAgentSocket({ connectionFile: path.join(app.getPath('userData'), 'browser-connection.json') });
      state.setBrowserAgentSocket(browserAgentSocket);
      try {
        // The window opens without waiting for the runtime (24 Oct: a runtime still starting kept the app closed for 20 s).
        const client = await DesktopClient.connect({ background: true, beforeConnect: ensureInstalledRuntime, browserConfig: {
          // Every chat gets the browser tools and, once the app's server is up, the Automations tools (bridge/schedule-mcp.mts).
          forSession: id => ({ ...browserMcpConfig(browserAgentSocket.path, undefined, browserAgentSocket.scope(id), browserAgentSocket.connectionFile),
            ...(state.getServer()?.automationAccess ? scheduleMcpConfig(state.getServer().automationAccess) : {}) }),
          bind: (from, to) => browserAgentSocket.rebind(from, to),
          close: id => { browserAgentSocket.revoke(id); state.getSessionWindows()?.closeBrowser(id); },
        } });
        state.setSleepBlocker(createSleepBlocker({ powerSaveBlocker, client, store }));
        // A connected terminal may keep the previous bridge and engine alive after an install.
        const noteEngine = () => { try { updates.setRunningEngine(JSON.parse(fs.readFileSync(path.join(path.dirname(existingSocket()), 'state.json'), 'utf8')).engine); } catch {} };
        client.on('event', event => { if (event.type === 'connection' && event.data.connected) noteEngine(); });
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
      const sessionWindows = createSessionWindows({ electron, url: state.getServer().url, store: state.getStore(), browserAgentSocket: state.getBrowserAgentSocket(), quickEntry: state.getQuickEntry(), screenshotPopup: state.getScreenshotPopup(), closeToTray, updates,
        mayClose, quitting: () => state.isClosing(), onDark: dark => state.setDarkTheme(dark),
        onClosed: host => { if (window === host) { window = [...sessionWindows.windows].find(item => !sessionWindows.openersFor(item)?.loveSpot && !sessionWindows.openersFor(item)?.workflows); state.setPrimaryOpeners(sessionWindows.openersFor(window)); } },
        onFocused: (host, openers) => { if (!openers?.loveSpot && !openers?.workflows) { window = host; state.setPrimaryOpeners(openers); } } });
      state.setSessionWindows(sessionWindows);
    }
  }

  async function openWindow(loveSpot = false, workflows = false) {
    if (!opening) opening = prepareWindows().finally(() => { opening = null; });
    await opening;
    const sessionWindows = state.getSessionWindows();
    if (loveSpot) return sessionWindows.openLoveSpot();
    if (workflows) return sessionWindows.openWorkflows();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    } else {
      if (!openingChat) openingChat = sessionWindows.open({ onPrimary: openers => state.setPrimaryOpeners(openers) }).finally(() => { openingChat = null; });
      window = await openingChat;
    }
    const initialThread = state.takeInitialThread();
    if (initialThread) state.getPrimaryOpeners().threads.queue(initialThread);
  }

  return { mayClose, prepareWindows, openWindow };
}

module.exports = { createMainBackend };
