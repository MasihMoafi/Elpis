"use strict";
import type { ContextMenuParams, Event as ElectronEvent, Input, WebContentsView as View } from "electron";
import type { BrowserContext, Command, RestoreHistory, Tab } from "./browser-types.cts";

const { randomUUID } = require("node:crypto");
const { browserUrl, loadFailure, pageSecurity } =
  require("./browser-policy.cts") as typeof import("./browser-policy.cts");

/** A new tab's page, sandboxed and off screen until it is selected. */
function createTabViewImpl(
  ctx: BrowserContext,
  WebContentsView: typeof View,
  PRELOAD: string,
  { id, restoring, owned }: { id: string | null; restoring: RestoreHistory | null; owned: boolean },
): Tab {
  const host = ctx.host();
  // Electron focuses a page on every navigation by default; an agent's page loads must never take the person's keyboard.
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:elpis-browser",
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      plugins: true,
      webviewTag: false,
      focusOnNavigation: owned !== true,
      // A launch with --remote-debugging-port=0 (Playwright, agent-driven instances) marks every page as automated (navigator.webdriver); sign-in pages refuse that.
      disableBlinkFeatures: "AutomationControlled",
    },
  });
  view.setVisible(false);
  // A session can receive agent input before its pane has ever been shown.
  const { width, height } = host.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
  host.contentView.addChildView(view);
  const tab: Tab = {
    id: typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id) && !ctx.tabs.has(id) ? id : randomUUID(),
    url: "about:blank",
    title: "New tab",
    customTitle: null,
    agent: owned === true,
    loading: false,
    error: null,
    failure: null,
    view,
    identityReady: Promise.resolve(),
    navigation: 0,
    pendingHistory: restoring,
    comments: [],
    draft: null,
    find: { open: false, text: "", matches: 0, active: 0, focus: 0 },
  };
  return tab;
}

/** Keeps a tab's state in step with its page, and keeps the page inside what the browser allows. */
function wireTabImpl(
  ctx: BrowserContext,
  tab: Tab,
  initializing: () => boolean,
  menu: (params: ContextMenuParams, tab: Tab) => void,
  keys: (event: ElectronEvent, input: Input, tab: Tab) => void,
) {
  const wc = tab.view.webContents;
  wc.on("will-attach-webview", event => event.preventDefault());
  const guard = (event: ElectronEvent, url: string) => {
    try {
      browserUrl(url, ctx.origin);
    } catch {
      event.preventDefault();
      tab.error = "This address cannot be opened in the browser.";
      ctx.emit();
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(({ url }) => {
    const now = Date.now();
    ctx.popups.times = ctx.popups.times.filter(time => now - time < 10000);
    if (ctx.popups.times.length < 5) {
      try {
        ctx.open(url, { agent: tab.agent });
        ctx.popups.times.push(now);
      } catch {}
    }
    return { action: "deny" };
  });
  wc.on("did-start-loading", () => {
    tab.loading = true;
    tab.error = null;
    ctx.emit();
  });
  wc.on("did-stop-loading", () => {
    tab.loading = false;
    ctx.emit();
  });
  wc.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace && tab.failure) {
      tab.failure = null;
      ctx.emit();
    }
  });
  const navigated = (_event: ElectronEvent, url: string) => {
    if (initializing() && url === "about:blank") return;
    tab.url = url;
    tab.error = null;
    tab.failure = null;
    if (tab.pendingHistory && wc.navigationHistory.removeEntryAtIndex(tab.pendingHistory.entries.length))
      tab.pendingHistory = null;
    ctx.emit();
  };
  wc.on("did-navigate", navigated);
  wc.on("did-navigate-in-page", (event, url, isMainFrame) => {
    if (isMainFrame) navigated(event, url);
  });
  wc.on("page-title-updated", (_event, title) => {
    if (!initializing()) {
      tab.title = String(title).slice(0, 200) || "New tab";
      ctx.emit();
    }
  });
  wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      tab.loading = false;
      tab.error = description;
      tab.failure = loadFailure(code, description, url || tab.url);
      ctx.emit();
    }
  });
  wc.on("render-process-gone", () => {
    tab.loading = false;
    tab.error = "This page stopped responding. Reload to try again.";
    ctx.emit();
  });
  wc.on("found-in-page", (_event, result) => {
    if (result?.finalUpdate) {
      tab.find.matches = result.matches;
      tab.find.active = result.activeMatchOrdinal;
      ctx.emit();
    }
  });
  wc.on("context-menu", (_event, params) => menu(params, tab));
  wc.on("destroyed", () => {
    if (!ctx.disposed()) ctx.close(tab.id);
  });
  wc.on("before-input-event", (event, input) => keys(event, input, tab));
}

