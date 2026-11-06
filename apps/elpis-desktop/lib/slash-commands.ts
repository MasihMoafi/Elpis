import type { ComposerPanel } from "@/lib/use-composer-panels";
import type { Dispatch, SetStateAction } from "react";
import type { SettingsDestination } from "@/components/settings-view";
import type { ReviewTarget } from "@/components/slash-panels";
import type { SlashCommand } from "@/components/slash-menu";
import type { Entry, Thread } from "@/lib/api";
import { configDestination } from "@/lib/config-sections";
import { errorText } from "@/lib/error-text.mjs";
import { INIT_PROMPT } from "@/lib/init-prompt";
import { lastReply } from "@/lib/slash";

type Setter<T> = Dispatch<SetStateAction<T>>;
type CommandInputs = {
  selected: Thread | null; askSideQuestion: (question?: string) => void; readOnlyRun: boolean; recapConversation: () => void;
  chooseGoal: (args?: string) => Promise<void>; busy: boolean; openComposerControl: (label: string) => void;
  chooseFast: (args?: string) => Promise<void>; turnEfforts: string[]; chooseEffort: (level?: string) => void;
  openSettings: (tab: SettingsDestination) => void; personal: { open: () => void }; writable: boolean; idle: boolean;
  startReview: (thread: Thread, target: ReviewTarget) => Promise<void>; setPanel: Setter<ComposerPanel>;
  renameThread: (thread: Thread, name: string) => Promise<void>; setError: Setter<string>; setRenameRequest: Setter<boolean>;
  newChat: () => void; clearChat: () => Promise<void>; archiveChats: (chats: Thread[]) => void;
  deleteChats: (ids: string[], focusAt?: number) => void; setResumeOpen: Setter<boolean>;
  lastTurn: string | undefined; activeTurn: string | undefined;
  forkFrom: (thread: Thread, lastTurnId: string, lastItemId?: string) => Promise<void>; continues: boolean;
  send: (own?: string) => Promise<void>; compactChat: (thread: Thread, guidance?: string) => void;
  setQueuedCompact: Setter<{ threadId: string; guidance?: string } | null>; setSlashNotice: Setter<string>;
  turnSmartPruneOn: () => Promise<void>; planMode: boolean; setPlan: (on: boolean) => void;
  team: Thread[]; panelShown: boolean; openAgentsPanel: () => void; entries: Entry[];
  exportChat: (thread: Thread) => Promise<void>; chatFolder: string | undefined;
};

