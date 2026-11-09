"use strict";
import type { BrowserContext, Saved, Tab } from "./browser-types.cts";

const { browserUrl } = require("./browser-policy.cts") as typeof import("./browser-policy.cts");

function savedBrowserImpl(tabs: Map<string, Tab>, visible: boolean, activeId: string | null) {
  return {
    visible,
    activeId,
    tabs: [...tabs.values()].map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      customTitle: tab.customTitle,
      agent: tab.agent,
      muted: tab.view.webContents.isAudioMuted?.() ?? false,
      zoom: tab.view.webContents.getZoomFactor(),
      history: tab.pendingHistory?.entries ?? tab.view.webContents.navigationHistory.getAllEntries?.(),
      historyIndex: tab.pendingHistory?.index ?? tab.view.webContents.navigationHistory.getActiveIndex?.(),
    })),
  };
}

async function restoreTabsImpl(
  ctx: BrowserContext,
  saved: Saved,
  setActive: (id: string) => void,
  setVisible: (shown: boolean) => void,
) {
  if (!saved || !Array.isArray(saved.tabs)) return;
  const preparations: Promise<void>[] = [];
  for (const item of saved.tabs.slice(0, 20)) {
    try {
      const history =
        Array.isArray(item.history) &&
        item.history.length &&
        Number.isInteger(item.historyIndex) &&
        item.historyIndex >= 0 &&
        item.historyIndex < item.history.length
          ? item.history.map(entry => ({ ...entry, url: browserUrl(entry.url, ctx.origin) }))
          : null;
      const pending = history ? { entries: history, index: item.historyIndex } : null;
      const id = ctx.open(item.url, { id: item.id, restoring: pending, agent: item.agent === true }),
        tab = ctx.tabs.get(id)!,
        wc = tab.view.webContents;
      if (typeof item.title === "string") tab.title = item.title.slice(0, 200);
      if (typeof item.customTitle === "string") tab.customTitle = item.customTitle.trim().slice(0, 200) || null;
      if (item.muted === true) wc.setAudioMuted(true);
      if (Number.isFinite(item.zoom) && item.zoom >= 0.25 && item.zoom <= 5) wc.setZoomFactor(item.zoom);
      // Start the saved entry after identity setup; do not wait for the remote site to switch chats.
      if (pending) {
        preparations.push(
          tab.identityReady
            .then(() => {
              if (!ctx.disposed() && ctx.tabs.has(id) && !wc.isDestroyed() && tab.navigation === 0) {
                wc.navigationHistory.goToIndex(pending.index);
              }
            })
            .catch(() => {}),
        );
      }
    } catch {
      /* An unavailable or previously blocked address must not expose another session. */
    }
  }
  if (ctx.tabs.has(saved.activeId)) setActive(saved.activeId);
  setVisible(saved.visible === true && ctx.tabs.size > 0);
  ctx.place();
  ctx.emit();
  await Promise.all(preparations);
}
export declare const savedBrowser: typeof savedBrowserImpl;
export declare const restoreTabs: typeof restoreTabsImpl;
module.exports = { savedBrowser: savedBrowserImpl, restoreTabs: restoreTabsImpl };
