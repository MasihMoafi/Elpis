"use strict";
// In-app browser pages: the annotation layer (the ChatGPT app's "Annotate" mode). It runs in Electron's
// isolated world before the page's scripts, exposes nothing to the page and draws in a closed shadow root.
// Comments are typed in Elpis, never in the page, so the page cannot read them. Sandboxed preloads cannot
// load other files, so preload-path.cts bundles browser-page-locate.cts in front of it; tests/browser-annotate.test.cts runs it in Chromium.
import type { PageElement, Rect } from "./browser-page-locate.cts";
const { ipcRenderer }: typeof import("electron") = require("electron");
const {
  clean,
  role,
  name,
  ownText,
  nearby,
  selector,
  path,
  fixed,
  id,
  viewport,
  page,
}: typeof import("./browser-page-locate.cts") = require("./browser-page-locate.cts");
type Anchor = ReturnType<typeof import("./browser-annotations.cts").cleanPick>;
type Comment = { id: string; number: number; kind: string; pageUrl: string; anchor: Anchor; editing?: string | null };
type Layer = {
  host: HTMLElement;
  catcher: HTMLElement;
  hover: HTMLElement;
  label: HTMLElement;
  drag: HTMLElement;
  draft: HTMLElement;
  markers: HTMLElement[];
  shadow: ShadowRoot;
};
type Drag = { x: number; y: number; moved: boolean; rect: Rect | null };
type Message = {
  type?: string;
  mode?: boolean;
  markersVisible?: boolean;
  comments?: Comment[];
  draft?: Comment | null;
  x?: number;
  y?: number;
  id?: string;
};

const BLUE = "#2f6fed",
  WASH = "rgba(47,111,237,0.10)";
const send = (message: object) => {
  try {
    ipcRenderer.send("elpis:browser:page", message);
  } catch {
    /* the tab is closing */
  }
};
const elements = new Map<string, PageElement>();
let mode = false,
  markersVisible = true,
  comments: Comment[] = [],
  draft: Comment | null = null,
  space = false,
  hover: PageElement | null = null,
  drag: Drag | null = null,
  layer: Layer | null = null,
  frame = 0;

function style(element: HTMLElement, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) element.style.setProperty(key, value, "important");
  return element;
}
function box(shadow: ShadowRoot, values: Record<string, string>) {
  const element = document.createElement("div");
  style(element, {
    position: "fixed",
    "box-sizing": "border-box",
    "pointer-events": "none",
    display: "none",
    margin: "0",
    ...values,
  });
  shadow.append(element);
  return element;
}
const pill = {
  background: BLUE,
  color: "#fff",
  font: "600 11px/16px system-ui, sans-serif",
  padding: "1px 6px",
  "border-radius": "4px",
  "white-space": "nowrap",
  "letter-spacing": "0",
};

function ensureLayer() {
  const pageRoot = document.documentElement;
  if (!pageRoot) return null;
  // Modal dialogs make everything outside them inert. The annotation layer must be their child,
  // then enter Chromium's top layer so dialogs and popovers cannot cover its pointer catcher.
  const modals = mode ? [...document.querySelectorAll("dialog:modal")] : [];
  const root = modals.findLast(dialog => dialog.contains(document.activeElement)) ?? modals.at(-1) ?? pageRoot;
  if (!layer) {
    // Inline styles marked important: they win over any page stylesheet and are allowed under a strict CSP.
    const host = style(document.createElement("elpis-annotations"), {
      all: "initial",
      position: "fixed",
      inset: "0",
      "z-index": "2147483647",
      "pointer-events": "none",
      display: "block",
    });
    const shadow = host.attachShadow({ mode: "closed" });
    const catcher = box(shadow, { inset: "0", cursor: "crosshair", background: "transparent" });
    layer = {
      host,
      catcher,
      hover: box(shadow, { border: `2px solid ${BLUE}`, background: WASH, "border-radius": "3px" }),
      label: box(shadow, pill),
      drag: box(shadow, { border: `1.5px dashed ${BLUE}`, background: WASH }),
      draft: box(shadow, {
        border: `2px solid ${BLUE}`,
        background: "rgba(47,111,237,0.06)",
        "border-radius": "3px",
        "box-shadow": "0 0 0 3px rgba(47,111,237,0.25)",
      }),
      markers: [],
      shadow,
    };
    listen(catcher);
  }
  if (layer.host.parentElement !== root) {
    if (layer.host.matches(":popover-open")) layer.host.hidePopover();
    root.append(layer.host);
  }
  if (mode && typeof layer.host.showPopover === "function") {
    layer.host.setAttribute("popover", "manual");
    if (!layer.host.matches(":popover-open")) layer.host.showPopover();
  } else if (layer.host.hasAttribute("popover")) {
    if (layer.host.matches(":popover-open")) layer.host.hidePopover();
    layer.host.removeAttribute("popover");
  }
  return layer;
}

