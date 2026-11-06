"use client";
// The engine's model list, shared by every model menu (chat, Love Spot, Workflows, Settings).
// One source: the bridge's GET /api/models?refresh=true, which asks the engine's model/list to
// fetch now (1 Nov, Masih: "Refresh it whenever the model picker opens"). A failed refresh keeps
// the last list and tries again by itself, quietly (4 Nov, Masih: a "Models unavailable" banner
// with a request id "doesn't even need to be shown to the user"); nothing here changes a chosen model.
import { useEffect, useState } from "react";
import type { Model } from "./api";
import { errorText } from "./error-text.mts";

type ListReader = (path: string) => Promise<{ data?: unknown }>;
// Loaded lazily, so this store has no runtime imports and its test can read it directly.
const readList: ListReader = path => import("@/lib/api").then(module => module.api(path));

export type ModelCatalogState = { models: Model[]; loading: boolean; error: string };

let state: ModelCatalogState = { models: [], loading: false, error: "" };
let latest = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** Seconds between quiet retries after a failure; the last one repeats. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const listeners = new Set<() => void>();
const publish = (next: Partial<ModelCatalogState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };

/** Reads the live list; the newest request wins, and a failure keeps the last list and retries. */
export async function refreshModelCatalog(fetchList: ListReader = readList, delays: readonly number[] = RETRY_DELAYS_MS): Promise<void> {
  const id = ++latest;
  if (retry) { clearTimeout(retry); retry = undefined; }
  publish({ loading: true });
  try {
    const result = await fetchList("/models?refresh=true");
    if (!Array.isArray(result?.data)) throw new Error("The model catalogue did not return a model list.");
    if (id === latest) { failures = 0; publish({ models: result.data as Model[], loading: false, error: "" }); }
  } catch (cause) {
    if (id !== latest) return;
    publish({ loading: false, error: errorText(cause) });
    const delay = delays[Math.min(failures++, delays.length - 1)];
    if (delay !== undefined) {
      retry = setTimeout(() => { retry = undefined; void refreshModelCatalog(fetchList, delays); }, delay);
      (retry as { unref?: () => void }).unref?.();
    }
  }
}

export const modelCatalogSnapshot = () => state;
export function subscribeModelCatalog(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** The shared list, its loading state and its last error. */
export function useModelCatalog(): ModelCatalogState {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => { setSnapshot(state); return subscribeModelCatalog(() => setSnapshot(state)); }, []);
  return snapshot;
}
