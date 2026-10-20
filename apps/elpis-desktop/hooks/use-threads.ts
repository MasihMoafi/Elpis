/** Owns conversation selection, list refresh, removal, and transcript loading. */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { mergeListedThreads } from "@/lib/agents";
import { mergeHistoryWithLive } from "@/lib/live-events";
import { writeDraft } from "@/lib/drafts";
import { writeAttachmentDraft, type Attachment } from "@/lib/attachments";
import { activate, forgetChats, tabFor, type ChatTabs } from "@/lib/chat-tabs";
import { api, unreadable, type Approval, type Entry, type Thread } from "@/lib/api";
import { without } from "@/lib/without";
import type { Browser } from "@/components/browser-panel";
import type { Live } from "@/hooks/use-live-connection";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = {
  threads: Thread[]; setThreads: Setter<Thread[]>; setSelected: Setter<Thread | null>;
  selectedRef: Ref<Thread | null>; browser: Browser; hidden: Ref<Set<string>>;
  transcripts: Ref<Map<string, { entries: Entry[]; cursor: string | null }>>;
  drafts: Ref<Record<string, string>>; attachmentDrafts: Ref<Record<string, Attachment[]>>;
  tabsRef: Ref<ChatTabs>; updateTabs: (next: ChatTabs) => void;
  setMarked: Setter<string[]>; setApprovals: Setter<Approval[]>; request: Ref<number>;
  setMessageEdits: Setter<Record<string, string>>;
  setText: (value: string) => void; savedDraft: (id: string) => string;
  newDraftKey: Ref<string>; restoreAttachments: (id: string) => void;
  setEntries: Setter<Entry[]>; setItemCursor: Setter<string | null>; setError: Setter<string>;
  markRead: (id: string) => void; saveDraft: (id: string, value: string) => void;
  textRef: Ref<string>; stickToBottom: Ref<boolean>;
  restoreScroll: Ref<{ height: number; top: number } | null>;
  liveVersions: Ref<Map<string, number>>; liveRevision: Ref<number>;
  liveKeysAfter: (revision: number) => Set<string>;
  setView: Setter<"chat" | "agentsGuide" | "canvas" | "experimentLab" | "loveSpot" | "customize" | "observability" | "settings">;
  setSidebar: Setter<boolean>; setLoading: Setter<boolean>;
  rememberModes: (id: string, live: Live) => void;
  completedTurns: Ref<Set<string>>; setActiveTurns: Setter<Record<string, string>>;
  setLiveError: Setter<Record<string, string>>;
};

