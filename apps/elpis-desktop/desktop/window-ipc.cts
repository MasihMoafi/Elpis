'use strict';

import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;

/** Electron invoke channels are process-wide; route each one to the window that registered it. */
function makeWindowIpc(ipcMain: IpcMain) {
  const channels = new Map<string, Map<number, Handler>>();
  return (host: BrowserWindow) => {
    const listeners = new Map<Listener, Listener>(), contents = host.webContents, id = contents.id;
    return {
      handle(channel: string, handler: Handler) {
        let handlers = channels.get(channel);
        if (!handlers) {
          handlers = new Map(); channels.set(channel, handlers);
          const routes = handlers;
          ipcMain.handle(channel, (event, ...args) => {
            const route = routes.get(event.sender.id);
            if (!route) throw Error('Elpis application window required');
            return route(event, ...args);
          });
        }
        handlers.set(id, handler);
      },
      removeHandler(channel: string) {
        const handlers = channels.get(channel); handlers?.delete(id);
        if (handlers?.size === 0) { ipcMain.removeHandler(channel); channels.delete(channel); }
      },
      on(channel: string, listener: Listener) {
        const scoped: Listener = (event, ...args) => { if (!contents.isDestroyed() && (event.sender === contents || channel === 'elpis:browser:page')) listener(event, ...args); };
        listeners.set(listener, scoped); ipcMain.on(channel, scoped);
      },
      removeListener(channel: string, listener: Listener) {
        const scoped = listeners.get(listener);
        if (scoped) { ipcMain.removeListener(channel, scoped); listeners.delete(listener); }
      },
    };
  };
}
export declare const createWindowIpc: typeof makeWindowIpc;
module.exports = { createWindowIpc: makeWindowIpc };
