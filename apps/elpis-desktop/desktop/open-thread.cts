"use strict";
import type { IpcMainInvokeEvent } from "electron";
type Host = {
  isDestroyed: () => boolean;
  webContents: { mainFrame: { url: string }; send: (channel: string) => unknown };
};
const { trustedBrowserSender }: typeof import("./browser-policy.cts") = require("./browser-policy.cts");

/** A chat id as Elpis writes it (a UUID); nothing that could name a path or a command. */
const THREAD_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
const threadIdImpl = (value: unknown) => (typeof value === "string" && THREAD_ID.test(value) ? value : null);

/** The chat the Elpis TUI's /app asks this launch to open: `--open-thread <id>` or `--open-thread=<id>`. */
function openThreadArgumentImpl(argv: unknown[]) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--open-thread") return threadIdImpl(argv[index + 1]);
    if (typeof argv[index] === "string" && (argv[index] as string).startsWith("--open-thread="))
      return threadIdImpl((argv[index] as string).slice(14));
  }
  return null;
}

/** Holds what the page should open until it takes it: the page asks at start, and again on each ping on `channel`.
 * `accept` returns the value to keep, or null to ignore it. */
function createOpener(channel: string, accept: (value: unknown) => string | null, initial: unknown = null) {
  let pending = accept(initial),
    window: Host | null = null;
  return {
    queue(value: unknown) {
      const next = accept(value);
      if (next === null) return;
      pending = next;
      if (window && !window.isDestroyed()) window.webContents.send(channel);
    },
    attach({
      host,
      origin,
      ipcMain,
    }: {
      host: Host;
      origin: string;
      ipcMain: {
        handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
        removeHandler: (channel: string) => void;
      };
    }) {
      window = host;
      ipcMain.handle(`${channel}:take`, (event: IpcMainInvokeEvent) => {
        if (!trustedBrowserSender(event, host.webContents, origin)) return null;
        const value = pending;
        pending = null;
        return value;
      });
      return () => {
        if (window === host) window = null;
        ipcMain.removeHandler(`${channel}:take`);
      };
    },
  };
}

/** The chat the TUI asked for. */
const createThreadOpenerImpl = (initial: unknown = null) => createOpener("elpis:open-thread", threadIdImpl, initial);
/** A new chat from Quick Entry (sent with its text) or the tray (empty), at most what the composer holds. */
const createNewChatOpenerImpl = () =>
  createOpener("elpis:new-chat", text => (typeof text === "string" && text.length <= 16384 ? text : null));

export declare const openThreadArgument: typeof openThreadArgumentImpl;
export declare const createThreadOpener: typeof createThreadOpenerImpl;
export declare const createNewChatOpener: typeof createNewChatOpenerImpl;
export declare const threadId: typeof threadIdImpl;
module.exports = {
  openThreadArgument: openThreadArgumentImpl,
  createThreadOpener: createThreadOpenerImpl,
  createNewChatOpener: createNewChatOpenerImpl,
  threadId: threadIdImpl,
};
