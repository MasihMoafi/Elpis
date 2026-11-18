import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { appStorage } from "@/lib/projects";
import { SIDEBAR_TOLD_KEY, sidebarFull, storedTold, toldAfter } from "@/lib/sidebar-fill";

/** What the sidebar last reported and what she last said. */
type Fill = { loose: number; sending: boolean; told: number | null; read: boolean };
let fill: Fill = { loose: 0, sending: false, told: null, read: false };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function set(next: Partial<Fill>) {
  fill = { ...fill, ...next };
  for (const listener of listeners) listener();
}
function remember(told: number | null) {
  try {
    if (told === null) appStorage().removeItem(SIDEBAR_TOLD_KEY);
    else appStorage().setItem(SIDEBAR_TOLD_KEY, String(told));
  } catch {
    /* kept for this session only */
  }
  set({ told });
}
/** The sidebar says how many idle chats sit outside any project. */
export function reportSidebar(loose: number) {
  let told = fill.told;
  if (!fill.read) {
    try {
      told = storedTold(appStorage().getItem(SIDEBAR_TOLD_KEY));
    } catch {
      told = null;
    }
  }
  const next = toldAfter(loose, told);
  if (fill.read && loose === fill.loose && next === fill.told) return;
  if (next !== told) remember(next);
  set({ loose, told: next, read: true });
}
export type SidebarNudge = { text: string; tidy?: () => Promise<void>; later: () => void };
/** What his pinned agent has to say about the sidebar, if anything. */
export function useSidebarNudge(): SidebarNudge | null {
  const current = useSyncExternalStore(
    subscribe,
    () => fill,
    () => fill,
  );
  const { loose } = current;
  if (current.sending || !sidebarFull(loose, current.told)) return null;
  return {
    text: `Your sidebar is filling up: ${loose} chats outside a project. Shall Elpis tidy it?`,
    tidy: async () => {
      if (fill.sending) return;
      set({ sending: true });
      try {
        await api("/mother-agent/tidy", {});
        remember(toldAfter(fill.loose, loose));
      } finally {
        set({ sending: false });
      }
    },
    later: () => remember(loose),
  };
}
