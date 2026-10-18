"use client";

import { useEffect, useSyncExternalStore } from "react";
import { appStorage } from "@/lib/projects";
// Types only: desktop/state.test.cjs runs this file with nothing but appStorage to require. readingStyle (lib/reading.ts)
// never applies a code font name it refuses, and Appearance refuses it before saving.
import type { InterfaceFont, ReadingStep } from "@/lib/reading";

/** Desktop-local preferences from Settings → General and Notifications, saved on this device
 * (desktop workspace store, or localStorage in a browser). desktop/preferences.cjs reads confirmClose, closeToTray and
 * quickEntryShortcut. */
export type Preferences = {
  defaultFolder: string;
  softWrap: boolean;
  sendShortcut: "enter" | "modEnter";
  followUp: "steer" | "queue";
  showContextUsage: boolean;
  confirmClose: boolean;
  /** Closing the window keeps Elpis in the system tray. Off by default: nothing runs after the window closes unless chosen. */
  closeToTray: boolean;
  /** The global shortcut that opens Quick Entry, as an Electron accelerator; empty when turned off. Claude's Linux default. */
  quickEntryShortcut: string;
  /** Off after "Don’t show me this again" in the delete confirmation; Settings → General turns it back on. */
  confirmDeleteChats: boolean;
  turnNotifications: "never" | "unfocused" | "always";
  inputNotifications: boolean;
  notificationSound: boolean;
  /** Settings → Appearance (lib/reading.ts): transcript text size and width, interface font, code font ("" default). */
  transcriptSize: ReadingStep;
  transcriptWidth: ReadingStep;
  interfaceFont: InterfaceFont;
  codeFont: string;
};
export const DEFAULT_PREFERENCES: Preferences = {
  softWrap: false, defaultFolder: "", sendShortcut: "enter", followUp: "steer", showContextUsage: true, confirmClose: false, closeToTray: false, quickEntryShortcut: "Ctrl+Alt+Space", confirmDeleteChats: true,
  turnNotifications: "unfocused", inputNotifications: true, notificationSound: false,
  transcriptSize: "m", transcriptWidth: "s", interfaceFont: "sans", codeFont: "",
};
export const PREFERENCES_KEY = "elpis-preferences-v1";
const choices: { [K in keyof Preferences]?: readonly Preferences[K][] } = {
  sendShortcut: ["enter", "modEnter"], followUp: ["steer", "queue"], turnNotifications: ["never", "unfocused", "always"],
  transcriptSize: ["s", "m", "l"], transcriptWidth: ["s", "m", "l"], interfaceFont: ["sans", "serif"],
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
let snapshotRaw: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
/** The current preferences; cheap to call from event handlers. */
export function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = appStorage().getItem(PREFERENCES_KEY);
    if (!snapshot || raw !== snapshotRaw) { snapshot = parse(raw); snapshotRaw = raw; }
  } catch { snapshot = { ...DEFAULT_PREFERENCES }; }
  return snapshot;
}
export function savePreferences(patch: Partial<Preferences>) {
  const next = parse(JSON.stringify({ ...readPreferences(), ...patch }));
  const storage = window.elpisDesktop?.storage;
  if (storage?.patchItem) {
    const changes: Record<string, string | boolean> = {};
    for (const key of Object.keys(patch) as (keyof Preferences)[]) if (Object.hasOwn(DEFAULT_PREFERENCES, key)) changes[key] = next[key];
    storage.patchItem(PREFERENCES_KEY, changes);
  } else appStorage().setItem(PREFERENCES_KEY, JSON.stringify(next));
  snapshot = null; notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const other = (event: StorageEvent) => { if (event.key === PREFERENCES_KEY) { snapshot = null; notify(); } };
  window.addEventListener("storage", other);
  const off = window.elpisDesktop?.storage?.onChange?.(key => { if (key === PREFERENCES_KEY) { snapshot = null; notify(); } });
  return () => { listeners.delete(listener); window.removeEventListener("storage", other); off?.(); };
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
/** While a turn runs, as in Claude's desktop app: the send key follows Settings → General → Follow-up behavior, and
 * the same key with Ctrl (with Ctrl+Shift under the Ctrl+Enter shortcut) does the other, for that one message.
 * Returns what this key press does, or null when it does not send. */
export function followUpKey(event: Key, preferences = readPreferences()): Preferences["followUp"] | null {
  if (event.key !== "Enter" || event.nativeEvent?.isComposing) return null;
  const mod = event.ctrlKey || event.metaKey;
  const other = preferences.sendShortcut === "enter" ? mod && !event.shiftKey : mod && event.shiftKey;
  if (other) return preferences.followUp === "queue" ? "steer" : "queue";
  return isSendKey(event, preferences) ? preferences.followUp : null;
}
export type FollowUpChoice = { follow: Preferences["followUp"]; /** Claude's wording for it. */ label: string; keys: string };
/** What the two send keys do while a turn runs, send key first. Claude: Enter sends into the run, Ctrl+Enter queues for
 * later. Settings → General → Follow-up behavior swaps them, so it is only the default; the other key does the other
 * thing for that one message. The send button's tooltip and menu, the composer's hint and Settings all read this. */
export function followUpChoices(preferences = readPreferences()): [FollowUpChoice, FollowUpChoice] {
  const [key, otherKey] = preferences.sendShortcut === "enter" ? ["Enter", "Ctrl+Enter"] : ["Ctrl+Enter", "Ctrl+Shift+Enter"];
  const [first, second]: Preferences["followUp"][] = preferences.followUp === "queue" ? ["queue", "steer"] : ["steer", "queue"];
  const label = (follow: Preferences["followUp"], sendKey: boolean) => follow === "queue" ? "Queue for later" : sendKey ? "Send" : "Send now";
  return [{ follow: first, label: label(first, true), keys: key }, { follow: second, label: label(second, false), keys: otherKey }];
}
/** The composer's hint while a turn runs: "Enter to send, Ctrl+Enter to queue for later", worded for the settings. */
export function followUpHint(preferences = readPreferences()) {
  return followUpChoices(preferences).map(choice => `${choice.keys} to ${choice.label.toLowerCase()}`).join(", ");
}
/** The send button's tooltip while a turn runs: one row per key, as Claude's. */
export function followUpTooltip(preferences = readPreferences()) {
  return followUpChoices(preferences).map(choice => `${choice.label} (${choice.keys})`).join("\n");
}
/** Settings → General → Follow-up behavior says what each key does, so the setting and the per-message key read as one rule. */
export function followUpSummary(preferences = readPreferences()) {
  const [first, second] = followUpChoices(preferences);
  const effect = (choice: FollowUpChoice, it: string) => choice.follow === "queue" ? `queues ${it} for later` : `sends ${it} into the current run`;
  return `While Elpis runs, ${first.keys} ${effect(first, "the message")} and ${second.keys} ${effect(second, "it")}.`;
}
/** The folder a new chat runs in: the selected project's, else Settings → General → Default folder, else Elpis's own. */
export function newChatFolder(projectFolder: string, preferences = readPreferences()) {
  return projectFolder.trim() || preferences.defaultFolder;
}
