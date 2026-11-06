import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { api, type Thread } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import { without } from "@/lib/utils";
import type { Live, NextTurn } from "@/lib/workspace-types";

/** The terminal's answer to a finished plan: Plan mode off, then this message. */
const IMPLEMENT_PLAN = "Implement the plan.";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  selected: Thread | null; selectedRef: RefObject<Thread | null>; request: RefObject<number>; runtime: ReturnType<typeof useRuntimeState>;
  conversations: ReturnType<typeof useConversationList>; ready: boolean; connected: boolean; busy: boolean; projectChanging: boolean;
  changingPermissions: boolean; planMode: boolean; permissionMode: PermissionMode; threadPlans: Record<string, boolean>;
  setThreadModes: Setter<Record<string, PermissionMode>>; setThreadPlans: Setter<Record<string, boolean>>; setPlanAnswered: Setter<Record<string, string>>;
  setNextTurn: Setter<Record<string, NextTurn>>; setNewPlan: Setter<boolean>; setNewMode: Setter<PermissionMode | null>; setChangingPermissions: Setter<boolean>; setError: Setter<string>;
  focusComposer: () => void; restoreComposerFocus: (origin: Element | null) => void;
};

export function createConversationSettings({ selected, selectedRef, request, runtime, conversations, ready, connected, busy, projectChanging, changingPermissions, planMode, permissionMode, threadPlans, setThreadModes, setThreadPlans, setPlanAnswered, setNextTurn, setNewPlan, setNewMode, setChangingPermissions, setError, focusComposer, restoreComposerFocus }: Inputs) {
  const { modeRevisions, markTurnStarted } = runtime;
  const { settingsOf, patchThread } = conversations;
  /** What a reopened chat reports about its approval mode and Plan mode. It is applied even when the chat's status
   * changed meanwhile (a resume itself reports one), unless the engine announced newer settings for it since the
   * request: without it the composer fell back to Ask for a Full access chat after a reload. */
  function rememberModes(id: string, live: Live) {
    if (live.permissions) setThreadModes(prev => ({ ...prev, [id]: live.permissions! }));
    if (typeof live.planMode === "boolean") setThreadPlans(prev => ({ ...prev, [id]: live.planMode! }));
  }
  const setPlan = (on: boolean) => selected ? setOverride(selected.id, { plan: on }) : setNewPlan(on);
  /** The plan card's answers (components/plan-card.tsx). Accept leaves Plan mode and asks Elpis to carry the plan out,
   * after switching the chat to `permissions` when one is chosen; Keep planning sends what should change, in Plan mode,
   * or with nothing to say just stays there. */
  async function answerPlan(thread: Thread, turnId: string, answer: { implement: true; permissions?: PermissionMode } | { feedback: string }) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    setPlanAnswered(prev => ({ ...prev, [thread.id]: turnId })); setError("");
    const implement = "implement" in answer, feedback = implement ? "" : answer.feedback.trim();
    if (!implement && !feedback) { focusComposer(); return; }
    try {
      if (implement && answer.permissions) {
        const changed = await api<{ permissions: PermissionMode }>(`/threads/${encodeURIComponent(thread.id)}/permissions`, { permissions: answer.permissions });
        setThreadModes(prev => ({ ...prev, [thread.id]: changed.permissions }));
      }
      const result = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/turns`, implement ? { text: IMPLEMENT_PLAN, mode: "default" } : { text: feedback });
      if (!result.turn?.id) throw new Error("Elpis did not acknowledge the new turn. Check the conversation before retrying.");
      if (implement) { setThreadPlans(prev => ({ ...prev, [thread.id]: false })); setNextTurn(prev => { const { plan: _, ...rest } = prev[thread.id] ?? {}; return Object.keys(rest).length ? { ...prev, [thread.id]: rest } : without(prev, thread.id); }); }
      markTurnStarted(thread.id, result.turn!.id);
    } catch (e) { setPlanAnswered(prev => without(prev, thread.id)); setError(errorText(e)); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  /** A chat's permission mode changes now, as the terminal's /permissions does: the engine applies it to the
   * running turn too, and the composer shows the mode the engine reports. A new chat's mode goes in its thread/start. */
  const permissionsLocked = !ready || !connected || (busy && !selected) || projectChanging || changingPermissions;
  const choosePermissions = (next: PermissionMode) => selected ? void changePermissions(selected.id, next) : setNewMode(next);
  /** Shift+Tab in the message box, as in Claude Code: Ask for approval, then Approve for me, then Plan mode, then back.
   * Full access and Bypass are chosen from the menu only; Shift+Tab from them returns to Ask for approval. */
  function cycleMode() {
    if (permissionsLocked) return;
    if (planMode) setPlan(false);
    else if (permissionMode === "auto") { choosePermissions("ask"); setPlan(true); }
    else choosePermissions(permissionMode === "ask" ? "auto" : "ask");
  }
  /** A new chat shows the mode the engine started it in. */
  const noteStartedMode = (id: string, mode: PermissionMode | null | undefined) => { if (mode) setThreadModes(prev => ({ ...prev, [id]: mode })); };
  async function changePermissions(id: string, mode: PermissionMode) {
    if (!ready || !connected) return;
    setChangingPermissions(true); setError("");
    try {
      const result = await api<{ permissions: PermissionMode }>(`/threads/${encodeURIComponent(id)}/permissions`, { permissions: mode });
      modeRevisions.current[id] = (modeRevisions.current[id] ?? 0) + 1; setThreadModes(prev => ({ ...prev, [id]: result.permissions }));
    } catch (e) { setError(errorText(e)); }
    finally { setChangingPermissions(false); }
  }
  /** A chat's effort is saved the moment it is picked (menu, /effort, Shift+Up/Down): later turns, a restart and a
   * running turn take it. "Default" is not a saved level, so it changes nothing here. */
  async function saveEffort(id: string, value: string) {
    if (!ready || !connected) return;
    const before = settingsOf.current[id]?.reasoningEffort ?? (selectedRef.current?.id === id ? selectedRef.current.reasoningEffort : null) ?? null;
    if (!value || value === before) return;
    const apply = (reasoningEffort: string | null) => { settingsOf.current[id] = { ...settingsOf.current[id], reasoningEffort }; patchThread(id, { reasoningEffort }); };
    apply(value); setError("");
    try { await api(`/threads/${encodeURIComponent(id)}/effort`, { effort: value }); }
    catch (e) { apply(before); setError(errorText(e)); }
  }
  function setOverride(id: string, patch: NextTurn) {
    const thread = selectedRef.current; if (!thread) return;
    setNextTurn(prev => {
      const merged = { ...prev[id], ...patch };
      if (merged.model === (thread.model ?? undefined)) delete merged.model;
      if (merged.plan === (threadPlans[id] ?? false)) delete merged.plan;
      return Object.keys(merged).length ? { ...prev, [id]: merged } : without(prev, id);
    });
  }
  return { rememberModes, setPlan, answerPlan, permissionsLocked, choosePermissions, cycleMode, noteStartedMode, saveEffort, setOverride };
}