const tabSnapshotImpl = (item: Tab) => ({
  id: item.id,
  url: item.url,
  title: item.customTitle ?? item.title,
  customTitle: item.customTitle,
  muted: item.view.webContents.isAudioMuted?.() ?? false,
  loading: item.loading,
  error: item.error,
  failure: item.failure,
  security: pageSecurity(item.url),
  zoom: Math.round(item.view.webContents.getZoomFactor() * 100),
  comments: item.comments.length,
  canGoBack: item.pendingHistory ? item.pendingHistory.index > 0 : item.view.webContents.navigationHistory.canGoBack(),
  canGoForward: item.pendingHistory
    ? item.pendingHistory.index < item.pendingHistory.entries.length - 1
    : item.view.webContents.navigationHistory.canGoForward(),
});

function navigateTabImpl(ctx: BrowserContext, tab: Tab, url: string) {
  const target = browserUrl(url, ctx.origin);
  tab.pendingHistory = null;
  tab.url = target;
  tab.error = null;
  tab.failure = null;
  tab.title =
    tab.url === "about:blank"
      ? "New tab"
      : new URL(tab.url).hostname || decodeURIComponent(new URL(tab.url).pathname.split("/").pop() || "File");
  ctx.emit();
  const revision = ++tab.navigation,
    wc = tab.view.webContents;
  // A new tab (including an OAuth popup) must have its identity before its first document loads.
  // did-fail-load owns page errors; Stop and replaced navigations also reject loadURL.
  void tab.identityReady
    .then(() => {
      if (!ctx.disposed() && ctx.tabs.has(tab.id) && !wc.isDestroyed() && tab.navigation === revision)
        return wc.loadURL(target);
    })
    .catch(() => {});
}

/** Find in page: `find` searches or steps through matches, `findClose` ends the search. */
function findCommandImpl(page: Tab, input: Command) {
  if (input.action === "findClose") {
    page.view.webContents.stopFindInPage("keepSelection");
    page.find = { ...page.find, open: false, matches: 0, active: 0 };
    return;
  }
  if (typeof input.text !== "string" || input.text.length > 500) throw Error("Invalid search.");
  const query = input.text,
    again = page.find.text === query;
  page.find = { ...page.find, open: true, text: query };
  // Electron's findNext starts a new search session: true for new text, false to step through matches.
  if (query) page.view.webContents.findInPage(query, { forward: input.value !== "previous", findNext: !again });
  else {
    page.view.webContents.stopFindInPage("clearSelection");
    page.find.matches = 0;
    page.find.active = 0;
  }
}
export declare const createTabView: typeof createTabViewImpl;
export declare const findCommand: typeof findCommandImpl;
export declare const navigateTab: typeof navigateTabImpl;
export declare const tabSnapshot: typeof tabSnapshotImpl;
export declare const wireTab: typeof wireTabImpl;
module.exports = {
  createTabView: createTabViewImpl,
  findCommand: findCommandImpl,
  navigateTab: navigateTabImpl,
  tabSnapshot: tabSnapshotImpl,
  wireTab: wireTabImpl,
};
