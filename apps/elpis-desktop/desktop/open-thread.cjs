'use strict';
const { trustedBrowserSender } = require('./browser-policy.cjs');

/** A chat id as Elpis writes it (a UUID); nothing that could name a path or a command. */
const THREAD_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
const threadId = value => typeof value === 'string' && THREAD_ID.test(value) ? value : null;

/** The chat the Elpis TUI's /app asks this launch to open: `--open-thread <id>` or `--open-thread=<id>`. */
function openThreadArgument(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--open-thread') return threadId(argv[index + 1]);
    if (typeof argv[index] === 'string' && argv[index].startsWith('--open-thread=')) return threadId(argv[index].slice(14));
  }
  return null;
}

/** Holds the chat to open until the page takes it: the page asks at start, and again on each ping. */
function createThreadOpener(initial = null) {
  let pending = threadId(initial), window = null;
  return {
    queue(id) {
      if (!threadId(id)) return;
      pending = id;
      if (window && !window.isDestroyed()) window.webContents.send('elpis:open-thread');
    },
    attach({ host, origin, ipcMain }) {
      window = host;
      ipcMain.handle('elpis:open-thread:take', event => {
        if (!trustedBrowserSender(event, host.webContents, origin)) return null;
        const id = pending; pending = null; return id;
      });
      return () => { if (window === host) window = null; ipcMain.removeHandler('elpis:open-thread:take'); };
    },
  };
}

module.exports = { openThreadArgument, createThreadOpener, threadId };