export function createSlashCommands({ selected, askSideQuestion, readOnlyRun, recapConversation, chooseGoal, busy, openComposerControl, chooseFast, turnEfforts, chooseEffort, openSettings, personal, writable, idle, startReview, setPanel, renameThread, setError, setRenameRequest, newChat, clearChat, archiveChats, deleteChats, setResumeOpen, lastTurn, activeTurn, forkFrom, continues, send, compactChat, setQueuedCompact, setSlashNotice, turnSmartPruneOn, planMode, setPlan, team, panelShown, openAgentsPanel, entries, exportChat, chatFolder }: CommandInputs): SlashCommand[] {
  return [
    { name: "btw", description: "Ask a quick side question without adding to the session", available: !!selected, args: true, run: askSideQuestion },
    { name: "recap", description: "Summarize this conversation and its next step", available: !!selected && !readOnlyRun, run: recapConversation },
    { name: "goal", description: "show, set or clear this chat’s goal: /goal [condition|clear]", available: !!selected && !readOnlyRun, args: true, run: args => void chooseGoal(args) },
    { name: "model", description: "choose what model and reasoning effort to use", available: !busy, run: () => openComposerControl("Model") },
    { name: "fast", description: "toggle OpenAI Fast speed: /fast [on|off]", available: !busy && !readOnlyRun, args: true, run: args => void chooseFast(args) },
    { name: "effort", description: "change how hard the model thinks: /effort [low|medium|high|…]", available: !busy && turnEfforts.length > 0, args: true, run: chooseEffort },
    { name: "pruner-model", description: "view or set the model that prunes context; follows /memory-model when unset", run: () => openSettings("configuration") },
    { name: "memory-model", description: "set Smart Prune's fallback model; memory uses the responding agent", run: () => openSettings("configuration") },
    { name: "permissions", description: "choose what Elpis is allowed to do", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "yolo", description: "choose Full access or Bypass permissions", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "settings", description: "open Settings", run: () => openSettings("general") },
    { name: "memories", description: "configure memory use and generation", run: () => openSettings("personalization") },
    { name: "personal", description: "edit your priorities, working habits and preferences", run: personal.open },
    { name: "hooks", description: "view and manage lifecycle hooks", run: () => openSettings("hooks") },
    { name: "review", description: "review my current changes and find issues", available: writable && idle, args: true, run: text => { if (!selected) return; if (text) void startReview(selected, { type: "custom", instructions: text }); else setPanel("review"); } },
    { name: "rename", description: "rename the current thread", available: !!selected, args: true, run: text => { if (text && selected) renameThread(selected, text).catch(e => setError(errorText(e))); else setRenameRequest(true); } },
    { name: "new", description: "start a new chat during a conversation", run: newChat },
    { name: "clear", description: "start a fresh chat in the current project", run: () => void clearChat() },
    { name: "archive", description: "archive this session", available: !!selected, run: () => { if (selected) archiveChats([selected]); } },
    { name: "delete", description: "permanently delete this session", available: !!selected, run: () => { if (selected) deleteChats([selected.id]); } },
    { name: "resume", description: "resume a saved chat", run: () => setResumeOpen(true) },
    { name: "fork", description: "fork the current chat", available: !!selected && !!lastTurn && !activeTurn, run: () => { if (selected && lastTurn) void forkFrom(selected, lastTurn); } },
    { name: "init", description: "create an AGENTS.md file with instructions for Elpis", available: !continues && idle, run: () => void send(INIT_PROMPT) },
    { name: "compact", description: idle ? "compact now, or add words to guide the summary" : "compact when this turn finishes, or add words to guide the summary", available: writable, args: true, run: text => {
      if (!selected) return;
      if (idle) compactChat(selected, text); else { setQueuedCompact({ threadId: selected.id, ...(text === undefined ? {} : { guidance: text }) }); setSlashNotice("Compacts when Elpis finishes this turn."); }
    } },
    { name: "prune", description: "turn Smart Prune on for new chats", available: idle, run: () => void turnSmartPruneOn() },
    { name: "plan", description: planMode ? "turn Plan mode off" : "turn Plan mode on", available: !busy, run: () => setPlan(!planMode) },
    { name: "agent", description: "switch the active agent thread", available: team.length > 0 && !panelShown, run: () => { openAgentsPanel(); requestAnimationFrame(() => document.querySelector<HTMLElement>(".team-panel .team-row.active, .team-panel .team-row")?.focus()); } },
    { name: "copy", description: "copy the last response", available: !!lastReply(entries), run: () => { const reply = lastReply(entries); if (reply) navigator.clipboard.writeText(reply).then(() => setSlashNotice("Copied the last reply."), () => setError("Could not copy: the clipboard is unavailable.")); } },
    { name: "export", description: "export the conversation as markdown", available: !!selected && entries.length > 0 && idle, run: () => { if (selected) void exportChat(selected); } },
    { name: "diff", description: "show git diff (including untracked files)", available: !!selected, run: () => setPanel("diff") },
    { name: "status", description: "show current session configuration and token usage", run: () => setPanel("status") },
    { name: "pwd", description: "show the current working directory", available: !!chatFolder, run: () => setSlashNotice(`Current working directory: ${chatFolder}`) },
    { name: "usage", description: "inspect this session; /usage account opens usage and limits", args: true, run: text => { if (text) openSettings("usage"); else setPanel("status"); } },
    { name: "context", description: "show context usage as a grid, by category, with checkpoints and system files", available: !!selected, run: () => window.dispatchEvent(new CustomEvent("elpis:open-context")) },
    { name: "config", description: "open Settings or a section: /config [section]", args: true, run: text => openSettings(configDestination(text)) },
    { name: "theme", description: "choose the theme", run: () => openSettings("appearance") },
    { name: "mcp", description: "list and manage MCP servers", run: () => openSettings("mcp") },
    { name: "rag", description: "use the configured RAG MCP server or manage it with /rag <request>", available: !continues && idle, run: () => void send("/rag") },
  ];
}
