import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { api, activityOf, isAgentRun, retryableSessionError, sessionReady, type Entry, type Item, type Thread } from "@/lib/api";
import type { Attention } from "@/lib/attention";
import { changesModelCatalog } from "@/lib/account-events";
import { activeTab, type ChatTabs } from "@/lib/chat-tabs";
import { historyPath, type HistoryPage } from "@/lib/chat-history";
import { errorText } from "@/lib/error-text.mjs";
import { sendQueuedFollowUp } from "@/lib/follow-ups";
import { HEART_REACTION, nativeHeartReaction } from "@/lib/heart-reactions";
import { liveEventItemKey, mergeLiveItem, RETRYING, retryRecovered, runtimeErrorNotice } from "@/lib/live-events";
import { notifyApproval, notifyRuntimeEvent } from "@/lib/notifications";
import { reloadSettings } from "@/lib/settings-store";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import { without } from "@/lib/utils";
import { refusedOffline, type Live, type View, type WorkflowReplay } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = RefObject<T>;
type RuntimeEvents = {
  runtime: ReturnType<typeof useRuntimeState>; conversations: ReturnType<typeof useConversationList>;
  selectedRef: Ref<Thread | null>; request: Ref<number>; tabsRef: Ref<ChatTabs>;
  refreshModels: () => Promise<void>; setError: Setter<string>;
  initialRestoration: Ref<{ threadId: string; promise: Promise<void> } | null>;
  liveRevision: Ref<number>;
  applyHistoryPage: (id: string, page: HistoryPage, revision: number) => void;
  rememberFollowing: (id: string, live: Live) => void; rememberModes: (id: string, live: Live) => void;
  reconcileLiveThread: (id: string, live: Live) => void;
  restoredTabs: Ref<boolean>; loadThread: (thread: Thread) => Promise<void>;
  openThread: (thread: Thread) => Promise<void>;
  viewRef: Ref<View>; planTurns: Ref<Map<string, string>>; setAttention: Setter<Attention>;
  loveRef: Ref<ReturnType<typeof useLoveActivity>>; isLoveChatId: (id: string) => boolean;
  setRewindActions: Setter<Record<string, "undo" | "redo" | undefined>>;
  setThreadModes: Setter<Record<string, PermissionMode>>;
  rewindSwitch: Ref<string | null>;
  removeThreads: (ids: Set<string>, permanent: boolean) => void;
  liveVersions: Ref<Map<string, number>>; setEntries: Setter<Entry[]>; clearApprovalDraft: (id: string) => void;
  liveKeysAfter: (revision: number) => Set<string>;
  noteHistoryGap: (id: string, page: { earliestHistoryMissing?: boolean }) => void;
};

