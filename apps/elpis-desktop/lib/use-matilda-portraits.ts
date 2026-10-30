"use client";

import { useSyncExternalStore } from "react";
import { appStorage } from "@/lib/projects";
import { PORTRAIT_KEY, readPortraits } from "@/lib/matilda-portraits.cjs";

const CHANGED = "elpis:matilda-portraits";
const snapshot = () => { try { return appStorage().getItem(PORTRAIT_KEY) || ""; } catch { return ""; } };
function subscribe(update: () => void) {
  window.addEventListener(CHANGED, update);
  window.addEventListener("storage", update);
  const stop = window.elpisDesktop?.storage?.onChange?.(key => { if (key === PORTRAIT_KEY) update(); });
  return () => { window.removeEventListener(CHANGED, update); window.removeEventListener("storage", update); stop?.(); };
}
export function useMatildaPortraits() {
  return readPortraits(useSyncExternalStore(subscribe, snapshot, () => ""));
}
export async function saveMatildaPortraits(value: ReturnType<typeof readPortraits>) {
  const raw = JSON.stringify(value), storage = window.elpisDesktop?.storage;
  if (storage?.saveItem) await storage.saveItem(PORTRAIT_KEY, raw);
  else appStorage().setItem(PORTRAIT_KEY, raw);
  window.dispatchEvent(new Event(CHANGED));
}
