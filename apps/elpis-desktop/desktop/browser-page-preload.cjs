'use strict';
// In-app browser pages: the annotation layer (the ChatGPT app's "Annotate" mode). It runs in Electron's
// isolated world before the page's scripts, exposes nothing to the page and draws in a closed shadow root.
// Comments are typed in Elpis, never in the page, so the page cannot read them. Sandboxed preloads cannot
// load other files, so this file stands alone; tests/browser-annotate.test.cjs runs it in Chromium.
const { ipcRenderer } = require('electron');

const BLUE = '#2f6fed', WASH = 'rgba(47,111,237,0.10)';
const send = message => { try { ipcRenderer.send('elpis:browser:page', message); } catch { /* the tab is closing */ } };
const elements = new Map();
let mode = false, markersVisible = true, comments = [], draft = null, space = false, hover = null, drag = null, layer = null, frame = 0;

function style(element, values) { for (const [key, value] of Object.entries(values)) element.style.setProperty(key, value, 'important'); return element; }
function box(shadow, values) { const element = document.createElement('div'); style(element, { position: 'fixed', 'box-sizing': 'border-box', 'pointer-events': 'none', display: 'none', margin: '0', ...values }); shadow.append(element); return element; }
const pill = { background: BLUE, color: '#fff', font: '600 11px/16px system-ui, sans-serif', padding: '1px 6px', 'border-radius': '4px', 'white-space': 'nowrap', 'letter-spacing': '0' };