function elementAt(x: number, y: number): PageElement | null {
  return document.elementsFromPoint(x, y).find(element => element !== layer?.host) ?? null;
}

function pickElement(element: PageElement) {
  const pick: { id: string; isFixed: boolean; rect?: Rect; [key: string]: unknown } = {
    id: id(),
    kind: "element",
    title: clean(document.title, 200),
    selector: selector(element),
    elementPath: path(element),
    role: role(element),
    name: name(element),
    nearbyText: nearby(element),
    immediateText: ownText(element),
    tag: element.localName,
    isFixed: fixed(element),
    viewport: viewport(),
  };
  const rect = element.getBoundingClientRect();
  pick.rect = pick.isFixed ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : page(rect);
  elements.set(pick.id, element);
  send({ type: "pick", pick });
}
function pickRegion(rect: Rect) {
  const center = elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  send({
    type: "pick",
    pick: {
      id: id(),
      kind: "region",
      title: clean(document.title, 200),
      elementPath: center ? path(center) : null,
      nearbyText: center ? clean(center.innerText, 300) : null,
      isFixed: false,
      viewport: viewport(),
      rect: page(rect),
    },
  });
}
function selectionAt(x: number, y: number) {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return [...range.getClientRects()].some(
    rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2,
  )
    ? range
    : null;
}
function pickText(range: Range) {
  const rect = range.getBoundingClientRect(),
    container =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as PageElement)
        : range.commonAncestorContainer.parentElement;
  send({
    type: "pick",
    pick: {
      id: id(),
      kind: "text",
      title: clean(document.title, 200),
      selectedText: clean(range.toString(), 2000),
      elementPath: container ? path(container) : null,
      nearbyText: container ? clean(container.innerText, 300) : null,
      isFixed: false,
      viewport: viewport(),
      rect: page(rect),
    },
  });
}
function pickAt(x: number, y: number) {
  const range = selectionAt(x, y);
  if (range) return pickText(range);
  const element = elementAt(x, y);
  if (element) pickElement(element);
}

