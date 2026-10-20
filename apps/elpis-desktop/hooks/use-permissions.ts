/** Owns permission and Plan mode changes for the next chat turn. */
import { useState, type Dispatch, type SetStateAction } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import { api, type Thread } from "@/lib/api";
import { without } from "@/lib/without";
import type { NextTurn } from "@/hooks/use-chat-turns";

/** The terminal's answer to a finished plan: Plan mode off, then this message. */
const IMPLEMENT_PLAN = "Implement the plan.";
type Setter<T> = Dispatch<SetStateAction<T>>;
export function usePermissionState() {
  const [nextTurn, setNextTurn] = useState<Record<string, NextTurn>>({});
  const [threadModes, setThreadModes] = useState<Record<string, PermissionMode>>({});
  const [changingPermissions, setChangingPermissions] = useState(false);
  const [threadPlans, setThreadPlans] = useState<Record<string, boolean>>({});
  const [newPlan, setNewPlan] = useState(false);
  return { nextTurn, setNextTurn, threadModes, setThreadModes, changingPermissions,
    setChangingPermissions, threadPlans, setThreadPlans, newPlan, setNewPlan };
}
type Ref<T> = { current: T };
type Props = {
  selected: Thread | null; selectedRef: Ref<Thread | null>;
  setNewPlan: Setter<boolean>; setPlanAnswered: Setter<Record<string, string>>;
  setError: Setter<string>; request: Ref<number>; setThreadModes: Setter<Record<string, PermissionMode>>;
  setThreadPlans: Setter<Record<string, boolean>>; setNextTurn: Setter<Record<string, NextTurn>>;
  completedTurns: Ref<Set<string>>; setActiveTurns: Setter<Record<string, string>>;
  ready: boolean; busy: boolean; projectChanging: boolean; changingPermissions: boolean;
  setChangingPermissions: Setter<boolean>; setNewMode: Setter<PermissionMode | null>;
  planMode: boolean; permissionMode: PermissionMode; threadPlans: Record<string, boolean>;
  focusComposer: () => void; restoreComposerFocus: (origin: Element | null) => void;
};

export function usePermissions({ selected, selectedRef, setNewPlan, setPlanAnswered, setError, request,
  setThreadModes, setThreadPlans, setNextTurn, completedTurns, setActiveTurns, ready, busy,
  projectChanging, changingPermissions, setChangingPermissions, setNewMode, planMode, permissionMode,
  threadPlans, focusComposer, restoreComposerFocus }: Props) {
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
      if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: result.turn!.id }));
    } catch (e) { setPlanAnswered(prev => without(prev, thread.id)); setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  /** A chat's permission mode changes now, as the terminal's /permissions does: the engine applies it to the
   * running turn too, and the composer shows the mode the engine reports. A new chat's mode goes in its thread/start. */
  const permissionsLocked = !ready || busy || projectChanging || changingPermissions;
  const choosePermissions = (next: PermissionMode) => selected ? void changePermissions(selected.id, next) : setNewMode(next);
  /** Shift+Tab in the message box, as in Claude Code: Ask for approval, then Approve for me, then Plan mode, then back.
   * Full access and Bypass are chosen from the menu only; Shift+Tab from them returns to Ask for approval. */
  function cycleMode() {
    if (permissionsLocked) return;
    if (planMode) setPlan(false);
    else if (permissionMode === "auto") { choosePermissions("ask"); setPlan(true); }
    else choosePermissions(permissionMode === "ask" ? "auto" : "ask");
  }
  async function changePermissions(id: string, mode: PermissionMode) {
    setChangingPermissions(true); setError("");
    try {
      const result = await api<{ permissions: PermissionMode }>(`/threads/${encodeURIComponent(id)}/permissions`, { permissions: mode });
      setThreadModes(prev => ({ ...prev, [id]: result.permissions }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChangingPermissions(false); }
  }
  function setOverride(id: string, patch: NextTurn) {
    const thread = selectedRef.current; if (!thread) return;
    setNextTurn(prev => {
      const merged = { ...prev[id], ...patch };
      if (merged.model === (thread.model ?? undefined)) delete merged.model;
      if (merged.effort === (thread.reasoningEffort ?? undefined) || merged.effort === "") delete merged.effort;
      if (merged.plan === (threadPlans[id] ?? false)) delete merged.plan;
      return Object.keys(merged).length ? { ...prev, [id]: merged } : without(prev, id);
    });
  }
  return { setPlan, answerPlan, permissionsLocked, choosePermissions, cycleMode, changePermissions, setOverride };
}
