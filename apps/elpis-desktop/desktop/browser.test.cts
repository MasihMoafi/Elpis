import type { EventEmitter as NodeEmitter } from "node:events";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createBrowser } = require("./browser.cts") as typeof import("./browser.cts");
// createBrowser runs inside Electron, which names its Chromium version.
(process.versions as { chrome?: string }).chrome ??= "152.0.7977.130";

test("a destroyed sign-in popup closes safely after Electron detaches its webContents", async () => {
  const { EventEmitter } = require("node:events");
  const wc = new EventEmitter();
  Object.assign(wc, {
    setBackgroundColor() {},
    setWindowOpenHandler() {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    getURL: () => "",
    getZoomFactor: () => 1,
    isLoading: () => false,
    isDestroyed: () => false,
    close() {},
    focus() {},
    send() {},
    loadURL: async () => {},
  });
  let view!: View;
  class View {
    declare webContents: typeof wc | undefined;
    constructor() {
      this.webContents = wc;
      view = this;
    }
    setVisible() {}
    setBounds() {}
  }
  const host = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ width: 1320, height: 900 }),
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send() {}, focus() {} }),
    isDestroyed: () => false,
    focus() {},
  });
  const browser = createBrowser({
    host,
    WebContentsView: View,
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setUserAgent() {},
        webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
      }),
    },
    origin: "http://127.0.0.1:4000",
    ipcMain: { handle() {}, on() {}, removeHandler() {}, removeListener() {} },
  });
  browser.open("https://claude.ai");
  view.webContents = undefined;
  assert.doesNotThrow(() => wc.emit("destroyed"));
  assert.equal(browser.snapshot().tabs.length, 0);
  browser.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
});

