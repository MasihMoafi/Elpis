'use strict';

/** Electron invoke channels are process-wide; route each one to the window that registered it. */
function createWindowIpc(ipcMain) {
  const channels = new Map();
  return host => {
    const listeners = new Map(), contents = host.webContents, id = contents.id;
    return {
      handle(channel, handler) {
        let handlers = channels.get(channel);
        if (!handlers) {
          handlers = new Map(); channels.set(channel, handlers);
          ipcMain.handle(channel, (event, ...args) => {
            const route = handlers.get(event.sender.id);
            if (!route) throw Error('Elpis application window required');
            return route(event, ...args);
          });
        }
        handlers.set(id, handler);
      },
      removeHandler(channel) {
        const handlers = channels.get(channel); handlers?.delete(id);
        if (handlers?.size === 0) { ipcMain.removeHandler(channel); channels.delete(channel); }
      },
      on(channel, listener) {
        const scoped = (event, ...args) => { if (!contents.isDestroyed() && (event.sender === contents || channel === 'elpis:browser:page')) listener(event, ...args); };
        listeners.set(listener, scoped); ipcMain.on(channel, scoped);
      },
      removeListener(channel, listener) {
        const scoped = listeners.get(listener);
        if (scoped) { ipcMain.removeListener(channel, scoped); listeners.delete(listener); }
      },
    };
  };
}
module.exports = { createWindowIpc };
