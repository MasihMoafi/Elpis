"use client";

import { useEffect, useRef, useState } from "react";
import { appStorage } from "@/lib/projects";

export type BrowserPin = { url: string; title: string };
const KEY = "elpis-browser-pins-v1", CHANGE = "elpis:browser-pins";
function readPins(): BrowserPin[] {
  const value: unknown = JSON.parse(appStorage().getItem(KEY) || "[]");
  if (!Array.isArray(value) || value.some(pin => !pin || typeof pin.url !== "string" || !/^https?:\/\//.test(pin.url) || typeof pin.title !== "string" || pin.title.length > 200)) throw Error("Saved browser pages could not be read. They have been preserved.");
  return value;
}

/** Sidebar pins are addresses, not live pages: reopening one uses the currently shown chat's browser. */
export function useBrowserPins(onError: (message: string) => void) {
  const [pins, setPins] = useState<BrowserPin[]>([]), report = useRef(onError); report.current = onError;
  useEffect(() => {
    const refresh = () => { try { setPins(readPins()); } catch (error) { report.current(error instanceof Error ? error.message : String(error)); } };
    refresh(); window.addEventListener(CHANGE, refresh);
    const unsubscribe = window.elpisDesktop?.storage?.onChange?.(key => { if (key === KEY) refresh(); });
    return () => { window.removeEventListener(CHANGE, refresh); unsubscribe?.(); };
  }, []);
  async function toggle(pin: BrowserPin) {
    try {
      if (!/^https?:\/\//.test(pin.url)) throw Error("Only web pages can be pinned.");
      const previous = readPins(), next = previous.some(item => item.url === pin.url) ? previous.filter(item => item.url !== pin.url) : [...previous, { url: pin.url, title: pin.title.slice(0, 200) }];
      const value = JSON.stringify(next), desktop = window.elpisDesktop?.storage;
      if (desktop?.saveItem) await desktop.saveItem(KEY, value); else appStorage().setItem(KEY, value);
      setPins(next); window.dispatchEvent(new Event(CHANGE));
    } catch (error) { report.current(error instanceof Error ? error.message : String(error)); }
  }
  return { pins, toggle };
}
