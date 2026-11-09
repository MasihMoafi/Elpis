"use strict";
import type { Event as ElectronEvent, IpcMainEvent, IpcMainInvokeEvent, Input, Rectangle } from "electron";
import type { BrowserContext, Command, Comment, Options, OpenOptions, Saved, Tab } from "./browser-types.cts";

const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");
const { browserUrl, trustedBrowserSender, nativeBounds, zoomStep, isSignInPage } =
  require("./browser-policy.cts") as typeof import("./browser-policy.cts");
const { commentLabel } = require("./browser-annotations.cts") as typeof import("./browser-annotations.cts");
const { pageMenu } = require("./browser-menu.cts") as typeof import("./browser-menu.cts");
const { keyboard } = require("./browser-keys.cts") as typeof import("./browser-keys.cts");
const { createComments } = require("./browser-comments.cts") as typeof import("./browser-comments.cts");
const { createTabView, findCommand, navigateTab, tabSnapshot, wireTab } =
  require("./browser-tab.cts") as typeof import("./browser-tab.cts");
const { savedBrowser, restoreTabs } = require("./browser-restore.cts") as typeof import("./browser-restore.cts");
const { createBrowserAgent } = require("./browser-agent.cts");
const { presentAsChrome, presentPageAsChrome } =
  require("./browser-identity.cts") as typeof import("./browser-identity.cts");

const PRELOAD = preloadPath("browser-page-preload");
const COMMANDS = ["action", "id", "url", "body", "text", "value"];

