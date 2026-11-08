

"use strict";

const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");


export type Preferences = {
  DEFAULT_PREFERENCES: Record<string, unknown>;
  readPreferences: () => Record<string, unknown>;
  savePreferences: (value: Record<string, unknown>) => void;
};

export type Handler = (...args: unknown[]) => unknown;

const assert = require("node:assert/strict");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const { createStateStore, registerState } = require("./state.cts");

const { createWindowIpc } = require("./window-ipc.cts");

const { EventEmitter } = require("node:events");

const vm = require("node:vm");


// The review's reproduction: two actual preloads and preference modules, routed
// through production window IPC to one real store. Broadcasts can be delayed.
function windows(t: import("node:test").TestContext, initial = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-windows-")), "workspace.json");
  fs.writeFileSync(file, JSON.stringify(initial));
  const store = createStateStore(file),
    ipc = new EventEmitter(),
    handlers = new Map<string, Handler>(),
    pending: Promise<unknown>[] = [],
    broadcasts: (() => void)[] = [];
  ipc.handle = (key: string, handler: Handler) => handlers.set(key, handler);
  ipc.removeHandler = (key: string) => handlers.delete(key);
  const scope = createWindowIpc(/** @type {import('electron').IpcMain} */ /** @type {unknown} */ ipc);
  let delay = false;
  const open = (id: number) => {
    const renderer = new EventEmitter(),
      mainFrame = { url: "http://127.0.0.1:45001/" };
    const webContents = {
      id,
      mainFrame,
      isDestroyed: () => false,
      send: (channel: string, value: unknown) => {
        const deliver = () => renderer.emit(channel, {}, value);
        if (delay) broadcasts.push(deliver);
        else deliver();
      },
    };
    const event = (): { sender: typeof webContents; senderFrame: typeof mainFrame; returnValue?: unknown } => ({
      sender: webContents,
      senderFrame: mainFrame,
    });
    renderer.sendSync = (channel: string) => {
      const e = event();
      ipc.emit(channel, e);
      return e.returnValue;
    };
    renderer.invoke = (channel: string, ...args: unknown[]) => {
      const result = Promise.resolve().then(() => handlers.get(channel)!(event(), ...args));
      pending.push(result);
      return result;
    };
    const dispose = registerState({
      host: { webContents },
      origin: "http://127.0.0.1:45001",
      ipcMain: scope(/** @type {import('electron').BrowserWindow} */ /** @type {unknown} */ { webContents }),
      dialog: {},
      store,
    });
    t.after(dispose);
    const context = vm.createContext({
      window: {},
      require: (name: string) => {
        assert.equal(name, "electron");
        return {
          ipcRenderer: renderer,
          contextBridge: {
            exposeInMainWorld: (key: string, value: unknown) => {
              context.window[key] = value;
            },
          },
        };
      },
    });
    vm.runInContext(fs.readFileSync(preloadPath("preload"), "utf8"), context);
    const storage = context.window.elpisDesktop.storage,
      errors: string[] = [],
      changes: string[] = [];
    storage.onError((message: string) => errors.push(message));
    storage.onChange?.((key: string) => changes.push(key));
    const code = require("typescript").transpileModule(
      fs.readFileSync(path.join(__dirname, "../lib/preferences.ts"), "utf8"),
      { compilerOptions: { module: 1 } },
    ).outputText;
    const exports = {} as Preferences;
    vm.runInContext("(function(require,exports){" + code + "\n})", context)(
      (name: string) =>
        name === "react"
          ? {}
          : name.includes("preference-choices")
            ? require("../lib/preference-choices.cts")
            : { appStorage: () => storage },
      exports,
    );
    exports.readPreferences(); // Both windows cache defaults before either edits.
    return { storage, preferences: exports, errors, changes };
  };
  return {
    store,
    file,
    open,
    delay: (value: boolean) => {
      delay = value;
    },
    deliver: () => {
      for (const send of broadcasts.splice(0)) send();
    },
    settle: async () => {
      await Promise.allSettled(pending.splice(0));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const fixtures = { windows };
export type Fixtures = typeof fixtures;
module.exports = fixtures;
