import type { EventEmitter as NodeEmitter } from "node:events";

// The in-app browser's ChatGPT-parity features in the Electron main process, with Electron replaced by fakes:
// annotation (page picks, capture, comments, the agent's text), the page menu, zoom, find, errors and keys.

const assert = require("node:assert/strict");


const { EventEmitter } = require("node:events");

const { createBrowser } = require("./browser.cts") as typeof import("./browser.cts");

// createBrowser runs inside Electron, which names its Chromium version.
(process.versions as { chrome?: string }).chrome ??= "152.0.7977.130";

export type State = {
  draft: { id: string; editing: boolean; body: string };
  annotating: boolean;
  markersVisible: boolean;
  visible: boolean;
  focusAddress: number;
  fullView: number;
  find: { open: boolean; text: string; matches: number; active: number; focus: number };
  annotations: { id: string; number: number; body: string }[];
  tabs: {
    id: string;
    url: string;
    title: string;
    muted: boolean;
    zoom: number;
    security: string;
    failure: { summary: string };
  }[];
};

export type PageMessage = {
  type: string;
  id: string;
  mode: boolean;
  markersVisible: boolean;
  comments: { anchor: { selector: string } }[];
};

export type Page = NodeEmitter & {
  url: string;
  zoom: number;
  sent: { channel: string; message: PageMessage }[];
  finds: [string, unknown][];
  mainFrame: object;
  backgroundAtLoad?: string | undefined;
  back?: boolean;
  stopped?: string;
  muted?: boolean;
  reloaded?: boolean;
  hard?: boolean;
  printed?: boolean;
  devtools?: unknown;
  inspected?: number[];
  isDestroyed: () => boolean;
};

export type MenuItem = { label: string; enabled: boolean; click: () => void };

export type CommandResult = {
  error: string;
  result: { count: number; text: string; image: string; images: { number: number; dataUrl: string }[] };
};

export type PickValue = {
  id: string;
  kind: string;
  title: string;
  selector: string | null;
  elementPath: string;
  role: string;
  name: string | null;
  nearbyText: string;
  immediateText: string | null;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  isFixed: boolean;
  viewport: { width: number; height: number };
};