export function useThreads({ threads, setThreads, setSelected, selectedRef, browser, hidden, transcripts, drafts,
  attachmentDrafts, tabsRef, updateTabs, setMarked, setApprovals, request, setMessageEdits, setText, savedDraft, newDraftKey,
  restoreAttachments, setEntries, setItemCursor, setError, markRead, saveDraft, textRef, stickToBottom,
  restoreScroll, liveVersions, liveRevision, liveKeysAfter, setView, setSidebar, setLoading, rememberModes,
  completedTurns, setActiveTurns, setLiveError }: Props) {
  const [moreLoading, setMoreLoading] = useState(false);
  const rootPaging = useRef(false), loadedRootPages = useRef(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const select = useCallback((thread: Thread | null) => {
    const launch = new URL(window.location.href);
    if (launch.searchParams.has("session") && launch.searchParams.get("session") !== (thread?.id || "")) {
      launch.searchParams.set("session", thread?.id || ""); window.history.replaceState(null, "", launch.pathname + launch.search);
    }
    selectedRef.current = thread; setSelected(thread); try { window.elpisDesktop?.storage?.setItem("elpis-last-chat", thread?.id || ""); } catch { /* The in-memory selection remains usable. */ } }, []);
  // Reported routes are authoritative; remembered settings fill list rows that omit model metadata.
  const settingsOf = useRef<Record<string, Pick<Thread, "model" | "modelProvider" | "reasoningEffort">>>({});
  const remember = (thread: Thread) => { if (thread.model) settingsOf.current[thread.id] = { model: thread.model, modelProvider: thread.modelProvider, reasoningEffort: thread.reasoningEffort ?? null }; return thread; };
  const threadsRef = useRef<Thread[]>([]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  const statusRevisions = useRef<Record<string, number>>({});
  const patchThread = useCallback((id: string, patch: Partial<Thread>) => {
    if (patch.status) statusRevisions.current[id] = (statusRevisions.current[id] ?? 0) + 1;
    setThreads(prev => prev.map(thread => thread.id === id ? { ...thread, ...patch } : thread));
    if (selectedRef.current?.id === id) select({ ...selectedRef.current, ...patch });
  }, [select]);
  const upsertThread = useCallback((thread: Thread) => setThreads(prev => prev.some(item => item.id === thread.id) ? prev.map(item => item.id === thread.id ? { ...item, ...thread } : item) : [thread, ...prev]), []);
  const removeThreads = useCallback((ids: Set<string>, permanent: boolean) => {
    for (let grew = true; grew;) { grew = false; for (const thread of threadsRef.current) if (thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id)) { ids.add(thread.id); grew = true; } }
    for (const id of ids) { hidden.current.add(id); transcripts.current.delete(id); browser.closeSession(id); }
    if (permanent) {
      for (const id of ids) for (const key of [id, `recovery-${id}`]) { delete drafts.current[key]; writeDraft(key, ""); delete attachmentDrafts.current[key]; writeAttachmentDraft(key, []); }
      setMessageEdits(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !ids.has((JSON.parse(key) as [string, string, string])[0]))));
    }
    updateTabs(forgetChats(tabsRef.current, ids));
    setThreads(prev => prev.filter(thread => !ids.has(thread.id)));
    setMarked(prev => prev.some(id => ids.has(id)) ? prev.filter(id => !ids.has(id)) : prev);
    setApprovals(prev => prev.filter(approval => !ids.has(approval.params.threadId ?? "")));
    if (selectedRef.current && ids.has(selectedRef.current.id)) { request.current++; select(null); setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setEntries([]); setItemCursor(null); }
  }, [select, setText, savedDraft, restoreAttachments, updateTabs, browser.closeSession]);
  const refreshThreads = useCallback(async () => {
    const routesAtRequest = { ...settingsOf.current };
    const statusesAtRequest = { ...statusRevisions.current };
    const result = await api<{ data: Thread[]; nextCursor: string | null }>("/threads?limit=100&includeAgentRuns=true"); if (!Array.isArray(result.data)) throw unreadable("conversations");
    result.data = result.data.filter(thread => !hidden.current.has(thread.id));
    // Preserve an event or local acknowledgment that arrived after this list request began.
    for (const thread of result.data) if (thread.model && settingsOf.current[thread.id] === routesAtRequest[thread.id]) remember({ ...settingsOf.current[thread.id], ...thread });
    // Listed rows omit forkedFromId (native stored rows); keep what thread/read or a fork already reported.
    const status = (t: Thread, current: Thread | undefined) => statusRevisions.current[t.id] !== statusesAtRequest[t.id] ? current?.status ?? t.status : t.status;
    const known = (t: Thread, prev: Thread[]) => ({ ...t, status: status(t, prev.find(p => p.id === t.id)), ...settingsOf.current[t.id], forkedFromId: t.forkedFromId ?? prev.find(p => p.id === t.id)?.forkedFromId ?? null });
    setThreads(prev => mergeListedThreads(prev, result.data.map(t => known(t, prev)), hidden.current, true));
    if (!loadedRootPages.current) setNextCursor(result.nextCursor);
    const updated = result.data.find(t => t.id === selectedRef.current?.id);
    if (updated) select({ ...selectedRef.current, ...updated, status: status(updated, selectedRef.current ?? undefined), ...settingsOf.current[updated.id], forkedFromId: updated.forkedFromId ?? selectedRef.current?.forkedFromId ?? null });
  }, [select]);

  const loadMoreConversations = useCallback(async () => {
    if (!nextCursor || rootPaging.current) return;
    rootPaging.current = true; setMoreLoading(true);
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&includeAgentRuns=true&cursor=${encodeURIComponent(nextCursor)}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      loadedRootPages.current = true;
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current)); setNextCursor(result.nextCursor);
    } catch (cause) { setError(String(cause)); }
    finally { rootPaging.current = false; setMoreLoading(false); }
  }, [nextCursor]);

  const loadThread = useCallback(async (thread: Thread) => {
    markRead(thread.id);
    // A chat that is already open in another tab brings that tab forward instead of opening twice.
    const owner = tabFor(tabsRef.current, thread.id);
    if (owner && owner.id !== tabsRef.current.activeId) updateTabs(activate(tabsRef.current, owner.id));
    saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); setText(savedDraft(thread.id));
    const id = ++request.current; stickToBottom.current = true; restoreScroll.current = null;
    liveVersions.current.clear(); const historyRevision = liveRevision.current;
    const shown = transcripts.current.get(thread.id);
    select(thread); setView("chat"); setSidebar(false); setEntries(shown?.entries ?? []); setItemCursor(shown?.cursor ?? null); setLoading(true); setError(""); restoreAttachments(thread.id);
    try {
      const result = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
      if (request.current !== id) return;
      select(remember(result.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...result.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(result.nextCursor);
    } catch (e) { if (request.current === id) setError(String(e)); return; }
    finally { if (request.current === id) setLoading(false); }
    // Follow it live in this app: subscribe, and learn the turn it is running now.
    try {
      const live = await api<Live>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
      if (request.current !== id || live.thread?.id !== thread.id) return;
      remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread); rememberModes(thread.id, live);
      if (live.activeTurnId && !completedTurns.current.has(live.activeTurnId)) setActiveTurns(prev => ({ ...prev, [thread.id]: live.activeTurnId! }));
      setLiveError(prev => without(prev, thread.id));
    } catch (e) { if (request.current === id) setLiveError(prev => ({ ...prev, [thread.id]: e instanceof Error ? e.message : String(e) })); }
  }, [select, setText, upsertThread, saveDraft, savedDraft, liveKeysAfter, restoreAttachments, updateTabs, markRead]);

  return { select, settingsOf, remember, threadsRef, patchThread, upsertThread, removeThreads,
    refreshThreads, loadMoreConversations, loadThread, nextCursor, moreLoading };
}
