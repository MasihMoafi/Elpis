import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { api, title, type Entry, type ProviderChoice, type Thread } from "@/lib/api";
import type { ChatTabs } from "@/lib/chat-tabs";
import { errorText } from "@/lib/error-text.mjs";
import { queueFollowUp, type FollowUpOptions } from "@/lib/follow-ups";
import { usedMentions } from "@/lib/mentions";
import { newChatFolder, type Preferences } from "@/lib/preferences";
import { entryKey, submittedContent, type SubmittedMessage } from "@/lib/submitted-messages";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useProjectState } from "@/lib/use-project-state";
import { without } from "@/lib/utils";
import type { NextTurn } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = RefObject<T>;
type SendInputs = {
  projectState: ReturnType<typeof useProjectState>; composer: ReturnType<typeof useComposerState>; conversations: ReturnType<typeof useConversationList>; runtime: ReturnType<typeof useRuntimeState>; attachments: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  readOnlyRun: boolean; sendShell: () => Promise<void>;
  selected: Thread | null; editDraft: (value: string) => void; askSideQuestion: (question?: string) => void;
  busy: boolean; canSendFollowUp: boolean; imageBlocked: boolean;
  missingChoiceNotice: string; needsModelId: boolean; model: string; setError: Setter<string>; sending: Ref<number>; setBusy: Setter<boolean>;
  newDraftKey: Ref<string>; request: Ref<number>; tabsRef: Ref<ChatTabs>;
  activeTurn: string | undefined; continues: boolean; preferences: Preferences;
  stickToBottom: Ref<boolean>; setSubmissions: Setter<SubmittedMessage[]>; entries: Entry[];
  newMode: PermissionMode | null; newChoice: ProviderChoice | undefined; newWorktree: boolean;
  noteStartedMode: (id: string, mode: PermissionMode | null | undefined) => void;
  browser: { adoptSession: (from: string, to: string) => Promise<void> };
  setThreads: Setter<Thread[]>; assignProject: (ids: string | string[], destination: string | null | undefined) => Promise<void>;
  pending: NextTurn | undefined; effort: string; newPlan: boolean;
  selectedRef: Ref<Thread | null>; loadThread: (thread: Thread) => Promise<void>; setThreadPlans: Setter<Record<string, boolean>>;
  setNewPlan: Setter<boolean>; setNextTurn: Setter<Record<string, NextTurn>>;
  restoreComposerFocus: (origin: Element | null) => number;
};