function fixture() {
  const origin = "http://127.0.0.1:4000",
    states: State[] = [],
    handlers = new Map<string, (event: unknown, input: unknown) => Promise<CommandResult>>(),
    listeners = new Map<string, (event: unknown, input: unknown) => void>(),
    pages: Page[] = [],
    views: View[] = [],
    menus: MenuItem[][] = [],
    externals: string[] = [];
  const root: NodeEmitter & { focused?: number; mainFrame: { url: string } } = Object.assign(new EventEmitter(), {
    mainFrame: { url: origin },
    isDestroyed: () => false,
    focus() {
      root.focused = (root.focused ?? 0) + 1;
    },
    send: (_name: string, state: State) => states.push(state),
    getZoomFactor: () => 1,
  });
  const host = Object.assign(new EventEmitter(), {
    webContents: root,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1320, height: 900 }),
    contentView: { addChildView() {}, removeChildView() {} },
  });
  const image: {
    resized?: unknown;
    getSize: () => { width: number; height: number };
    isEmpty: () => boolean;
    resize: (options: unknown) => typeof image;
    toJPEG: (quality: number) => Buffer;
  } = {
    getSize: () => ({ width: 2560, height: 1440 }),
    isEmpty: () => false,
    resize(options) {
      image.resized = options;
      return image;
    },
    toJPEG: quality => Buffer.from(`jpeg-${quality}`),
  };
  class View {
    declare options: {
      webPreferences: { preload: string; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean };
    };
    declare webContents: Page;
    declare background: string | undefined;
    constructor(options: View["options"]) {
      this.options = options;
      views.push(this);
      const view = this;
      const wc = (this.webContents = Object.assign(new EventEmitter(), {
        url: "about:blank",
        zoom: 1,
        sent: [],
        finds: [],
        mainFrame: {},
        navigationHistory: {
          canGoBack: () => true,
          canGoForward: () => false,
          goBack() {
            wc.back = true;
          },
          goForward() {},
        },
        setWindowOpenHandler() {},
        isDestroyed: () => false,
        close() {},
        focus() {},
        getURL: () => wc.url,
        loadURL(url: string) {
          wc.url = url;
          wc.backgroundAtLoad = view.background;
          return Promise.resolve();
        },
        send: (channel: string, message: PageMessage) => wc.sent.push({ channel, message }),
        capturePage: async () => image,
        getZoomFactor: () => wc.zoom,
        setZoomFactor(value: number) {
          wc.zoom = value;
        },
        findInPage(text: string, options: unknown) {
          wc.finds.push([text, options]);
          return wc.finds.length;
        },
        stopFindInPage(action: string) {
          wc.stopped = action;
        },
        setAudioMuted(value: boolean) {
          wc.muted = value;
        },
        isAudioMuted: () => !!wc.muted,
        reload() {
          wc.reloaded = true;
        },
        reloadIgnoringCache() {
          wc.hard = true;
        },
        stop() {},
        print() {
          wc.printed = true;
        },
        openDevTools(options: unknown) {
          wc.devtools = options;
        },
        inspectElement(x: number, y: number) {
          wc.inspected = [x, y];
        },
        isDevToolsOpened: () => !!wc.devtools,
        copy() {},
        cut() {},
        paste() {},
        selectAll() {},
        copyImageAt() {},
        downloadURL() {},
        replaceMisspelling() {},
        session: {},
      }) as unknown as Page);
      pages.push(wc);
    }
    setVisible() {}
    setBounds() {}
    setBackgroundColor(color: string) {
      this.background = color;
    }
  }
  const clipboard: {
    text?: string;
    image?: unknown;
    writeText: (text: string) => void;
    writeImage: (value: unknown) => void;
  } = {
    writeText(text) {
      clipboard.text = text;
    },
    writeImage(value) {
      clipboard.image = value;
    },
  };
  const Menu = {
    buildFromTemplate: (template: MenuItem[]) => ({
      popup() {
        menus.push(template);
      },
    }),
  };
  const browserSession: {
    cleared?: unknown;
    cacheCleared?: boolean;
    setPermissionRequestHandler: () => void;
    setPermissionCheckHandler: () => void;
    setUserAgent: () => void;
    webRequest: { onHeadersReceived: () => void; onBeforeSendHeaders: () => void };
    clearStorageData: (options: unknown) => Promise<void>;
    clearCache: () => Promise<void>;
  } = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setUserAgent() {},
    webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} },
    async clearStorageData(options) {
      browserSession.cleared = options;
    },
    async clearCache() {
      browserSession.cacheCleared = true;
    },
  };
  const browser = createBrowser({
    host,
    origin,
    WebContentsView: View,
    session: { fromPartition: () => browserSession },
    Menu,
    clipboard,
    ipcMain: {
      handle: (name: string, fn: (event: unknown, input: unknown) => Promise<CommandResult>) => handlers.set(name, fn),
      on: (name: string, fn: (event: unknown, input: unknown) => void) => listeners.set(name, fn),
      removeHandler() {},
      removeListener() {},
    },
    openExternal: (url: string) => externals.push(url),
  });
  const app = { sender: root, senderFrame: root.mainFrame };
  const command = (action: string, data = {}) => handlers.get("elpis:browser")!(app, { action, ...data });
  const fromPage = (wc: { mainFrame?: object; sender?: object; senderFrame?: object }, message: unknown) =>
    listeners.get("elpis:browser:page")!({ sender: wc, senderFrame: wc.mainFrame }, message);
  const state = () => states.at(-1)!;
  const toPage = (wc: Page, type: string) =>
    wc.sent.filter(item => item.channel === "elpis:annotate" && item.message.type === type).map(item => item.message);
  return {
    browser,
    command,
    fromPage,
    state,
    pages,
    views,
    menus,
    externals,
    clipboard,
    image,
    root,
    browserSession,
    toPage,
  };
}

const pick = {
  id: "pick-1",
  kind: "element",
  title: "Login",
  selector: "#login > button.primary",
  elementPath: "html > body > main > form > button",
  role: "button",
  name: "Sign in",
  nearbyText: "Email Password",
  immediateText: "Sign in",
  tag: "button",
  rect: { x: 10, y: 20, width: 120, height: 32 },
  isFixed: false,
  viewport: { width: 1280, height: 720 },
};

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function picked(f: ReturnType<typeof fixture>, page: Page, value: PickValue = pick) {
  f.fromPage(page, { type: "pick", pick: value });
  await settle();
  const paint = f.toPage(page, "paint").at(-1)!;
  assert.equal(paint.id, value.id, "the page draws the outline and number before the screenshot");
  f.fromPage(page, { type: "painted", id: value.id });
  await new Promise<void>(resolve => setTimeout(resolve, 150));
}

const fixtures = { fixture, pick, settle, picked };
export type Fixtures = typeof fixtures;
module.exports = fixtures;
