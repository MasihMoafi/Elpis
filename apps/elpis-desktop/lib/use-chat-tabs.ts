"use client";
// The chat tabs' state for the page (the rules are lib/chat-tabs.ts): read once from the app's store, saved on every
// change after that, and readable at event time through `tabsRef`.
import { useCallback, useEffect, useRef, useState } from "react";
import { readTabs, startTabs, writeTabs, type ChatTabs } from "./chat-tabs";

export function useChatTabs(onError: (message: string) => void) {
  const [tabs, setTabs] = useState<ChatTabs>(startTabs);
  const tabsRef = useRef(tabs);
  const [restoreDone, setRestoreDone] = useState(false);
  /** Whether the tabs came from the store (rather than starting afresh). */
  const restored = useRef(false);
  const updateTabs = useCallback((next: ChatTabs) => { tabsRef.current = next; setTabs(next); }, []);
  /** Reads the saved tabs into the strip, once at start; returns them, or null when there were none. */
  const restoreTabs = useCallback(() => {
    let saved: ChatTabs | null = null;
    try { const store = window.elpisDesktop?.storage; saved = store ? readTabs(store) : null; } catch { /* The tabs start afresh. */ }
    if (saved) { updateTabs(saved); restored.current = true; }
    setRestoreDone(true);
    return saved;
  }, [updateTabs]);
  useEffect(() => {
    const store = window.elpisDesktop?.storage;
    if (restoreDone && store && !writeTabs(tabs, store)) onError("Could not save the open chat tabs on this device.");
  }, [tabs, restoreDone]); // eslint-disable-line react-hooks/exhaustive-deps
  return { tabs, tabsRef, updateTabs, restoreTabs, restored };
}