function createBrowserImpl({
  host,
  origin,
  WebContentsView,
  session,
  ipcMain,
  openExternal,
  Menu,
  clipboard,
  sessionId,
  onChange,
  presented = true,
}: Options) {
  const tabs = new Map<string, Tab>();
  let activeId: string | null = null,
    visible = false,
    bounds: Rectangle | null = null,
    obscured = false,
    focusAddress = 0,
    fullView = 0,
    disposed = false,
    presentation = 0;
  const browserSession = session.fromPartition("persist:elpis-browser");
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  presentAsChrome(browserSession);
  const active = () => tabs.get(activeId as string);
  // The app's page background (its theme token): a tab's page is painted with it, so a blank tab matches the app, not white.
  let background: string | null = null;
  const tint = (tab: Tab) => {
    if (background && !tab.view.webContents.isDestroyed()) tab.view.setBackgroundColor(background);
  };
  const setBackground = (color: string) => {
    background = color;
    for (const tab of tabs.values()) tint(tab);
  };
  const commentView = (tab: Tab, item: Comment) => ({
    id: item.id,
    number: item.number,
    kind: item.kind,
    label: commentLabel(item),
    body: item.body,
  });
  const snapshot = () => {
    const tab = active();
    return {
      ...(sessionId ? { sessionId, presentation } : {}),
      visible,
      activeId,
      focusAddress,
      fullView,
      annotating: comments.annotating(),
      markersVisible: comments.markersVisible(),
      agent: agent.state(),
      annotations: tab ? tab.comments.map(item => commentView(tab, item)) : [],
      draft: tab?.draft ? { ...commentView(tab, tab.draft), editing: !!tab.draft.editing } : null,
      find: tab
        ? {
            open: tab.find.open,
            text: tab.find.text,
            matches: tab.find.matches,
            active: tab.find.active,
            focus: tab.find.focus,
          }
        : { open: false, text: "", matches: 0, active: 0, focus: 0 },
      tabs: [...tabs.values()].map(tabSnapshot),
    };
  };
  const emit = () => {
    if (disposed) return;
    onChange?.();
    if (presented && !host.isDestroyed() && !host.webContents.isDestroyed())
      host.webContents.send("elpis:browser:state", snapshot());
  };
  const ctx: BrowserContext = {
    tabs,
    origin,
    Menu,
    clipboard,
    openExternal,
    popups: { times: [] },
    host: () => host,
    active,
    activeId: () => activeId,
    visible: () => visible,
    presented: () => presented,
    disposed: () => disposed,
    emit,
    place,
    focusInput,
    bumpFullView: () => {
      fullView++;
      emit();
    },
    zoom,
    openFind,
    open,
    close,
    select,
  };
  const comments = createComments(ctx);
  const agent = createBrowserAgent({
    tabs,
    open,
    origin,
    emit,
    prepare(id: string) {
      if (comments.annotating() && id === activeId) comments.setAnnotating(false);
    },
  });
  function place() {
    if (disposed || host.isDestroyed()) return;
    const size = host.getContentBounds();
    const rectangle = bounds ? nativeBounds(bounds, host.webContents.getZoomFactor(), size) : null;
    for (const tab of tabs.values()) {
      const show = presented && visible && !obscured && tab.id === activeId && !!rectangle;
      if (show) tab.view.setBounds(rectangle);
      tab.view.setVisible(show);
    }
  }
  function focusInput() {
    focusAddress++;
    if (presented) host.webContents.focus();
    emit();
  }
  // focus: true focuses the page, false the address bar of a blank tab, null nothing (the agent's tab).
  function select(id: string, focus: boolean | null = true) {
    if (!tabs.has(id)) throw Error("This browser tab is closed.");
    const previous = active();
    activeId = id;
    visible = true;
    place();
    if (previous && previous.id !== id) comments.syncPage(previous);
    comments.syncPage(tabs.get(id));
    emit();
    const tab = tabs.get(id)!;
    if (focus === null) return;
    if (presented && focus && tab.url !== "about:blank") tab.view.webContents.focus();
    else if (tab.url === "about:blank") focusInput();
  }
  function close(id: string | null) {
    const tab = tabs.get(id as string);
    if (!tab) return;
    const order = [...tabs.keys()],
      index = order.indexOf(id as string);
    tabs.delete(id as string);
    if (!host.isDestroyed()) host.contentView.removeChildView(tab.view);
    const webContents = tab.view.webContents;
    if (webContents && !webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
    if (activeId === id) {
      activeId = order[index + 1] ?? order[index - 1] ?? null;
      comments.syncPage(active());
    }
    if (!tabs.size) {
      visible = false;
      comments.stop();
    }
    place();
    emit();
  }
  const navigate = (tab: Tab, url: string) => navigateTab(ctx, tab, url);
  // An agent's tab opens behind the person's tab; it is shown only when he has none.
  function open(
    url = "about:blank",
    { focus = false, after = null, id = null, restoring = null, agent: owned = false }: OpenOptions = {},
  ) {
    const target = browserUrl(url, origin);
    if (tabs.size >= 20) throw Error("Close a browser tab before opening another (20 tab limit).");
    const tab = createTabView(ctx, WebContentsView, PRELOAD, { id, restoring, owned });
    const view = tab.view;
    tabs.set(tab.id, tab);
    if (after && tabs.has(after)) {
      const order = [...tabs.entries()].filter(([id]) => id !== tab.id),
        at = order.findIndex(([id]) => id === after) + 1;
      order.splice(at, 0, [tab.id, tab]);
      tabs.clear();
      for (const [id, item] of order) tabs.set(id, item);
    }
    const wc = view.webContents;
    tint(tab);
    // Electron needs a renderer for the identity override, but can restore history only before its first load.
    // Restore onto a temporary blank entry, set the identity, then select the saved entry and remove the temporary one.
    let initializing = true;
    const initial = restoring
      ? wc.navigationHistory.restore({
          entries: [...restoring.entries, { url: "about:blank", title: "New tab" }],
          index: restoring.entries.length,
        })
      : wc.loadURL("about:blank");
    tab.identityReady = initial
      .then(() => {
        initializing = false;
        if (!disposed && tabs.has(tab.id) && !wc.isDestroyed()) return presentPageAsChrome(wc);
      })
      .catch((error: unknown) => {
        initializing = false;
        const aborted =
          error instanceof Error &&
          (("code" in error && error.code === "ERR_ABORTED") || ("errno" in error && error.errno === -3));
        if (!disposed && tabs.has(tab.id) && !wc.isDestroyed() && !aborted) {
          tab.loading = false;
          tab.error = "The browser could not initialize this tab.";
          emit();
        }
        throw error;
      });
    agent.observe(tab);
    wireTab(
      ctx,
      tab,
      () => initializing,
      (params, page) => pageMenu(ctx, comments, page, params),
      (event, input, page) => keyboard(ctx, event, input, page),
    );
    if (!tab.agent) select(tab.id, focus);
    else if (active()) place();
    else select(tab.id, null);
    if (restoring) {
      tab.url = target;
      emit();
    } else navigate(tab, target);
    return tab.id;
  }

  function zoom(tab: Tab, direction: string) {
    const wc = tab.view.webContents;
    wc.setZoomFactor(zoomStep(wc.getZoomFactor(), direction)!);
    emit();
  }
  function openFind(tab: Tab) {
    tab.find.open = true;
    tab.find.focus++;
    emit();
    host.webContents.focus();
  }
  const rootKeyboard = (event: ElectronEvent, input: Input) => keyboard(ctx, event, input);
  const resetLayout = (_event: ElectronEvent, _url: string, inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !inPlace) {
      bounds = null;
      place();
    }
  };
  function detach() {
    if (!host.isDestroyed()) {
      host.webContents.removeListener("before-input-event", rootKeyboard);
      host.webContents.removeListener("did-start-navigation", resetLayout);
    }
    host.removeListener("resize", place);
  }
  function attach() {
    host.webContents.on("before-input-event", rootKeyboard);
    host.webContents.on("did-start-navigation", resetLayout);
    host.on("resize", place);
  }
  attach();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!trustedBrowserSender(event, host.webContents, origin))
      throw Error("Browser controls are available only to Elpis.");
  };
  const text = (value: unknown, limit: number, label: string) => {
    if (typeof value !== "string" || value.length > limit) throw Error(`Invalid ${label}.`);
    return value;
  };
  async function run(input: Command) {
    const tab = tabs.get((input.id ?? activeId) as string),
      current = active();
    const need = () => {
      if (!current) throw Error("Open a browser tab first.");
      return current;
    };
    const annotated = comments.command(input, need, current);
    if (annotated !== undefined) return annotated ? { ...snapshot(), result: annotated.result } : snapshot();
    switch (input.action) {
      case "state":
        break;
      case "agentStop":
        agent.stop();
        break;
      case "agentAllow":
        agent.allow();
        break;
      case "toggle":
        if (!tabs.size) open();
        else {
          visible = !visible;
          place();
          emit();
        }
        break;
      case "hide":
        visible = false;
        place();
        emit();
        break;
      case "new":
        if (input.id && !tab) throw Error("This browser tab is closed.");
        open(input.url, { after: input.id ?? null });
        break;
      case "select":
        select(input.id);
        break;
      case "close":
        close(input.id);
        break;
      case "navigate":
        if (!tab) throw Error("Open a browser tab first.");
        navigate(tab, input.url);
        break;
      case "back":
        if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
        break;
      case "forward":
        if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
        break;
      case "reload":
        tab?.view.webContents.reload();
        break;
      case "hardReload":
        tab?.view.webContents.reloadIgnoringCache();
        break;
      case "stop":
        if (tab) {
          tab.navigation++;
          tab.view.webContents.stop();
        }
        break;
      case "external-url": {
        const url = browserUrl(input.url, origin);
        if (!isSignInPage(url) || !openExternal) throw Error("Choose a Claude, OpenAI, or CloudRoom sign-in page.");
        await openExternal(url);
        break;
      }
      case "external":
        if (tab && /^https?:/.test(tab.url) && openExternal) void openExternal(tab.url);
        break;
      case "duplicate":
        if (tab) open(tab.url, { after: tab.id });
        break;
      case "rename":
        if (!tab) throw Error("This browser tab is closed.");
        tab.customTitle = text(input.text, 200, "tab name").trim() || null;
        emit();
        break;
      case "mute":
        if (!tab) throw Error("This browser tab is closed.");
        if (typeof input.value !== "boolean") throw Error("Invalid audio setting.");
        tab.view.webContents.setAudioMuted(input.value);
        emit();
        break;
      case "copyUrl":
        if (tab && /^https?:/.test(tab.url)) clipboard?.writeText(tab.url);
        break;
      case "zoom":
        if (!["in", "out", "reset"].includes(input.value as string)) throw Error("Invalid zoom.");
        zoom(need(), input.value as string);
        break;
      case "findOpen":
        openFind(need());
        break;
      case "find":
      case "findClose":
        findCommand(need(), input);
        emit();
        break;
      case "print":
        need().view.webContents.print({});
        break;
      case "devtools": {
        const wc = need().view.webContents;
        if (wc.isDevToolsOpened?.()) wc.closeDevTools?.();
        else wc.openDevTools({ mode: "detach" });
        break;
      }
      case "screenshot": {
        const page = need(),
          image = await page.view.webContents.capturePage();
        if (input.value === "copy") {
          clipboard?.writeImage(image);
          return { ...snapshot(), result: { copied: true } };
        }
        return { ...snapshot(), result: { image: await comments.capture(page) } };
      }
      case "clearData":
        if (input.value === "cookies") await browserSession.clearStorageData({ storages: ["cookies"] });
        else if (input.value === "cache") await browserSession.clearCache();
        else throw Error("Choose cookies or cache.");
        break;
      default:
        throw Error("Unknown browser command.");
    }
    return snapshot();
  }
  ipcMain.handle("elpis:browser", async (event, input) => {
    try {
      trusted(event);
      if (!input || typeof input !== "object" || Object.keys(input).some(key => !COMMANDS.includes(key)))
        throw Error("Invalid browser command.");
      return await run(input);
    } catch (error) {
      return { error: (error as Error).message || "The browser is unavailable. Try opening it again." };
    }
  });
  const layout = (event: IpcMainEvent, input: { bounds: Rectangle; obscured: boolean }) => {
    try {
      trusted(event);
      if (!input || typeof input.obscured !== "boolean") return;
      nativeBounds(input.bounds, 1, host.getContentBounds());
      bounds = input.bounds;
      obscured = input.obscured;
      place();
    } catch {
      /* Ignore malformed or untrusted layout messages. */
    }
  };
  ipcMain.on("elpis:browser:layout", layout);
  ipcMain.on("elpis:browser:page", comments.pageMessage);
  return {
    open,
    agent,
    setBackground,
    snapshot,
    present(value: boolean, nextHost = host) {
      if (value && (!presented || nextHost !== host)) presentation++;
      if (nextHost !== host) {
        detach();
        for (const tab of tabs.values()) {
          if (!host.isDestroyed()) host.contentView.removeChildView(tab.view);
          nextHost.contentView.addChildView(tab.view);
        }
        host = nextHost;
        attach();
        bounds = null;
      }
      presented = value;
      if (!value) {
        bounds = null;
        obscured = true;
      }
      place();
      if (value) emit();
    },
    saved: () => savedBrowser(tabs, visible, activeId),
    restore: (saved: Saved) =>
      restoreTabs(
        ctx,
        saved,
        id => {
          activeId = id;
        },
        shown => {
          visible = shown;
        },
      ),
    dispose() {
      agent.dispose();
      disposed = true;
      ipcMain.removeHandler("elpis:browser");
      ipcMain.removeListener("elpis:browser:layout", layout);
      ipcMain.removeListener("elpis:browser:page", comments.pageMessage);
      detach();
      for (const tab of tabs.values()) {
        if (!host.isDestroyed()) host.contentView.removeChildView(tab.view);
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
      }
      tabs.clear();
    },
  };
}
export declare const createBrowser: (options: unknown) => ReturnType<typeof createBrowserImpl>;
module.exports = { createBrowser: createBrowserImpl };
