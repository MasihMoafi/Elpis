"use strict";
// What a selection says about the page (untrusted evidence; main checks every field). preload-path.cts bundles this into the sandboxed preload.
export type PageElement = Element &
  Partial<Pick<HTMLElement, "innerText" | "isContentEditable">> & { labels?: NodeListOf<HTMLLabelElement> | null };
export type Rect = { x: number; y: number; width: number; height: number };
const ROLESImpl: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  img: "img",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  ul: "list",
  ol: "list",
  li: "listitem",
  table: "table",
  form: "form",
  dialog: "dialog",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};
const INPUTSImpl: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
  range: "slider",
  search: "searchbox",
};
const cleanImpl = (value: string | null | undefined, limit: number) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, limit) : null;
};
function roleImpl(element: PageElement) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.split(/\s+/)[0];
  if (element.localName === "a") return element.hasAttribute("href") ? "link" : null;
  if (element.localName === "input") return INPUTSImpl[(element as HTMLInputElement).type] ?? "textbox";
  return ROLESImpl[element.localName] ?? null;
}
function nameImpl(element: PageElement) {
  const labelled = element.getAttribute("aria-labelledby");
  const byId = labelled
    ? labelled
        .split(/\s+/)
        .map(id => document.getElementById(id)?.innerText ?? "")
        .join(" ")
    : "";
  const label = element.labels?.[0]?.innerText;
  const own =
    element.getAttribute("aria-label") ||
    byId ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    label;
  if (cleanImpl(own, 200)) return cleanImpl(own, 200);
  const text = cleanImpl(element.innerText, 400);
  return text && text.length <= 120 ? text : null;
}
function ownTextImpl(element: PageElement) {
  return cleanImpl(
    [...element.childNodes]
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent)
      .join(" "),
    200,
  );
}
function nearbyImpl(element: PageElement) {
  for (let node = element.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const text = cleanImpl(node.innerText, 300);
    if (text && text !== cleanImpl(element.innerText, 300)) return text;
  }
  return null;
}
const escapeImpl = (value: string) =>
  typeof globalThis.CSS?.escape === "function" ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");
function selectorImpl(element: PageElement) {
  const parts = [];
  for (
    let node: PageElement | null = element;
    node && node.nodeType === 1 && parts.length < 10;
    node = node.parentElement
  ) {
    if (
      node.id &&
      /^[A-Za-z][\w-]*$/.test(node.id) &&
      document.querySelectorAll(`#${escapeImpl(node.id)}`).length === 1
    ) {
      parts.unshift(`#${escapeImpl(node.id)}`);
      break;
    }
    let part = node.localName;
    const classes = [...node.classList]
      .filter(nameImpl => /^[A-Za-z][\w-]{0,40}$/.test(nameImpl) && !/\d{3,}/.test(nameImpl))
      .slice(0, 3);
    if (classes.length) part += `.${classes.map(escapeImpl).join(".")}`;
    const parent: HTMLElement | null = node.parentElement;
    if (parent && node.localName !== "body" && node.localName !== "html") {
      const same = [...parent.children].filter(
        child =>
          child.localName === node.localName &&
          (!classes.length || classes.every(nameImpl => child.classList.contains(nameImpl))),
      );
      if (same.length > 1)
        part += `:nth-of-type(${[...parent.children].filter(child => child.localName === node.localName).indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.localName === "body") break;
  }
  const value = parts.join(" > ");
  try {
    return document.querySelector(value) === element ? value : null;
  } catch {
    return null;
  }
}
function pathImpl(element: PageElement) {
  const parts = [];
  for (let node: PageElement | null = element; node && node.nodeType === 1; node = node.parentElement)
    parts.unshift(node.localName);
  return (parts.length > 12 ? ["…", ...parts.slice(-11)] : parts).join(" > ");
}
function fixedImpl(element: PageElement) {
  for (
    let node: PageElement | null = element, depth = 0;
    node && node.nodeType === 1 && depth < 12;
    node = node.parentElement, depth++
  )
    if (/^(fixedImpl|sticky)$/.test(getComputedStyle(node).position)) return true;
  return false;
}
const idImpl = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const viewportImpl = () => ({ width: innerWidth, height: innerHeight });
const pageImpl = (rect: Rect) => ({ x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height });

export declare const ROLES: typeof ROLESImpl;
export declare const INPUTS: typeof INPUTSImpl;
export declare const clean: typeof cleanImpl;
export declare const role: typeof roleImpl;
export declare const name: typeof nameImpl;
export declare const ownText: typeof ownTextImpl;
export declare const nearby: typeof nearbyImpl;
export declare const escape: typeof escapeImpl;
export declare const selector: typeof selectorImpl;
export declare const path: typeof pathImpl;
export declare const fixed: typeof fixedImpl;
export declare const id: typeof idImpl;
export declare const viewport: typeof viewportImpl;
export declare const page: typeof pageImpl;
module.exports = {
  ROLES: ROLESImpl,
  INPUTS: INPUTSImpl,
  clean: cleanImpl,
  role: roleImpl,
  name: nameImpl,
  ownText: ownTextImpl,
  nearby: nearbyImpl,
  escape: escapeImpl,
  selector: selectorImpl,
  path: pathImpl,
  fixed: fixedImpl,
  id: idImpl,
  viewport: viewportImpl,
  page: pageImpl,
};
