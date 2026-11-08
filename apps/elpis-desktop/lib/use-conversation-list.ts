import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, type Thread } from "@/lib/api";
import { mergeListedThreads } from "@/lib/agents";
import { loadConversationPage } from "@/lib/conversation-page";

export function useConversationList(
  threads: Thread[],
  setThreads: Dispatch<SetStateAction<Thread[]>>,
  selectedRef: RefObject<Thread | null>,
  setSelected: Dispatch<SetStateAction<Thread | null>>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [moreLoading, setMoreLoading] = useState(false);
  const rootPaging = useRef(false),
    loadedRootPages = useRef(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const select = useCallback((thread: Thread | null) => {
    const launch = new URL(window.location.href);
    if (launch.searchParams.has("session") && launch.searchParams.get("session") !== (thread?.id || "")) {
      launch.searchParams.set("session", thread?.id || "");
      window.history.replaceState(null, "", launch.pathname + launch.search);
    }
    selectedRef.current = thread;
    setSelected(thread);
    try {
      window.elpisDesktop?.storage?.setItem("elpis-last-chat", thread?.id || "");
    } catch {
      /* The in-memory selection remains usable. */
    }
  }, []);
  // Reported routes are authoritative; remembered settings fill list rows that omit model metadata.
  const settingsOf = useRef<Record<string, Pick<Thread, "model" | "modelProvider" | "reasoningEffort">>>({});
  const remember = (thread: Thread) => {
    if (thread.model)
      settingsOf.current[thread.id] = {
        model: thread.model,
        modelProvider: thread.modelProvider,
        reasoningEffort: thread.reasoningEffort ?? null,
      };
    return thread;
  };
  const threadsRef = useRef<Thread[]>([]);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  const statusRevisions = useRef<Record<string, number>>({});
  const patchThread = useCallback(
    (id: string, patch: Partial<Thread>) => {
      if (patch.status) statusRevisions.current[id] = (statusRevisions.current[id] ?? 0) + 1;
      setThreads(prev => prev.map(thread => (thread.id === id ? { ...thread, ...patch } : thread)));
      if (selectedRef.current?.id === id) select({ ...selectedRef.current, ...patch });
    },
    [select],
  );
  // Deleted and archived chats never reappear from a list read that raced with their removal.
  const hidden = useRef(new Set<string>());
  const upsertThread = useCallback(
    (thread: Thread) =>
      setThreads(prev =>
        hidden.current.has(thread.id)
          ? prev
          : prev.some(item => item.id === thread.id)
            ? prev.map(item => (item.id === thread.id ? { ...item, ...thread } : item))
            : [thread, ...prev],
      ),
    [],
  );
  const refreshThreads = useCallback(async () => {
    const routesAtRequest = { ...settingsOf.current };
    const statusesAtRequest = { ...statusRevisions.current };
    const result = await loadConversationPage(api);
    result.data = result.data.filter(thread => !hidden.current.has(thread.id));
    // Preserve an event or local acknowledgment that arrived after this list request began.
    for (const thread of result.data)
      if (thread.model && settingsOf.current[thread.id] === routesAtRequest[thread.id])
        remember({ ...settingsOf.current[thread.id], ...thread });
    // Listed rows omit forkedFromId (native stored rows); keep what thread/read or a fork already reported.
    const status = (t: Thread, current: Thread | undefined) =>
      statusRevisions.current[t.id] !== statusesAtRequest[t.id] ? (current?.status ?? t.status) : t.status;
    const known = (t: Thread, prev: Thread[]) => ({
      ...t,
      status: status(
        t,
        prev.find(p => p.id === t.id),
      ),
      ...settingsOf.current[t.id],
      forkedFromId: t.forkedFromId ?? prev.find(p => p.id === t.id)?.forkedFromId ?? null,
    });
    setThreads(prev =>
      mergeListedThreads(
        prev,
        result.data.map(t => known(t, prev)),
        hidden.current,
        true,
      ),
    );
    if (!loadedRootPages.current) setNextCursor(result.nextCursor);
    const updated = result.data.find(t => t.id === selectedRef.current?.id);
    if (updated)
      select({
        ...selectedRef.current,
        ...updated,
        status: status(updated, selectedRef.current ?? undefined),
        ...settingsOf.current[updated.id],
        forkedFromId: updated.forkedFromId ?? selectedRef.current?.forkedFromId ?? null,
      });
  }, [select]);

  const loadMoreConversations = useCallback(async () => {
    if (!nextCursor || rootPaging.current) return;
    rootPaging.current = true;
    setMoreLoading(true);
    try {
      const result = await loadConversationPage(api, nextCursor);
      loadedRootPages.current = true;
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current));
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(String(cause));
    } finally {
      rootPaging.current = false;
      setMoreLoading(false);
    }
  }, [nextCursor]);

  return {
    select,
    settingsOf,
    remember,
    threadsRef,
    statusRevisions,
    patchThread,
    hidden,
    upsertThread,
    refreshThreads,
    loadMoreConversations,
    nextCursor,
    moreLoading,
  };
}