function ensureLayer() {
  const root = document.documentElement; if (!root) return null;
  if (!layer) {
    // Inline styles marked important: they win over any page stylesheet and are allowed under a strict CSP.
    const host = style(document.createElement('elpis-annotations'), { all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483647', 'pointer-events': 'none', display: 'block' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const catcher = box(shadow, { inset: '0', cursor: 'crosshair', background: 'transparent' });
    layer = { host, catcher, hover: box(shadow, { border: `2px solid ${BLUE}`, background: WASH, 'border-radius': '3px' }), label: box(shadow, pill),
      drag: box(shadow, { border: `1.5px dashed ${BLUE}`, background: WASH }), draft: box(shadow, { border: `2px solid ${BLUE}`, background: 'rgba(47,111,237,0.06)', 'border-radius': '3px', 'box-shadow': '0 0 0 3px rgba(47,111,237,0.25)' }), markers: [] , shadow };
    listen(catcher);
  }
  if (!layer.host.isConnected) root.append(layer.host);
  return layer;
}

// --- What a selection says about the page (untrusted evidence; main checks every field). ---
const ROLES = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', ul: 'list', ol: 'list', li: 'listitem', table: 'table', form: 'form', dialog: 'dialog', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
const INPUTS = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox' };
const clean = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, limit) : null; };
function role(element) {
  const explicit = element.getAttribute('role'); if (explicit) return explicit.split(/\s+/)[0];
  if (element.localName === 'a') return element.hasAttribute('href') ? 'link' : null;
  if (element.localName === 'input') return INPUTS[element.type] ?? 'textbox';
  return ROLES[element.localName] ?? null;
}
function name(element) {
  const labelled = element.getAttribute('aria-labelledby');
  const byId = labelled ? labelled.split(/\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' ') : '';
  const label = element.labels?.[0]?.innerText;
  const own = element.getAttribute('aria-label') || byId || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || label;
  if (clean(own, 200)) return clean(own, 200);
  const text = clean(element.innerText, 400);
  return text && text.length <= 120 ? text : null;
}
function ownText(element) { return clean([...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' '), 200); }
function nearby(element) {
  for (let node = element.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const text = clean(node.innerText, 300); if (text && text !== clean(element.innerText, 300)) return text;
  }
  return null;
}
const escape = value => (globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&'));
function selector(element) {
  const parts = [];
  for (let node = element; node && node.nodeType === 1 && parts.length < 10; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${escape(node.id)}`).length === 1) { parts.unshift(`#${escape(node.id)}`); break; }
    let part = node.localName;
    const classes = [...node.classList].filter(name => /^[A-Za-z][\w-]{0,40}$/.test(name) && !/\d{3,}/.test(name)).slice(0, 3);
    if (classes.length) part += `.${classes.map(escape).join('.')}`;
    const parent = node.parentElement;
    if (parent && node.localName !== 'body' && node.localName !== 'html') {
      const same = [...parent.children].filter(child => child.localName === node.localName && (!classes.length || classes.every(name => child.classList.contains(name))));
      if (same.length > 1) part += `:nth-of-type(${[...parent.children].filter(child => child.localName === node.localName).indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.localName === 'body') break;
  }
  const value = parts.join(' > ');
  try { return document.querySelector(value) === element ? value : null; } catch { return null; }
}
function path(element) {
  const parts = []; for (let node = element; node && node.nodeType === 1; node = node.parentElement) parts.unshift(node.localName);
  return (parts.length > 12 ? ['…', ...parts.slice(-11)] : parts).join(' > ');
}
function fixed(element) {
  for (let node = element, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) if (/^(fixed|sticky)$/.test(getComputedStyle(node).position)) return true;
  return false;
}
const id = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const viewport = () => ({ width: innerWidth, height: innerHeight });
const page = rect => ({ x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height });
function elementAt(x, y) { return document.elementsFromPoint(x, y).find(element => element !== layer?.host) ?? null; }

function pickElement(element) {
  const pick = { id: id(), kind: 'element', title: clean(document.title, 200), selector: selector(element), elementPath: path(element), role: role(element), name: name(element),
    nearbyText: nearby(element), immediateText: ownText(element), tag: element.localName, isFixed: fixed(element), viewport: viewport() };
  const rect = element.getBoundingClientRect();
  pick.rect = pick.isFixed ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : page(rect);
  elements.set(pick.id, element); send({ type: 'pick', pick });
}
function pickRegion(rect) {
  const center = elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  send({ type: 'pick', pick: { id: id(), kind: 'region', title: clean(document.title, 200), elementPath: center ? path(center) : null, nearbyText: center ? clean(center.innerText, 300) : null, isFixed: false, viewport: viewport(), rect: page(rect) } });
}
function selectionAt(x, y) {
  const selection = getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return [...range.getClientRects()].some(rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) ? range : null;
}
function pickText(range) {
  const rect = range.getBoundingClientRect(), container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  send({ type: 'pick', pick: { id: id(), kind: 'text', title: clean(document.title, 200), selectedText: clean(range.toString(), 2000), elementPath: container ? path(container) : null, nearbyText: container ? clean(container.innerText, 300) : null, isFixed: false, viewport: viewport(), rect: page(rect) } });
}
function pickAt(x, y) {
  const range = selectionAt(x, y); if (range) return pickText(range);
  const element = elementAt(x, y); if (element) pickElement(element);
}

// --- Drawing ---
function rectOf(item) {
  let element = elements.get(item.id);
  if (!element?.isConnected && item.kind === 'element' && item.anchor?.selector && item.pageUrl === location.href) {
    try { element = document.querySelector(item.anchor.selector); } catch { element = null; }
    if (element) elements.set(item.id, element);
  }
  if (element?.isConnected) return element.getBoundingClientRect();
  if (item.pageUrl && item.pageUrl !== location.href) return null;
  const rect = item.anchor?.rect; if (!rect) return null;
  return item.anchor.isFixed ? rect : { x: rect.x - scrollX, y: rect.y - scrollY, width: rect.width, height: rect.height };
}
function place(element, rect) {
  if (!rect) { style(element, { display: 'none' }); return; }
  style(element, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${Math.max(2, rect.width)}px`, height: `${Math.max(2, rect.height)}px` });
}
function marker(index) {
  if (!layer.markers[index]) {
    const element = box(layer.shadow, { width: '22px', height: '22px', 'border-radius': '11px', background: BLUE, color: '#fff', border: '2px solid #fff', 'box-shadow': '0 1px 4px rgba(0,0,0,0.35)',
      font: '700 11px/18px system-ui, sans-serif', 'text-align': 'center', cursor: 'pointer', 'letter-spacing': '0' });
    element.addEventListener('pointerdown', event => { event.stopPropagation(); event.preventDefault(); });
    element.addEventListener('click', event => { event.stopPropagation(); if (mode && element.dataset.id) send({ type: 'edit', id: element.dataset.id }); });
    layer.markers[index] = element;
  }
  return layer.markers[index];
}
function render() {
  frame = 0; if (!ensureLayer()) return;
  const active = mode && !space;
  style(layer.catcher, { display: active ? 'block' : 'none', 'pointer-events': active ? 'auto' : 'none' });
  const hovered = active && !drag?.moved && hover?.isConnected ? hover.getBoundingClientRect() : null;
  place(layer.hover, hovered);
  if (hovered) {
    layer.label.textContent = `${hover.localName} · ${Math.round(hovered.width)}×${Math.round(hovered.height)}`;
    style(layer.label, { display: 'block', left: `${Math.max(0, hovered.x)}px`, top: `${hovered.y >= 20 ? hovered.y - 20 : hovered.y + hovered.height + 2}px` });
  } else style(layer.label, { display: 'none' });
  place(layer.drag, drag?.moved ? drag.rect : null);
  const draftRect = draft ? rectOf(draft) : null;
  place(layer.draft, draftRect);
  const shown = [...(markersVisible ? comments.filter(item => item.id !== draft?.editing) : []), ...(draft ? [draft] : [])];
  shown.forEach((item, index) => {
    const element = marker(index), rect = rectOf(item);
    if (!rect) { style(element, { display: 'none' }); return; }
    element.textContent = String(item.number); element.dataset.id = item === draft ? '' : item.id;
    style(element, { display: 'block', left: `${Math.min(innerWidth - 24, Math.max(0, rect.x + rect.width - 11))}px`, top: `${Math.max(0, rect.y - 11)}px`, 'pointer-events': mode && item !== draft ? 'auto' : 'none' });
  });
  for (const element of layer.markers.slice(shown.length)) style(element, { display: 'none' });
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

function listen(catcher) {
  catcher.addEventListener('mousedown', event => event.preventDefault());
  catcher.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); drag = { x: event.clientX, y: event.clientY, moved: false, rect: null };
    try { catcher.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  });
  catcher.addEventListener('pointermove', event => {
    if (drag) {
      const width = event.clientX - drag.x, height = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(width, height) > 5) drag.moved = true;
      if (drag.moved) drag.rect = { x: Math.min(drag.x, event.clientX), y: Math.min(drag.y, event.clientY), width: Math.abs(width), height: Math.abs(height) };
    } else hover = elementAt(event.clientX, event.clientY);
    schedule();
  });
  catcher.addEventListener('pointerup', event => {
    const current = drag; drag = null; if (!current) return;
    if (current.moved && current.rect.width >= 8 && current.rect.height >= 8) pickRegion(current.rect);
    else if (!current.moved) pickAt(event.clientX, event.clientY);
    schedule();
  });
  catcher.addEventListener('pointercancel', () => { drag = null; schedule(); });
  catcher.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  catcher.addEventListener('pointerleave', () => { hover = null; schedule(); });
  catcher.addEventListener('wheel', event => {
    // The layer covers the page; scroll whatever is under the pointer so reading and annotating mix.
    event.preventDefault();
    for (let node = elementAt(event.clientX, event.clientY); node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if ((node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(css.overflowY)) || (node.scrollWidth > node.clientWidth && /(auto|scroll)/.test(css.overflowX))) { node.scrollBy(event.deltaX, event.deltaY); return; }
    }
    scrollBy(event.deltaX, event.deltaY);
  }, { passive: false });
}

