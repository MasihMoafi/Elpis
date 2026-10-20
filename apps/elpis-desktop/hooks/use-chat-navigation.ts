/** Owns chat tab changes, new chat navigation, and back and forward history. */
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { activeTab, activate, addTab, closeTab, cycle, makeTab, startTabs, tabFor, type ChatTab, type ChatTabs } from "@/lib/chat-tabs";
import { step, type History } from "@/lib/nav-history";
import { title, type Entry, type Thread } from "@/lib/api";

export type View = "chat" | "agentsGuide" | "canvas" | "experimentLab" | "loveSpot" | "customize" | "observability" | "settings";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
export function useChatTabs() {
  // The shown tab follows the chat on screen, so every way of opening a chat lands in it.
  const [tabs, setTabs] = useState<ChatTabs>(startTabs);
  const tabsRef = useRef(tabs);
  const [tabsRestored, setTabsRestored] = useState(false);
  const restoredTabs = useRef(false);
  const updateTabs = useCallback((next: ChatTabs) => { tabsRef.current = next; setTabs(next); }, []);
  return { tabs, tabsRef, tabsRestored, setTabsRestored, restoredTabs, updateTabs };
}
type Props = {
  projectId: string | null; tabsRef: Ref<ChatTabs>; updateTabs: (next: ChatTabs) => void;
  selectedRef: Ref<Thread | null>; newDraftKey: Ref<string>; textRef: Ref<string>;
  saveDraft: (id: string, value: string) => void; savedDraft: (id: string) => string;
  request: Ref<number>; stickToBottom: Ref<boolean>;
  restoreScroll: Ref<{ height: number; top: number } | null>;
  select: (thread: Thread | null) => void; setEntries: Setter<Entry[]>;
  setItemCursor: Setter<string | null>; setText: (value: string) => void;
  setError: Setter<string>; restoreAttachments: (id: string) => void;
  setLoading: Setter<boolean>; setView: Setter<View>; setSidebar: Setter<boolean>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  loadThread: (thread: Thread) => Promise<void>; find: (id?: string | null) => Thread | undefined;
  showChat: () => void; closeSession: (id: string) => void;
  historyRef: Ref<History>; setHistory: Setter<History>; hidden: Ref<Set<string>>;
  show: (view: View) => void;
};

export function useChatNavigation({ projectId, tabsRef, updateTabs, selectedRef, newDraftKey, textRef,
  saveDraft, savedDraft, request, stickToBottom, restoreScroll, select, setEntries, setItemCursor,
  setText, setError, restoreAttachments, setLoading, setView, setSidebar, composerRef, loadThread,
  find, showChat, closeSession, historyRef, setHistory, hidden, show }: Props) {
  function openNewChat(draftKey = newDraftKey.current) { saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); newDraftKey.current = draftKey; request.current++; stickToBottom.current = true; restoreScroll.current = null; select(null); setEntries([]); setItemCursor(null); setText(savedDraft(draftKey)); setError(""); restoreAttachments(draftKey); setLoading(false); setView("chat"); setSidebar(false); requestAnimationFrame(() => composerRef.current?.focus()); }
  const newChat = () => openNewChat(tabDraftKey(activeTab(tabsRef.current)));
  /** An empty tab keeps its unsent text under its own key; the first one uses the project's new-chat draft. */
  const tabDraftKey = (tab: ChatTab) => tab.draftKey ?? (projectId ? `new-${projectId}` : "new");
  /** Puts the tab's chat (or empty chat) on screen. */
  function openTab(tab: ChatTab) {
    if (tab.threadId) void loadThread(find(tab.threadId) ?? { id: tab.threadId, ...(tab.title ? { name: tab.title } : {}) } as Thread);
    else openNewChat(tabDraftKey(tab));
  }
  function showTab(tab: ChatTab) {
    if (tab.id === tabsRef.current.activeId) { showChat(); return; }
    updateTabs(activate(tabsRef.current, tab.id)); openTab(tab);
  }
  /** The "+" and Ctrl+T: a new empty chat beside the others (a sibling chat, never an agent or a fork). */
  function newChatTab() { const tab = makeTab(); updateTabs(addTab(tabsRef.current, tab)); openNewChat(tabDraftKey(tab)); }
  function closeChatTab(id: string) {
    const before = tabsRef.current, next = closeTab(before, id);
    if (next === before) return;
    const closed = before.tabs.find(tab => tab.id === id);
    if (closed) closeSession(closed.threadId ?? `draft:${closed.id}`);
    updateTabs(next);
    if (id === before.activeId) openTab(activeTab(next));
  }
  function cycleTabs(delta: number) { const next = cycle(tabsRef.current, delta); if (next !== tabsRef.current) { updateTabs(next); openTab(activeTab(next)); } }
  /** Back (-1) or Forward (1): to the previous or next place visited, skipping chats that are gone. */
  function goHistory(delta: -1 | 1) {
    const found = step(historyRef.current, delta, place => !place.threadId || !hidden.current.has(place.threadId));
    if (!found) return;
    historyRef.current = found.history; setHistory(found.history);
    const { view: target, threadId } = found.place;
    if (target !== "chat") show(target as View);
    else if (threadId === (selectedRef.current?.id ?? null)) show("chat");
    else if (threadId) void loadThread(find(threadId) ?? { id: threadId } as Thread);
    else openNewChat();
  }
  /** Middle-click on a chat in the sidebar: its own tab (or the one it already has). */
  function openInNewTab(thread: Thread) {
    const owner = tabFor(tabsRef.current, thread.id);
    if (owner) { showTab(owner); return; }
    updateTabs(addTab(tabsRef.current, makeTab(thread.id, title(thread)))); void loadThread(thread);
  }
  return { openNewChat, newChat, showTab, newChatTab, closeChatTab, cycleTabs, goHistory, openInNewTab };
}
