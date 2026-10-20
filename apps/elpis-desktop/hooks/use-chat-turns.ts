/** Owns sending, stopping, replacing, rewinding, and paging chat turns. */
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { queueFollowUp, type FollowUpOptions } from "@/lib/follow-ups";
import { newChatFolder, type Preferences } from "@/lib/preferences";
import { usedMentions, type Mention } from "@/lib/mentions";
import { entryKey, submittedContent, type SubmittedMessage } from "@/lib/submitted-messages";
import { api, title, unreadable, type Entry, type ProviderChoice, type Thread } from "@/lib/api";
import { without } from "@/lib/without";
import type { Attachment } from "@/lib/attachments";
import type { Browser } from "@/components/browser-panel";
import type { ChatTabs } from "@/lib/chat-tabs";
import type { PermissionMode } from "@/components/composer-controls";
import type { RestoreMode } from "@/components/rewind-dialog";
import type { replacementEligibility } from "@/lib/turn-replacement";
import type { FailedTurn } from "@/components/failed-turn-card";
import type { TaskPlan } from "@/components/task-list";

export type NextTurn = { model?: string; effort?: string; plan?: boolean };
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
export function useTurnActivity() {
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  // Each chat's latest task list (turn/plan/updated), shown above the message box.
  const [plans, setPlans] = useState<Record<string, TaskPlan>>({});
  // A fast turn can finish over SSE before its HTTP start response arrives.
  const completedTurns = useRef(new Set<string>());
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [liveError, setLiveError] = useState<Record<string, string>>({});
  const [runtimeNotices, setRuntimeNotices] = useState<Record<string, string>>({});
  const [failedTurns, setFailedTurns] = useState<Record<string, FailedTurn>>({});
  // A stopped turn says so until the next turn starts.
  const [stoppedTurns, setStoppedTurns] = useState<Record<string, string>>({});
  return { activeTurns, setActiveTurns, plans, setPlans, completedTurns, activity, setActivity,
    liveError, setLiveError, runtimeNotices, setRuntimeNotices, failedTurns, setFailedTurns,
    stoppedTurns, setStoppedTurns };
}
type Props = {
  selected: Thread | null; selectedRef: Ref<Thread | null>; request: Ref<number>; tabsRef: Ref<ChatTabs>;
  newDraftKey: Ref<string>; textRef: Ref<string>; attachmentsRef: Ref<Attachment[]>;
  pickedMentions: Ref<Map<string, Mention>>; shellCreated: Ref<string | null>;
  stickToBottom: Ref<boolean>; completedTurns: Ref<Set<string>>;
  settingsOf: Ref<Record<string, Pick<Thread, "model" | "modelProvider" | "reasoningEffort">>>;
  transcripts: Ref<Map<string, { entries: Entry[]; cursor: string | null }>>;
  hidden: Ref<Set<string>>; rewindSwitch: Ref<string | null>;
  scroll: Ref<HTMLDivElement | null>; restoreScroll: Ref<{ height: number; top: number } | null>;
  browser: Browser; preferences: Preferences; newChoice: ProviderChoice | undefined;
  replacementOptions: Map<string, ReturnType<typeof replacementEligibility>>;
  readOnlyRun: boolean; shellMode: boolean; busy: boolean; dictating: boolean; attaching: boolean;
  projectChanging: boolean; connected: boolean; imageBlocked: boolean; missingChoiceNotice: string;
  needsModelId: boolean; model: string; cwd: string; newWorktree: boolean; newMode: PermissionMode | null;
  activeTurn: string | undefined; activeTurns: Record<string, string>; continues: boolean;
  effort: string; newPlan: boolean; pending: NextTurn | undefined; nextTurn: Record<string, NextTurn>;
  entries: Entry[]; itemCursor: string | null;
  setError: Setter<string>; setBusy: Setter<boolean>; setText: (value: string) => void;
  setAttachments: (value: Attachment[]) => void; setFileNotice: Setter<string>;
  setSubmissions: Setter<SubmittedMessage[]>; setThreads: Setter<Thread[]>;
  setThreadModes: Setter<Record<string, PermissionMode>>; setRuntimeNotices: Setter<Record<string, string>>;
  setActiveTurns: Setter<Record<string, string>>; setThreadPlans: Setter<Record<string, boolean>>;
  setNewPlan: Setter<boolean>; setNextTurn: Setter<Record<string, NextTurn>>;
  setMessageEdits: Setter<Record<string, string>>; setEntries: Setter<Entry[]>;
  setRewindBusy: Setter<boolean>; setRewindActions: Setter<Record<string, "undo" | "redo" | undefined>>;
  setLoading: Setter<boolean>; setItemCursor: Setter<string | null>;
  editDraft: (value: string) => void; saveDraft: (id: string, value: string) => void;
  savedDraft: (id: string) => string; saveAttachments: (id: string, value: Attachment[]) => void;
  savedAttachments: (id: string) => Attachment[];
  select: (thread: Thread | null) => void; upsertThread: (thread: Thread) => void;
  loadThread: (thread: Thread) => Promise<void>; patchThread: (id: string, patch: Partial<Thread>) => void;
  submitDraft: <T>(key: string, send: () => Promise<T>) => Promise<T>;
  askSideQuestion: (question?: string) => void; restoreComposerFocus: (origin: Element | null) => void;
  focusComposer: () => void;
};