const editable = target => target instanceof Element && (target.isContentEditable || /^(input|textarea|select)$/.test(target.localName));
addEventListener('keydown', event => {
  if (!mode) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); send({ type: draft ? 'cancel' : 'exit' }); }
  else if (event.code === 'Space' && !editable(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); if (!space) { space = true; hover = null; render(); } }
}, true);
addEventListener('keyup', event => { if (event.code === 'Space' && space) { space = false; render(); } }, true);
addEventListener('blur', () => { if (space) { space = false; schedule(); } });
addEventListener('scroll', schedule, { capture: true, passive: true });
addEventListener('resize', schedule);

ipcRenderer.on('elpis:annotate', (_event, message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'state') {
    mode = message.mode === true; markersVisible = message.markersVisible !== false;
    comments = Array.isArray(message.comments) ? message.comments : []; draft = message.draft && typeof message.draft === 'object' ? message.draft : null;
    if (!mode) { hover = null; drag = null; space = false; }
    for (const key of elements.keys()) if (!comments.some(item => item.id === key) && draft?.id !== key) elements.delete(key);
    render();
  } else if (message.type === 'pickAt' && Number.isFinite(message.x) && Number.isFinite(message.y)) pickAt(message.x, message.y);
  else if (message.type === 'paint') { hover = null; render(); requestAnimationFrame(() => requestAnimationFrame(() => send({ type: 'painted', id: message.id }))); }
});
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => send({ type: 'ready' }), { once: true });
else send({ type: 'ready' });
