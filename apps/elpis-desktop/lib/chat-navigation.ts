import type { Dispatch, RefObject, SetStateAction } from "react";
import { title, type Thread } from "@/lib/api";
import { activate, activeTab, addBackgroundTab, addTab, closeTab, cycle, makeTab, tabFor, type ChatTab } from "@/lib/chat-tabs";
import type { useNavHistory } from "@/lib/nav-history";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useProjectState } from "@/lib/use-project-state";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import type { View } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = RefObject<T>;
type NavigationInputs = {
  projectState: ReturnType<typeof useProjectState>; composer: ReturnType<typeof useComposerState>; conversations: ReturnType<typeof useConversationList>;
  history: ReturnType<typeof useTranscriptHistory>; drafts: ReturnType<typeof useDraftStore>; attachments: ReturnType<typeof useComposerAttachments>;
  tabsRef: ReturnType<typeof useChatTabs>["tabsRef"]; updateTabs: ReturnType<typeof useChatTabs>["updateTabs"];
  session: ReturnType<typeof useConversationSession>; newDraftKey: Ref<string>;
  setError: Setter<string>; setView: Setter<View>; setSidebar: Setter<boolean>;
  find: (id?: string | null) => Thread | undefined;
  openThread: (thread: Thread) => Promise<void>; loadThread: (thread: Thread) => Promise<void>; showChat: () => void;
  browser: { closeSession: (id: string) => void }; navHistory: ReturnType<typeof useNavHistory>; show: (view: View) => void;
};

export function createChatNavigation({ projectState, composer, conversations, history, drafts, attachments, tabsRef, updateTabs, session, newDraftKey, setError, setView, setSidebar, find, openThread, loadThread, showChat, browser, navHistory, show }: NavigationInputs) {
  const { selectedRef, request, stickToBottom, followingBottom, restoreScroll, setEntries, setLoading } = session;
  const { setProjectId, setCwd } = projectState;
  const { textRef, setText, composerRef } = composer;
  const { select, upsertThread, hidden } = conversations;
  const { setItemCursor } = history;
  const { saveDraft, savedDraft } = drafts;
  const { restoreAttachments } = attachments;
  function openNewChat(draftKey = newDraftKey.current) { saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); newDraftKey.current = draftKey; request.current++; stickToBottom.current = true; followingBottom.current = false; restoreScroll.current = null; select(null); setEntries([]); setItemCursor(null); setText(savedDraft(draftKey)); setError(""); restoreAttachments(draftKey); setLoading(false); setView("chat"); setSidebar(false); requestAnimationFrame(() => composerRef.current?.focus()); }
  const newChat = () => { setProjectId(null); setCwd(""); openNewChat(activeTab(tabsRef.current)!.draftKey ?? "new"); };
  /** An empty tab keeps its unsent text under its own key; the first one uses the project's new-chat draft. */
  const tabDraftKey = (tab: ChatTab) => tab.draftKey ?? "new";
  /** Puts the tab's chat (or empty chat) on screen. */
  function openTab(tab: ChatTab) {
    if (tab.threadId) void openThread(find(tab.threadId) ?? { id: tab.threadId, ...(tab.title ? { name: tab.title } : {}) } as Thread);
    else { setProjectId(null); setCwd(""); openNewChat(tabDraftKey(tab)); }
  }
  function showTab(tab: ChatTab) {
    if (tab.id === tabsRef.current.activeId) { showChat(); return; }
    updateTabs(activate(tabsRef.current, tab.id)); openTab(tab);
  }
  /** The "+" and Ctrl+T: a new empty chat beside the others (a sibling chat, never an agent or a fork). */
  function newChatTab() { const tab = makeTab(); updateTabs(addTab(tabsRef.current, tab)); setProjectId(null); setCwd(""); openNewChat(tabDraftKey(tab)); }
  function closeChatTab(id: string) {
    const before = tabsRef.current, next = closeTab(before, id);
    if (next === before) return;
    const closed = before.tabs.find(tab => tab.id === id);
    if (closed) browser.closeSession(closed.threadId ?? `draft:${closed.id}`);
    updateTabs(next);
    if (id === before.activeId) openTab(activeTab(next)!);
  }
  function cycleTabs(delta: number) { const next = cycle(tabsRef.current, delta); if (next !== tabsRef.current) { updateTabs(next); openTab(activeTab(next)!); } }
  /** Back (-1) or Forward (1): to the previous or next place visited, skipping chats that are gone. */
  function goHistory(delta: -1 | 1) {
    const place = navHistory.go(delta, place => !place.threadId || !hidden.current.has(place.threadId));
    if (!place) return;
    const { view: target, threadId } = place;
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
  /** A workflow owns a chat tab as soon as it starts, while its board stays on screen. */
  function keepWorkflowTab(thread: Thread) {
    upsertThread(thread);
    if (!tabFor(tabsRef.current, thread.id)) updateTabs(addBackgroundTab(tabsRef.current, makeTab(thread.id, title(thread))));
  }
  return { openNewChat, newChat, showTab, newChatTab, closeChatTab, cycleTabs, goHistory, openInNewTab, keepWorkflowTab };
}