export function useRuntimeEvents({ conversations, runtime, selectedRef, request, tabsRef, refreshModels, setError, initialRestoration, liveRevision, applyHistoryPage, rememberFollowing, rememberModes, reconcileLiveThread, restoredTabs, loadThread, openThread, viewRef, planTurns, setAttention, loveRef, isLoveChatId, setRewindActions, setThreadModes, rewindSwitch, removeThreads, liveVersions, setEntries, clearApprovalDraft, liveKeysAfter, noteHistoryGap }: RuntimeEvents) {
  const { refreshThreads, hidden, threadsRef, statusRevisions, settingsOf, patchThread, upsertThread, select } = conversations;
  const { setConnected, setConnectionStatus, setApprovals, setAccountRefresh, turnRevisions, modeRevisions, setLiveError, setReady, setReplays, completedTurns, setPlans, setActiveTurns, setRuntimeNotices, setFailedTurns, setStoppedTurns, setActivity } = runtime;
  useEffect(() => {
    let disposed = false; let events: EventSource | undefined; let wasConnected = false; let receivedConnection = false; let recovery = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined, retryDelay = 500;
    function disconnected() { wasConnected = false; recovery++; setConnected(false); setConnectionStatus("Elpis is disconnected. Reconnecting to Elpis… Your draft is saved."); setApprovals([]); }
    async function reconnect() {
      const attempt = ++recovery, thread = selectedRef.current, requestId = request.current;
      const ids = new Set(tabsRef.current.tabs.flatMap(tab => tab.threadId ? [tab.threadId] : []));
      if (thread) ids.add(thread.id);
      const current = () => !disposed && attempt === recovery;
      // Reconcile the gap between the initial reads and subscribing, without holding up navigation.
      setAccountRefresh(value => value + 1);
      void refreshModels();
      void refreshThreads().catch(error => { if (current()) setError(String(error)); });
      void reloadSettings().catch(() => null);
      // A list page can omit open chats or fail; each tab still needs its own authoritative turn state.
      await Promise.all([...ids].map(async id => {
        const open = () => current() && !hidden.current.has(id) && (selectedRef.current?.id === id || tabsRef.current.tabs.some(tab => tab.threadId === id));
        // The initial restore survives effect restarts. Its own resume must finish before this chat's recovery read.
        const restoring = initialRestoration.current;
        if (restoring?.threadId === id) await restoring.promise;
        if (!open()) return;
        const turnRevision = turnRevisions.current[id], modeRevision = modeRevisions.current[id];
        const historyRevision = liveRevision.current;
        const shown = () => open() && request.current === requestId && selectedRef.current?.id === id;
        // History and resume are independent: a refused history read must not leave a finished turn running.
        const history = thread?.id === id ? (async () => {
          const result = await api<HistoryPage & { thread: Thread }>(historyPath(id));
          if (shown()) { applyHistoryPage(id, result, historyRevision); }
          return !result.data.length && !result.nextCursor;
        })() : Promise.resolve(false);
        const resume = (async () => {
          const live = await api<Live>(`/threads/${encodeURIComponent(id)}/resume`, {});
          if (!open() || live.thread?.id !== id) return;
          rememberFollowing(id, live);
          if (modeRevisions.current[id] === modeRevision) rememberModes(id, live);
          if (turnRevisions.current[id] === turnRevision) reconcileLiveThread(id, live);
        })();
        const results = await Promise.allSettled([history, resume]);
        if (!open()) return;
        // A saved chat reads as empty until the resume has loaded it (see loadThread): read it again.
        if (results[0].status === "fulfilled" && results[0].value && results[1].status === "fulfilled" && shown()) {
          const again = await api<HistoryPage>(historyPath(id)).catch(() => null);
          if (again && Array.isArray(again.data) && shown()) { applyHistoryPage(id, again, historyRevision); }
        }
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") setLiveError(previous => ({ ...previous, [id]: failed.reason instanceof Error ? failed.reason.message : String(failed.reason) }));
      }));
    }
    async function initialize() {
      if (disposed) return;
      try {
        // Bind the restored chat and its draft before waiting for the connection. loadThread's API reads already
        // wait for sessionReady; an early edit must belong to this chat rather than be replaced after sign-in.
        // The chat of the shown tab comes back; without saved tabs, the last chat does.
        const launch = new URLSearchParams(location.search);
        const last = launch.has("session") ? launch.get("session") : restoredTabs.current ? activeTab(tabsRef.current)!.threadId : window.elpisDesktop?.storage?.getItem("elpis-last-chat");
        if (last && !selectedRef.current && request.current === 0) {
          initialRestoration.current = { threadId: last, promise: loadThread({ id: last, ...(restoredTabs.current && activeTab(tabsRef.current)!.title ? { name: activeTab(tabsRef.current)!.title } : {}) } as Thread) };
        }
        await sessionReady(true);
        if (disposed) return;
        setReady(true);
        // No data read gates navigation or the live connection. A busy bridge fills each part as it arrives.
        void api<{ connected: boolean }>("/health").then(health => {
          if (disposed || receivedConnection) return;
          setConnected(health.connected);
          if (!health.connected) setConnectionStatus("Elpis is disconnected. Waiting to reconnect…");
        }).catch(() => { if (!disposed && !receivedConnection) disconnected(); });
        void refreshModels();
        void refreshThreads().catch(error => { if (!disposed) setError(String(error)); });
        void reloadSettings().catch(() => null);
        events = new EventSource("/api/events");
        // A scheduled workflow is due: the first window to claim it replays its board (Workflows' Scheduled view).
        events.addEventListener("automationWorkflow", event => {
          const replay = JSON.parse(event.data) as WorkflowReplay;
          void api<{ granted: boolean }>(`/automations/${replay.taskId}`, { action: "claim", token: replay.token })
            .then(result => { if (result.granted) setReplays(previous => [...previous, replay]); }).catch(() => {});
        });
        events.addEventListener("sideChat", event => window.dispatchEvent(new CustomEvent("elpis:side-chat", { detail: JSON.parse(event.data) })));
        events.addEventListener("connection", event => {
          if (disposed) return;
          receivedConnection = true;
          const available = Boolean(JSON.parse(event.data).connected);
          if (!available) { disconnected(); return; }
          const recovered = !wasConnected; wasConnected = true; setConnected(true);
          // What failed only because Elpis was away is not an error once it is back (reconnect reads it again).
          setError(previous => refusedOffline(previous) ? "" : previous);
          if (recovered) void reconnect();
        });
        events.onerror = disconnected;
        events.addEventListener("message", event => {
          const { method, params } = JSON.parse(event.data);
          if (method === "thread/goal/updated" || method === "thread/goal/cleared") window.dispatchEvent(new CustomEvent("elpis:goal-updated", { detail: { threadId: params.threadId } }));
          notifyRuntimeEvent(method, params, threadsRef.current, id => void openThread({ id } as Thread)); void sendQueuedFollowUp(method, params).catch(e => setError(String(e)));
          const threadId: string | undefined = params.threadId ?? params.thread?.id;
          if (viewRef.current === "chat" && selectedRef.current?.id === threadId) {
            const reaction = nativeHeartReaction(method, params);
            if (reaction) window.dispatchEvent(new CustomEvent(HEART_REACTION, { detail: reaction }));
          }
          if (threadId && method === "turn/started" && !completedTurns.current.has(params.turn.id)) {
            turnRevisions.current[threadId] = (turnRevisions.current[threadId] ?? 0) + 1;
            planTurns.current.delete(threadId);
            setAttention(previous => ({ unread: previous.unread.filter(id => id !== threadId), plans: without(previous.plans, threadId) }));
          }
          if (threadId && method === "item/completed" && params.item?.type === "plan") planTurns.current.set(threadId, params.turnId);
          if (threadId && method === "turn/completed" && !completedTurns.current.has(params.turn.id) && params.turn.status === "completed" && !params.turn.error && !isAgentRun(threadsRef.current.find(thread => thread.id === threadId) ?? {})) {
            // A reply is read when it is on screen: in its open chat, or on the open Love Spot board for a Love Spot chat.
            const unread = viewRef.current === "loveSpot" || loveRef.current.chatShown ? !isLoveChatId(threadId)
              : selectedRef.current?.id !== threadId || viewRef.current !== "chat";
            const planReady = planTurns.current.get(threadId) === params.turn.id || params.turn.items?.some((item: Item) => item.type === "plan");
            setAttention(previous => ({
              unread: unread ? [...new Set([...previous.unread, threadId])] : previous.unread.filter(id => id !== threadId),
              plans: planReady ? { ...previous.plans, [threadId]: params.turn.id } : previous.plans,
            }));
          }
          if (method === "turn/plan/updated" && Array.isArray(params.plan)) setPlans(prev => ({ ...prev, [params.threadId]: { turnId: params.turnId, explanation: params.explanation ?? null, steps: params.plan } }));
          // A new turn starts without a list; the last turn's list goes until this one makes its own.
          if (method === "turn/started") { setPlans(prev => prev[params.threadId] && prev[params.threadId]!.turnId !== params.turn.id ? without(prev, params.threadId) : prev); setRewindActions(prev => without(prev, params.threadId)); }
          if (method === "turn/started" && !completedTurns.current.has(params.turn.id)) { setActiveTurns(prev => ({ ...prev, [params.threadId]: params.turn.id })); setRuntimeNotices(prev => without(prev, params.threadId)); setFailedTurns(prev => without(prev, params.threadId)); patchThread(params.threadId, { status: { type: "active" } }); }
          if (method === "turn/started") setStoppedTurns(prev => without(prev, params.threadId));
          if (method === "turn/completed") {
            turnRevisions.current[params.threadId] = (turnRevisions.current[params.threadId] ?? 0) + 1;
            statusRevisions.current[params.threadId] = (statusRevisions.current[params.threadId] ?? 0) + 1;
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
          // A retry that worked: the reply goes on, so "retrying…" is no longer true (3 Nov, Masih: "this says retrying
          // even when the model no longer retries!"). The first new output after it clears the notice.
          if (threadId && retryRecovered(method)) setRuntimeNotices(prev => prev[threadId]?.endsWith(RETRYING) ? without(prev, threadId) : prev);
          if (method === "thread/status/changed" && params.status) patchThread(params.threadId, { status: params.status });
          if ((method === "thread/started" || method === "thread/status/changed") && (params.thread?.name?.startsWith("Workflows · ") || threadsRef.current.some(thread => thread.id === params.threadId && thread.name?.startsWith("Workflows · ")))) window.dispatchEvent(new Event("elpis:workflow-history"));
          // The engine's word that a chat is no longer running ends its turn here too, even if that turn's own end was
          // missed (another window, a reconnect, a dropped stream), so a finished chat never keeps offering a follow-up.
          if (method === "thread/status/changed" && params.status && params.status.type !== "active") { turnRevisions.current[params.threadId] = (turnRevisions.current[params.threadId] ?? 0) + 1; setActiveTurns(prev => without(prev, params.threadId)); }
          // The engine's applied permission mode, from this or any other client.
          if (method === "thread/settings/updated" && params.permissions) { modeRevisions.current[params.threadId] = (modeRevisions.current[params.threadId] ?? 0) + 1; setThreadModes(prev => ({ ...prev, [params.threadId]: params.permissions })); }
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
          // A chat brought back (writing in it, or Unarchive anywhere) returns to the list.
          if (method === "thread/unarchived") { hidden.current.delete(params.threadId); refreshThreads().catch(e => setError(String(e))); }
          const line = threadId ? activityOf(method, params) : null;
          if (line && threadId) setActivity(prev => prev[threadId] === line ? prev : { ...prev, [threadId]: line });
          if (!threadId || threadId !== selectedRef.current?.id) return;
          const itemKey = liveEventItemKey(method, params);
          if (itemKey) liveVersions.current.set(itemKey, ++liveRevision.current);
          setEntries(prev => {
            const merged = mergeLiveItem(prev, method, params, threadId);
            return method === "item/completed" && params.item?.type === "agentMessage"
              ? merged.map(entry => entry.turnId === params.turnId && entry.item.id === params.item.id ? { ...entry, completedAtMs: Date.now() } : entry)
              : merged;
          });
        });
        events.addEventListener("approval", event => { const approval = JSON.parse(event.data); notifyApproval(approval, threadsRef.current, id => void openThread({ id } as Thread)); setApprovals(prev => [...prev.filter(a => a.id !== approval.id), approval]); });
        events.addEventListener("approvalResolved", event => { const { id } = JSON.parse(event.data); setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id); });
        events.addEventListener("unsupportedApproval", event => { const { method } = JSON.parse(event.data); setError(`Elpis requested an unsupported approval (${method}). Update the app to answer this request.`); });
        events.addEventListener("account", event => { setAccountRefresh(n => n + 1); if (changesModelCatalog(JSON.parse(event.data).method)) void refreshModels(); });
      } catch (e) {
        if (disposed) return;
        disconnected();
        if (retryableSessionError(e)) {
          retryTimer = setTimeout(() => void initialize(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        } else {
          setConnectionStatus("Elpis could not connect. Your draft is saved.");
          setError(errorText(e));
        }
      }
    }
    void initialize(); return () => { disposed = true; clearTimeout(retryTimer); events?.close(); };
  }, [refreshThreads, patchThread, upsertThread, removeThreads, select, liveKeysAfter, applyHistoryPage, clearApprovalDraft, refreshModels, reconcileLiveThread, rememberFollowing, noteHistoryGap]);
}