// --- Drawing ---
function rectOf(item: Comment) {
  let element = elements.get(item.id);
  if (!element?.isConnected && item.kind === "element" && item.anchor?.selector && item.pageUrl === location.href) {
    try {
      element = document.querySelector(item.anchor.selector) ?? undefined;
    } catch {
      element = undefined;
    }
    if (element) elements.set(item.id, element);
  }
  if (element?.isConnected) return element.getBoundingClientRect();
  if (item.pageUrl && item.pageUrl !== location.href) return null;
  const rect = item.anchor?.rect;
  if (!rect) return null;
  return item.anchor.isFixed
    ? rect
    : { x: rect.x - scrollX, y: rect.y - scrollY, width: rect.width, height: rect.height };
}
function place(element: HTMLElement, rect: Rect | null) {
  if (!rect) {
    style(element, { display: "none" });
    return;
  }
  style(element, {
    display: "block",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${Math.max(2, rect.width)}px`,
    height: `${Math.max(2, rect.height)}px`,
  });
}
function marker(index: number, layer: Layer) {
  if (!layer.markers[index]) {
    const element = box(layer.shadow, {
      width: "22px",
      height: "22px",
      "border-radius": "11px",
      background: BLUE,
      color: "#fff",
      border: "2px solid #fff",
      "box-shadow": "0 1px 4px rgba(0,0,0,0.35)",
      font: "700 11px/18px system-ui, sans-serif",
      "text-align": "center",
      cursor: "pointer",
      "letter-spacing": "0",
    });
    element.addEventListener("pointerdown", event => {
      event.stopPropagation();
      event.preventDefault();
    });
    element.addEventListener("click", event => {
      event.stopPropagation();
      if (mode && element.dataset.id) send({ type: "edit", id: element.dataset.id });
    });
    layer.markers[index] = element;
  }
  return layer.markers[index];
}
function render() {
  frame = 0;
  const layer = ensureLayer();
  if (!layer) return;
  const active = mode && !space;
  style(layer.catcher, { display: active ? "block" : "none", "pointer-events": active ? "auto" : "none" });
  const hovered = active && !drag?.moved && hover?.isConnected ? hover.getBoundingClientRect() : null;
  place(layer.hover, hovered);
  if (hovered && hover) {
    layer.label.textContent = `${hover.localName} · ${Math.round(hovered.width)}×${Math.round(hovered.height)}`;
    style(layer.label, {
      display: "block",
      left: `${Math.max(0, hovered.x)}px`,
      top: `${hovered.y >= 20 ? hovered.y - 20 : hovered.y + hovered.height + 2}px`,
    });
  } else style(layer.label, { display: "none" });
  place(layer.drag, drag?.moved ? drag.rect : null);
  const draftRect = draft ? rectOf(draft) : null;
  place(layer.draft, draftRect);
  const shown = [
    ...(markersVisible ? comments.filter(item => item.id !== draft?.editing) : []),
    ...(draft ? [draft] : []),
  ];
  shown.forEach((item, index) => {
    const element = marker(index, layer),
      rect = rectOf(item);
    if (!rect) {
      style(element, { display: "none" });
      return;
    }
    element.textContent = String(item.number);
    element.dataset.id = item === draft ? "" : item.id;
    style(element, {
      display: "block",
      left: `${Math.min(innerWidth - 24, Math.max(0, rect.x + rect.width - 11))}px`,
      top: `${Math.max(0, rect.y - 11)}px`,
      "pointer-events": mode && item !== draft ? "auto" : "none",
    });
  });
  for (const element of layer.markers.slice(shown.length)) style(element, { display: "none" });
}
const schedule = () => {
  if (!frame) frame = requestAnimationFrame(render);
};

function listen(catcher: HTMLElement) {
  catcher.addEventListener("mousedown", event => event.preventDefault());
  catcher.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, moved: false, rect: null };
    try {
      catcher.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointer */
    }
  });
  catcher.addEventListener("pointermove", event => {
    if (drag) {
      const width = event.clientX - drag.x,
        height = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(width, height) > 5) drag.moved = true;
      if (drag.moved)
        drag.rect = {
          x: Math.min(drag.x, event.clientX),
          y: Math.min(drag.y, event.clientY),
          width: Math.abs(width),
          height: Math.abs(height),
        };
    } else hover = elementAt(event.clientX, event.clientY);
    schedule();
  });
  catcher.addEventListener("pointerup", event => {
    const current = drag;
    drag = null;
    if (!current) return;
    if (current.moved && current.rect && current.rect.width >= 8 && current.rect.height >= 8) pickRegion(current.rect);
    else if (!current.moved) pickAt(event.clientX, event.clientY);
    schedule();
  });
  catcher.addEventListener("pointercancel", () => {
    drag = null;
    schedule();
  });
  catcher.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  catcher.addEventListener("pointerleave", () => {
    hover = null;
    schedule();
  });
  catcher.addEventListener(
    "wheel",
    event => {
      // The layer covers the page; scroll whatever is under the pointer so reading and annotating mix.
      event.preventDefault();
      for (let node = elementAt(event.clientX, event.clientY); node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (
          (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(css.overflowY)) ||
          (node.scrollWidth > node.clientWidth && /(auto|scroll)/.test(css.overflowX))
        ) {
          node.scrollBy(event.deltaX, event.deltaY);
          return;
        }
      }
      scrollBy(event.deltaX, event.deltaY);
    },
    { passive: false },
  );
}

const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  ((target as PageElement).isContentEditable || /^(input|textarea|select)$/.test(target.localName));
addEventListener(
  "keydown",
  event => {
    if (!mode) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: draft ? "cancel" : "exit" });
    } else if (event.code === "Space" && !editable(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!space) {
        space = true;
        hover = null;
        render();
      }
    }
  },
  true,
);
addEventListener(
  "keyup",
  event => {
    if (event.code === "Space" && space) {
      space = false;
      render();
    }
  },
  true,
);
addEventListener("blur", () => {
  if (space) {
    space = false;
    schedule();
  }
});
addEventListener("scroll", schedule, { capture: true, passive: true });
addEventListener("resize", schedule);
// A popup may open while Space temporarily gives the page control. Bring the catcher above that
// newly opened top-layer surface without closing it or changing the person's page selection.
addEventListener(
  "toggle",
  event => {
    if (
      !mode ||
      !layer ||
      event.target === layer.host ||
      !(event.target instanceof Element) ||
      !event.target.matches("dialog,[popover]")
    )
      return;
    if (layer.host.matches(":popover-open")) layer.host.hidePopover();
    schedule();
  },
  true,
);

ipcRenderer.on("elpis:annotate", (_event, message: Message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "state") {
    mode = message.mode === true;
    markersVisible = message.markersVisible !== false;
    comments = Array.isArray(message.comments) ? message.comments : [];
    draft = message.draft && typeof message.draft === "object" ? message.draft : null;
    if (!mode) {
      hover = null;
      drag = null;
      space = false;
    }
    for (const key of elements.keys())
      if (!comments.some(item => item.id === key) && draft?.id !== key) elements.delete(key);
    render();
  } else if (
    message.type === "pickAt" &&
    typeof message.x === "number" &&
    typeof message.y === "number" &&
    Number.isFinite(message.x) &&
    Number.isFinite(message.y)
  )
    pickAt(message.x, message.y);
  else if (message.type === "paint") {
    hover = null;
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "painted", id: message.id })));
  }
});
if (document.readyState === "loading")
  addEventListener("DOMContentLoaded", () => send({ type: "ready" }), { once: true });
else send({ type: "ready" });
