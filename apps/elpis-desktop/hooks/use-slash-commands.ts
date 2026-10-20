/** Owns the composer slash commands and their session actions. */
import type { Dispatch, SetStateAction } from "react";
import { permissionLabel, type PermissionMode } from "@/components/composer-controls";
import type { SlashCommand } from "@/components/slash-menu";
import type { ReviewTarget } from "@/components/slash-panels";
import type { Tab as SettingsTab } from "@/components/settings-view";
import { api, chatProvider, modelLabel, providerLabel, title, unreadable, type Entry, type Model, type ProviderChoice, type ProviderSettings, type Thread } from "@/lib/api";
import { INIT_PROMPT } from "@/lib/init-prompt";
import { conversationMarkdown, exportFileName, lastReply } from "@/lib/slash";
import { fastServiceTier } from "@/lib/service-tier.mjs";
import { reloadSettings, saveSettings } from "@/lib/settings-store";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = {
  turnEfforts: string[]; turnEffort: string; openComposerControl: (label: string) => void; turnModel: string;
  providerSettings: ProviderSettings | null; models: Model[]; setSlashNotice: Setter<string>;
  selected: Thread | null; setOverride: (id: string, patch: { effort: string }) => void;
  setEffort: Setter<string>; setPanel: Setter<"status" | "review" | "diff" | null>;
  setError: Setter<string>; completedTurns: Ref<Set<string>>;
  setActiveTurns: Setter<Record<string, string>>; focusComposer: () => void;
  entries: Entry[]; setBusy: Setter<boolean>; patchThread: (id: string, patch: Partial<Thread>) => void;
  newChoice: ProviderChoice | undefined; permissionMode: PermissionMode; chatFolder: string | null | undefined;
  readOnlyRun: boolean; busy: boolean; openSettings: (tab: SettingsTab) => void;
  openPersonal: () => void; writable: boolean; idle: boolean;
  renameThread: (thread: Thread, name: string) => Promise<void>; setRenameRequest: Setter<boolean>;
  newChat: () => void; archiveThread: (thread: Thread) => Promise<void>;
  setDeleteTargets: Setter<Thread[] | null>; focusSearch: () => void;
  lastTurn: string | undefined; activeTurn: string | undefined;
  forkFrom: (thread: Thread, turnId: string) => Promise<void>; continues: boolean;
  send: (own?: string) => Promise<void>; planMode: boolean; setPlan: (on: boolean) => void;
  team: Thread[]; panelShown: boolean; setAgentsPanel: Setter<boolean>;
  askSideQuestion: (question?: string) => void;
};

