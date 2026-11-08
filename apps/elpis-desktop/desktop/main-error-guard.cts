"use strict";

let started = false;
let pendingNotice = false;
const state: { electron?: typeof import("electron") } = {};

function report(error: unknown, context = "Main process error") {
  const electron = state.electron;
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  const line = `${new Date().toISOString()} ${context}: ${detail}\n`;
  try {
    const fs: typeof import("node:fs") = require("node:fs");
    const path: typeof import("node:path") = require("node:path");
    const dir = electron?.app.getPath("logs");
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "main.log"), line);
    }
  } catch {
    /* stderr remains available if the log directory cannot be written. */
  }
  try {
    process.stderr.write(line);
  } catch {
    /* A closed output pipe must not cause another exception. */
  }
  if (!started) {
    // Startup failed: say so in plain words once, then exit; the stack stays in the log.
    try {
      electron?.dialog?.showErrorBox("Elpis could not open", error instanceof Error ? error.message : String(error));
    } catch {
      /* exiting anyway */
    }
    if (electron?.app) electron.app.exit(1);
    else process.exit(1);
    return;
  }
  pendingNotice = true;
  showNotice();
}

function showNotice() {
  if (!pendingNotice) return;
  try {
    const windows = state.electron?.BrowserWindow?.getAllWindows().filter(window => !window.isDestroyed()) ?? [];
    const window = windows.find(window => !window.webContents.isLoading());
    if (!window) {
      for (const candidate of windows) candidate.webContents.once("did-finish-load", showNotice);
      return;
    }
    pendingNotice = false;
    void window.webContents
      .executeJavaScript(
        `(() => {
      if (document.getElementById('elpis-main-error')) return;
      const notice = document.createElement('div');
      notice.id = 'elpis-main-error'; notice.setAttribute('role', 'alert');
      notice.className = 'error-banner notice';
      Object.assign(notice.style, {position:'fixed', bottom:'16px', left:'16px', right:'16px', zIndex:'2147483647'});
      const message = document.createElement('span');
      message.textContent = 'Elpis encountered an error. See the app log for details.';
      const close = document.createElement('button'); close.textContent = 'Dismiss';
      close.addEventListener('click', () => notice.remove());
      notice.append(message, close); document.body.append(notice);
    })()`,
      )
      .catch(() => {
        pendingNotice = true;
      });
  } catch {
    /* Reporting an error must not throw another error. */
  }
}

process.on("uncaughtException", error => report(error, "Uncaught exception"));
process.on("unhandledRejection", error => report(error, "Unhandled rejection"));
state.electron = require("electron");
// A test's stand-in for electron may have no app yet; the guard must load anywhere main.cts does.
state.electron?.app?.on("browser-window-created", (_event, window) => {
  window.webContents.on("did-finish-load", showNotice);
});
function markReady() {
  started = true;
}
export declare const ready: typeof markReady;
export declare const reportError: typeof report;
module.exports = { reportError: report, ready: markReady };
