/** Owns agent child lists, expanded parents, and related chat lookup. */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, isAgentRun, unreadable, type Thread } from "@/lib/api";
import { mergeListedThreads } from "@/lib/agents";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type ChildrenProps = { selected: Thread | null; setThreads: Setter<Thread[]>; hidden: Ref<Set<string>>; setError: Setter<string> };

export function useAgentChildren({ selected, setThreads, hidden, setError }: ChildrenProps) {
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const childPaging = useRef(new Set<string>()), loadedChildPages = useRef(new Set<string>());
  const [childCursors, setChildCursors] = useState<Record<string, string | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const loadChildren = useCallback(async (id: string, cursor?: string, expand = true) => {
    if (childPaging.current.has(id)) return;
    childPaging.current.add(id); setLoadingChildren(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?ancestorThreadId=${encodeURIComponent(id)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current));
      if (cursor) loadedChildPages.current.add(id);
      if (cursor || !loadedChildPages.current.has(id)) setChildCursors(prev => ({ ...prev, [id]: result.nextCursor }));
      if (expand) setExpanded(prev => ({ ...prev, [id]: true }));
    } catch (e) { setError(String(e)); }
    finally { childPaging.current.delete(id); setLoadingChildren(prev => ({ ...prev, [id]: false })); }
  }, []);
  useEffect(() => { if (selected?.id && !selected.parentThreadId) loadChildren(selected.id); }, [selected?.id, selected?.parentThreadId, loadChildren]);
  return { loadingChildren, childCursors, expanded, setExpanded, loadChildren };
}

export function useExpandedAgents(expanded: Record<string, boolean>, loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>, setError: Setter<string>) {
  // Follow agents whose parent is expanded in the sidebar.
  const observedIds = JSON.stringify(Object.keys(expanded).filter(id => expanded[id]).sort());
  useEffect(() => {
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const ids = JSON.parse(observedIds) as string[];
        for (let start = 0; start < ids.length && !disposed; start += 3) await Promise.all(ids.slice(start, start + 3).map(id => loadChildren(id, undefined, false)));
      } catch (cause) { if (!disposed) setError(String(cause)); }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [observedIds, loadChildren]);
}

type RelatedProps = { selected: Thread | null; threads: Thread[]; showAgentRuns: boolean;
  agentRunsOpen: boolean; related: Record<string, Thread>; setRelated: Setter<Record<string, Thread>> };
export function useRelatedAgents({ selected, threads, showAgentRuns, agentRunsOpen, related, setRelated }: RelatedProps) {
  // Name the parent and the agent a continued chat came from, even when they are not on the loaded page.
  const relatedIds = [...new Set([selected?.parentThreadId, selected?.forkedFromId, ...(showAgentRuns && agentRunsOpen ? threads.filter(isAgentRun).map(thread => thread.parentThreadId) : [])])].filter((id): id is string => !!id && !threads.some(thread => thread.id === id) && !related[id]);
  useEffect(() => {
    for (const id of relatedIds) api<{ thread: Thread }>(`/threads/${encodeURIComponent(id)}?limit=1`).then(result => setRelated(prev => ({ ...prev, [id]: result.thread }))).catch(() => {});
  }, [relatedIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
}
