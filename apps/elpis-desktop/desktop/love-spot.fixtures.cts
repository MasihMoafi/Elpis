

const { createTestTempDir } = require("../tests/temp-root.cts");



const vm = require("node:vm");

const { stripTypeScriptTypes } = require("node:module");

const fs = require("node:fs");

const path = require("node:path");

const { EventEmitter } = require("node:events");

export type Control = { dirty: unknown; workflowSaved: boolean; inert?: boolean; readFailure?: boolean };

export type Relaunch = { execPath: string; args: string[] };

export type Call = string | ["thread", string] | ["relaunch", Relaunch];

export type Host = { isDestroyed: () => boolean; webContents: { executeJavaScript: (script: string) => Promise<unknown> } };

// The standalone app makes its own home on start; tests give it a throwaway one, never the real ~/.local/share/love-spot.
const launchHome = createTestTempDir(path.join(require("node:os").tmpdir(), "love-dock-home-"));

let launchEnv: Record<string, string> = {};
const setLaunchEnv = (value: Record<string, string>) => {
  launchEnv = value;
};

async function launch(
  args: string[],
  flushText?: () => Promise<boolean>,
  flushBrowsers?: () => Promise<void>,
  canRestart = async () => true,
) {
  const app = new EventEmitter();
  let ready!: () => void, lock!: { loveSpot: boolean };
  const identity: Record<string, string> = {};
  Object.assign(app, {
    setName: (name: string) => {
      identity.name = name;
    },
    setPath: (key: string, value: string) => {
      identity[key] = value;
    },
    setDesktopName: (name: string) => {
      identity.desktop = name;
    },
    getPath: () => "/tmp/love-dock-test",
    commandLine: { appendSwitch() {}, getSwitchValue: () => "" },
    requestSingleInstanceLock: (data: { loveSpot: boolean }) => {
      lock = data;
      return true;
    },
    whenReady: () =>
      new Promise<void>(resolve => {
        ready = resolve;
      }),
    quit() {},
    relaunch: (value: Relaunch) => calls.push(["relaunch", value]),
  });
  const calls: Call[] = [];
  const host = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    focus: () => calls.push("focus-chat"),
  };
  const openers = { threads: { queue: (id: string) => calls.push(["thread", id]) }, newChats: { queue() {} } };
  const sessions = {
    windows: new Set<Host>(),
    flushText,
    flushBrowsers: async () => {
      calls.push("browser-flush");
      await flushBrowsers?.();
    },
    openersFor: () => openers,
    open: async () => {
      calls.push("chat");
      return host;
    },
    openLoveSpot: async () => {
      calls.push("love");
    },
    openWorkflows: async () => {
      calls.push("workflows");
    },
  };
  const electron = {
    app,
    ipcMain: { handle() {}, removeHandler() {} },
    dialog: { showErrorBox() {} },
    Menu: { buildFromTemplate: (x: unknown) => x, setApplicationMenu() {} },
  };
  const context = vm.createContext({
    __dirname,
    console,
    process: { argv: ["electron", "app", ...args], env: { HOME: launchHome, ...launchEnv }, platform: "linux" },
    sessions,
    openers,
    testStore: { get: () => null, flush: async () => calls.push("workspace-flush") },
    testServer: { canRestart, close: async () => calls.push("board-close") },
    require: (name: string) =>
      name === "./app-updates.cts"
        ? { executableLauncher: (file: string) => file, createAppUpdates: () => ({ setRunningEngine() {} }) }
        : name === "electron"
          ? electron
          : name === "./quick-entry.cts"
            ? {
                startQuickEntry: () => {
                  calls.push("quick-entry");
                  return { start: async () => {} };
                },
              }
            : name === "./tray.cts"
              ? {
                  createCloseToTray: () => ({}),
                  createTray: () => {
                    calls.push("tray");
                    return { destroy() {} };
                  },
                }
              : name === "./screenshot-popup.cts"
                ? {
                    createScreenshotPopup: () => ({ attach: () => () => {}, dispose() {} }),
                    drawsOnWayland: () => false,
                  }
                : require(name),
  });
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "main.cts"), "utf8")), context);
  vm.runInContext(
    "server = testServer; store = testStore; sessionWindows = sessions; primaryOpeners = openers;",
    context,
  );
  ready();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    app,
    calls,
    lock,
    settle,
    identity,
    sessions,
    quit: () => vm.runInContext("quitApp", context)(),
    restart: (target: string) => vm.runInContext("quitApp", context)(target),
  };
}