function identityFixture(requireBlank = false, initialFailure?: Error) {
  let release!: () => void;
  let blankLoaded = false;
  const identity = new Promise<void>(resolve => {
    release = resolve;
  });
  const awaitingDocument = new Promise<void>(() => undefined);
  const loads: string[] = [];
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: (name: string) =>
      name === "Emulation.setUserAgentOverride"
        ? requireBlank && !blankLoaded
          ? awaitingDocument
          : identity
        : Promise.resolve(),
  });
  const wc = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    setWindowOpenHandler() {},
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      getAllEntries: () => [{ url: "about:blank", title: "New tab" }],
      getActiveIndex: () => 0,
      restore: async () => {},
      goToIndex() {},
      removeEntryAtIndex: () => true,
    },
    getURL: () => "",
    getZoomFactor: () => 1,
    setZoomFactor() {},
    isDestroyed: () => false,
    close() {},
    focus() {},
    send() {},
    stop() {},
    loadURL: async (url: string) => {
      if (url === "about:blank") {
        if (initialFailure) throw initialFailure;
        blankLoaded = true;
      } else loads.push(url);
    },
  });
  class View {
    webContents = wc;
    setVisible() {}
    setBounds() {}
  }
  const origin = "http://127.0.0.1:4000";
  const root = Object.assign(new EventEmitter(), {
    mainFrame: { url: origin },
    isDestroyed: () => false,
    send() {},
    focus() {},
    getZoomFactor: () => 1,
  });
  const host = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ width: 1320, height: 900 }),
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: root,
    isDestroyed: () => false,
  });
  const session = {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      setUserAgent() {},
      webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
    }),
  };
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const browser = createBrowser({
    host,
    WebContentsView: View,
    session,
    origin,
    ipcMain: {
      handle: (name: string, handler: (event: unknown, input: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
      on() {},
      removeHandler() {},
      removeListener() {},
    },
  });
  const command = (id: string, action: string, data: Record<string, string> = {}) =>
    handlers.get("elpis:browser")!({ sender: root, senderFrame: root.mainFrame }, { id, action, ...data });
  return { browser, command, loads, release, wc };
}

test("initializing a tab does not replace its requested address with the blank document", async () => {
  const { browser, release, wc } = identityFixture();
  try {
    browser.open("https://example.com/");
    wc.emit("did-navigate", {}, "about:blank");
    assert.equal(browser.snapshot().tabs[0]!.url, "https://example.com/");
  } finally {
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    browser.dispose();
  }
});

test("a saved tab keeps its history while its identity is initializing", async () => {
  const { browser, command, release } = identityFixture();
  const history = [
    { url: "https://example.com/first", title: "First" },
    { url: "https://example.com/second", title: "Second" },
  ];
  const restoring = browser.restore({
    visible: true,
    activeId: "tab",
    tabs: [
      {
        id: "tab",
        url: history[1]!.url,
        title: "Second",
        customTitle: "",
        agent: false,
        muted: false,
        zoom: 1,
        history,
        historyIndex: 1,
      },
    ],
  });
  try {
    assert.deepEqual(browser.saved().tabs[0]!.history, history);
    await command("tab", "navigate", { url: "javascript:alert(1)" });
    assert.deepEqual(browser.saved().tabs[0]!.history, history, "a rejected address must not discard pending history");
    assert.equal(browser.saved().tabs[0]!.historyIndex, 1);
  } finally {
    release();
    await restoring;
    browser.dispose();
  }
});

test("a new browser tab applies its identity before loading its first page", async () => {
  const { browser, loads, release } = identityFixture();
  browser.open("https://example.com/");
  const premature = [...loads];
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  browser.dispose();
  assert.deepEqual(premature, []);
  assert.deepEqual(loads, ["https://example.com/"]);
});

test("a failed browser initialization reports the failure without loading the requested page", async () => {
  const { browser, loads, release } = identityFixture(false, new Error("initialization failed"));
  try {
    browser.open("https://example.com/");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(browser.snapshot().tabs[0]!.error, "The browser could not initialize this tab.");
    assert.deepEqual(loads, []);
  } finally {
    release();
    browser.dispose();
  }
});

test("a newer address, Stop, or Close supersedes a pending first page", async () => {
  for (const action of ["navigate", "stop", "close"]) {
    const { browser, command, loads, release } = identityFixture();
    const id = browser.open("https://example.com/first");
    await command(id, action, action === "navigate" ? { url: "https://example.com/second" } : {});
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    browser.dispose();
    assert.deepEqual(loads, action === "navigate" ? ["https://example.com/second"] : [], action);
  }
});

test("a blank document initializes Electron before the identity override", async () => {
  const { browser, loads, release } = identityFixture(true);
  browser.open("https://example.com/");
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  browser.dispose();
  assert.deepEqual(loads, ["https://example.com/"]);
});
const { createBrowserSessions } = require("./browser-sessions.cts");

test("a window link is policy-checked before its session browser is initialized", async () => {
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  });
  const store = { read: () => ({}), set: async () => {}, flush: async () => {} };
  const sessions = createBrowserSessions({ store });
  const browser = sessions.attach({
    host,
    origin: "http://127.0.0.1:4000",
    ipcMain: { handle() {}, on() {}, removeHandler() {}, removeListener() {} },
  });
  for (const url of ["javascript:alert(1)", "http://127.0.0.1:4000/settings", "file://server/share/x.pdf"])
    assert.throws(() => browser.open(url), /web address|file on this computer/);
  // Local files and PDFs open (29 Oct): a file: address or a plain path.
  const { browserUrl } = require("./browser-policy.cts") as typeof import("./browser-policy.cts");
  assert.equal(browserUrl("/home/me/Report 1.pdf", "http://127.0.0.1:4000"), "file:///home/me/Report%201.pdf");
  assert.equal(browserUrl("file:///tmp/a.html", "http://127.0.0.1:4000"), "file:///tmp/a.html");
  browser.dispose();
  await sessions.flush();
});

