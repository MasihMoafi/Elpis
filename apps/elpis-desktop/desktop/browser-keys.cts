"use strict";
import type { Event as ElectronEvent, Input } from "electron";
import type { BrowserContext, Tab } from "./browser-types.cts";

function keyboardImpl(ctx: BrowserContext, event: ElectronEvent, input: Input, tab: Tab | null = null) {
  const { tabs, focusInput, open, close, select, zoom, openFind } = ctx;
  const activeId = ctx.activeId();
  // Only the shown page has the person's keyboard; keys on a background page are the agent's.
  if (input.type !== "keyDown" || !ctx.visible() || !ctx.presented() || (tab && tab.id !== activeId)) return;
  const key = input.key.toLowerCase(),
    primary = (input.control || input.meta) && !input.alt;
  const page = tab ?? null,
    act = (fn: () => void) => {
      event.preventDefault();
      fn();
    };
  if (page && input.alt && !input.control && !input.meta && (key === "arrowleft" || key === "arrowright"))
    return act(() => {
      const history = page.view.webContents.navigationHistory;
      if (key === "arrowleft" && history.canGoBack()) history.goBack();
      else if (key === "arrowright" && history.canGoForward()) history.goForward();
    });
  if (page && key === "f5")
    return act(() => (input.shift ? page.view.webContents.reloadIgnoringCache() : page.view.webContents.reload()));
  if (!primary) return;
  if (key === "l") act(focusInput);
  // In Elpis's own window Ctrl+T, Ctrl+W and Ctrl+Tab belong to the chat tabs (the renderer); a page that has the focus keeps them for the side panel's page tabs.
  else if (!page) return;
  else if (key === "t")
    act(() => {
      try {
        open();
      } catch {}
    });
  else if (key === "w") act(() => close(activeId));
  else if (key === "tab" && tabs.size)
    act(() => {
      const ids = [...tabs.keys()],
        index = ids.indexOf(activeId as string);
      select(ids[(index + (input.shift ? ids.length - 1 : 1)) % ids.length]!);
    });
  else if (key === "r")
    act(() => (input.shift ? page.view.webContents.reloadIgnoringCache() : page.view.webContents.reload()));
  // Ctrl+Shift+F is full view (the window toggles it when the count changes), not find.
  else if (key === "f" && input.shift)
    act(() => {
      ctx.bumpFullView();
    });
  else if (key === "f") act(() => openFind(page));
  else if (key === "=" || key === "+") act(() => zoom(page, "in"));
  else if (key === "-") act(() => zoom(page, "out"));
  else if (key === "0") act(() => zoom(page, "reset"));
  else if (key === "p") act(() => page.view.webContents.print({}));
}
export declare const keyboard: typeof keyboardImpl;
module.exports = { keyboard: keyboardImpl };
