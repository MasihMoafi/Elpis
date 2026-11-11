import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { appStorage } from "@/lib/projects";
import { SIDEBAR_TOLD_KEY, TIDY_REQUEST, sidebarFull, storedTold, toldAfter } from "@/lib/sidebar-fill";

/** What the sidebar last reported, what she last said, and whether Elpis was just asked. */
type Fill = { loose: number; elpisId: string | null; told: number | null; asked: boolean; read: boolean };
let fill: Fill = { loose: 0, elpisId: null, told: null, asked: false, read: false };
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
/** The sidebar says how many idle chats sit outside any project, and which chat is Elpis's. */
export function reportSidebar(loose: number, elpisId: string | null) {
  let told = fill.told;
  if (!fill.read) {
    try {
      told = storedTold(appStorage().getItem(SIDEBAR_TOLD_KEY));
    } catch {
      told = null;
    }
  }
  const next = toldAfter(loose, told);
  if (fill.read && loose === fill.loose && elpisId === fill.elpisId && next === fill.told) return;
  if (next !== told) remember(next);
  set({ loose, elpisId, told: next, read: true });
}
export type SidebarNudge = { text: string; tidy?: () => Promise<void>; later: () => void };
/** What his pinned agent has to say about the sidebar, if anything. */
export function useSidebarNudge(): SidebarNudge | null {
  const current = useSyncExternalStore(
    subscribe,
    () => fill,
    () => fill,
  );
  if (current.asked)
    return { text: "I asked Elpis to tidy. Its answer is in the Elpis tab.", later: () => set({ asked: false }) };
  const { elpisId, loose } = current;
  if (!elpisId || !sidebarFull(loose, current.told)) return null;
  return {
    text: `Your sidebar is filling up: ${loose} chats outside a project. Shall Elpis tidy it?`,
    tidy: async () => {
      await api(`/threads/${encodeURIComponent(elpisId)}/turns`, { text: TIDY_REQUEST });
      remember(loose);
      set({ asked: true });
    },
    later: () => remember(loose),
  };
}