test("stopping a navigation does not turn its rejected load promise into a page error", async () => {
  const origin = "http://127.0.0.1:4000",
    states: { tabs: { error: string | null }[] }[] = [],
    handlers = new Map<string, (event: unknown, input: unknown) => void>();
  let page!: NodeEmitter;
  const root = Object.assign(new EventEmitter(), {
    mainFrame: { url: origin },
    isDestroyed: () => false,
    focus() {},
    send: (_name: string, state: { tabs: { error: string | null }[] }) => states.push(state),
    getZoomFactor: () => 1,
  });
  const host = Object.assign(new EventEmitter(), {
    webContents: root,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1320, height: 900 }),
    contentView: { addChildView() {}, removeChildView() {} },
  });
  class View {
    declare webContents: NodeEmitter;
    declare reject: (reason: Error) => void;
    constructor() {
      page = this.webContents = Object.assign(new EventEmitter(), {
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler() {},
        isDestroyed: () => false,
        close() {},
        focus() {},
        send() {},
        getZoomFactor: () => 1,
        getURL: () => "",
        loadURL: () =>
          new Promise((_resolve, reject) => {
            this.reject = reject;
          }),
        stop: () => {
          this.reject(Object.assign(Error("(-3) loading 'https://example.com/'"), { errno: -3 }));
          page.emit("did-stop-loading");
        },
      });
    }
    setVisible() {}
    setBounds() {}
  }
  const browser = createBrowser({
    host,
    origin,
    WebContentsView: View,
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setUserAgent() {},
        webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
      }),
    },
    ipcMain: {
      handle: (name: string, fn: (event: unknown, input: unknown) => void) => handlers.set(name, fn),
      on() {},
      removeHandler() {},
      removeListener() {},
    },
  });
  browser.open("https://example.com");
  handlers.get("elpis:browser")!({ sender: root, senderFrame: root.mainFrame }, { action: "stop" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(states.at(-1)!.tabs[0]!.error, null);
  page.emit("did-fail-load", {}, -105, "Could not resolve this website", "https://example.com/", true);
  assert.equal(states.at(-1)!.tabs[0]!.error, "Could not resolve this website");
  browser.dispose();
});

test("external-url opens Claude, OpenAI, and CloudRoom sign-in URLs and refuses unrelated URLs", async () => {
  const origin = "http://127.0.0.1:4000",
    opened: string[] = [],
    handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const root = Object.assign(new EventEmitter(), {
    mainFrame: { url: origin },
    isDestroyed: () => false,
    focus() {},
    send() {},
    getZoomFactor: () => 1,
  });
  const host = Object.assign(new EventEmitter(), {
    webContents: root,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1320, height: 900 }),
    contentView: { addChildView() {}, removeChildView() {} },
  });
  class View {
    webContents = Object.assign(new EventEmitter(), {
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler() {},
      isDestroyed: () => false,
      close() {},
      focus() {},
      send() {},
      getZoomFactor: () => 1,
      getURL: () => "",
      loadURL: async () => {},
    });
    setVisible() {}
    setBounds() {}
  }
  const browser = createBrowser({
    host,
    origin,
    WebContentsView: View,
    openExternal: async (url: string) => {
      opened.push(url);
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setUserAgent() {},
        webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
      }),
    },
    ipcMain: {
      handle: (name: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(name, fn),
      on() {},
      removeHandler() {},
      removeListener() {},
    },
  });
  const invoke = (url: string) =>
    handlers.get("elpis:browser")!({ sender: root, senderFrame: root.mainFrame }, { action: "external-url", url });
  await invoke("https://auth.openai.com/oauth/authorize?client_id=test");
  await invoke("https://claude.ai/oauth/authorize?client_id=test");
  await invoke("https://www.cloudroom.dev/desktop");
  assert.deepEqual(opened, [
    "https://auth.openai.com/oauth/authorize?client_id=test",
    "https://claude.ai/oauth/authorize?client_id=test",
    "https://www.cloudroom.dev/desktop",
  ]);
  const refused = (await invoke("https://example.com/phishing")) as { error?: string };
  assert.match(refused.error ?? "", /Claude, OpenAI, or CloudRoom/);
  assert.equal(opened.length, 3);
  browser.dispose();
});
