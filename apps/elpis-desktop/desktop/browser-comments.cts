"use strict";
import type { IpcMainEvent } from "electron";
import type { BrowserContext, Command, Comment, Tab } from "./browser-types.cts";

const { cleanPick, commentsPrompt } =
  require("./browser-annotations.cts") as typeof import("./browser-annotations.cts");

// One screenshot sheet holds twelve panels; send these before adding more.
const MAX_COMMENTS = 12;
const text = (value: unknown, limit: number, label: string) => {
  if (typeof value !== "string" || value.length > limit) throw Error(`Invalid ${label}.`);
  return value;
};

/** Annotation mode (the ChatGPT app's "Annotate") follows the active tab; comments belong to their tab. */
function createCommentsImpl(ctx: BrowserContext) {
  let annotating = false,
    markersVisible = true;
  const painted = new Map<string, () => void>();
  // What the page layer draws: markers for saved comments and the outline of the one being written.
  function syncPage(tab: Tab | undefined) {
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const anchor = (item: Comment) => ({
      id: item.id,
      number: item.number,
      kind: item.kind,
      pageUrl: item.pageUrl,
      anchor: { selector: item.anchor.selector, rect: item.anchor.rect, isFixed: item.anchor.isFixed },
    });
    tab.view.webContents.send("elpis:annotate", {
      type: "state",
      mode: annotating && tab.id === ctx.activeId(),
      markersVisible,
      comments: tab.comments.map(anchor),
      draft: tab.draft ? { ...anchor(tab.draft), editing: tab.draft.editing || null } : null,
    });
  }
  // --- Annotation ---
  async function capture(tab: Tab) {
    const image = await tab.view.webContents.capturePage();
    if (!image || image.isEmpty?.()) return null;
    const scaled = image.getSize().width > 1280 ? image.resize({ width: 1280, quality: "good" }) : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(82).toString("base64")}`;
  }
  function paint(tab: Tab, id: string) {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        painted.delete(id);
        resolve();
      }, 700);
      painted.set(id, () => {
        clearTimeout(timer);
        painted.delete(id);
        resolve();
      });
      tab.view.webContents.send("elpis:annotate", { type: "paint", id });
    });
  }
  async function picked(tab: Tab, raw: unknown) {
    if (!annotating || tab.id !== ctx.activeId() || (tab.comments.length >= MAX_COMMENTS && !tab.draft?.editing))
      return;
    let pick;
    try {
      pick = cleanPick(raw);
    } catch {
      return;
    }
    const keep = tab.draft && !tab.draft.editing ? tab.draft.number : tab.comments.length + 1;
    tab.draft = {
      id: pick.id,
      number: keep,
      kind: pick.kind,
      pageUrl: tab.view.webContents.getURL() || tab.url,
      anchor: pick,
      body: "",
      screenshot: null,
      editing: null,
    };
    syncPage(tab);
    ctx.emit();
    ctx.host().webContents.focus();
    await paint(tab, pick.id);
    // Two animation frames commit the outline; the compositor can still present the frame after that.
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    const screenshot = await capture(tab).catch(() => null);
    const owner = tab.draft?.id === pick.id ? tab.draft : tab.comments.find(item => item.id === pick.id);
    if (owner) owner.screenshot = screenshot;
  }
  function editComment(tab: Tab, id: string) {
    const item = tab.comments.find(comment => comment.id === id);
    if (!item) throw Error("This comment was removed.");
    tab.draft = { ...item, editing: item.id };
    syncPage(tab);
    ctx.emit();
    ctx.host().webContents.focus();
  }
  function renumber(tab: Tab) {
    tab.comments.forEach((item, index) => {
      item.number = index + 1;
    });
    if (tab.draft && !tab.draft.editing) tab.draft.number = tab.comments.length + 1;
  }
  function setAnnotating(value: boolean) {
    if (value && !ctx.active()?.url.startsWith("http")) throw Error("Open a web page to annotate it.");
    annotating = value;
    const tab = ctx.active();
    if (!value && tab?.draft) tab.draft = null;
    if (tab) {
      syncPage(tab);
      if (value) tab.view.webContents.focus();
    }
    ctx.emit();
  }
  function collect(tab: Tab, images: boolean) {
    const comments = tab.comments.filter(item => item.body.trim());
    // Comments stay until the message that carries them is accepted ("annotationsSent").
    return {
      count: comments.length,
      text: comments.length ? commentsPrompt(comments, { images }) : "",
      images: images
        ? comments.filter(item => item.screenshot).map(item => ({ number: item.number, dataUrl: item.screenshot }))
        : [],
    };
  }
  function pageMessage(event: IpcMainEvent, message: { type: string; id: string; pick: unknown }) {
    const tab = [...ctx.tabs.values()].find(item => item.view.webContents === event.sender);
    if (!tab || event.senderFrame !== event.sender.mainFrame || !message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        syncPage(tab);
        break;
      case "pick":
        void picked(tab, message.pick);
        break;
      case "painted":
        painted.get(message.id)?.();
        break;
      case "edit":
        if (annotating && tab.id === ctx.activeId() && typeof message.id === "string")
          try {
            editComment(tab, message.id);
          } catch {}
        break;
      case "cancel":
        if (tab.draft) {
          tab.draft = null;
          syncPage(tab);
          ctx.emit();
        }
        break;
      case "exit":
        if (annotating && tab.id === ctx.activeId()) setAnnotating(false);
        break;
    }
  }

  /** Runs an annotation command; undefined means the command is not one, otherwise its extra result (or null). */
  function command(input: Command, need: () => Tab, current: Tab | undefined): { result: unknown } | null | undefined {
    switch (input.action) {
      case "annotate":
        setAnnotating(input.value === undefined ? !annotating : input.value === true);
        break;
      case "comment": {
        const page = need(),
          body = text(input.body, 8000, "comment").trim();
        if (!page.draft) throw Error("Select something on the page first.");
        if (!body) throw Error("Write a comment first.");
        if (page.draft.editing) {
          const item = page.comments.find(comment => comment.id === page.draft!.editing);
          if (item) item.body = body;
        } else page.comments.push({ ...page.draft, number: page.comments.length + 1, body, editing: null });
        page.draft = null;
        syncPage(page);
        ctx.emit();
        break;
      }
      case "commentEdit":
        editComment(need(), text(input.id, 100, "comment"));
        break;
      case "commentDelete": {
        const page = need();
        page.comments = page.comments.filter(item => item.id !== input.id);
        if (page.draft?.editing === input.id) page.draft = null;
        renumber(page);
        syncPage(page);
        ctx.emit();
        break;
      }
      case "commentCancel": {
        const page = need();
        page.draft = null;
        syncPage(page);
        ctx.emit();
        break;
      }
      case "markers":
        markersVisible = !markersVisible;
        syncPage(current);
        ctx.emit();
        break;
      case "annotationsDiscard": {
        const page = need();
        page.comments = [];
        page.draft = null;
        syncPage(page);
        ctx.emit();
        break;
      }
      case "annotationsCollect":
        return { result: collect(need(), input.value === "images") };
      case "annotationsSent": {
        const page = need();
        page.comments = [];
        page.draft = null;
        annotating = false;
        syncPage(page);
        ctx.emit();
        break;
      }
      default:
        return undefined;
    }
    return null;
  }
  return {
    annotating: () => annotating,
    markersVisible: () => markersVisible,
    stop: () => {
      annotating = false;
    },
    syncPage,
    capture,
    setAnnotating,
    pageMessage,
    command,
  };
}
export declare const createComments: typeof createCommentsImpl;
module.exports = { createComments: createCommentsImpl };
