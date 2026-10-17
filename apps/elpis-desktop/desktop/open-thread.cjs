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

/** Holds what the page should open until it takes it: the page asks at start, and again on each ping on `channel`.
 * `accept` returns the value to keep, or null to ignore it. */
function createOpener(channel, accept, initial = null) {
  let pending = accept(initial), window = null;
  return {
    queue(value) {
      const next = accept(value);
      if (next === null) return;
      pending = next;
      if (window && !window.isDestroyed()) window.webContents.send(channel);
    },
    attach({ host, origin, ipcMain }) {
      window = host;
      ipcMain.handle(`${channel}:take`, event => {
        if (!trustedBrowserSender(event, host.webContents, origin)) return null;
        const value = pending; pending = null; return value;
      });
      return () => { if (window === host) window = null; ipcMain.removeHandler(`${channel}:take`); };
    },
  };
}

/** The chat the TUI asked for. */
const createThreadOpener = (initial = null) => createOpener('elpis:open-thread', threadId, initial);
/** A new chat from Quick Entry (sent with its text) or the tray (empty), at most what the composer holds. */
const createNewChatOpener = () => createOpener('elpis:new-chat', text => typeof text === 'string' && text.length <= 16384 ? text : null);

module.exports = { openThreadArgument, createThreadOpener, createNewChatOpener, threadId };
