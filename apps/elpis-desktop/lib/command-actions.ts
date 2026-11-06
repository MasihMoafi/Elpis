import type { ComposerPanel } from "@/lib/use-composer-panels";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ReviewTarget } from "@/components/slash-panels";
import type { useSidePanel } from "@/components/side-panel";
import { api, chatProvider, modelLabel, title, unreadable, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { historyPath, inReadingOrder } from "@/lib/chat-history";
import { errorText } from "@/lib/error-text.mjs";
import type { modelSelection } from "@/lib/model-selection";
import { fastServiceTier } from "@/lib/service-tier.mjs";
import { reloadSettings, saveSettings } from "@/lib/settings-store";
import { conversationMarkdown, exportFileName } from "@/lib/slash";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  selected: Thread | null; selectedRef: RefObject<Thread | null>; textRef: RefObject<string>; turnEfforts: string[]; turnEffort: string; turnModel: string;
  models: Model[]; providerSettings: ProviderSettings | null; newChoice: ReturnType<typeof modelSelection>["newChoice"];
  commandNoticeOwner: RefObject<string>; fastNoticeOwner: RefObject<string | null>; side: ReturnType<typeof useSidePanel>; runtime: ReturnType<typeof useRuntimeState>;
  conversations: ReturnType<typeof useConversationList>; ready: boolean; connected: boolean; desktop: boolean;
  setSlashNotice: Setter<string>; setEffort: Setter<string>; setPanel: Setter<ComposerPanel>; setError: Setter<string>; setBusy: Setter<boolean>;
  openComposerControl: (label: string) => void; saveEffort: (id: string, value: string) => Promise<void>; focusComposer: () => void; editDraft: (value: string) => void;
};