export function useChatTurns({ selected, selectedRef, request, tabsRef, newDraftKey, textRef, attachmentsRef,
  pickedMentions, shellCreated, stickToBottom, completedTurns, settingsOf, transcripts, hidden, rewindSwitch,
  scroll, restoreScroll, browser, preferences, newChoice, replacementOptions, readOnlyRun, shellMode, busy,
  dictating, attaching, projectChanging, connected, imageBlocked, missingChoiceNotice, needsModelId, model,
  cwd, newWorktree, newMode, activeTurn, activeTurns, continues, effort, newPlan, pending, nextTurn, entries,
  itemCursor, setError, setBusy, setText, setAttachments, setFileNotice, setSubmissions, setThreads, setThreadModes,
  setRuntimeNotices, setActiveTurns, setThreadPlans, setNewPlan, setNextTurn, setMessageEdits, setEntries,
  setRewindBusy, setRewindActions, setLoading, setItemCursor, editDraft, saveDraft, savedDraft, saveAttachments,
  savedAttachments, select, upsertThread, loadThread, patchThread, submitDraft,
  askSideQuestion, restoreComposerFocus, focusComposer }: Props) {
  /** Sends the composer's message, or `own`: a command's message (such as /init's prompt), sent without the composer's files.
   * While a turn runs, `followUp` steers or queues this one message instead of following Settings (Ctrl+Enter). */
  async function send(own?: string, followUp?: Preferences["followUp"]) {
    if (readOnlyRun) return;
    if (own === undefined && shellMode) { await sendShell(); return; }
    const sideQuestion = own === undefined ? /^\/btw(?:[\s:,.]\s*([\s\S]*))?$/i.exec(textRef.current.trim()) : null;
    if (sideQuestion) { if (selected) editDraft(""); askSideQuestion(sideQuestion[1]); return; }
    const outgoing = own ?? textRef.current, files = own === undefined ? attachmentsRef.current : [];
    if ((!outgoing.trim() && !files.length) || busy || dictating || attaching || projectChanging || !connected) return;
    if (imageBlocked && own === undefined) return; // the box already says why
    if (missingChoiceNotice) return;
    if (needsModelId && !model.trim()) { setError("Enter a model ID for the selected provider."); return; }
    setBusy(true); setError("");
    const sentText = outgoing, sentAttachments = [...files];
    const sentMentions = own === undefined ? usedMentions(outgoing, [...pickedMentions.current.values()]) : [];
    pickedMentions.current = new Map();
    const originalId = selected?.id || newDraftKey.current, originalRequest = request.current, browserDraft = `draft:${tabsRef.current.activeId}`;
    const submissionKey = crypto.randomUUID();
    const clearsComposer = own === undefined;
    if (clearsComposer) { setText(""); saveDraft(originalId, ""); setAttachments([]); saveAttachments(originalId, []); }
    const queued = activeTurn && !continues && (followUp ?? preferences.followUp) === "queue";
    if (!queued) {
      stickToBottom.current = true;
      setSubmissions(previous => [...previous.filter(sent => sent.scope === originalId), { key: submissionKey, scope: originalId, content: submittedContent(sentText, sentAttachments), previousKeys: entries.map(entryKey), newTurn: !activeTurn || continues, ...(activeTurn && !continues ? { turnId: activeTurn } : {}) }]);
    }
    const updateSubmission = (patch: Partial<SubmittedMessage>) => setSubmissions(previous => previous.map(sent => sent.key === submissionKey
      ? { ...sent, ...(patch.turnId && sent.turnId && patch.turnId !== sent.turnId ? { recorded: undefined } : {}), ...patch } : sent));
    const originalFocus = document.activeElement;
    const attached = { ...(sentAttachments.length ? { attachments: sentAttachments } : {}), ...(sentMentions.length ? { mentions: sentMentions } : {}) };
    let errorThreadId = selected?.id;
    try {
      let thread = selected;
      if (!thread) {
        const result = await api<{ thread: Thread }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}), ...(newWorktree ? { worktree: true } : {}) });
        thread = result.thread; errorThreadId = thread.id; if (newMode) setThreadModes(prev => ({ ...prev, [result.thread.id]: newMode }));
        updateSubmission({ scope: thread.id });
        await browser.adoptSession(browserDraft, thread.id);
        saveDraft(thread.id, originalRequest === request.current ? textRef.current : sentText);
        saveAttachments(thread.id, originalRequest === request.current ? attachmentsRef.current : sentAttachments);
        if (originalRequest === request.current) { saveDraft(originalId, ""); saveAttachments(originalId, []); select(thread); }
        setThreads(prev => [thread!, ...prev]);
      }
      const used: NextTurn | undefined = selected ? pending : effort || newPlan ? { ...(effort ? { effort } : {}), ...(newPlan ? { plan: true } : {}) } : undefined;
      const turnOptions: FollowUpOptions = { ...(used?.model ? { model: used.model } : {}), ...(used?.effort ? { effort: used.effort } : {}), ...(used?.plan !== undefined ? { mode: used.plan ? "plan" : "default" } : {}) };
      if (activeTurn && !continues && queueFollowUp(thread.id, sentText, sentAttachments, { ...turnOptions, ...(sentMentions.length ? { mentions: sentMentions } : {}) }, followUp)) { /* queued until the running turn completes */ } else if (activeTurn && !continues) {
        const steered = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/steer`, { text: sentText, expectedTurnId: activeTurn, ...attached });
        // The turn shown as running had ended, so the message started a new one.
        if (steered.turn?.id) {
          updateSubmission({ turnId: steered.turn.id, newTurn: true });
          if (!completedTurns.current.has(steered.turn.id)) setActiveTurns(prev => ({ ...prev, [thread!.id]: steered.turn!.id }));
        }
      } else {
        const result = await api<{ turn?: { id: string }; thread?: Thread; continuedFrom?: string; sendError?: string }>(`/threads/${encodeURIComponent(thread.id)}/turns`, { text: sentText, ...attached, ...turnOptions, ...(continues ? { continueAs: `${title(thread)} (continued)` } : {}) });
        if (result.thread && result.sendError) {
          updateSubmission({ failed: true });
          const forkDraft = savedDraft(result.thread.id);
          const hasNewerForkDraft = !!forkDraft.trim() && forkDraft !== sentText || savedAttachments(result.thread.id).length > 0;
          const targetKey = hasNewerForkDraft ? `recovery-${result.thread.id}` : result.thread.id;
          saveDraft(targetKey, sentText); saveAttachments(targetKey, sentAttachments); upsertThread(result.thread);
          setRuntimeNotices(previous => ({ ...previous, [result.thread!.id]: result.sendError + (hasNewerForkDraft ? " Your current draft is kept; recover the unsent message below." : "") }));
          if (selectedRef.current?.id === thread.id && request.current === originalRequest) await loadThread(result.thread);
          return;
        }
        if (!result.turn?.id) throw new Error("Elpis did not acknowledge the new turn. Check the conversation before retrying.");
        updateSubmission({ turnId: result.turn.id, ...(result.thread ? { scope: result.thread.id } : {}) });
        if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [result.thread?.id || thread!.id]: result.turn!.id }));
        if (used?.plan !== undefined) { setThreadPlans(prev => ({ ...prev, [result.thread?.id || thread!.id]: used.plan! })); if (!selected) setNewPlan(false); }
        if (selected && used) {
          setNextTurn(prev => without(prev, selected.id));
          const effective = { ...settingsOf.current[thread.id], ...(used.model ? { model: used.model } : {}), ...(used.effort ? { reasoningEffort: used.effort } : {}) };
          settingsOf.current[thread.id] = effective; patchThread(thread.id, effective);
        }
        if (result.thread) {
          upsertThread(result.thread);
          if (selectedRef.current?.id === thread.id && request.current === originalRequest) await loadThread(result.thread);
          return;
        }
      }
    } catch (e) {
      updateSubmission({ failed: true });
      for (const mention of sentMentions) pickedMentions.current.set(mention.path, mention);
      if (clearsComposer) {
        const key = errorThreadId || originalId, shown = (selectedRef.current?.id || newDraftKey.current) === key;
        if (shown && !textRef.current.trim() && !attachmentsRef.current.length) { setText(sentText); setAttachments(sentAttachments); }
        const target = !savedDraft(key).trim() && !savedAttachments(key).length ? key : `recovery-${key}`;
        saveDraft(target, sentText); saveAttachments(target, sentAttachments);
      }
      if (errorThreadId) setRuntimeNotices(previous => ({ ...previous, [errorThreadId!]: e instanceof Error ? e.message : String(e) }));
      else if (originalRequest === request.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      if (request.current === originalRequest && (errorThreadId ? selectedRef.current?.id === errorThreadId : !selectedRef.current)) restoreComposerFocus(originalFocus);
    }
  }
  async function sendShell() {
    const command = textRef.current, originalRequest = request.current;
    if (!command.trim() || busy || !connected || projectChanging) return;
    if (attachmentsRef.current.length) { setFileNotice("Bash mode is on. Return to chat to send attachments."); return; }
    setBusy(true); setError("");
    let thread = selectedRef.current;
    const originalId = thread?.id || newDraftKey.current, browserDraft = `draft:${tabsRef.current.activeId}`;
    try {
      if (!thread) {
        const result = await api<{ thread: Thread }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}) });
        thread = result.thread; upsertThread(thread);
        await browser.adoptSession(browserDraft, thread.id);
        if (request.current === originalRequest) { saveDraft(originalId, ""); saveDraft(thread.id, command); shellCreated.current = thread.id; select(thread); }
      }
      await api(`/threads/${encodeURIComponent(thread.id)}/shell`, { command });
      if (savedDraft(thread.id) === command) saveDraft(thread.id, "");
      if (selectedRef.current?.id === thread.id && textRef.current === command && request.current === originalRequest) setText("");
    } catch (e) { if (request.current === originalRequest) setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (request.current === originalRequest) focusComposer(); }
  }
  async function stop(thread: Thread) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    try { await api(`/threads/${encodeURIComponent(thread.id)}/interrupt`, activeTurns[thread.id] ? { turnId: activeTurns[thread.id] } : {}); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  /** Edit-and-resend and regenerate: Elpis replaces the turn and every later one, then runs the new text. */
  async function replaceFrom(turnId: string, replacement: string, editKey?: string, retryModel?: string) {
    const thread = selectedRef.current; if (!thread) return;
    const originalFocus = document.activeElement, originalRequest = request.current;
    if (savedDraft(`recovery-${thread.id}`) || savedAttachments(`recovery-${thread.id}`).length) throw new Error("Recover the saved edited message before replacing another turn.");
    const eligibility = replacementOptions.get(turnId);
    if (!eligibility?.allowed) throw new Error(eligibility && !eligibility.allowed ? eligibility.reason : "The complete input for this turn is unavailable.");
    const index = entries.findIndex(entry => entry.turnId === turnId);
    const stale = new Set(entries.slice(Math.max(index, 0)).map(entry => entry.turnId));
    const overrides = retryModel ? { ...nextTurn[thread.id], model: retryModel } : nextTurn[thread.id];
    const sendReplacement = () => api<{ turn?: { id: string }; rewound?: boolean; sendError?: string }>(`/threads/${encodeURIComponent(thread.id)}/revert`, { beforeTurnId: turnId, text: replacement,
      ...(overrides?.model ? { model: overrides.model } : {}), ...(overrides?.effort ? { effort: overrides.effort } : {}) });
    const result = editKey ? await submitDraft(editKey, sendReplacement) : await sendReplacement();
    if (result.rewound && result.sendError) {
      saveDraft(`recovery-${thread.id}`, replacement);
      if (selectedRef.current?.id === thread.id) await loadThread(thread);
      setRuntimeNotices(prev => ({ ...prev, [thread.id]: `${result.sendError} Your edited message is saved separately below; your composer draft is unchanged.` }));
      return;
    }
    if (!result.turn) throw new Error("Elpis did not acknowledge the replacement turn. Check the conversation before retrying.");
    if (editKey) setMessageEdits(previous => previous[editKey] === replacement ? without(previous, editKey) : previous);
    const startedTurn = result.turn;
    if (overrides) setNextTurn(prev => without(prev, thread.id));
    if (selectedRef.current?.id === thread.id) { stickToBottom.current = true; setEntries(prev => prev.filter(entry => !stale.has(entry.turnId))); }
    if (!completedTurns.current.has(startedTurn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: startedTurn.id }));
    if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus);
  }
  /** "Rewind to here": Elpis drops the turn and every later one (thread/revert, as edit-and-resend does) without sending anything;
   * the turn's prompt returns to an empty message box when it can be resent as text. */
  async function rewindFrom(turnId: string, mode: RestoreMode, version?: string) {
    const thread = selectedRef.current; if (!thread) return;
    const prompt = replacementOptions.get(turnId);
    await switchRewind({ action: "restore", beforeTurnId: turnId, mode, ...(version ? { version } : {}) }, mode === "code");
    if (mode !== "code" && prompt?.allowed && !textRef.current.trim()) editDraft(prompt.prompt);
    if (mode !== "code") focusComposer();
  }
  async function switchRewind(body: { action: string; beforeTurnId?: string; mode?: RestoreMode; version?: string }, filesOnly = false) {
    const thread = selectedRef.current; if (!thread) return;
    const draft = textRef.current; rewindSwitch.current = thread.id; setRewindBusy(true);
    try {
      const result = await api<{ thread?: Thread; undo?: "undo" | "redo" }>(`/threads/${encodeURIComponent(thread.id)}/rewind`, body);
      if (filesOnly || selectedRef.current?.id !== thread.id) return;
      const next = result.thread ?? thread;
      transcripts.current.delete(next.id); hidden.current.delete(next.id); upsertThread(next);
      if (next.id !== thread.id) { hidden.current.add(thread.id); setThreads(prev => prev.filter(item => item.id !== thread.id)); }
      setEntries([]); await loadThread(next);
      if (draft.trim()) editDraft(draft);
      setRewindActions(prev => ({ ...prev, [thread.id]: undefined, [next.id]: result.undo }));
    } finally { rewindSwitch.current = null; setRewindBusy(false); }
  }
  async function older(untilTurnId?: string): Promise<boolean> {
    if (!selected || !itemCursor) return false;
    setLoading(true);
    const id = selected.id, pages: Entry[] = [], seen = new Set<string>();
    let cursor: string | null = itemCursor, found = false;
    try {
      while (cursor) {
        if (seen.has(cursor)) throw new Error("Repeated conversation cursor");
        seen.add(cursor);
        const result: { data: Entry[]; nextCursor: string | null } = await api(`/threads/${encodeURIComponent(id)}?limit=100&cursor=${encodeURIComponent(cursor)}`);
        if (!Array.isArray(result.data)) throw unreadable("conversations");
        found = result.data.some(entry => entry.turnId === untilTurnId && entry.item.type === "userMessage");
        pages.unshift(...result.data.reverse());
        cursor = result.nextCursor;
        if (!untilTurnId || found || selectedRef.current?.id !== id) break;
      }
      if (selectedRef.current?.id !== id) return false;
      stickToBottom.current = false;
      if (scroll.current) restoreScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
      setEntries(prev => [...pages, ...prev]);
      setItemCursor(cursor);
      return untilTurnId ? found : true;
    } catch (e) { setError(String(e)); return false; }
    finally { setLoading(false); }
  }
  return { send, sendShell, stop, replaceFrom, rewindFrom, switchRewind, older };
}
