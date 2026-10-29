"use client";

import { useLayoutEffect, useRef, type HTMLAttributes } from "react";

/** A row of icon buttons and short labels spaced by what the eye sees ("spaces must be in harmony", 29 Oct): each item
 * keeps its box, and its inline-start margin makes the gap from the previous item's ink (glyph strokes and fills, or
 * text) to its own ink equal `--ink-gap` (16px unless the row sets it). Glyphs differ in width, so equal box gaps
 * look uneven. How far each glyph's ink sits inside its box is measured once per kind of item and cached, so rows
 * that appear later need no layout reads. */
export function InkRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = row.current; if (!element) return;
    schedule(element);
    const changes = new MutationObserver(() => schedule(element));
    changes.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "d", "hidden"] });
    // A row first laid out later (a page shown again) is measured when it gets a size.
    const shown = new ResizeObserver(() => schedule(element)); shown.observe(element);
    return () => { changes.disconnect(); shown.disconnect(); pending.delete(element); };
  }, []);
  return <div ref={row} className={className ? `ink-row ${className}` : "ink-row"} {...props} />;
}

type Insets = { left: number; right: number };
const insets = new Map<string, Insets>(), pending = new Set<HTMLElement>();
let frame = 0;

function schedule(row: HTMLElement) {
  pending.add(row);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const rows = [...pending].filter(row => row.isConnected); pending.clear();
    // Reads first (styles, and insets of kinds not seen before), then every write, so rows never force layout in turn.
    const plans = rows.map(row => {
      const gap = parseFloat(getComputedStyle(row).getPropertyValue("--ink-gap")) || 16;
      const items = ([...row.children] as HTMLElement[]).filter(item => getComputedStyle(item).display !== "none" && (item.querySelector("svg") || item.textContent?.trim()));
      return { gap, items, insets: items.map(insetsOf) };
    });
    for (const { gap, items, insets: inner } of plans) items.forEach((item, index) => {
      item.style.marginInlineStart = index ? `${gap - inner[index - 1].right - inner[index].left}px` : "";
    });
  });
}

/** Text fills its own box; an item with a glyph is measured once per kind (its classes and markup). */
function insetsOf(item: HTMLElement): Insets {
  if (!item.querySelector("svg")) return { left: 0, right: 0 };
  const key = `${item.className}|${item.innerHTML}`;
  let found = insets.get(key);
  if (!found) {
    const box = item.getBoundingClientRect();
    if (!box.width) return { left: 0, right: 0 }; // Not laid out (a hidden page): measured when it shows.
    const ink = inkOf(item);
    found = { left: ink.left - box.left, right: box.right - ink.right };
    insets.set(key, found);
  }
  return found;
}

/** The union of an item's glyph shapes (with half their stroke) and its text. */
function inkOf(item: HTMLElement) {
  const boxes: { left: number; right: number }[] = [];
  for (const svg of item.querySelectorAll("svg")) {
    const scale = svg.getBoundingClientRect().width / (svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width || 1);
    for (const shape of svg.querySelectorAll("path, circle, rect, line, polyline, polygon, ellipse")) {
      const rect = shape.getBoundingClientRect(), style = getComputedStyle(shape);
      const half = style.stroke !== "none" ? parseFloat(style.strokeWidth) * scale / 2 : 0;
      boxes.push({ left: rect.left - half, right: rect.right + half });
    }
  }
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) {
    const range = document.createRange(); range.selectNodeContents(node); boxes.push(range.getBoundingClientRect());
  }
  return { left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)) };
}