export function createCommandActions({ selected, selectedRef, textRef, turnEfforts, turnEffort, turnModel, models, providerSettings, newChoice, commandNoticeOwner, fastNoticeOwner, side, runtime, conversations, ready, connected, desktop, setSlashNotice, setEffort, setPanel, setError, setBusy, openComposerControl, saveEffort, focusComposer, editDraft }: Inputs) {
  const { markTurnStarted } = runtime;
  const { patchThread } = conversations;
  const chooseEffort = (level?: string) => {
    if (!level) { openComposerControl("Reasoning effort"); return; }
    const match = turnEfforts.find(item => item.toLowerCase() === level.toLowerCase());
    if (!match) { setSlashNotice(`${modelLabel(turnModel || providerSettings?.main.model, models)} does not offer the reasoning effort “${level}”. It offers: ${turnEfforts.join(", ")}.`); return; }
    if (selected) void saveEffort(selected.id, match); else setEffort(match);
  };
  const stepEffort = (by: -1 | 1) => {
    const configured = turnModel || providerSettings?.main.model;
    const model = models.find(item => item.model === configured || item.id === configured);
    const current = turnEffort || model?.defaultReasoningEffort || "medium";
    const index = Math.max(0, turnEfforts.indexOf(current));
    chooseEffort(turnEfforts[Math.max(0, Math.min(turnEfforts.length - 1, index + by))]);
  };
  async function startReview(thread: Thread, target: ReviewTarget) {
    setPanel(null); setError("");
    try {
      const result = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/review`, { target });
      if (!result.turn?.id) throw new Error("Elpis did not acknowledge the review. Check the conversation before retrying.");
      markTurnStarted(thread.id, result.turn!.id);
    } catch (e) { setError(errorText(e)); }
    focusComposer();
  }
  function compactChat(thread: Thread, guidance?: string) {
    // The terminal reads a lone number as its pressure setting; this app has no such setting to save.
    if (guidance && /^\d+(\.\d+)?%?$/.test(guidance)) { setSlashNotice("A number sets the terminal's pressure compaction, which this app does not save. Compact now, or add words to guide the summary."); return; }
    api(`/threads/${encodeURIComponent(thread.id)}/compact`, guidance ? { instructions: guidance } : {}).catch(e => setError(errorText(e)));
  }
  async function exportChat(thread: Thread) {
    try {
      const all: Entry[] = []; let cursor: string | null = null;
      do { // Pages come newest first; each older page goes in front.
        const result: { data: Entry[]; nextCursor: string | null } = await api(historyPath(thread.id, cursor)); if (!Array.isArray(result.data)) throw unreadable("conversations");
        all.unshift(...inReadingOrder(result)); cursor = result.nextCursor;
      } while (cursor && all.length < 100000);
      const link = document.createElement("a"), file = exportFileName(title(thread));
      link.href = URL.createObjectURL(new Blob([conversationMarkdown(title(thread), all)], { type: "text/markdown" })); link.download = file;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      setSlashNotice(`Exported the conversation as ${file}.`);
    } catch (e) { setError(`Could not export: ${errorText(e)}`); }
  }
  async function turnSmartPruneOn() {
    try {
      const current = await api<{ version?: string | null; smartPrune?: { enabled: boolean | null } }>("/settings");
      if (current.smartPrune?.enabled) { setSlashNotice("Smart Prune is already on."); return; }
      await saveSettings("/settings", { version: current.version, options: { automaticPruning: true } });
      setSlashNotice("Smart Prune is on. It applies to new chats.");
    } catch (e) { setError(`Could not turn Smart Prune on: ${errorText(e)}`); }
  }
  async function chooseFast(args?: string) {
    if (!ready || !connected) return;
    const owner = commandNoticeOwner.current;
    const notify = (message: string) => { if (commandNoticeOwner.current === owner) { fastNoticeOwner.current = owner; setSlashNotice(message); } };
    const choice = args?.trim().toLowerCase();
    if (choice && choice !== 'on' && choice !== 'off') { notify('Use /fast, /fast on or /fast off.'); return; }
    const provider = chatProvider(turnModel, selected ? selected.modelProvider : newChoice?.provider, providerSettings?.main.provider);
    if (provider !== 'openai') { notify('/fast is available for OpenAI models.'); return; }
    setBusy(true); notify('');
    try {
      let serviceTier: string;
      let activeTurnApplied = false, warning: string | undefined;
      if (selected) {
        const applied = await api<{ serviceTier: string; activeTurnApplied?: boolean; warning?: string }>(`/threads/${encodeURIComponent(selected.id)}/service-tier`, choice ? { enabled: choice === 'on' } : {});
        serviceTier = applied.serviceTier;
        activeTurnApplied = applied.activeTurnApplied === true; warning = applied.warning;
        patchThread(selected.id, { serviceTier });
      } else {
        const current = await reloadSettings();
        const enabled = choice ? choice === 'on' : !['fast', 'priority'].includes(current.options?.serviceTier ?? '');
        const chosen = models.find(item => item.model === (turnModel || current.main.model));
        if (enabled && !fastServiceTier(chosen)) throw new Error('This model does not offer Fast on this account.');
        const confirmed = await saveSettings('/settings', { version: current.version, options: { serviceTier: enabled ? 'fast' : 'default' } });
        serviceTier = confirmed.options?.serviceTier ?? 'default';
      }
      const notice = ['fast', 'priority'].includes(serviceTier) ? 'Fast is on. It uses plan limits faster.' : 'Fast is off. Standard speed is selected.';
      notify(warning || notice + (activeTurnApplied ? ' Applies from the next request in this turn.' : ''));
    } catch (error) { notify(errorText(error)); }
    finally { setBusy(false); }
  }
  async function chooseGoal(args?: string) {
    const thread = selected;
    if (!thread) return;
    const condition = args?.trim();
    setError("");
    try {
      const result = await api<{ goal?: { objective: string }; cleared?: boolean }>(`/threads/${encodeURIComponent(thread.id)}/goal`, condition ? condition === "clear" ? { clear: true } : { objective: condition } : undefined);
      window.dispatchEvent(new CustomEvent("elpis:goal-updated", { detail: { threadId: thread.id } }));
      if (selectedRef.current?.id !== thread.id) return;
      setSlashNotice(condition === "clear" ? "Goal cleared." : result.goal?.objective ? `Goal: ${result.goal.objective}` : "No goal set.");
      if (desktop) side.openContext();
    } catch (cause) {
      if (selectedRef.current?.id !== thread.id) return;
      if (condition && !textRef.current) editDraft(`/goal ${condition}`);
      setError(errorText(cause));
    }
  }
  return { chooseEffort, stepEffort, startReview, compactChat, exportChat, turnSmartPruneOn, chooseFast, chooseGoal };
}
