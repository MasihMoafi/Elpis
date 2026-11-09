"use strict";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { BrowserContext, Tab } from "./browser-types.cts";

const { contextMenuTemplate } = require("./context-menu.cts") as typeof import("./context-menu.cts");

/** Right-click on a page, as in the ChatGPT app's browser. */
function pageMenuImpl(
  ctx: BrowserContext,
  comments: { annotating: () => boolean; setAnnotating: (value: boolean) => void },
  tab: Tab,
  params: ContextMenuParams,
) {
  const { Menu, clipboard, origin, openExternal, open, select } = ctx;
  if (!Menu) return;
  const wc = tab.view.webContents,
    zoom = wc.getZoomFactor() || 1,
    x = Math.round(params.x / zoom),
    y = Math.round(params.y / zoom),
    groups: MenuItemConstructorOptions[][] = [];
  // Text, spelling, image and link items are the app's own (desktop/context-menu.cts); a link opens in a new tab.
  const shared = contextMenuTemplate(params, {
    contents: wc,
    clipboard,
    origin,
    openLink: url => {
      try {
        open(url);
      } catch {}
    },
  });
  if (/^https?:/i.test(params.linkURL || "") && openExternal)
    shared.push({ label: "Open link in external browser", click: () => void openExternal(params.linkURL) });
  if (shared.length) groups.push(shared);
  groups.push([
    { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: "Reload", click: () => wc.reload() },
  ]);
  groups.push([
    {
      label: "Comment",
      enabled: /^https?:/.test(tab.url),
      click: () => {
        try {
          if (tab.id !== ctx.activeId()) select(tab.id);
          if (!comments.annotating()) comments.setAnnotating(true);
          wc.send("elpis:annotate", { type: "pickAt", x, y });
        } catch {}
      },
    },
    {
      label: "Inspect",
      click: () => {
        if (!wc.isDevToolsOpened?.()) wc.openDevTools({ mode: "detach" });
        wc.inspectElement(params.x, params.y);
      },
    },
  ]);
  Menu.buildFromTemplate(groups.flatMap((group, index) => (index ? [{ type: "separator" }, ...group] : group))).popup({
    window: ctx.host(),
  });
}
export declare const pageMenu: typeof pageMenuImpl;
module.exports = { pageMenu: pageMenuImpl };
