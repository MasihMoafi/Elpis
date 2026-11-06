'use strict';

/**
 * @param {{
 *   app: import('electron').App,
 *   loveSpotApp: boolean,
 *   workflowsApp: boolean,
 *   executableLauncher: (file: string) => string,
 *   mayClose: (host?: import('electron').BrowserWindow) => boolean,
 *   state: import('./main-backend.cjs').MainState
 * }} options
 */
function createMainQuit({ app, loveSpotApp, workflowsApp, executableLauncher, mayClose, state }) {
  /** @type {Promise<boolean> | null | undefined} */
  let quitAttempt;
  /** @type {string | null | undefined} */
  let pendingRestartTarget;

  /** @param {string} [restartTarget] */
  async function quitApp(restartTarget) {
    if (restartTarget) pendingRestartTarget = restartTarget;
    if (quitAttempt) return quitAttempt;
    quitAttempt = (async () => {
      const sessionWindows = state.getSessionWindows();
      const server = state.getServer();
      const quickEntry = state.getQuickEntry();
      const hosts = [...(sessionWindows?.windows ?? [])].filter(host => !host.isDestroyed());
      if (!hosts.every(host => mayClose(host))) return false;
      try {
        if (pendingRestartTarget && server?.canRestart && !await server.canRestart()) throw Error('Wait for the voice call, Love Spot, Lab or workflow run in this window to finish, then restart.');
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
        await state.getStore()?.flush();
        if (pendingRestartTarget && server?.canRestart && !await server.canRestart()) throw Error('A voice call, Love Spot, Lab or workflow run started while preparing the update. Restart when it finishes.');
        if (pendingRestartTarget) executableLauncher(pendingRestartTarget);
        state.setClosing(true);
        state.getSleepBlocker()?.dispose(); state.setSleepBlocker(undefined);
        await Promise.all([server?.close(), state.getBrowserAgentSocket()?.close()]);
        quickEntry?.dispose?.(); state.getScreenshotPopup()?.dispose?.(); state.getTray()?.destroy();
        // All editable text is saved. A page's beforeunload must not veto explicit Quit afterward.
        for (const host of hosts) if (!host.isDestroyed()) host.webContents.on('will-prevent-unload', event => event.preventDefault());
        if (pendingRestartTarget) app.relaunch({ execPath: pendingRestartTarget, args: loveSpotApp ? ['--love-spot-app'] : workflowsApp ? ['--workflows-app'] : [] });
        app.quit();
        return true;
      } catch (error) {
        state.setClosing(false);
        sessionWindows?.cancelQuit?.();
        await Promise.allSettled([Promise.resolve().then(() => quickEntry?.cancelQuit?.()),
          ...hosts.filter(host => !host.isDestroyed()).map(host => host.webContents.executeJavaScript?.('document.documentElement.inert = false; true'))]);
        throw error;
      }
    })();
    try { return await quitAttempt; }
    finally { quitAttempt = null; if (!state.isClosing()) pendingRestartTarget = null; }
  }

  return { quitApp, isQuitting: () => Boolean(quitAttempt) };
}

module.exports = { createMainQuit };
