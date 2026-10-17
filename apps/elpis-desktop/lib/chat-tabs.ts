// The top tab strip: one tab per open chat, as in Obsidian. A tab holds a chat id, or nothing for an empty
// "New chat". The active tab always mirrors the chat on screen (app/page.tsx), so every way of opening a chat
// (sidebar, search, links) already lands in the active tab. Pure functions; the page keeps the state.
import type {} from "./desktop";

export type ChatTab = {
  id: string;
  /** The chat this tab shows; null for an empty new chat. */
  threadId: string | null;
  /** The last known name, shown until the chat list has loaded. */
  title?: string;
  /** Where an empty tab keeps its unsent text; tabs without one use the project's new-chat draft. */
  draftKey?: string;
};
export type ChatTabs = { tabs: ChatTab[]; activeId: string };

export const TABS_KEY = "elpis-chat-tabs-v1";
const MAX_TABS = 40;
type TabStorage = Pick<Storage, "getItem" | "setItem">;

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const makeTab = (threadId: string | null = null, title?: string): ChatTab => {
  const id = `tab-${uid()}`;
  return { id, threadId, ...(title ? { title } : {}), ...(threadId ? {} : { draftKey: `new-${id}` }) };
};
export function startTabs(): ChatTabs { const tab = { id: `tab-${uid()}`, threadId: null }; return { tabs: [tab], activeId: tab.id }; }

export const activeTab = (state: ChatTabs) => state.tabs.find(tab => tab.id === state.activeId) ?? state.tabs[0];
export const tabFor = (state: ChatTabs, threadId: string) => state.tabs.find(tab => tab.threadId === threadId);

/** Opens a tab at the end and shows it. */
export function addTab(state: ChatTabs, tab: ChatTab = makeTab()): ChatTabs {
  return { tabs: [...state.tabs, tab].slice(-MAX_TABS), activeId: tab.id };
}

export function activate(state: ChatTabs, id: string): ChatTabs {
  return state.activeId === id || !state.tabs.some(tab => tab.id === id) ? state : { ...state, activeId: id };
}

/** Closing the shown tab shows its right neighbour, else its left; closing the last one leaves an empty New chat. */
export function closeTab(state: ChatTabs, id: string): ChatTabs {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  if (!tabs.length) return startTabs();
  return { tabs, activeId: state.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId };
}

/** The tab `delta` places after the shown one, wrapping around (Ctrl+Tab is 1, Ctrl+Shift+Tab is -1). */
export function cycle(state: ChatTabs, delta: number): ChatTabs {
  const count = state.tabs.length, at = Math.max(0, state.tabs.findIndex(tab => tab.id === state.activeId));
  return activate(state, state.tabs[(at + delta % count + count) % count].id);
}

/** The shown tab follows the chat on screen. */
export function followChat(state: ChatTabs, chat: { id: string; title: string } | null): ChatTabs {
  const tab = activeTab(state), threadId = chat?.id ?? null;
  if (tab.threadId === threadId && (!chat || tab.title === chat.title)) return state;
  const { title: _, ...rest } = tab;
  const next: ChatTab = chat ? { ...rest, threadId, title: chat.title } : { ...rest, threadId: null };
  return { ...state, tabs: state.tabs.map(item => item.id === tab.id ? next : item) };
}

/** Chats that were deleted or archived: their other tabs close (the shown tab becomes an empty chat through followChat). */
export function forgetChats(state: ChatTabs, ids: ReadonlySet<string>): ChatTabs {
  let next = state;
  for (const tab of state.tabs) if (tab.threadId && ids.has(tab.threadId) && tab.id !== state.activeId) next = closeTab(next, tab.id);
  return next;
}

/** Fresh names for the tabs whose chat was renamed or loaded. */
export function renameTabs(state: ChatTabs, titleOf: (threadId: string) => string | undefined): ChatTabs {
  let changed = false;
  const tabs = state.tabs.map(tab => {
    const title = tab.threadId ? titleOf(tab.threadId) : undefined;
    if (!title || title === tab.title) return tab;
    changed = true; return { ...tab, title };
  });
  return changed ? { ...state, tabs } : state;
}

export function readTabs(storage: TabStorage): ChatTabs | null {
  try {
    const value = JSON.parse(storage.getItem(TABS_KEY) || "null");
    if (!value || !Array.isArray(value.tabs) || !value.tabs.length) return null;
    const seen = new Set<string>();
    const tabs: ChatTab[] = [];
    for (const raw of value.tabs.slice(0, MAX_TABS)) {
      if (!raw || typeof raw.id !== "string" || !raw.id || seen.has(raw.id) || (raw.threadId !== null && typeof raw.threadId !== "string")) continue;
      seen.add(raw.id);
      tabs.push({ id: raw.id, threadId: raw.threadId, ...(typeof raw.title === "string" && raw.title ? { title: raw.title.slice(0, 200) } : {}), ...(typeof raw.draftKey === "string" && raw.draftKey ? { draftKey: raw.draftKey.slice(0, 200) } : {}) });
    }
    if (!tabs.length) return null;
    return { tabs, activeId: tabs.some(tab => tab.id === value.activeId) ? value.activeId : tabs[0].id };
  } catch { return null; }
}

export function writeTabs(state: ChatTabs, storage: TabStorage): boolean {
  try { storage.setItem(TABS_KEY, JSON.stringify(state)); return true; } catch { return false; }
}