export function createChatSend({ projectState, composer, conversations, runtime, attachments, drafts, sendShell, askSideQuestion, restoreComposerFocus, readOnlyRun, selected, editDraft, busy, canSendFollowUp, imageBlocked, missingChoiceNotice, needsModelId, model, setError, sending, setBusy, newDraftKey, request, tabsRef, activeTurn, continues, preferences, stickToBottom, setSubmissions, entries, newMode, newChoice, newWorktree, noteStartedMode, browser, setThreads, assignProject, pending, effort, newPlan, selectedRef, loadThread, setThreadPlans, setNewPlan, setNextTurn }: SendInputs) {
  const { projectChanging, cwd, projectId } = projectState;
  const { shellMode, textRef, setText, pickedMentions, dictating } = composer;
  const { select, settingsOf, patchThread, upsertThread } = conversations;
  const { ready, connected, markTurnStarted, setRuntimeNotices } = runtime;
  const { attaching, attachmentsRef, setAttachments } = attachments;
  const { saveDraft, savedDraft, saveAttachments, savedAttachments } = drafts;
  return async function send(own?: string, followUp?: Preferences["followUp"]) {
    if (!ready || !connected || readOnlyRun) return;
    if (own === undefined && shellMode) { await sendShell(); return; }
    const sideQuestion = own === undefined ? /^\/btw(?:[\s:,.]\s*([\s\S]*))?$/i.exec(textRef.current.trim()) : null;
    if (sideQuestion) { if (selected) editDraft(""); askSideQuestion(sideQuestion[1]); return; }
    const outgoing = own ?? textRef.current, files = own === undefined ? attachmentsRef.current : [];
    if ((!outgoing.trim() && !files.length) || (busy && !canSendFollowUp) || dictating || attaching || projectChanging) return;
    if (imageBlocked && own === undefined) return; // the box already says why
    if (missingChoiceNotice) return;
    if (needsModelId && !model.trim()) { setError("Enter a model ID for the selected provider."); return; }
    sending.current++; setBusy(true); setError("");
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
        const result = await api<{ thread: Thread; permissions?: PermissionMode | null }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}), ...(newWorktree ? { worktree: true } : {}) });
        thread = result.thread; errorThreadId = thread.id; noteStartedMode(result.thread.id, result.permissions ?? newMode);
        updateSubmission({ scope: thread.id });
        await browser.adoptSession(browserDraft, thread.id);
        saveDraft(thread.id, originalRequest === request.current ? textRef.current : sentText);
        saveAttachments(thread.id, originalRequest === request.current ? attachmentsRef.current : sentAttachments);
        if (originalRequest === request.current) { saveDraft(originalId, ""); saveAttachments(originalId, []); select(thread); }
        setThreads(prev => [thread!, ...prev]);
        if (projectId) await assignProject(thread.id, projectId);
      }
      const used: (NextTurn & { effort?: string }) | undefined = selected ? pending : effort || newPlan ? { ...(effort ? { effort } : {}), ...(newPlan ? { plan: true } : {}) } : undefined;
      const turnOptions: FollowUpOptions = { ...(used?.model ? { model: used.model } : {}), ...(used?.effort ? { effort: used.effort } : {}), ...(used?.plan !== undefined ? { mode: used.plan ? "plan" : "default" } : {}) };
      if (activeTurn && !continues && queueFollowUp(thread.id, sentText, sentAttachments, { ...turnOptions, ...(sentMentions.length ? { mentions: sentMentions } : {}) }, followUp)) { /* queued until the running turn completes */ } else if (activeTurn && !continues) {
        const steered = await api<{ turn?: { id: string }; turnId?: string; compacting?: boolean }>(`/threads/${encodeURIComponent(thread.id)}/steer`, { text: sentText, expectedTurnId: activeTurn, ...attached });
        // The running turn compacts the history and takes no message: it waits in the queue for the compaction's end.
        if (steered.compacting) {
          queueFollowUp(thread.id, sentText, sentAttachments, { ...turnOptions, ...(sentMentions.length ? { mentions: sentMentions } : {}) }, "queue");
          setSubmissions(previous => previous.filter(sent => sent.key !== submissionKey));
        // The turn shown as running had ended, so the message started a new one.
        } else if (steered.turn?.id) {
          updateSubmission({ turnId: steered.turn.id, newTurn: true });
          markTurnStarted(thread!.id, steered.turn!.id);
        } else if (steered.turnId && steered.turnId !== activeTurn) {
          updateSubmission({ turnId: steered.turnId });
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
        markTurnStarted(result.thread?.id || thread!.id, result.turn!.id);
        if (used?.plan !== undefined) { setThreadPlans(prev => ({ ...prev, [result.thread?.id || thread!.id]: used.plan! })); if (!selected) setNewPlan(false); }
        if (selected && used) {
          setNextTurn(prev => without(prev, selected.id));
          const effective = { ...settingsOf.current[thread.id], ...(used.model ? { model: used.model } : {}) };
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
      if (errorThreadId) setRuntimeNotices(previous => ({ ...previous, [errorThreadId!]: errorText(e) }));
      else if (originalRequest === request.current) setError(String(errorText(e)));
    } finally {
      sending.current--; setBusy(sending.current > 0);
      if (request.current === originalRequest && (errorThreadId ? selectedRef.current?.id === errorThreadId : !selectedRef.current)) restoreComposerFocus(originalFocus);
    }
  };
}
