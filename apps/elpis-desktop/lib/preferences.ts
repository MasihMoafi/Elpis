"use client";

import { useEffect, useSyncExternalStore } from "react";
import { appStorage } from "@/lib/projects";

/** Desktop-local preferences from Settings → General and Notifications, saved on this device
 * (desktop workspace store, or localStorage in a browser). desktop/preferences.cjs reads confirmClose. */
export type Preferences = {
  defaultFolder: string;
  sendShortcut: "enter" | "modEnter";
  followUp: "steer" | "queue";
  showContextUsage: boolean;
  confirmClose: boolean;
  turnNotifications: "never" | "unfocused" | "always";
  inputNotifications: boolean;
  notificationSound: boolean;
};
export const DEFAULT_PREFERENCES: Preferences = {
  defaultFolder: "", sendShortcut: "enter", followUp: "steer", showContextUsage: false, confirmClose: false,
  turnNotifications: "unfocused", inputNotifications: true, notificationSound: false,
};
export const PREFERENCES_KEY = "elpis-preferences-v1";
const choices: { [K in keyof Preferences]?: readonly Preferences[K][] } = {
  sendShortcut: ["enter", "modEnter"], followUp: ["steer", "queue"], turnNotifications: ["never", "unfocused", "always"],
};

function parse(raw: string | null): Preferences {
  const result = { ...DEFAULT_PREFERENCES };
  let saved: Record<string, unknown> = {};
  try { const value = raw ? JSON.parse(raw) : {}; if (value && typeof value === "object" && !Array.isArray(value)) saved = value; } catch { /* Defaults replace an unreadable value. */ }
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    const value = saved[key], allowed = choices[key] as readonly unknown[] | undefined;
    if (allowed ? allowed.includes(value) : typeof value === typeof DEFAULT_PREFERENCES[key]) (result as Record<string, unknown>)[key] = value;
  }
  if (result.defaultFolder && !result.defaultFolder.startsWith("/")) result.defaultFolder = "";
  return result;
}

let snapshot: Preferences | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
/** The current preferences; cheap to call from event handlers. */
export function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  if (!snapshot) { try { snapshot = parse(appStorage().getItem(PREFERENCES_KEY)); } catch { snapshot = { ...DEFAULT_PREFERENCES }; } }
  return snapshot;
}
export function savePreferences(patch: Partial<Preferences>) {
  const next = parse(JSON.stringify({ ...readPreferences(), ...patch }));
  appStorage().setItem(PREFERENCES_KEY, JSON.stringify(next));
  snapshot = next; notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const other = (event: StorageEvent) => { if (event.key === PREFERENCES_KEY) { snapshot = null; notify(); } };
  window.addEventListener("storage", other);
  return () => { listeners.delete(listener); window.removeEventListener("storage", other); };
}
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, readPreferences, () => DEFAULT_PREFERENCES);
}

/** Subscribes the app to preference changes and applies window-level ones (a browser's close prompt;
 * the desktop window asks natively). Call once from the app page. */
export function useAppPreferences(): Preferences {
  const preferences = usePreferences();
  useEffect(() => {
    if (!preferences.confirmClose || window.elpisDesktop) return;
    const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [preferences.confirmClose]);
  return preferences;
}

type Key = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; nativeEvent?: { isComposing?: boolean } };
/** Whether this composer key press sends, under Settings → General → Send shortcut. */
export function isSendKey(event: Key, preferences = readPreferences()) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return false;
  return preferences.sendShortcut === "enter" || event.ctrlKey || event.metaKey;
}
export function sendHint(preferences = readPreferences()) {
  return preferences.sendShortcut === "enter" ? "Enter to send · Shift+Enter for a new line" : "Ctrl+Enter to send · Enter for a new line";
}
/** The folder a new chat runs in: the selected project's, else Settings → General → Default folder, else Elpis's own. */
export function newChatFolder(projectFolder: string, preferences = readPreferences()) {
  return projectFolder.trim() || preferences.defaultFolder;
}
