"use client";
// The engine's model list, shared by every model menu (chat, Love Spot, Workflows, Settings).
// One source: the bridge's GET /api/models?refresh=true, which asks the engine's model/list to
// fetch now (1 Nov, Masih: "Refresh it whenever the model picker opens"). A failed refresh keeps
// the last list and says why; nothing here ever changes a chosen model.
import { useSyncExternalStore } from "react";
import type { Model } from "./api";

type ListReader = (path: string) => Promise<{ data?: unknown }>;
// Loaded lazily, so this store has no runtime imports and its test can read it directly.
const readList: ListReader = path => import("./api").then(module => module.api(path));

export type ModelCatalogState = { models: Model[]; loading: boolean; error: string };

let state: ModelCatalogState = { models: [], loading: false, error: "" };
let latest = 0;
const listeners = new Set<() => void>();
const publish = (next: Partial<ModelCatalogState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };

/** Reads the live list; the newest request wins, and a failure keeps the last list. */
export async function refreshModelCatalog(fetchList: ListReader = readList): Promise<void> {
  const id = ++latest;
  publish({ loading: true });
  try {
    const result = await fetchList("/models?refresh=true");
    if (!Array.isArray(result?.data)) throw new Error("The model catalogue did not return a model list.");
    if (id === latest) publish({ models: result.data as Model[], loading: false, error: "" });
  } catch (cause) {
    if (id === latest) publish({ loading: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

export const modelCatalogSnapshot = () => state;
export function subscribeModelCatalog(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** The shared list, its loading state and its last error. */
export const useModelCatalog = () => useSyncExternalStore(subscribeModelCatalog, modelCatalogSnapshot, modelCatalogSnapshot);
