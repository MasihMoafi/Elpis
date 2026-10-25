"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, unreadable, type PermissionRequirements } from "@/lib/api";

/** The bridge's /settings snapshot. Every config-backed Settings page shares this one copy,
 * so a save on one page gives the others the new config version. */
export type Background = { model: string | null; provider: string | null };
export type Memory = { enabled?: boolean | null; generate: boolean | null; use: boolean | null; skipExternalContext?: boolean | null; extractionModel: string | null; consolidationModel: string | null };
export type ConfigOptions = {
  reasoningEffort?: string | null;
  defaultPermissions: string | null; webSearch: string | null; verbosity: string | null;
  reasoningSummary: string | null; serviceTier: string | null; developerInstructions: string | null;
  projectRootMarkers: string[] | null; worktreeRoot: string | null;
};
export type ElpisSettings = {
  version?: string | null;
  main: Background;
  background: Background;
  providers?: { id: string; displayName: string }[];
  smartPrune: { enabled: boolean | null; explicitOverride: { available?: boolean; model?: string | null; provider?: string | null; reasoningEffort?: string | null; version?: string; reason?: string } };
  memory: Memory;
  options?: ConfigOptions;
  /** How many agents a work graph may use: in all, and at once (bridge/elpis-features.mjs `agentLimits`). */
  agents?: { graph: number; atOnce: number; source: string };
  sources?: Record<string, string>;
  features?: { available: boolean; reason?: string; data: { key: string; title: string; description: string; enabled: boolean; reason?: string | null }[] };
  managed?: PermissionRequirements & { modelProvider?: string | null; allowedWebSearchModes?: string[] | null };
  write: { available?: boolean; reason: string };
};
type State = { data: ElpisSettings | null; error: string; loading: boolean };

let state: State = { data: null, error: "", loading: false };
let request = 0;
const listeners = new Set<() => void>();
const update = (next: Partial<State>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function readSettings(data: ElpisSettings): ElpisSettings {
  if (![data.main, data.background, data.smartPrune, data.memory, data.write].every(part => part && typeof part === "object" && !Array.isArray(part))) throw unreadable("settings");
  return data;
}

export async function reloadSettings() {
  const id = ++request; update({ loading: true });
  try { const data = readSettings(await api<ElpisSettings>("/settings")); if (id === request) update({ data, error: "", loading: false }); return data; }
  catch (error) { if (id === request) update({ error: message(error), loading: false }); throw error; }
}
/** Posts a change and adopts the snapshot the bridge returns. Errors are thrown to the caller's form. */
export async function saveSettings(path: "/settings" | "/pruner", body: unknown) {
  const data = readSettings(await api<ElpisSettings>(path, body));
  ++request; update({ data, error: "", loading: false });
  return data;
}
/** Whether a page has loaded the snapshot yet (a reload is then worth doing). */
export const settingsLoaded = () => state.data !== null;
export const editable = (data: ElpisSettings | null): boolean => data?.write?.available === true && typeof data.version === "string";

export function useElpisSettings() {
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
  useEffect(() => { if (!state.data && !state.loading) reloadSettings().catch(() => {}); }, []);
  return snapshot;
}

/** Saves one group of options, keeping its own pending/feedback state. */
export async function saveOptions(data: ElpisSettings, options: Partial<ConfigOptions>) {
  return saveSettings("/settings", { version: data.version, options });
}
