import type { AgentPanelState } from "@/lib/use-chat-team";
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { mergeListedThreads } from "@/lib/agents";
import { api, unreadable, type Thread } from "@/lib/api";
import type { useConversationList } from "@/lib/use-conversation-list";

type Inputs = {
  conversations: ReturnType<typeof useConversationList>; selectedRef: RefObject<Thread | null>;
  setThreads: Dispatch<SetStateAction<Thread[]>>; setError: Dispatch<SetStateAction<string>>;
  setAgentsPanelState: Dispatch<SetStateAction<AgentPanelState>>;
};

export function useChildConversations({ conversations, selectedRef, setThreads, setError, setAgentsPanelState }: Inputs) {
  const { threadsRef, hidden } = conversations;
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const childPaging = useRef(new Set<string>()), loadedChildPages = useRef(new Set<string>());
  const checkedChildren = useRef(new Set<string>());
  const [childCursors, setChildCursors] = useState<Record<string, string | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Once an unavailable team read lets a draft appear, a later reply must not move it.
  const holdAgentPanel = useCallback((thread: Thread) => {
    const root = thread.parentThreadId ?? thread.id;
    if (checkedChildren.current.has(root) || threadsRef.current.some(item => item.parentThreadId === root)) return;
    setAgentsPanelState(previous => previous.open && !previous.held.has(root)
      ? { ...previous, held: new Set([...previous.held, root]) } : previous);
  }, []);
  const loadChildren = useCallback(async (id: string, cursor?: string, expand = false) => {
    if (childPaging.current.has(id)) return;
    childPaging.current.add(id); setLoadingChildren(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?ancestorThreadId=${encodeURIComponent(id)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current));
      if (cursor) loadedChildPages.current.add(id);
      if (cursor || !loadedChildPages.current.has(id)) setChildCursors(prev => ({ ...prev, [id]: result.nextCursor }));
      if (expand) setExpanded(prev => ({ ...prev, [id]: true }));
    } catch (e) {
      const current = selectedRef.current;
      if (current && (current.parentThreadId ?? current.id) === id) holdAgentPanel(current);
      if (cursor) setError(String(e)); // A background read retries on its own; only his "Load more" click hears of a failure.
    } finally { checkedChildren.current.add(id); childPaging.current.delete(id); setLoadingChildren(prev => ({ ...prev, [id]: false })); }
  }, [holdAgentPanel]);
  return { loadingChildren, checkedChildren, childCursors, expanded, setExpanded, holdAgentPanel, loadChildren };
}
