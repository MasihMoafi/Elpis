/** Owns the desktop event stream, startup load, and reconnect recovery. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { notifyApproval, notifyRuntimeEvent } from "@/lib/notifications";
import { sendQueuedFollowUp } from "@/lib/follow-ups";
import { liveEventItemKey, mergeHistoryWithLive, mergeLiveItem, runtimeErrorNotice } from "@/lib/live-events";
import { reloadSettings } from "@/lib/settings-store";
import { activeTab, type ChatTabs } from "@/lib/chat-tabs";
import { activityOf, api, isAgentRun, sessionReady, type Approval, type Entry, type Item, type Thread } from "@/lib/api";
import { without } from "@/lib/without";
import { changesModelCatalog } from "@/lib/account-events";
import type { Attention } from "@/lib/attention";
import type { PermissionMode } from "@/components/composer-controls";
import type { TaskPlan } from "@/components/task-list";
import type { FailedTurn } from "@/components/failed-turn-card";

export type Live = { thread: Thread; activeTurnId?: string | null; permissions?: PermissionMode | null; planMode?: boolean };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = {
  refreshThreads: () => Promise<void>; patchThread: (id: string, patch: Partial<Thread>) => void;
  upsertThread: (thread: Thread) => void; removeThreads: (ids: Set<string>, permanent: boolean) => void;
  select: (thread: Thread | null) => void; remember: (thread: Thread) => Thread;
  rememberModes: (id: string, live: Live) => void; loadThread: (thread: Thread) => Promise<void>;
  liveKeysAfter: (revision: number) => Set<string>; clearApprovalDraft: (id: string) => void;
  refreshModels: () => Promise<void>;
  selectedRef: Ref<Thread | null>; request: Ref<number>; liveRevision: Ref<number>;
  liveVersions: Ref<Map<string, number>>; completedTurns: Ref<Set<string>>;
  planTurns: Ref<Map<string, string>>; viewRef: Ref<string>; threadsRef: Ref<Thread[]>;
  settingsOf: Ref<Record<string, Pick<Thread, "model" | "modelProvider" | "reasoningEffort">>>;
  rewindSwitch: Ref<string | null>; restoredTabs: Ref<boolean>; tabsRef: Ref<ChatTabs>;
  catalogRequest: Ref<number>;
  setConnected: Setter<boolean>; setApprovals: Setter<Approval[]>; setAccountRefresh: Setter<number>;
  setEntries: Setter<Entry[]>; setItemCursor: Setter<string | null>; setActiveTurns: Setter<Record<string, string>>;
  setLiveError: Setter<Record<string, string>>; setReady: Setter<boolean>; setError: Setter<string>;
  setAttention: Setter<Attention>; setPlans: Setter<Record<string, TaskPlan>>;
  setRewindActions: Setter<Record<string, "undo" | "redo" | undefined>>;
  setRuntimeNotices: Setter<Record<string, string>>; setFailedTurns: Setter<Record<string, FailedTurn>>;
  setStoppedTurns: Setter<Record<string, string>>; setThreadModes: Setter<Record<string, PermissionMode>>;
  setActivity: Setter<Record<string, string>>;
};

export function useLiveConnection({ refreshThreads, patchThread, upsertThread, removeThreads, select, remember,
  rememberModes, loadThread, liveKeysAfter, clearApprovalDraft, refreshModels, selectedRef, request, liveRevision,
  liveVersions, completedTurns, planTurns, viewRef, threadsRef, settingsOf, rewindSwitch, restoredTabs, tabsRef,
  catalogRequest, setConnected, setApprovals, setAccountRefresh, setEntries, setItemCursor, setActiveTurns,
  setLiveError, setReady, setError, setAttention, setPlans, setRewindActions, setRuntimeNotices, setFailedTurns,
  setStoppedTurns, setThreadModes, setActivity }: Props) {
  useEffect(() => {
    let disposed = false; let events: EventSource | undefined; let wasConnected = false; let recovery = 0;
    function disconnected() { wasConnected = false; recovery++; setConnected(false); setApprovals([]); }
    async function reconnect() {
      const attempt = ++recovery, thread = selectedRef.current, requestId = request.current;
      setAccountRefresh(value => value + 1);
      void refreshModels();
      try {
        await refreshThreads();
        await reloadSettings().catch(() => null);
        if (disposed || attempt !== recovery) return;
        if (!thread) return;
        const historyRevision = liveRevision.current;
        const history = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`);
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        select(remember(history.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...history.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(history.nextCursor);
        const live = await api<Live>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread); rememberModes(thread.id, live);
        setActiveTurns(previous => live.activeTurnId && !completedTurns.current.has(live.activeTurnId) ? { ...previous, [thread.id]: live.activeTurnId } : without(previous, thread.id));
        setLiveError(previous => without(previous, thread.id));
      } catch (error) {
        if (!disposed && attempt === recovery && thread) setLiveError(previous => ({ ...previous, [thread.id]: error instanceof Error ? error.message : String(error) }));
      }
    }
    async function initialize() {
      try {
        await sessionReady();
        const health = await api<{ connected: boolean }>("/health"); if (disposed) return; wasConnected = health.connected; setConnected(health.connected);
        void refreshModels();
        await refreshThreads();
        await reloadSettings().catch(() => null); if (disposed) return;
        setReady(true);
        // The chat of the shown tab comes back; without saved tabs, the last chat does.
        const launch = new URLSearchParams(location.search);
        const last = launch.has("session") ? launch.get("session") : restoredTabs.current ? activeTab(tabsRef.current).threadId : window.elpisDesktop?.storage?.getItem("elpis-last-chat");
        if (last && !selectedRef.current && request.current === 0) await loadThread({ id: last, ...(restoredTabs.current && activeTab(tabsRef.current).title ? { name: activeTab(tabsRef.current).title } : {}) } as Thread);
        events = new EventSource("/api/events");
        events.addEventListener("sideChat", event => window.dispatchEvent(new CustomEvent("elpis:side-chat", { detail: JSON.parse(event.data) })));
        events.addEventListener("connection", event => {
          const available = Boolean(JSON.parse(event.data).connected);
          if (!available) { disconnected(); return; }
          const recovered = !wasConnected; wasConnected = true; setConnected(true);
          if (recovered) void reconnect();
        });
        events.onerror = disconnected;
        events.addEventListener("message", event => {
          const { method, params } = JSON.parse(event.data);
          notifyRuntimeEvent(method, params, threadsRef.current, id => void loadThread({ id } as Thread)); void sendQueuedFollowUp(method, params).catch(e => setError(String(e)));
          const threadId: string | undefined = params.threadId ?? params.thread?.id;
          if (threadId && method === "turn/started" && !completedTurns.current.has(params.turn.id)) {
            planTurns.current.delete(threadId);
            setAttention(previous => ({ unread: previous.unread.filter(id => id !== threadId), plans: without(previous.plans, threadId) }));
          }
          if (threadId && method === "item/completed" && params.item?.type === "plan") planTurns.current.set(threadId, params.turnId);
          if (threadId && method === "turn/completed" && !completedTurns.current.has(params.turn.id) && params.turn.status === "completed" && !params.turn.error && !isAgentRun(threadsRef.current.find(thread => thread.id === threadId) ?? {})) {
            const unread = selectedRef.current?.id !== threadId || viewRef.current !== "chat";
            const planReady = planTurns.current.get(threadId) === params.turn.id || params.turn.items?.some((item: Item) => item.type === "plan");
            setAttention(previous => ({
              unread: unread ? [...new Set([...previous.unread, threadId])] : previous.unread.filter(id => id !== threadId),
              plans: planReady ? { ...previous.plans, [threadId]: params.turn.id } : previous.plans,
            }));
          }
          if (method === "turn/plan/updated" && Array.isArray(params.plan)) setPlans(prev => ({ ...prev, [params.threadId]: { turnId: params.turnId, explanation: params.explanation ?? null, steps: params.plan } }));
          // A new turn starts without a list; the last turn's list goes until this one makes its own.
          if (method === "turn/started") { setPlans(prev => prev[params.threadId] && prev[params.threadId].turnId !== params.turn.id ? without(prev, params.threadId) : prev); setRewindActions(prev => without(prev, params.threadId)); }
          if (method === "turn/started" && !completedTurns.current.has(params.turn.id)) { setActiveTurns(prev => ({ ...prev, [params.threadId]: params.turn.id })); setRuntimeNotices(prev => without(prev, params.threadId)); setFailedTurns(prev => without(prev, params.threadId)); patchThread(params.threadId, { status: { type: "active" } }); }
          if (method === "turn/started") setStoppedTurns(prev => without(prev, params.threadId));
          if (method === "turn/completed") {
            completedTurns.current.add(params.turn.id);
            setStoppedTurns(prev => params.turn?.status === "interrupted" ? { ...prev, [params.threadId]: params.turn.id } : without(prev, params.threadId));
            setActiveTurns(prev => prev[params.threadId] !== params.turn.id ? prev : without(prev, params.threadId));
            refreshThreads().catch(e => setError(String(e)));
            if (params.turn?.error) {
              setFailedTurns(prev => ({ ...prev, [params.threadId]: { turnId: params.turn.id, error: params.turn.error } }));
              setRuntimeNotices(prev => without(prev, params.threadId));
            } else {
              setFailedTurns(prev => without(prev, params.threadId));
              setRuntimeNotices(prev => without(prev, params.threadId));
            }
          }
          if (method === "error" && threadId) {
            const notice = runtimeErrorNotice(params);
            if (notice) setRuntimeNotices(prev => ({ ...prev, [threadId]: notice }));
          }
          if (method === "thread/status/changed" && params.status) patchThread(params.threadId, { status: params.status });
          // The engine's word that a chat is no longer running ends its turn here too, even if that turn's own end was
          // missed (another window, a reconnect, a dropped stream), so a finished chat never keeps offering a follow-up.
          if (method === "thread/status/changed" && params.status && params.status.type !== "active") setActiveTurns(prev => without(prev, params.threadId));
          // The engine's applied permission mode, from this or any other client.
          if (method === "thread/settings/updated" && params.permissions) setThreadModes(prev => ({ ...prev, [params.threadId]: params.permissions }));
          if (method === "thread/settings/updated" && params.threadSettings?.model) {
            const settings = { model: params.threadSettings.model, modelProvider: params.threadSettings.modelProvider, reasoningEffort: params.threadSettings.effort ?? null };
            settingsOf.current[params.threadId] = settings; patchThread(params.threadId, settings);
          }
          // Another client started working in a chat this window has not listed yet; Elpis lists it once stored.
          if (method === "thread/status/changed" && !threadsRef.current.some(thread => thread.id === params.threadId)) void (async () => {
            for (let attempt = 0; attempt < 5 && !threadsRef.current.some(thread => thread.id === params.threadId); attempt++) {
              await refreshThreads().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 1000));
            }
          })();
          if (method === "thread/started" && params.thread?.parentThreadId) upsertThread(params.thread);
          if (method === "thread/name/updated" || method === "thread/started") refreshThreads().catch(e => setError(String(e)));
          if (method === "thread/deleted" || (method === "thread/archived" && rewindSwitch.current !== params.threadId)) removeThreads(new Set([params.threadId]), method === "thread/deleted");
          const line = threadId ? activityOf(method, params) : null;
          if (line && threadId) setActivity(prev => prev[threadId] === line ? prev : { ...prev, [threadId]: line });
          if (!threadId || threadId !== selectedRef.current?.id) return;
          const itemKey = liveEventItemKey(method, params);
          if (itemKey) liveVersions.current.set(itemKey, ++liveRevision.current);
          setEntries(prev => mergeLiveItem(prev, method, params, threadId));
        });
        events.addEventListener("approval", event => { const approval = JSON.parse(event.data); notifyApproval(approval, threadsRef.current, id => void loadThread({ id } as Thread)); setApprovals(prev => [...prev.filter(a => a.id !== approval.id), approval]); });
        events.addEventListener("approvalResolved", event => { const { id } = JSON.parse(event.data); setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id); });
        events.addEventListener("unsupportedApproval", event => { const { method } = JSON.parse(event.data); setError(`Elpis requested an unsupported approval (${method}). Update the app to answer this request.`); });
        events.addEventListener("account", event => { setAccountRefresh(n => n + 1); if (changesModelCatalog(JSON.parse(event.data).method)) void refreshModels(); });
      } catch (e) { if (!disposed) setError(String(e)); }
    }
    initialize(); return () => { disposed = true; catalogRequest.current++; events?.close(); };
  }, [refreshThreads, patchThread, upsertThread, removeThreads, select, liveKeysAfter, clearApprovalDraft, refreshModels]);

}