export function useSlashCommands({ turnEfforts, turnEffort, openComposerControl, turnModel, providerSettings, models,
  setSlashNotice, selected, setOverride, setEffort, setPanel, setError, completedTurns, setActiveTurns,
  focusComposer, entries, setBusy, patchThread, newChoice, permissionMode, chatFolder, readOnlyRun,
  busy, openSettings, openPersonal, writable, idle, renameThread, setRenameRequest, newChat,
  archiveThread, setDeleteTargets, focusSearch, lastTurn, activeTurn, forkFrom, continues, send,
  planMode, setPlan, team, panelShown, setAgentsPanel, askSideQuestion }: Props) {
  const chooseEffort = (level?: string) => {
    if (!level) { openComposerControl("Reasoning effort"); return; }
    const match = turnEfforts.find(item => item.toLowerCase() === level.toLowerCase());
    if (!match) { setSlashNotice(`${modelLabel(turnModel || providerSettings?.main.model, models)} does not offer the reasoning effort “${level}”. It offers: ${turnEfforts.join(", ")}.`); return; }
    if (selected) setOverride(selected.id, { effort: match }); else setEffort(match);
  };
  async function startReview(thread: Thread, target: ReviewTarget) {
    setPanel(null); setError("");
    try {
      const result = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/review`, { target });
      if (!result.turn?.id) throw new Error("Elpis did not acknowledge the review. Check the conversation before retrying.");
      if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: result.turn!.id }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    focusComposer();
  }
  function compactChat(thread: Thread, guidance?: string) {
    // The terminal reads a lone number as its pressure setting; this app has no such setting to save.
    if (guidance && /^\d+(\.\d+)?%?$/.test(guidance)) { setSlashNotice("A number sets the terminal's pressure compaction, which this app does not save. Compact now, or add words to guide the summary."); return; }
    api(`/threads/${encodeURIComponent(thread.id)}/compact`, guidance ? { instructions: guidance } : {}).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }
  async function exportChat(thread: Thread) {
    try {
      const all: Entry[] = []; let cursor: string | null = null;
      do { // Pages come newest first; each older page goes in front.
        const result: { data: Entry[]; nextCursor: string | null } = await api(`/threads/${encodeURIComponent(thread.id)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
        all.unshift(...[...result.data].reverse()); cursor = result.nextCursor;
      } while (cursor && all.length < 100000);
      const link = document.createElement("a"), file = exportFileName(title(thread));
      link.href = URL.createObjectURL(new Blob([conversationMarkdown(title(thread), all)], { type: "text/markdown" })); link.download = file;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      setSlashNotice(`Exported the conversation as ${file}.`);
    } catch (e) { setError(`Could not export: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function turnSmartPruneOn() {
    try {
      const current = await api<{ version?: string | null; smartPrune?: { enabled: boolean | null } }>("/settings");
      if (current.smartPrune?.enabled) { setSlashNotice("Smart Prune is already on."); return; }
      await saveSettings("/settings", { version: current.version, options: { automaticPruning: true } });
      setSlashNotice("Smart Prune is on. It applies to new chats.");
    } catch (e) { setError(`Could not turn Smart Prune on: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const sessionRows: [string, string][] = [
    ["Model", modelLabel(turnModel || providerSettings?.main.model, models)],
    ["Provider", providerLabel(turnModel || providerSettings?.main.model, selected ? selected.modelProvider : newChoice?.provider ?? providerSettings?.main.provider, providerSettings?.providers)],
    ["Reasoning effort", turnEffort || "Default"],
    ["Permissions", permissionLabel(permissionMode)],
    ["Folder", chatFolder || "Default folder"],
    ["Chat", selected?.id ?? "Not started yet"],
  ];
  async function chooseFast(args?: string) {
    const choice = args?.trim().toLowerCase();
    if (choice && choice !== 'on' && choice !== 'off') { setSlashNotice('Use /fast, /fast on or /fast off.'); return; }
    const provider = chatProvider(turnModel, selected ? selected.modelProvider : newChoice?.provider, providerSettings?.main.provider);
    if (provider !== 'openai') { setSlashNotice('/fast is available for OpenAI models.'); return; }
    setBusy(true); setSlashNotice('');
    try {
      let serviceTier: string;
      if (selected) {
        const applied = await api<{ serviceTier: string }>(`/threads/${encodeURIComponent(selected.id)}/service-tier`, choice ? { enabled: choice === 'on' } : {});
        serviceTier = applied.serviceTier;
        patchThread(selected.id, { serviceTier });
      } else {
        const current = await reloadSettings();
        const enabled = choice ? choice === 'on' : !['fast', 'priority'].includes(current.options?.serviceTier ?? '');
        const chosen = models.find(item => item.model === (turnModel || current.main.model));
        if (enabled && !fastServiceTier(chosen)) throw new Error('This model does not offer Fast on this account.');
        serviceTier = enabled ? 'fast' : 'default';
        await saveSettings('/settings', { version: current.version, options: { serviceTier } });
      }
      setSlashNotice(['fast', 'priority'].includes(serviceTier) ? 'Fast is on for subsequent turns. It uses plan limits faster.' : 'Fast is off. Standard speed is selected.');
    } catch (error) { setSlashNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const slashCommands: SlashCommand[] = [
    { name: "btw", description: "Ask a quick side question without adding to the session", available: !!selected, args: true, run: askSideQuestion },
    { name: "model", description: "choose what model and reasoning effort to use", available: !busy, run: () => openComposerControl("Model") },
    { name: "fast", description: "toggle OpenAI Fast speed: /fast [on|off]", available: !busy && !readOnlyRun, args: true, run: chooseFast },
    { name: "effort", description: "change how hard the model thinks: /effort [low|medium|high|…]", available: !busy && turnEfforts.length > 0, args: true, run: chooseEffort },
    { name: "pruner-model", description: "view or set the model that prunes context; follows /memory-model when unset", run: () => openSettings("configuration") },
    { name: "memory-model", description: "set Smart Prune's fallback model; memory uses the responding agent", run: () => openSettings("configuration") },
    { name: "permissions", description: "choose what Elpis is allowed to do", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "yolo", description: "choose Full access or Bypass permissions", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "settings", description: "open Settings", run: () => openSettings("general") },
    { name: "memories", description: "configure memory use and generation", run: () => openSettings("personalization") },
    { name: "personal", description: "edit your priorities, working habits and preferences", run: openPersonal },
    { name: "hooks", description: "view and manage lifecycle hooks", run: () => openSettings("hooks") },
    { name: "review", description: "review my current changes and find issues", available: writable && idle, args: true, run: text => { if (!selected) return; if (text) void startReview(selected, { type: "custom", instructions: text }); else setPanel("review"); } },
    { name: "rename", description: "rename the current thread", available: !!selected, args: true, run: text => { if (text && selected) renameThread(selected, text).catch(e => setError(e instanceof Error ? e.message : String(e))); else setRenameRequest(true); } },
    { name: "new", description: "start a new chat during a conversation", run: newChat },
    { name: "archive", description: "archive this session", available: !!selected, run: () => { if (selected) void archiveThread(selected); } },
    { name: "delete", description: "permanently delete this session", available: !!selected, run: () => { if (selected) setDeleteTargets([selected]); } },
    { name: "resume", description: "resume a saved chat", run: focusSearch },
    { name: "fork", description: "fork the current chat", available: !!selected && !!lastTurn && !activeTurn, run: () => { if (selected && lastTurn) void forkFrom(selected, lastTurn); } },
    { name: "init", description: "create an AGENTS.md file with instructions for Elpis", available: !continues && idle, run: () => void send(INIT_PROMPT) },
    { name: "compact", description: "compact now, or add words to guide the summary", available: writable && idle, args: true, run: text => { if (selected) compactChat(selected, text); } },
    { name: "prune", description: "turn Smart Prune on for new chats", available: idle, run: () => void turnSmartPruneOn() },
    { name: "plan", description: planMode ? "turn Plan mode off" : "turn Plan mode on", available: !busy, run: () => setPlan(!planMode) },
    { name: "agent", description: "switch the active agent thread", available: team.length > 0 && !panelShown, run: () => { setAgentsPanel(true); requestAnimationFrame(() => document.querySelector<HTMLElement>(".team-panel .team-row.active, .team-panel .team-row")?.focus()); } },
    { name: "copy", description: "copy the last response", available: !!lastReply(entries), run: () => { const reply = lastReply(entries); if (reply) navigator.clipboard.writeText(reply).then(() => setSlashNotice("Copied the last reply."), () => setError("Could not copy: the clipboard is unavailable.")); } },
    { name: "export", description: "export the conversation as markdown", available: !!selected && entries.length > 0 && idle, run: () => { if (selected) void exportChat(selected); } },
    { name: "diff", description: "show git diff (including untracked files)", available: !!selected, run: () => setPanel("diff") },
    { name: "status", description: "show current session configuration and token usage", run: () => setPanel("status") },
    { name: "pwd", description: "show the current working directory", available: !!chatFolder, run: () => setSlashNotice(`Current working directory: ${chatFolder}`) },
    { name: "usage", description: "inspect this session; /usage account opens usage and limits", args: true, run: text => { if (text) openSettings("usage"); else setPanel("status"); } },
    { name: "context", description: "show context usage as a grid, by category, with checkpoints and system files", available: !!selected, run: () => window.dispatchEvent(new CustomEvent("elpis:open-context")) },
    { name: "theme", description: "choose the theme", run: () => openSettings("appearance") },
    { name: "mcp", description: "list and manage MCP servers", run: () => openSettings("mcp") },
    { name: "rag", description: "use the configured RAG MCP server or manage it with /rag <request>", available: !continues && idle, run: () => void send("/rag") },
  ];
  return { sessionRows, slashCommands, startReview };
}