function editableHost(control: Control, calls: Call[]) {
  const webContents = Object.assign(new EventEmitter(), {
    executeJavaScript: async (script: string) => {
      if (script.includes("__elpisHasUnsavedFiles")) {
        calls.push("files-check");
        if (control.readFailure) throw Error("Private file status read failed");
        return control.dirty;
      }
      if (script.includes("__elpisFlushWorkflow")) {
        calls.push("workflow-flush");
        return control.workflowSaved;
      }
      if (script.includes("inert = true")) control.inert = true;
      if (script.includes("inert = false")) control.inert = false;
      if (script.includes("storage")) calls.push("storage-flush");
      return true;
    },
  });
  return { isDestroyed: () => false, webContents };
}

function sessionFixture({ loveSpotApp = false } = {}) {
  class Window extends EventEmitter {
    constructor() {
      super();
      this.text = "First words";
      this.saved = "";
      this.saves = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
          setUserAgent() {},
          webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
        },
        setWindowOpenHandler() {},
        executeJavaScript: async () => {
          this.saves++;
          if (this.failure === "throw") throw Error("Test disk unavailable");
          if (this.failure === "refuse") return false;
          this.saved = this.text;
          return true;
        },
      });
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    async loadURL(url: string) {
      this.url = url;
    }
    close() {
      let prevented = false;
      this.emit("close", {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) {
        this.destroyed = true;
        this.emit("closed");
      }
    }
  }
  const noop = () => {};
  const stubs = {
    "./browser-sessions.cts": {
      createBrowserSessions: () => ({
        attach: () => ({ open: noop, setBackground: noop, dispose: noop }),
        drop: noop,
        flush: async () => {},
      }),
    },
    "./state.cts": { registerState: () => noop },
    "./files.cts": { registerFiles: () => noop },
    "./terminal.cts": { registerTerminal: () => noop },
    "./context-menu.cts": { attachContextMenu: () => noop },
    "./theme.cts": { registerTheme: () => noop },
    "./improve.cts": { registerImprove: () => noop },
    "./open-thread.cts": {
      createThreadOpener: () => ({ attach: () => noop }),
      createNewChatOpener: () => ({ attach: () => noop }),
    },
    "./window-ipc.cts": { createWindowIpc: () => () => ({ handle: noop, removeHandler: noop }) },
    // Shared documents (84f35b9d4) attach to each window; these checks are about saving and closing.
    "./documents.cts": { createDocuments: () => ({ attach: () => noop, call: async () => null }) },
  };
  const module = {
    exports: {} as {
      createSessionWindows: (options: unknown) => {
        open: () => Promise<Window>;
        openLoveSpot: () => Promise<Window>;
        flushText: () => Promise<boolean>;
        windows: Set<Window>;
      };
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, "session-windows.cts"), "utf8")), {
    __dirname,
    module,
    console: { ...console, error: noop },
    URL,
    require: (name: string) => (stubs as Record<string, unknown>)[name] ?? require(name),
  });
  return module.exports.createSessionWindows({
    electron: { BrowserWindow: Window },
    url: "http://127.0.0.1:4000/",
    closeToTray: { hides: () => false, closed: noop },
    mayClose: () => true,
    loveSpotApp,
  });
}

const fixtures = { setLaunchEnv, launch, editableHost, sessionFixture };
export type Fixtures = typeof fixtures;
module.exports = fixtures;
