"use client";

import dynamic from "next/dynamic";
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { ChatIcon, ExperimentLabIcon, FolderIcon, LoveSpotIcon, NewChatIcon, PlusIcon, SendIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Activity, Blocks, ChevronRight, PanelLeft, PanelRight, PanelRightClose, PanelRightOpen, RefreshCw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { ApprovalCard } from "@/components/approval-card";
import { PlanCard } from "@/components/plan-card";
import { SearchField } from "@/components/ui/search-field";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/chat-message";
import { FailedTurnCard } from "@/components/failed-turn-card";
import { ViewBoundary } from "@/components/view-boundary";
import { Transcript } from "@/components/transcript";
import { readPins } from "@/lib/pins";
import { addGroup, groupSections, moveChats, sortChats } from "@/lib/chat-groups";
import { SHORTCUTS } from "@/lib/shortcuts";
import { CommandMenu, type CommandAction } from "@/components/command-menu";
import { ImproveElpis } from "@/components/improve-elpis";
import { arrange, move } from "@/lib/nav-order";
import { followUpChoices, followUpHint, followUpKey, followUpTooltip, isSendKey, newChatFolder, savePreferences, useAppPreferences } from "@/lib/preferences";
import { QueuedFollowUps } from "@/components/queued-follow-ups";
import { stopsOnEscape, usePromptKeys } from "@/lib/prompt-history";
import { PromptStatusLine } from "@/components/prompt-status";
import { ContextUsage } from "@/components/context-usage";
import { ElpisFeatures } from "@/components/elpis-features";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StartupSplash } from "@/components/startup-splash";
import { AppUpdate } from "@/components/app-update";
import { PermissionsMenu, PlanPill, PlusMenu, SendOptionsMenu, permissionLabel, type PermissionMode } from "@/components/composer-controls";
import { CopyButton } from "@/components/markdown-text";
import { entryKey, rememberSubmittedMessages, withSubmittedMessages, type SubmittedMessage } from "@/lib/submitted-messages";
import { replacementEligibility } from "@/lib/turn-replacement";
import { AgentsGuide } from "@/components/agents-guide";
import { CanvasGuideHelp } from "@/components/canvas-guide-help";
import { ExperimentLab } from "@/components/experiment-lab";
import { CustomizeView } from "@/components/customize-view";
import { SettingsView, type SettingsDestination } from "@/components/settings-view";
import { DeleteChatsDialog, ThreadActions } from "@/components/thread-actions";
import { GroupAndSortMenu, GroupNameDialog } from "@/components/chat-groups";
import { SidebarGroup } from "@/components/sidebar-group";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { SlashMenu, useSlashMenu } from "@/components/slash-menu";
import { MentionMenu, useMentionMenu } from "@/components/mention-menu";
import { NavButtons } from "@/components/nav-buttons";
import { PromptRail } from "@/components/prompt-rail";
import { RewindDialog } from "@/components/rewind-dialog";
import { canBack, canForward, startHistory, visit, type History } from "@/lib/nav-history";
import { DiffPanel, ReviewPanel, SessionPanel } from "@/components/slash-panels";
import { SelectionReply } from "@/components/message-reply";
import { reloadSettings } from "@/lib/settings-store";
import { UsagePanel } from "@/components/provider-usage";
import { Dictation } from "@/components/dictation";
import { EnvironmentMenu, ProjectActions, ProjectDialog, ProjectMenu } from "@/components/project-picker";
import { BranchChip } from "@/components/branch-chip";
import { projectFolderOf } from "@/lib/chat-worktree";
import { AccountMenu } from "@/components/account-menu";
import { ModelPicker } from "@/components/model-picker";
import { appStorage } from "@/lib/projects";
import { ResizeEdge } from "@/components/resize-edge";
import { TaskList } from "@/components/task-list";
import { chatOrigin } from "@/lib/love-activity";
import { useLoveActivity } from "@/lib/use-love-activity";
import { AgentsCanvas } from "@/components/agents-canvas";
import { AgentsPanel } from "@/components/agents-panel";
import { agentState, mergeListedThreads } from "@/lib/agents";
import { useChatGroups } from "@/hooks/use-chat-groups";
import { useChatAttention } from "@/hooks/use-chat-attention";
import { approvalDraftKey, useApprovals } from "@/hooks/use-approvals";
import { insertTranscript } from "@/lib/dictation";
import { openFile, setFileView } from "@/lib/files-pane";
import { PersonalTip, usePersonal } from "@/components/personal-tip";
import { SidePanel } from "@/components/side-panel";
import { SideChat } from "@/components/side-chat";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { useSessionSplit } from "@/components/session-split";
import { Tab, TabStrip } from "@/components/tab-strip";
import { followChat, renameTabs, writeTabs, type ChatTab } from "@/lib/chat-tabs";
import { AttachmentChips } from "@/components/attachment-chips";
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS, TEXT_ONLY_NOTICE, transferFiles } from "@/lib/attachments";
import { without } from "@/lib/without";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useDraftRecovery } from "@/hooks/use-draft-recovery";
import { useChatSearch } from "@/hooks/use-chat-search";
import { useThreads } from "@/hooks/use-threads";
import { useChatTurns, useTurnActivity } from "@/hooks/use-chat-turns";
import { useSidebarRows, useSidebarState } from "@/hooks/use-sidebar-rows";
import { useLiveConnection, type Live } from "@/hooks/use-live-connection";
import { useChatNavigation, useChatTabs, type View } from "@/hooks/use-chat-navigation";
import { useProjectActions, useProjectState } from "@/hooks/use-project-actions";
import { usePermissionState, usePermissions } from "@/hooks/use-permissions";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import { useComposerAttachments } from "@/hooks/use-composer-attachments";
import { useAgentChildren, useExpandedAgents, useRelatedAgents } from "@/hooks/use-agent-relations";
import { useDisconnectedChat } from "@/hooks/use-disconnected-chat";
import { useWorkspacePanels } from "@/hooks/use-workspace-panels";
import { useComposerInput } from "@/hooks/use-composer-input";
import { useWorkspaceRestore } from "@/hooks/use-workspace-restore";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { useThreadActions } from "@/hooks/use-thread-actions";
import { useComposerActions } from "@/hooks/use-composer-actions";
import type { ThemeChoice } from "@/components/appearance-settings";
import { api, chatProvider, choiceById, choiceOf, effortsOf, isAgentRun, AGENT_RUN_NOTICE, isUnlinkedAgent, providerChoices, title, agentName, mediaUrl, type Entry, type Thread } from "@/lib/api";

const LoveSpot = dynamic(() => import("@/components/love-spot"), { ssr: false, loading: () => <p role="status">Opening Love Spot…</p> });
function ObservabilityView() { return <div className="page-scroll" data-view="observability" />; }
/** The sidebar's width in pixels: the default, and how far its edge can be dragged. */
const SIDEBAR = { initial: 256, min: 200, max: 480 };
// Sidebar sections by last activity, as in ChatGPT and Claude; the list keeps Elpis's own order inside each.
/** Whether a chat ran in a project's folder (trailing slashes ignored). */
const sameFolder = (a: string | undefined, b: string) => !!a && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The sidebar's pages after New chat, in their default order; the person may rearrange them. */
const NAV_PAGES = [
  { id: "experimentLab", name: "Lab", Icon: ExperimentLabIcon },
  { id: "canvas", name: "Workflows", Icon: WorkflowsIcon },
  { id: "loveSpot", name: "Love Spot", Icon: LoveSpotIcon },
  { id: "customize", name: "Ledger", Icon: Blocks },
  { id: "observability", name: "Observability", Icon: Activity },
] as const;

export default function Home() {
  const preferences = useAppPreferences();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedRef = useRef<Thread | null>(null);
  const { tabs, tabsRef, tabsRestored, setTabsRestored, restoredTabs, updateTabs } = useChatTabs();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [submissions, setSubmissions] = useState<SubmittedMessage[]>([]);
  const { models, catalogError, catalogLoading, catalogRequest, refreshModels, providerSettings } = useModelCatalog();
  // New conversations: where to run and with what.
  const [choiceId, setChoiceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const { cwd, setCwd, projects, setProjects, projectId, setProjectId, projectChanging,
    setProjectChanging, project, projectEdit, setProjectEdit } = useProjectState();
  // Existing conversations: overrides for their next turn only.
  const { nextTurn, setNextTurn, threadModes, setThreadModes, changingPermissions,
    setChangingPermissions, threadPlans, setThreadPlans, newPlan, setNewPlan } = usePermissionState();
  const [error, setError] = useState("");
  const [pins, setPins] = useState<string[]>([]);
  const { chatGroups, newGroupFor, setNewGroupFor, updateGroups } = useChatGroups(setError);
  const { attention, setAttention, planAnswered, setPlanAnswered, planTurns, markRead } = useChatAttention(setError);
  const { deleteTargets, setDeleteTargets, deleteRunHistory, setDeleteRunHistory,
    deletedNotice, setDeletedNotice, shownWhenDeleted, marked, setMarked, markAnchor,
    threadList, collapsedProjects, setCollapsedProjects } = useSidebarState();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  /** The message whose "Rewind to here" is awaiting confirmation (its turn). */
  const [rewindTurn, setRewindTurn] = useState<string | null>(null);
  const [rewindActions, setRewindActions] = useState<Record<string, "undo" | "redo" | undefined>>({});
  const [rewindBusy, setRewindBusy] = useState(false);
  const rewindSwitch = useRef<string | null>(null);
  /** The chats and pages visited, for Back and Forward (lib/nav-history.ts). */
  const [history, setHistory] = useState<History>(() => startHistory({ view: "chat", threadId: null }));
  const historyRef = useRef(history), historySeeded = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renameRequest, setRenameRequest] = useState(false);
  /** What a slash command has open above the composer, and the one-line answer of a command that only reports. */
  const [panel, setPanel] = useState<"status" | "review" | "diff" | null>(null);
  const [slashNotice, setSlashNotice] = useState("");
  // A new chat in its own worktree (the Local/Worktree menu), and where an archived or deleted chat's worktree was kept.
  const [newWorktree, setNewWorktree] = useState(false), [worktreeNotice, setWorktreeNotice] = useState("");
  const noteKept = (text: string) => { if (text) setWorktreeNotice(previous => previous ? `${previous} ${text}` : text); };
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  useEffect(() => { setPins(readPins()); }, []);
  const [newMode, setNewMode] = useState<PermissionMode | null>(null);
  const { text, shellMode, setShellMode, shellCreated, sideChat, setSideChat, sideRequests,
    textRef, composerRef, caret, setCaret, pickedMentions, filePickerRef, attachments,
    attachmentsRef, setAttachments, dictating, setDictating, setText } = useComposerInput();
  const [agentRunsOpen, setAgentRunsOpen] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const { approvals, setApprovals, approvalDrafts, pendingDrafts, submitDraft, clearApprovalDraft, draftAnswer } = useApprovals();
  const [fileNotice, setFileNotice] = useState("");
  // Hidden chats stay absent while a list request races with deletion or archiving.
  const hidden = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  const { search, setSearch, searchTerm, searchResults, loadMoreSearch } = useChatSearch(ready, hidden);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const { drafts, attachmentDrafts, newDraftKey, savedDraft, saveDraft, editDraft, savedAttachments,
    saveAttachments, restoreAttachments } = useDraftRecovery(selectedRef, setText,
    setAttachments, setFileNotice, setError);
  const { attaching, addFiles, attachFromBrowser } = useComposerAttachments({ shellMode, setFileNotice,
    selectedRef, newDraftKey, savedAttachments, saveAttachments, setAttachments,
    setRuntimeNotices: updater => setRuntimeNotices(updater), showChat: () => showChat(),
    send: () => send(), composerRef });
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState(0);
  const { activeTurns, setActiveTurns, plans, setPlans, completedTurns, activity, setActivity,
    liveError, setLiveError, runtimeNotices, setRuntimeNotices, failedTurns, setFailedTurns,
    stoppedTurns, setStoppedTurns } = useTurnActivity();
  const [related, setRelated] = useState<Record<string, Thread>>({});
  const [accountRefresh, setAccountRefresh] = useState(0);
  const [view, setView] = useState<View>("chat");
  const loveActivity = useLoveActivity(view === "loveSpot", ready);
  const [originOpen, setOriginOpen] = useState({ love: true, workflows: true });
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => { if (view === "chat" && selected) markRead(selected.id); }, [view, selected?.id, markRead]);
  const { settingsSection, setSettingsSection, desktop, windowAvailable, sessionWindowApi,
    browser, side, hasTerminal, tuiLaunch, setTuiLaunch, panelShown, fullView, showChat,
    pendingInputOpen, setPendingInputOpen, pendingInputButton, sidebar, setSidebar, panelDrawer,
    agentsPanel, setAgentsPanel } = useWorkspacePanels({ selected, activeTabId: tabs.activeId, view, setView });
  const [loveToolbarHost, setLoveToolbarHost] = useState<HTMLDivElement | null>(null);
  // Theme: System follows the operating system; the choice is kept on this device.
  const [theme, setThemeChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  // The website's animated wordmark, its dark or light version (website/assets/branding).
  const brandMark = dark ? "/branding/elpis-wordmark-amber-loop.svg" : "/branding/elpis-wordmark-amber-light-loop.svg";
  // The sidebar's width, set by dragging its edge (components/resize-edge.tsx) and kept on this device.
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR.initial);
  useEffect(() => { const saved = Number(appStorage().getItem("elpis-sidebar-width")); if (saved >= SIDEBAR.min && saved <= SIDEBAR.max) setSidebarWidth(saved); }, []);
  const resizeSidebar = (width: number) => { setSidebarWidth(width); try { appStorage().setItem("elpis-sidebar-width", String(width)); } catch { /* the width still applies to this window */ } };
  const setTheme = (next: ThemeChoice) => { setThemeChoice(next); try { appStorage().setItem("elpis-theme", next); } catch { setError("Could not save appearance on this device."); } };
  const searchInput = useRef<HTMLInputElement>(null);
  const shortcutsReturnFocus = useRef<HTMLElement | null>(null);
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  /** Each chat's last read transcript: reopening a chat draws it at once while it rereads, as in the ChatGPT app. */
  const transcripts = useRef(new Map<string, { entries: Entry[]; cursor: string | null }>());
  useEffect(() => { if (selected && !loading) transcripts.current.set(selected.id, { entries, cursor: itemCursor }); }, [selected, loading, entries, itemCursor]);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const request = useRef(0);
  const liveRevision = useRef(0), liveVersions = useRef(new Map<string, number>());
  const liveKeysAfter = useCallback((revision: number) => new Set([...liveVersions.current].filter(([, version]) => version > revision).map(([key]) => key)), []);

  const { select, settingsOf, remember, threadsRef, patchThread, upsertThread, removeThreads,
    refreshThreads, loadMoreConversations, loadThread, nextCursor, moreLoading } = useThreads({ threads,
    setThreads, setSelected, selectedRef, browser, hidden, transcripts, drafts, attachmentDrafts, tabsRef,
    updateTabs, setMarked, setApprovals, request, setMessageEdits, setText, savedDraft, newDraftKey, restoreAttachments,
    setEntries, setItemCursor, setError, markRead, saveDraft, textRef, stickToBottom, restoreScroll,
    liveVersions, liveRevision, liveKeysAfter, setView, setSidebar, setLoading, rememberModes,
    completedTurns, setActiveTurns, setLiveError });
  useEffect(() => { setText(savedDraft(newDraftKey.current)); }, [savedDraft]);

  useWorkspaceRestore({ dark, theme, newDraftKey, setText, savedDraft, restoreAttachments,
    setProjects, setProjectId, setCwd, updateTabs, restoredTabs, setTabsRestored,
    setThemeChoice, setSystemDark, setError });
  useGlobalShortcuts(shortcutAction);
  useLiveConnection({ refreshThreads, patchThread, upsertThread, removeThreads, select, remember, rememberModes,
    loadThread, liveKeysAfter, clearApprovalDraft, refreshModels, selectedRef, request, liveRevision, liveVersions,
    completedTurns, planTurns, viewRef, threadsRef, settingsOf, rewindSwitch, restoredTabs, tabsRef, catalogRequest,
    setConnected, setApprovals, setAccountRefresh, setEntries, setItemCursor, setActiveTurns, setLiveError, setReady,
    setError, setAttention, setPlans, setRewindActions, setRuntimeNotices, setFailedTurns, setStoppedTurns,
    setThreadModes, setActivity });
  const { loadingChildren, childCursors, expanded, loadChildren } = useAgentChildren({
    selected, setThreads, hidden, setError,
  });
  const selectedLiveError = useDisconnectedChat({ selected, liveError, view, loading, liveRevision,
    selectedRef, select, setEntries, liveKeysAfter, setError });
  useExpandedAgents(expanded, loadChildren, setError);
  useRelatedAgents({ selected, threads, showAgentRuns: preferences.showAgentRuns, agentRunsOpen, related, setRelated });
  const shownScope = selected?.id ?? newDraftKey.current;
  const shownEntries = useMemo(() => withSubmittedMessages(entries, submissions, shownScope), [entries, submissions, shownScope]);
  useEffect(() => { setSubmissions(previous => rememberSubmittedMessages(entries, previous, selected?.id ?? newDraftKey.current)); }, [entries, selected?.id, submissions]);
  useEffect(() => { const element = scroll.current; if (!element) return; if (restoreScroll.current) { const previous = restoreScroll.current; restoreScroll.current = null; element.scrollTop = previous.top + element.scrollHeight - previous.height; } else if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); }, [entries, submissions, selected?.id]);

  // A chat that was at its end stays there when its box changes size (full view turns the column into a card).
  useEffect(() => {
    const element = scroll.current, content = element?.firstElementChild; if (!element || !content) return;
    const observer = new ResizeObserver(() => { if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); });
    observer.observe(element); observer.observe(content); return () => observer.disconnect();
  }, [view]);

  const activeTurn = selected ? activeTurns[selected.id] : undefined;
  useEffect(() => {
    const id = selected?.id; if (!id || activeTurn) return;
    let disposed = false;
    api<{ action?: "undo" | "redo" } | null>(`/threads/${encodeURIComponent(id)}/rewind`, { action: "status" }).then(result => {
      if (!disposed) setRewindActions(prev => ({ ...prev, [id]: result?.action }));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [selected?.id, activeTurn]);
  // A new chat runs with the configured defaults until a mode is chosen, so the button shows those.
  const configuredMode: PermissionMode = providerSettings?.options?.approvalPolicy !== "never" ? "ask"
    : providerSettings.options.sandboxMode === "bypass-permissions" ? "bypass" : providerSettings.options.sandboxMode === "danger-full-access" ? "full" : "ask";
  const permissionMode: PermissionMode = selected ? threadModes[selected.id] ?? "ask" : newMode ?? configuredMode;
  const planMode = selected ? nextTurn[selected.id]?.plan ?? threadPlans[selected.id] ?? false : newPlan;
  // The last finished turn's proposed plan, while the chat is still in Plan mode and it is unanswered.
  const lastTurnId = entries.at(-1)?.turnId;
  const proposedPlan = selected && planMode && lastTurnId && lastTurnId !== activeTurn && planAnswered[selected.id] !== lastTurnId && entries.some(entry => entry.turnId === lastTurnId && entry.item.type === "plan") ? lastTurnId : null;
  const outsideChatApprovals = approvals.filter(approval => view !== "chat" || approval.params.threadId !== selected?.id);
  const readOnlyRun = !!selected && (isAgentRun(selected) || selected.desktopAccess?.writable === false);
  const continues = readOnlyRun || selected?.desktopAccess?.mode === "continue";
  const choices = providerChoices(models, providerSettings);
  const newChoice = choiceById(choices, choiceId);
  const missingChoiceNotice = !selected && choiceId && !newChoice ? "This connection is no longer available. Choose another model." : "";
  const needsModelId = !selected && !!newChoice?.provider && newChoice.provider !== providerSettings?.main.provider;
  const selectedChoice = selected ? choiceOf(selected, choices) : null;
  const pending = selected ? nextTurn[selected.id] : undefined;
  const turnModel = selected ? pending?.model ?? selected.model ?? "" : model;
  const dictationProvider = chatProvider(turnModel, selected ? selected.modelProvider : newChoice?.provider, providerSettings?.main.provider);
  const turnEfforts = effortsOf(turnModel || providerSettings?.main.model, models);
  const turnEffort = selected ? pending?.effort ?? selected.reasoningEffort ?? "" : effort;
  const knownModel = (selected ? selectedChoice?.models : newChoice?.models)?.find(item => item.model === (turnModel || providerSettings?.main.model));
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const composerNotice = [fileNotice, imageBlocked ? TEXT_ONLY_NOTICE : "", !shellMode ? missingChoiceNotice : ""].filter(Boolean).join("\n");
  const sendBlocked = readOnlyRun || (!text.trim() && !attachments.length) || busy || dictating || attaching || imageBlocked || !ready || !connected || (!shellMode && (!!missingChoiceNotice || needsModelId && !model.trim()));
  const recoveryAttachments = selected ? attachmentDrafts.current[`recovery-${selected.id}`] ?? [] : [];

  const find = (id?: string | null) => id ? threads.find(thread => thread.id === id) ?? related[id] : undefined;
  const selectedTitle = selected ? title(selected) : "";
  useEffect(() => { if (ready) updateTabs(followChat(tabsRef.current, selected ? { id: selected.id, title: selectedTitle } : null)); }, [ready, selected?.id, selectedTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTabs(renameTabs(tabsRef.current, id => { const thread = find(id); return thread ? title(thread) : undefined; })); }, [threads, related]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const store = window.elpisDesktop?.storage; if (tabsRestored && store && !writeTabs(tabs, store)) setError("Could not save the open chat tabs on this device."); }, [tabs, tabsRestored]);
  // Back and forward: each place reached (a chat, a new chat, a page) joins the stack; the first one only starts it.
  useEffect(() => {
    if (!ready) return;
    const place = { view, threadId: view === "chat" ? selected?.id ?? null : null };
    const next = historySeeded.current ? visit(historyRef.current, place) : startHistory(place);
    historySeeded.current = true;
    if (next !== historyRef.current) { historyRef.current = next; setHistory(next); }
  }, [ready, view, selected?.id]);
  // Elpis can replace turns only in chats it lets this app write directly, and not while one is running.
  const replaceable = !!selected && !continues && !activeTurn && selected.status?.type !== "active" && connected && !busy;
  const turnEntries = new Map<string, Entry[]>();
  for (const entry of entries) { const group = turnEntries.get(entry.turnId) ?? []; group.push(entry); turnEntries.set(entry.turnId, group); }
  // A descending item page can cut only its oldest turn. Later turns have a visible
  // earlier-turn boundary; replacing them does not need the rest of the older history.
  const replacementOptions = new Map([...turnEntries].map(([id, group]) => [id, replacementEligibility(group, id, { historyComplete: !loading && (itemCursor === null || id !== entries[0]?.turnId) })]));
  const replacementOptionsKey = JSON.stringify([...replacementOptions]);
  const failedTurn = selected ? failedTurns[selected.id] : undefined;
  const failedInput = failedTurn ? replacementOptions.get(failedTurn.turnId) : undefined;
  const recoveredEdit = selected ? savedDraft(`recovery-${selected.id}`) : "";
  // The message box's history keys (lib/prompt-history.ts): ↑/↓ and Ctrl+R through what you sent, Esc Esc to edit the last.
  const { focusComposer, beginReply, askSideQuestion, restoreComposerFocus, editQueued,
    writePrompt, editLastMessage, pickFiles, startMention, startSlash, focusSearch,
    openComposerControl, closePanel } = useComposerActions({ composerRef, selectedRef, readOnlyRun,
    attachmentsRef, setFileNotice, setShellMode, setAttachments, saveAttachments, selected, setError,
    setSideChat, sideRequests, editDraft, textRef, pickedMentions, newDraftKey, replaceable,
    entries, replacementOptions, setSlashNotice, setMessageEdits, filePickerRef, setCaret,
    view, show: next => show(next), setSidebar, setSidebarCollapsed, searchInput, setPanel });
  const promptKeys = usePromptKeys(selected?.id ?? newDraftKey.current, { entries, box: () => composerRef.current, read: () => textRef.current, write: writePrompt, editLast: editLastMessage });
  const regenerate = (() => {
    if (!replaceable) return null;
    const last = entries.at(-1); if (!last) return null;
    const turn = entries.filter(entry => entry.turnId === last.turnId);
    const eligibility = replacementOptions.get(last.turnId);
    const prompt = eligibility?.allowed ? eligibility.prompt : null;
    const reply = turn.filter(entry => entry.item.type === "agentMessage").at(-1);
    return prompt && reply ? { turnId: last.turnId, prompt, replyId: reply.item.id } : null;
  })();
  const parent = find(selected?.parentThreadId), source = find(selected?.forkedFromId);
  const waitingIds = new Set(approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId));
  // The chat's team: a root shows its agents; an agent shows its siblings and the way back to the root.
  const teamRoot = selected ? (selected.parentThreadId ? find(selected.parentThreadId) ?? { id: selected.parentThreadId } as Thread : selected) : null;
  const team = teamRoot ? threads.filter(thread => thread.parentThreadId === teamRoot.id) : [];
  const folder = (path?: string | null) => path ? path.split("/").filter(Boolean).at(-1) || path : "";

  const { openNewChat, newChat, showTab, newChatTab, closeChatTab, cycleTabs, goHistory, openInNewTab } = useChatNavigation({
    projectId, tabsRef, updateTabs, selectedRef, newDraftKey, textRef, saveDraft, savedDraft, request,
    stickToBottom, restoreScroll, select, setEntries, setItemCursor, setText, setError,
    restoreAttachments, setLoading, setView, setSidebar, composerRef, loadThread, find, showChat,
    closeSession: browser.closeSession, historyRef, setHistory, hidden, show: next => show(next),
  });
  const split = useSessionSplit({ thread: selected, text, attachments }, () => composerRef.current?.focus(), remaining => {
    const restore = () => { editDraft(remaining.text); setAttachments(remaining.attachments); saveAttachments(remaining.thread?.id || newDraftKey.current, remaining.attachments); };
    if (remaining.thread) void loadThread(remaining.thread).then(restore); else { newChat(); restore(); }
  });
  const openSplit = (thread: Thread) => { side.closePanel(); setAgentsPanel(false); setView("chat"); split.open(thread); };
  const openSessionWindow = (thread?: Thread) => { void sessionWindowApi()?.(thread?.id).catch(cause => setError(String(cause))); };

  const { selectProject, saveProject, addProject, moveChat, moveChatToFolder, removeProject } = useProjectActions({
    projects, setProjects, projectId, setProjectId, setProjectChanging, setCwd, setProjectEdit,
    openNewChat, selected, patchThread, setError,
  });
  const show = (next: View) => { if (next !== "chat") side.toggleFull(false); if (next === "settings") { setSettingsVisited(true); setSettingsNavigation(value => value + 1); } setView(next); setSidebar(false); };
  const manageConnections = () => { setSettingsSection("providers"); show("settings"); };
  const { forkFrom, continueHere, deleteThread, renameThread, archiveThread, unarchived, answer } = useThreadActions({
    request, selectedRef, upsertThread, loadThread, restoreComposerFocus: origin => restoreComposerFocus(origin),
    setError, setBusy, removeThreads, noteKept, patchThread, hidden, refreshThreads, submitDraft,
    setApprovals, clearApprovalDraft,
  });
  /** What a reopened chat reports about its approval mode and Plan mode. */
  function rememberModes(id: string, live: Live) {
    if (live.permissions) setThreadModes(prev => ({ ...prev, [id]: live.permissions! }));
    if (typeof live.planMode === "boolean") setThreadPlans(prev => ({ ...prev, [id]: live.planMode! }));
  }
  const { setPlan, answerPlan, permissionsLocked, choosePermissions, cycleMode, setOverride } = usePermissions({
    selected, selectedRef, setNewPlan, setPlanAnswered, setError, request, setThreadModes,
    setThreadPlans, setNextTurn, completedTurns, setActiveTurns, ready, busy, projectChanging,
    changingPermissions, setChangingPermissions, setNewMode, planMode, permissionMode, threadPlans,
    focusComposer: () => focusComposer(), restoreComposerFocus: origin => restoreComposerFocus(origin),
  });
  const openById = (id: string) => loadThread(threads.find(thread => thread.id === id) || related[id] || { id });
  /** "Open in Elpis TUI": the chat opens here and its terminal resumes it in the TUI (`elpis resume <id>`). */
  const openInTui = (thread: Thread) => {
    if (selectedRef.current?.id !== thread.id || view !== "chat") void loadThread(thread);
    setTuiLaunch({ key: side.openTerminal(thread.cwd || cwd, thread.id), threadId: thread.id, token: Date.now() });
  };
  // The TUI's /app (`elpis-app --open-thread <id>`): the running window opens that chat.
  const openFromTui = useRef(openById); openFromTui.current = openById;
  useEffect(() => window.elpisDesktop?.onOpenThread?.(id => void openFromTui.current(id)), []);
  // Quick Entry's text opens a new chat and is sent, as in Claude; the tray's New chat opens one empty (desktop/main.cjs).
  // The text waits until the new chat is on screen and Elpis can send.
  const [desktopPrompt, setDesktopPrompt] = useState<string | null>(null);
  const openFromDesktop = useRef(newChat); openFromDesktop.current = newChat;
  useEffect(() => window.elpisDesktop?.onNewChat?.(prompt => { openFromDesktop.current(); setDesktopPrompt(prompt.trim() ? prompt : null); }), []);
  useEffect(() => {
    if (desktopPrompt === null || selected || view !== "chat" || !connected || busy || dictating || attaching || projectChanging) return;
    setDesktopPrompt(null); void send(desktopPrompt);
  }, [desktopPrompt, selected, view, connected, busy, dictating, attaching, projectChanging]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The terminal's slash commands this app performs (codex-rs/tui/src/slash_command.rs), in its popup order and mostly in its words.
   * Commands that run the model or rewrite the chat wait for an idle chat; controls and views are always there. */
  const openSettings = (tab: SettingsDestination) => { setSettingsSection(tab); show("settings"); };
  const { send, sendShell, stop, replaceFrom, rewindFrom, switchRewind, older } = useChatTurns({ selected,
    selectedRef, request, tabsRef, newDraftKey, textRef, attachmentsRef, pickedMentions, shellCreated,
    stickToBottom, completedTurns, settingsOf, transcripts, hidden, rewindSwitch, scroll, restoreScroll,
    browser, preferences, newChoice, replacementOptions, readOnlyRun, shellMode, busy, dictating, attaching,
    projectChanging, connected, imageBlocked, missingChoiceNotice, needsModelId, model, cwd, newWorktree,
    newMode, activeTurn, activeTurns, continues, effort, newPlan, pending, nextTurn, entries, itemCursor,
    setError, setBusy, setText, setAttachments, setFileNotice, setSubmissions, setThreads, setThreadModes,
    setRuntimeNotices, setActiveTurns, setThreadPlans, setNewPlan, setNextTurn, setMessageEdits, setEntries,
    setRewindBusy, setRewindActions, setLoading, setItemCursor, editDraft, saveDraft, savedDraft,
    saveAttachments, savedAttachments, select, upsertThread, loadThread, patchThread,
    submitDraft, askSideQuestion, restoreComposerFocus, focusComposer });

  // The transcript is redrawn only when what it shows changes, not on every keystroke in the message box; its
  // handlers call the current render's functions through a ref, so a reused row never calls a stale one.
  const live = useRef({ openById, focusComposer, replaceFrom, forkFrom, setRewindTurn, setMessageEdits, setError, beginReply });
  live.current = { openById, focusComposer, replaceFrom, forkFrom, setRewindTurn, setMessageEdits, setError, beginReply };
  const conversation = useMemo(() => <ViewBoundary label="The conversation" resetKey={selected?.id}>{selected && !readOnlyRun && <SelectionReply key={selected.id} onQuote={(reference, text) => { const entry = shownEntries.find(entry => entryKey(entry) === reference); if (entry) live.current.beginReply(entry, text); }} />}<Transcript entries={shownEntries} activeTurnId={activeTurn ?? null} onViewChanges={desktop && selected ? side.openChanges : undefined} mediaOf={e => selected ? mediaUrl(selected.id, e) : undefined} renderItem={e => { const editKey = JSON.stringify([selected?.id, e.turnId, e.item.id]); return <ChatMessage key={e.clientKey ?? editKey} item={e.item} reference={entryKey(e)} onReply={selected && !readOnlyRun && !e.clientPending && (e.item.type === "userMessage" || e.item.type === "agentMessage") ? () => live.current.beginReply(e) : undefined} mediaBase={selected ? mediaUrl(selected.id, e) : undefined} threads={threads} speaker={agentName(selected) || "Elpis"} onOpenThread={id => live.current.openById(id)}
            editDraft={messageEdits[editKey]} editPending={!!pendingDrafts[editKey]} onEditDraftChange={value => { live.current.setMessageEdits(previous => value === null ? without(previous, editKey) : { ...previous, [editKey]: value }); if (value === null) live.current.focusComposer(); }}
            onEdit={!e.clientPending && replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed ? text => live.current.replaceFrom(e.turnId, text, editKey) : undefined}
            editBlockedReason={replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed === false ? (replacementOptions.get(e.turnId) as { allowed: false; reason: string }).reason : undefined}
            time={e.item.type === "userMessage" ? e.startedAtMs : undefined}
            onFork={selected && !readOnlyRun && e.item.type === "agentMessage" && e.turnId !== activeTurn ? () => void live.current.forkFrom(selected, e.turnId, e.item.id) : undefined} onRewind={!e.clientPending && replaceable ? () => live.current.setRewindTurn(e.turnId) : undefined}
            onRegenerate={regenerate && e.item.id === regenerate.replyId ? () => { live.current.replaceFrom(regenerate.turnId, regenerate.prompt).catch(error => live.current.setError(String(error instanceof Error ? error.message : error))); } : undefined} />; }} /></ViewBoundary>, [shownEntries, activeTurn, desktop, selected, side.openChanges, threads, messageEdits, pendingDrafts, replaceable, replacementOptionsKey, readOnlyRun, regenerate?.turnId, regenerate?.replyId, regenerate?.prompt]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastTurn = entries.at(-1)?.turnId;
  const idle = !busy && !activeTurn && selected?.status?.type !== "active";
  const writable = !!selected && !continues;
  const chatFolder = selected ? selected.cwd : newChatFolder(cwd);
  // The profile opens as source: /personal is for editing it.
  const personal = usePersonal(ready && !selected, path => { const at = selected?.cwd || cwd; openFile(at, path); setFileView(at, path, "source"); side.openFiles(); }, setError);
  const { sessionRows, slashCommands, startReview } = useSlashCommands({
    turnEfforts, turnEffort, openComposerControl, turnModel, providerSettings, models, setSlashNotice,
    selected, setOverride, setEffort, setPanel, setError, completedTurns, setActiveTurns,
    focusComposer, entries, setBusy, patchThread, newChoice, permissionMode, chatFolder,
    readOnlyRun, busy, openSettings, openPersonal: personal.open, writable, idle,
    renameThread, setRenameRequest, newChat, archiveThread, setDeleteTargets, focusSearch,
    lastTurn, activeTurn, forkFrom, continues, send, planMode, setPlan, team, panelShown, setAgentsPanel,
    askSideQuestion,
  });
  const slash = useSlashMenu(text, slashCommands, () => { editDraft(""); setPanel(null); setSlashNotice(""); });
  const mention = useMentionMenu({ text, caret, cwd: chatFolder || undefined, threads, currentId: selected?.id,
    onPick: result => { pickedMentions.current.set(result.mention.path, result.mention); flushSync(() => editDraft(result.text)); setCaret(result.caret); composerRef.current?.setSelectionRange(result.caret, result.caret); } });
  // A panel belongs to the chat and page it was opened on; a notice goes when the person types again.
  useEffect(() => { setPanel(null); }, [selected?.id, view]);
  useEffect(() => { if (shellCreated.current !== selected?.id || view !== "chat") setShellMode(false); shellCreated.current = null; setSideChat(null); }, [selected?.id, view]);
  useEffect(() => { if (text) setSlashNotice(""); }, [text]);

  const searchedThreads = searchTerm && searchResults.query === searchTerm ? mergeListedThreads(threads, searchResults.data, hidden.current) : threads;
  const matchedOnServer = new Set(searchTerm && searchResults.query === searchTerm ? searchResults.data.map(thread => thread.id) : []);
  const ordinaryThreads = threads.filter(thread => !isAgentRun(thread));
  const agentRuns = threads.filter(isAgentRun);
  const runActions: MenuAction[] = [
    { id: "hide", label: "Hide Agent runs", run: () => {
      try { savePreferences({ showAgentRuns: false }); requestAnimationFrame(() => searchInput.current?.focus()); }
      catch (cause) { setError(`Could not save this preference: ${cause instanceof Error ? cause.message : String(cause)}`); }
    } },
    { id: "delete", label: agentRuns.length > 100 ? "Delete 100 Agent runs…" : "Delete Agent run history…", destructive: true, run: () => { setDeleteRunHistory(true); setDeleteTargets(agentRuns.slice(0, 100)); } },
  ];
  const ordinaryUnread = attention.unread.filter(id => ordinaryThreads.some(thread => thread.id === id));
  const filtered = searchedThreads.filter(t => !isAgentRun(t) && (matchedOnServer.has(t.id) || `${title(t)} ${t.agentNickname || ""} ${t.model || ""} ${t.id}`.toLowerCase().includes(searchTerm.toLowerCase())));
  const roots = filtered.filter(t => !isUnlinkedAgent(t, searchedThreads) && (!t.parentThreadId || !filtered.some(p => p.id === t.parentThreadId)));
  const unlinked = filtered.filter(t => isUnlinkedAgent(t, searchedThreads));
  // The chat list in screen order: Pinned, the groups (when the list is drawn by them), then Recents; sorted as chosen.
  // Search results keep the search's order.
  const listedRoots = searchTerm ? roots : sortChats(roots, chatGroups.sortBy, title, chatGroups.order);
  const pinnedChats = listedRoots.filter(t => pins.includes(t.id)), unpinnedChats = listedRoots.filter(t => !pins.includes(t.id));
  const grouped = !searchTerm && chatGroups.groupBy === "custom" ? groupSections(unpinnedChats, chatGroups) : null;
  const ungroupedChats = grouped ? grouped.ungrouped : unpinnedChats;
  const loveChats = searchTerm ? [] : ungroupedChats.filter(thread => chatOrigin(thread, loveActivity.threads) === "Love Spot");
  const workflowChats = searchTerm ? [] : ungroupedChats.filter(thread => chatOrigin(thread, loveActivity.threads) === "Workflows");
  const recentChats = searchTerm ? ungroupedChats : ungroupedChats.filter(thread => !chatOrigin(thread, loveActivity.threads));
  const ordered = [...pinnedChats, ...(grouped?.groups.flatMap(section => chatGroups.collapsed.includes(section.group.id) ? [] : section.chats) ?? []), ...(originOpen.love ? loveChats : []), ...(originOpen.workflows ? workflowChats : []), ...recentChats];
  // Esc stops the running reply, as in Claude, wherever in the chat the focus is, unless a menu, dialog or field owns the key.
  const escapeStops = useRef<(event: KeyboardEvent) => void>(() => {});
  escapeStops.current = event => { if (selected && !readOnlyRun && activeTurn && view === "chat" && stopsOnEscape(event)) { event.preventDefault(); void stop(selected); } };
  useEffect(() => { const onKey = (event: KeyboardEvent) => escapeStops.current(event); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  shortcutAction.current = (id, index) => {
    const at = selected ? ordered.findIndex(t => t.id === selected.id) : -1;
    if (id === "new-chat") newChat();
    else if (id === "command-menu") { commandReturnFocus.current = document.activeElement as HTMLElement | null; setCommandMenuOpen(true); }
    else if (id === "side-chat" && selected && !readOnlyRun && view === "chat") { setSideChat(previous => previous?.parentId === selected.id ? { ...previous, open: !previous.open } : { parentId: selected.id, open: true }); if (sideChat?.open) focusComposer(); }
    else if (id === "search") focusSearch();
    else if (id === "undo-delete") void undoDelete();
    else if (id === "sidebar") showSidebar(narrow() ? !sidebar : sidebarCollapsed);
    else if (id === "settings") { setSettingsSection("general"); show("settings"); }
    else if (id === "back" || id === "forward") goHistory(id === "back" ? -1 : 1);
    else if (id === "shortcuts") { shortcutsReturnFocus.current = document.activeElement as HTMLElement | null; setShortcutsOpen(true); }
    else if (id === "previous-chat" && ordered.length) void loadThread(ordered[at <= 0 ? 0 : at - 1]);
    else if (id === "next-chat" && ordered.length) void loadThread(ordered[at < 0 ? 0 : Math.min(ordered.length - 1, at + 1)]);
    else if (id === "go-to-chat" && index !== undefined && ordered[index]) void loadThread(ordered[index]);
    else if (id === "rename" && selected) setRenameRequest(true);
    else if (id === "archive" && selected) void archiveThread(selected);
    else if (id === "pin" && selected) togglePin(selected);
    else if (id === "copy-folder" && (selected?.cwd || cwd)) void navigator.clipboard.writeText(selected?.cwd || cwd);
    else if (id === "new-tab" && desktop) { newChatTab(); }
    else if (id === "close-tab" && desktop && view === "chat") closeChatTab(tabs.activeId);
    else if ((id === "next-tab" || id === "previous-tab") && desktop && view === "chat") cycleTabs(id === "next-tab" ? 1 : -1);
    else if (id === "full-view" && desktop) { if (view !== "chat") show("chat"); side.toggleFull(view === "chat" ? undefined : true); }
    else if (id === "terminal" && hasTerminal) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleTerminal(selected?.cwd || cwd, !away)) focusComposer(); }
    else if (id === "files" && desktop) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleFiles(!away)) focusComposer(); }
  };
  const { togglePin, deleteChats, trashChats, undoDelete, sidebarKeys, listKeys, attentionFor, groupMenu,
    drop, dropTarget, threadRow, chatRows, chatGroupSection, descendants } = useSidebarRows({ selected, view, searchedThreads,
    filtered, expanded, ordinaryThreads, preferences, searchTerm, pins, setPins, marked, setMarked, markAnchor,
    threadList, deletedNotice, setDeletedNotice, setDeleteTargets, setDeleteRunHistory, selectedRef, shownWhenDeleted,
    hidden, setError, noteKept, removeThreads, upsertThread, remember, refreshThreads, loadThread, openSplit,
    openInNewTab, attention, setAttention, setPlanAnswered, chatGroups, updateGroups, setNewGroupFor, listedRoots,
    pinnedChats, recentChats, grouped, waitingIds, approvals, find, hasTerminal, openInTui, splitPane: split.pane,
    windowAvailable, openSessionWindow, agentRunsOpen, setAgentRunsOpen, loadChildren, desktop, renameThread,
    archiveThread, markRead, loveThreads: loveActivity.threads });
  /** A narrow window slides the sidebar over the page; a wide one collapses it (the sidebar button and Ctrl+B), as in ChatGPT and Claude. */
  function narrow() { return matchMedia("(max-width: 760px)").matches || (panelShown && panelDrawer); }
  function showSidebar(open: boolean) { if (!narrow()) { setSidebarCollapsed(!open); return; } setSidebar(open); if (open) setSidebarCollapsed(false); }
  /** A chat's menu around its tab or title: the "…" button and right-click on `area` share one list. The shown chat's is "Chat actions". */
  const threadMenu = (thread: Thread, area: React.ReactElement, content: (menu: React.ReactNode) => React.ReactNode, shown: boolean) =>
    <ThreadActions label={shown ? "Chat actions" : undefined} thread={thread} attention={attentionFor(thread.id)} group={groupMenu(thread, [thread.id])} onRequestDelete={() => deleteChats([thread.id])} onRename={renameThread} onArchive={archiveThread} pinned={pins.includes(thread.id)} onPin={togglePin} onOpenInTui={hasTerminal ? openInTui : undefined} onOpenSplit={!split.pane ? openSplit : undefined} onOpenWindow={windowAvailable ? openSessionWindow : undefined} onNewWindow={windowAvailable ? () => openSessionWindow() : undefined} renameRequested={shown && renameRequest} onRenameRequestHandled={() => setRenameRequest(false)} area={area}>{content}</ThreadActions>;
  const chatActions = (area: React.ReactElement, content: React.ReactNode) => view === "chat" && selected
    ? threadMenu(selected, area, menu => <>{content}{menu}</>, true)
    : cloneElement(area, undefined, content);
  /** One chat tab: its title and close button, the "…" on the shown one, and the chat's menu on right-click. */
  function chatTab(tab: ChatTab) {
    const shown = tab.id === tabs.activeId, thread = tab.threadId ? (shown && selected?.id === tab.threadId ? selected : find(tab.threadId)) : undefined;
    const label = thread ? title(thread) : tab.threadId ? tab.title || "Chat" : "New chat";
    return <Tab key={tab.id} chat icon={<ChatIcon size={14} />} label={label} active={shown} closeLabel={`Close ${label} tab`} trailing={shown}
      wrap={thread ? (area, content) => threadMenu(thread, area, content, shown) : undefined} onSelect={() => showTab(tab)} onClose={() => closeChatTab(tab.id)} />;
  }
  useEffect(() => { document.title = view === "canvas" ? "Workflows · Elpis" : view === "experimentLab" ? "Lab · Elpis" : view === "customize" ? "Ledger — Elpis" : "Elpis"; }, [view]);
  const heading = view === "chat" ? (selected ? title(selected) : "") : { agentsGuide: "Guide to managing agents", canvas: "Workflows", experimentLab: "Lab", loveSpot: "Love Spot", customize: "Ledger", observability: "Observability", settings: "Settings" }[view];
  const chatName = selected ? title(selected) : "New chat";
  const chatState = selected ? agentState(selected, waitingIds) : "idle", floatState = activeTurn && chatState === "idle" ? "working" : chatState;
  const meta = selected ? [agentName(selected), selected.agentRole && selected.agentRole !== "default" ? selected.agentRole : null].filter(Boolean).join(" · ") : "";
  const commandActions: CommandAction[] = ["new-chat", "search", "settings", "shortcuts", "sidebar", ...(desktop ? ["files", "full-view"] : []), ...(hasTerminal ? ["terminal"] : []), ...(selected ? ["rename", "pin", "archive"] : [])].filter(id => id !== "new-chat" || !projectChanging).map(id => {
    const shortcut = SHORTCUTS.find(item => item.id === id)!;
    return { id, name: id === "pin" ? `${pins.includes(selected!.id) ? "Unpin" : "Pin"} chat` : id === "shortcuts" ? "Keyboard shortcuts" : shortcut.label, keys: shortcut.keys, run: () => { if (id === "shortcuts") { shortcutsReturnFocus.current = commandReturnFocus.current; setShortcutsOpen(true); } else shortcutAction.current(id); } };
  });
  commandActions.push({ id: "improve-elpis", name: "Improve Elpis…", run: () => window.dispatchEvent(new CustomEvent("elpis:improve")) });
  // The sidebar's pages in the person's order (drag and drop, or Alt+Up/Down), saved with the preferences.
  const arrangedPages = arrange(NAV_PAGES, preferences.navOrder.split(",").filter(Boolean));
  const reorderPages = (ids: string[]) => { try { savePreferences({ navOrder: ids.join(",") }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  for (const [target, name] of [["agentsGuide", "Guide to managing agents"], ["experimentLab", "Lab"], ["canvas", "Workflows"], ["loveSpot", "Love Spot"], ["observability", "Observability"], ["customize", "Ledger"]] as const) commandActions.push({ id: target, name, run: () => show(target) });

  return <div data-workspace={view} className={`app-shell${split.pane ? " session-pane" : ""}${split.thread && view === "chat" ? " session-split" : ""}${dark ? " dark" : ""}${desktop ? " has-title-bar" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${panelShown ? " panel-active" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {desktop && <div className="title-bar"><Button variant="ghost" size="icon" aria-label={sidebarCollapsed || (panelShown && panelDrawer && !sidebar) ? "Open sidebar" : "Close sidebar"} title={`${sidebarCollapsed ? "Open" : "Close"} sidebar (Ctrl+B)`} onClick={() => showSidebar(narrow() ? !sidebar : sidebarCollapsed)}><PanelLeft /></Button><NavButtons canBack={canBack(history)} canForward={canForward(history)} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} /><AppUpdate /></div>}
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} returnFocus={shortcutsReturnFocus} />
    {commandMenuOpen && <CommandMenu threads={ordinaryThreads} projects={busy || projectChanging ? [] : projects} actions={commandActions} returnFocus={commandReturnFocus} onClose={() => setCommandMenuOpen(false)} onThread={thread => { void loadThread(thread); }} onProject={item => { void selectProject(item).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }} onNewChat={prompt => { newChat(); setDesktopPrompt(prompt); }} />}
    {desktop && <StartupSplash done={ready && connected} />}
    <ProjectDialog projects={projects} editing={projectEdit} onClose={() => setProjectEdit(undefined)} onSave={saveProject} />
    <GroupNameDialog open={!!newGroupFor} state={chatGroups} group={null} switches={chatGroups.groupBy !== "custom"} onClose={() => setNewGroupFor(null)}
      onSave={name => { const ids = newGroupFor ?? [], id = crypto.randomUUID(); updateGroups(state => moveChats(addGroup(state, name, id), ids, id)); setNewGroupFor(null); setMarked([]); }} />
    <DeleteChatsDialog threads={deleteTargets} trash={trashChats} alwaysConfirm={deleteRunHistory} onClose={() => { setDeleteTargets(null); setDeleteRunHistory(false); }} />
    <RewindDialog threadId={selected?.id} turnId={rewindTurn} prompt={rewindTurn ? entries.find(entry => entry.turnId === rewindTurn && entry.item.type === "userMessage")?.item.content?.map(part => part.text ?? "").join("\n") ?? "" : ""} turns={rewindTurn ? Math.max(1, turnEntries.size - [...turnEntries.keys()].indexOf(rewindTurn)) : null} onConfirm={(mode, version) => rewindFrom(rewindTurn!, mode, version)} onClose={() => setRewindTurn(null)} />
    <aside className={`sidebar${sidebar ? " open" : ""}`} aria-label="Workspace navigation" onKeyDown={sidebarKeys}>
      <div className="brand"><Button className="sidebar-toggle" variant="ghost" size="icon-sm" aria-label="Close sidebar" title="Close sidebar (Ctrl+B)" onClick={() => showSidebar(false)}><PanelLeft size={16} /></Button><img src={brandMark} alt="Elpis" width={73} height={36} /></div>
      <nav className="nav-list" aria-label="Workspace">
        <Button data-slot="nav-row" className="new-chat" variant="ghost" aria-current={view === "chat" && !selected ? "page" : undefined} disabled={projectChanging} onClick={newChat}><NewChatIcon size={16} />New chat</Button>
        {arrangedPages.map(page => <Button data-slot="nav-row" key={page.id} variant="ghost" draggable data-nav-page={page.id} aria-current={view === page.id ? "page" : undefined} onClick={() => show(page.id)}
          title={`${page.name} (drag, or Alt+Up/Down, to reorder)`}
          onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/x-elpis-page", page.id); }}
          onDragOver={event => { if (event.dataTransfer.types.includes("text/x-elpis-page")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDrop={event => { const id = event.dataTransfer.getData("text/x-elpis-page"); if (!id || id === page.id) return; event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); reorderPages(move(arrangedPages.map(item => item.id), id, { target: page.id, after: event.clientY > box.top + box.height / 2 })); }}
          onKeyDown={event => { if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return; event.preventDefault(); event.stopPropagation(); reorderPages(move(arrangedPages.map(item => item.id), page.id, { by: event.key === "ArrowUp" ? -1 : 1 })); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-nav-page="${page.id}"]`)?.focus()); }}>
          <page.Icon size={16} />{page.name}{page.id === "loveSpot" && loveActivity.unread > 0 && <span className="love-unread badge badge-sm" role="status" aria-label={`${loveActivity.unread} Love Spot agents replied`}>{loveActivity.unread}</span>}</Button>)}
      </nav>
      <SearchField ref={searchInput} hint="Ctrl Shift K" aria-label="Search conversations" placeholder="Search chats" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); setSearch(""); focusComposer(); } }} />
      <div className="thread-list" ref={threadList} onKeyDown={listKeys}>
        {!searchTerm && <section aria-label="Projects"><div className="section-label-row"><div className="section-label">Projects</div><Button variant="ghost" size="icon-xs" aria-label="Add new project" title="Add new project: choose a folder" onClick={() => void addProject()}><PlusIcon size={13} /></Button></div>
          {projects.map(item => { const open = !collapsedProjects[item.id], chats = ordinaryThreads.filter(t => !t.parentThreadId && sameFolder(t.cwd && projectFolderOf(t.cwd), item.cwd)).slice(0, 5);
            return <SidebarGroup key={item.id} kind="project" name={item.name} title={item.cwd} icon={<FolderIcon size={14} />} open={open} active={project?.id === item.id} onToggle={() => setCollapsedProjects(prev => ({ ...prev, [item.id]: open }))}
              wrap={(area, content) => <ProjectActions project={item} onEdit={setProjectEdit} onRemove={removeProject} area={area}>{content}</ProjectActions>}
              trailing={<Button className="project-new-chat" variant="ghost" size="icon-xs" aria-label={`Start new chat in ${item.name}`} title="New chat in this project" disabled={!ready || busy} onClick={() => void selectProject(item)}><PlusIcon size={13} /></Button>}
              empty={!chats.length}>{chats.map(t => threadRow(t))}</SidebarGroup>; })}
        </section>}
        {pinnedChats.length > 0 && <section aria-label="Pinned"><div className="section-label-row"><div className="section-label">Pinned</div></div>{pinnedChats.map(chatRows("pinned"))}</section>}
        {grouped && grouped.groups.length > 0 && <section aria-label="Groups"><div className="section-label">Groups</div>{grouped.groups.map(chatGroupSection)}</section>}
        {(loveChats.length > 0 || workflowChats.length > 0) && <div className="section-label">Agent chats</div>}
        {loveChats.length > 0 && <SidebarGroup kind="chat" name="Love Spot" icon={<LoveSpotIcon size={14} />} open={originOpen.love} onToggle={() => setOriginOpen(value => ({ ...value, love: !value.love }))} wrap={(area, content) => cloneElement(area, {}, content(null))} empty={false}>{loveChats.map(thread => <div key={thread.id}>{threadRow(thread)}{expanded[thread.id] && descendants(thread.id, 1)}</div>)}</SidebarGroup>}
        {workflowChats.length > 0 && <SidebarGroup kind="chat" name="Workflows" icon={<WorkflowsIcon size={14} />} open={originOpen.workflows} onToggle={() => setOriginOpen(value => ({ ...value, workflows: !value.workflows }))} wrap={(area, content) => cloneElement(area, {}, content(null))} empty={false}>{workflowChats.map(thread => <div key={thread.id}>{threadRow(thread)}{expanded[thread.id] && descendants(thread.id, 1)}</div>)}</SidebarGroup>}
        {(searchTerm ? recentChats.length > 0 : roots.length > 0) && <section aria-label={searchTerm ? "Results" : "Recents"}><div className="section-label-row data-[drop=into]:shadow-[inset_0_0_0_1px_var(--primary)]" data-drop={drop?.id === "recents" ? "into" : undefined} {...(grouped ? dropTarget("recents", "recents", true) : {})}><div className="section-label">{searchTerm ? "Results" : "Recents"}</div>
          {!searchTerm && ordinaryUnread.length > 0 && <Button variant="ghost" size="xs" onClick={() => setAttention(previous => ({ ...previous, unread: [] }))}>Mark all as read</Button>}
          {!searchTerm && <GroupAndSortMenu state={chatGroups} onChange={change => updateGroups(state => ({ ...state, ...change }))} />}</div>
          {recentChats.map(chatRows("recents"))}
        </section>}
        {unlinked.length > 0 && <div className="unlinked-thread-list" aria-label="Agents whose parent is not listed"><div className="section-label mt-4" title="Their parent conversation is not in the current list.">Other agents</div>{unlinked.map(thread => threadRow(thread))}</div>}
        {ready && !threads.length && <p className="px-2 text-xs text-muted-foreground">Your conversations will appear here.</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.loading && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Searching saved conversations…</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.error && <p role="alert" className="px-2 py-3 text-xs text-destructive">Could not search saved conversations: {searchResults.error}</p>}
        {searchTerm && searchResults.query === searchTerm && !searchResults.loading && !searchResults.error && !filtered.length && <p className="px-2 py-3 text-xs text-muted-foreground">No matching conversations.</p>}
        {searchTerm ? searchResults.nextCursor && <Button variant="ghost" className="w-full" disabled={searchResults.loading} onClick={() => void loadMoreSearch()}>More search results</Button> : nextCursor && <Button variant="ghost" className="w-full" disabled={moreLoading} onClick={() => void loadMoreConversations()}>Load more</Button>}
        {!searchTerm && preferences.showAgentRuns && agentRuns.length > 0 && <section className="mt-4" aria-label="Background runs">
          <RightClickMenu actions={runActions} area={<div className="flex items-center" />}>
            <Button data-sidebar-stop variant="ghost" size="sm" className="min-w-0 flex-1 justify-start text-muted-foreground" aria-expanded={agentRunsOpen} aria-controls="agent-runs" onClick={() => setAgentRunsOpen(open => !open)}><ChevronRight size={13} className={agentRunsOpen ? "rotate-90" : undefined} />Agent runs ({agentRuns.length})</Button>
            <MoreMenu actions={runActions} label="Agent runs actions" title="Hide Agent runs or delete their history" />
          </RightClickMenu>
          {agentRunsOpen && <div id="agent-runs" role="region" aria-label="Agent runs">{agentRuns.map(thread => threadRow(thread, 1))}
            {Object.entries(childCursors).filter(([id, cursor]) => cursor && !hidden.current.has(id)).map(([id, cursor]) => <Button key={id} variant="ghost" size="xs" className="w-full justify-start" disabled={loadingChildren[id]} onClick={() => void loadChildren(id, cursor!, false)}><span className="truncate">More agents from {find(id) ? title(find(id)!) : "parent conversation"}</span></Button>)}
          </div>}
        </section>}
      </div>
      <UsagePanel refreshKey={accountRefresh} onOpen={() => { setSettingsSection("usage"); show("settings"); }} />
      <div className="sidebar-footer"><AccountMenu refreshKey={accountRefresh} dark={dark} onTheme={() => setTheme(dark ? "light" : "dark")} onSettings={() => openSettings("general")} onAccounts={manageConnections} /></div>
      <span className="status-line"><i className={`status-dot${connected ? " connected" : ""}`} />{connected ? "Local workspace" : "Disconnected"}</span>
      <ResizeEdge label="Resize sidebar" width={sidebarWidth} min={SIDEBAR.min} max={SIDEBAR.max} initial={SIDEBAR.initial} grows="right" onResize={resizeSidebar} />
    </aside>
    <main className="workspace" style={panelShown && !fullView && side.width ? { "--side-w": `clamp(380px, ${side.width}px, 70%)` } as CSSProperties : undefined}>
      <header className={`workspace-header${heading ? "" : " untitled"}`}>
        <ImproveElpis threadId={view === "chat" ? selected?.id : undefined} onChat={loadThread} />
        {outsideChatApprovals.length > 0 && <div className="pending-input-anchor"><Button ref={pendingInputButton} className="pending-input-trigger" variant="secondary" size="sm" aria-label={`Needs input (${outsideChatApprovals.length})`} aria-expanded={pendingInputOpen} aria-controls="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") setPendingInputOpen(false); }} onClick={() => setPendingInputOpen(value => !value)}><span className="pending-count">{outsideChatApprovals.length}</span>Needs input<span className="pending-task-name">{title(threads.find(thread => thread.id === outsideChatApprovals[0].params.threadId) || outsideChatApprovals[0].thread || {id:outsideChatApprovals[0].params.threadId || "unreported"})}</span></Button></div>}
        <Button className="mobile-menu sidebar-open" variant="ghost" size="icon-sm" aria-label="Open sidebar" title="Open sidebar (Ctrl+B)" onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>
        <img className="mobile-brand" src={brandMark} alt="" aria-hidden="true" width={49} height={24} />
        <div className="header-titles min-w-0 flex-1">
          {view === "chat" && desktop && !split.pane
            ? <TabStrip label="Chat tabs" activeKey={tabs.activeId} add={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New chat tab" title="New chat tab (Ctrl+T)" onClick={newChatTab}><PlusIcon size={15} /></Button>}>
                {tabs.tabs.map(chatTab)}
              </TabStrip>
            : chatActions(<div className="header-title-row" />, <h1>{heading}</h1>)}
          {view === "chat" && selected && chatOrigin(selected, loveActivity.threads) === "Love Spot" && <Button variant="ghost" size="xs" className="thread-origin" data-origin="Love Spot" onClick={() => show("loveSpot")}><LoveSpotIcon size={13} />Love Spot</Button>}
          {view === "chat" && selected && meta && <p className="thread-meta">{meta}</p>}
          {view === "chat" && selected && (selected.parentThreadId || selected.forkedFromId) && <p className="thread-links">
            {selected.parentThreadId && <Button variant="link" size="xs" aria-label={`Open parent: ${parent ? title(parent) : "parent conversation"}`} onClick={() => openById(selected.parentThreadId!)}>Agent of {parent ? title(parent) : "its parent conversation"}</Button>}
            {selected.forkedFromId && <Button variant="link" size="xs" aria-label={`Open original: ${source ? title(source) : "original chat"}`} onClick={() => openById(selected.forkedFromId!)}>Continued from {source ? title(source) : "the original chat"}</Button>}
          </p>}
        </div>
        {view === "loveSpot" && <div ref={setLoveToolbarHost} className="love-spot-toolbar-host" />}
        {view === "chat" && desktop && <Button className="header-action" variant="ghost" size="icon-sm" aria-pressed={side.open} aria-label={side.open ? "Hide side panel" : "Show side panel"} title={side.open ? "Hide side panel" : "Side panel: terminals and browser tabs"} onClick={() => side.open ? side.closePanel() : side.openPanel()}>{side.open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</Button>}
        {selected && view === "chat" && team.length > 0 && !panelShown && <Button className="header-action" variant="ghost" size="icon-sm" aria-label={agentsPanel ? "Hide agents panel" : "Show agents panel"} aria-pressed={agentsPanel} onClick={() => setAgentsPanel(value => !value)}><PanelRight size={16} /></Button>}
        {(split.pane || (split.thread && view === "chat")) && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Close split view" title="Close split view" onClick={split.close}><X size={16} /></Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Refresh conversation" disabled={loading} onClick={() => loadThread(selected)}><RefreshCw size={16} /></Button>}
      </header>
      <div className="workspace-notices">
      {deletedNotice && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1 truncate">{deletedNotice}</span><Button variant="outline" size="sm" title="Undo (Ctrl+Z)" onClick={() => void undoDelete()}>Undo</Button><Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setDeletedNotice(null)}><X size={15} /></Button></div>}
      {selected && rewindActions[selected.id] && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1">Your files stay as they are.</span><Button variant="outline" size="sm" disabled={rewindBusy || !!activeTurn} onClick={() => void switchRewind({ action: rewindActions[selected.id]! }).catch(cause => setError(String(cause)))}>{rewindActions[selected.id] === "undo" ? "Undo rewind" : "Redo rewind"}</Button></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></Button></div>}
      {worktreeNotice && <div className="error-banner warning worktree-notice" role="status"><span>{worktreeNotice}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss worktree notice" onClick={() => setWorktreeNotice("")}><X size={15} /></Button></div>}
      {catalogError && <div className="error-banner" role="alert"><span className="min-w-0">Models unavailable: {catalogError} Sign in or check Models &amp; accounts, then retry.</span><Button className="shrink-0" variant="outline" size="sm" disabled={catalogLoading} onClick={() => void refreshModels()}>Retry models</Button></div>}
      {/* Only the first load shows this line: account events refresh the list during turns, and a line appearing above the chat for each refresh shook it. */}
      {catalogLoading && !catalogError && !models.length && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">Loading models…</p>}
      {selected && runtimeNotices[selected.id] && <div className="error-banner" role="alert"><span>{runtimeNotices[selected.id]}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss conversation error" onClick={() => setRuntimeNotices(prev => without(prev, selected.id))}><X size={15} /></Button></div>}
      {selected && (recoveredEdit || recoveryAttachments.length > 0) && <div className="error-banner"><details className="min-w-0 w-full"><summary>Recover unsent message</summary><pre className="whitespace-pre-wrap break-words py-2" dir="auto">{recoveredEdit}</pre>{recoveryAttachments.length > 0 && <p>Files: {recoveryAttachments.map(part => part.name).join(", ")}</p>}<div className="flex flex-wrap items-center gap-2">{recoveredEdit && <CopyButton label="Copy unsent message" text={() => recoveredEdit} />}<Button variant="outline" size="sm" disabled={!!text.trim() || attachments.length > 0} title={text.trim() || attachments.length ? "Keep or clear your current draft before restoring this message." : undefined} onClick={() => { saveDraft(`recovery-${selected.id}`, ""); saveAttachments(`recovery-${selected.id}`, []); editDraft(recoveredEdit); setAttachments(recoveryAttachments); saveAttachments(selected.id, recoveryAttachments); }}>Use in composer</Button>{(!!text.trim() || attachments.length > 0) && <span>Your current draft is kept. Save it, or clear it to restore the unsent message.</span>}</div></details></div>}
      {!connected && ready && <div className="error-banner" role="status">Reconnecting to Elpis… Your draft is saved.</div>}
      {outsideChatApprovals.length > 0 && pendingInputOpen && <section id="pending-input-panel" aria-label="Pending input" className="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") { setPendingInputOpen(false); pendingInputButton.current?.focus(); } }}>
        <div className="pending-panel-heading"><div><h2>Needs input</h2><p>{outsideChatApprovals.length} {outsideChatApprovals.length === 1 ? "request" : "requests"} waiting for you</p></div><Button variant="ghost" size="icon-sm" aria-label="Close pending input" onClick={() => { setPendingInputOpen(false); pendingInputButton.current?.focus(); }}><X size={16}/></Button></div>
        <div className="pending-request-list">{outsideChatApprovals.map(approval => {
          const thread = threads.find(item => item.id === approval.params.threadId);
          const requester = thread ?? approval.thread; const name = requester ? title(requester) : approval.params.threadId || "Conversation not reported";
          return <div key={approvalDraftKey(approval)} className="pending-request"><div className="pending-request-heading"><p>{name}</p>{approval.params.threadId && <Button variant="ghost" size="sm" onClick={() => { setPendingInputOpen(false); openById(approval.params.threadId!); }}>Open chat</Button>}</div><ApprovalCard approval={approval} globalKeys={false} answer={(id, body) => answer(id, body, approvalDraftKey(approval))} deny={(id, text) => answer(id, { text }, approvalDraftKey(approval), true)} busy={!!pendingDrafts[approvalDraftKey(approval)]} answers={approvalDrafts[approvalDraftKey(approval)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(approval, id, value)} /></div>;
        })}</div>
      </section>}
      </div>
      <div className={`workspace-body${panelShown ? " panel-open" : ""}${fullView ? ` full-view${side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${view !== "chat" ? " no-browser" : ""}`}><div className="workspace-content" {...(fullView ? { role: "region", "aria-label": "Floating chat" } : {})}>
      {fullView && <FloatChatBar title={chatName} onCollapse={() => side.setChatCollapsed(true)} />}
      {settingsVisited && <div className="page-scroll" hidden={view !== "settings"}><ViewBoundary label="Settings" resetKey={settingsNavigation}><SettingsView initialTab={settingsSection} navigationKey={settingsNavigation} active={view === "settings"} threadId={selected?.id} currentModel={selected?.model} currentPermission={selected ? permissionLabel(permissionMode) : null} accountRefresh={accountRefresh} theme={theme} onTheme={setTheme} onUnarchived={unarchived} onDeleteThread={deleteThread} onBack={() => { show("chat"); requestAnimationFrame(focusComposer); }} onChatPermissions={() => { show("chat"); requestAnimationFrame(() => openComposerControl("Change permissions")); }} onProvidersChanged={async () => { await reloadSettings(); void refreshModels(); }} /></ViewBoundary></div>}
      {view === "agentsGuide" && <div className="page-scroll"><ViewBoundary label="Guide to managing agents"><AgentsGuide onBack={() => show("canvas")} /></ViewBoundary></div>}
      {view === "experimentLab" && <ViewBoundary label="Lab"><ExperimentLab /></ViewBoundary>}
      {view === "canvas" && <ViewBoundary label="Workflows"><CanvasGuideHelp onOpen={() => show("agentsGuide")}><AgentsCanvas models={models} cwd={newChatFolder(cwd) || undefined} dark={dark} onOpenChat={id => { show("chat"); void openById(id); }}
        projectMenu={<ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} />} /></CanvasGuideHelp></ViewBoundary>}
      {view === "loveSpot" && <ViewBoundary label="Love Spot"><LoveSpot dark={dark} toolbarHost={loveToolbarHost} cwd={newChatFolder(cwd) || undefined} onOpenChat={id => { show("chat"); void openById(id); }} /></ViewBoundary>}
      {view === "customize" && <div className="page-scroll"><ViewBoundary label="Ledger"><CustomizeView cwd={cwd} onOpenSettings={() => openSettings("mcp")}
        onConnectGithub={hasTerminal ? () => { show("chat"); setTuiLaunch({ key: side.openTerminal(cwd), command: "github-login", token: Date.now() }); } : undefined}
        onCreateSkill={() => { newChat(); requestAnimationFrame(() => editDraft("Use $skill-creator to create a new skill that ")); }} /></ViewBoundary></div>}
      {view === "observability" && <ViewBoundary label="Observability"><ObservabilityView /></ViewBoundary>}
      {view === "chat" && <ViewBoundary label="Chat" resetKey={selected?.id}><div className="chat-split"><div className={`chat-view${!selected && !shownEntries.length ? " empty-chat" : ""}`}>
        <div className="chat-scroll-wrap"><div className="chat-scroll" ref={scroll} onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}><div className="chat-content">
          {itemCursor && <Button variant="outline" className="load-earlier-messages" disabled={loading} onClick={() => void older()}>Load earlier messages</Button>}
          {loading && !shownEntries.length && <p role="status" className="chat-loading text-muted-foreground">Loading conversation…</p>}
          {!loading && !shownEntries.length && !activeTurn && <div className="empty-state">{selected ? <><h2>This conversation has no messages yet.</h2><p>Messages and tool activity appear here.</p></> : <><img className="empty-mark" src={brandMark} alt="" aria-hidden="true" /><h2>{project ? <>What should we build in <ProjectMenu variant="heading" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} />?</> : "What should we build?"}</h2>{personal.showTip && <PersonalTip onOpen={personal.open} onDismiss={personal.dismiss} />}</>}</div>}
          {conversation}
          {selected && stoppedTurns[selected.id] && !activeTurn && <p className="turn-stopped" role="status">Stopped. The reply above is where it was when the turn was stopped.</p>}
          {failedTurn && <FailedTurnCard key={`${selected?.id}:${failedTurn.turnId}`} failure={failedTurn} models={selectedChoice?.models ?? models} currentModel={selected?.model} disabled={!replaceable}
            blockedReason={continues ? "Continue this conversation here before trying again." : failedInput?.allowed ? undefined : failedInput?.reason ?? "The original complete input is unavailable, so this turn cannot be safely resent."}
            onRetry={!continues && failedInput?.allowed ? retryModel => replaceFrom(failedTurn.turnId, failedInput.prompt, undefined, retryModel) : undefined} />}
          {selected && proposedPlan && !readOnlyRun && <PlanCard mode={permissionMode} busy={busy || !connected} onImplement={permissions => answerPlan(selected, proposedPlan, { implement: true, permissions })} onKeepPlanning={feedback => answerPlan(selected, proposedPlan, { feedback })} />}
          {approvals.filter(a => a.params.threadId === selected?.id).map(a => <ApprovalCard key={approvalDraftKey(a)} approval={a} answer={(id, body) => answer(id, body, approvalDraftKey(a))} deny={(id, text) => answer(id, { text }, approvalDraftKey(a), true)} busy={!!pendingDrafts[approvalDraftKey(a)]} answers={approvalDrafts[approvalDraftKey(a)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(a, id, value)} />)}
        </div><PromptRail scroller={scroll} threadId={selected?.id ?? null} entries={shownEntries} onLoadEarlier={older} onNavigate={() => { stickToBottom.current = false; }} /></div></div>
        <div className="composer-wrap">
          {sideChat && selected?.id === sideChat.parentId && <SideChat key={sideChat.parentId} parentId={sideChat.parentId} open={sideChat.open} question={sideChat.question} onClose={() => { setSideChat(previous => previous ? { ...previous, open: false } : null); focusComposer(); }} />}
          <ViewBoundary label="This panel" resetKey={panel}>
          {panel === "status" && <SessionPanel rows={sessionRows} threadId={selected?.id} onUsage={() => { setPanel(null); openSettings("usage"); }} onClose={closePanel} />}
          {panel === "review" && selected && <ReviewPanel threadId={selected.id} onStart={target => void startReview(selected, target)} onClose={closePanel} />}
          {panel === "diff" && selected && <DiffPanel threadId={selected.id} onClose={closePanel} />}
          </ViewBoundary>
          {slashNotice && <p role="status" className="mx-auto mb-2 w-full max-w-[var(--transcript-width,740px)] px-1 text-sm text-muted-foreground">{slashNotice}</p>}
          {selected && plans[selected.id] && <TaskList plan={plans[selected.id]} running={activeTurns[selected.id] === plans[selected.id].turnId} />}
          <QueuedFollowUps threadId={selected?.id} activeTurnId={activeTurn} onError={setError} onComplete={restoreComposerFocus} onEdit={editQueued} />
          {!selected && <div className="composer-tray"><EnvironmentMenu folder={chatFolder || null} disabled={!ready || busy} worktree={newWorktree} onWorktree={setNewWorktree} /><ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} /></div>}
          {readOnlyRun ? <div className="mx-auto flex w-full max-w-[var(--transcript-width,740px)] flex-col gap-3 rounded-lg border p-4 text-sm text-muted-foreground" role="status">
            <p>{AGENT_RUN_NOTICE}</p>
            {selected?.desktopAccess?.canContinue && !activeTurn && selected.status?.type !== "active" && <Button variant="outline" size="sm" className="self-start" disabled={busy || !connected || loading} onClick={() => void continueHere(selected)}>Continue here</Button>}
          </div> : <form className="composer" onSubmit={e => { e.preventDefault(); send(); }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { const files = transferFiles(e.dataTransfer); if (files.length || e.dataTransfer.types.includes("Files")) { e.preventDefault(); void addFiles(files); } }}>
            {!shellMode && <><SlashMenu menu={slash} /><MentionMenu menu={mention} /></>}
            <input ref={filePickerRef} type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" aria-label="Choose files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addFiles(files); }} />
            <AttachmentChips attachments={attachments} disabled={busy || attaching} onRemove={id => { const next = attachmentsRef.current.filter(item => item.id !== id); setAttachments(next); saveAttachments(selectedRef.current?.id || newDraftKey.current, next); focusComposer(); }} />
            {attaching && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Reading files…</p>}
            {shellMode && <p role="status" className="bash-mode-notice"><span className="composer-pill">bash</span><span>Bash mode. Press Escape to return to chat.</span></p>}
            {!shellMode && promptKeys.status && <PromptStatusLine status={promptKeys.status} />}
            <Textarea ref={composerRef} aria-label="Message Elpis" {...(mention.open ? mention.inputProps : slash.inputProps)} onBlur={() => { slash.close(); mention.close(); promptKeys.cancel(); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} placeholder={shellMode ? "Run a shell command…" : continues ? `Message ${title(selected!)}…` : selected && activeTurn ? followUpHint(preferences) : selected ? "Ask for a follow-up" : "Ask Elpis to build, fix or explain something"} value={text} onChange={e => { const value = e.target.value; if (!shellMode && !textRef.current && value.startsWith("!") && !attachmentsRef.current.length) { setShellMode(true); promptKeys.cancel(); editDraft(value.slice(1)); setCaret(value.length - 1); } else { editDraft(value); setCaret(e.target.selectionStart); } }} onPaste={e => { const files = transferFiles(e.clipboardData); if (files.length) { if (!e.clipboardData.getData("text/plain")) e.preventDefault(); void addFiles(files); } }} disabled={!ready || !connected || projectChanging} onKeyDown={e => { if (shellMode) { if (e.key === "Escape" || (e.key === "Backspace" && !textRef.current)) { e.preventDefault(); e.stopPropagation(); setShellMode(false); promptKeys.cancel(); return; } if (isSendKey(e, preferences)) { e.preventDefault(); void sendShell(); } return; } if (mention.onKeyDown(e) || slash.onKeyDown(e) || promptKeys.onKeyDown(e)) return; if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); cycleMode(); return; } if (activeTurn && !continues) { const followUp = followUpKey(e, preferences); if (followUp) { e.preventDefault(); send(undefined, followUp); } } else if (isSendKey(e, preferences)) { e.preventDefault(); send(); } }} />
            {composerNotice && <div className="flex items-center gap-2 px-3 text-sm text-destructive" role="alert"><span className="whitespace-pre-line">{composerNotice}</span>{fileNotice && <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss file notice" onClick={() => setFileNotice("")}><X size={14} /></Button>}</div>}
            <div className="composer-controls"><div className="model-controls"><PlusMenu disabled={!ready || !connected || busy || projectChanging} attachDisabled={shellMode || attaching || attachments.length >= ATTACHMENT_LIMITS.count} slashDisabled={!!text} plan={planMode} returnFocus={composerRef}
                onAttach={pickFiles} onMention={() => { setShellMode(false); startMention(); }} onSlash={() => { setShellMode(false); startSlash(); }} onPlan={setPlan} onShell={() => { setShellMode(true); slash.close(); mention.close(); promptKeys.cancel(); focusComposer(); }} />
              {planMode && <PlanPill disabled={!ready || busy} onOff={() => setPlan(false)} />}
              <PermissionsMenu mode={permissionMode} disabled={permissionsLocked} onChange={choosePermissions} />
            </div><div className="composer-right">
              <ContextUsage threadId={selected?.id} />
              <ModelPicker choices={!selected ? choices : selectedChoice?.provider ? [selectedChoice] : choices.filter(choice => !choice.provider)} models={models}
                model={selected ? turnModel : model} choiceId={selected ? selectedChoice?.id || "" : choiceId} defaultModel={selected ? null : providerSettings?.main.model}
                disabled={!ready || busy || projectChanging} onConfigure={manageConnections} onKeySaved={() => void reloadSettings().catch(() => {})} onChange={choice => { if (selected) setOverride(selected.id, { model: choice.model }); else { setChoiceId(choice.choiceId); setModel(choice.model); setEffort(""); } }} />
              {turnEfforts.length > 0 && <OptionSelect aria-label="Reasoning effort" size="sm" className="model-select" value={turnEffort} onChange={e => selected ? setOverride(selected.id, { effort: e.target.value }) : setEffort(e.target.value)} disabled={!ready || busy}>
                <option value=""><span className="effort-long">Default effort</span><span className="effort-short">Default</span></option>
                {turnEffort && !turnEfforts.includes(turnEffort) && <option value={turnEffort}>{turnEffort}</option>}
                {turnEfforts.map(value => <option key={value} value={value}>{value}</option>)}
              </OptionSelect>}
              {ready && <Dictation key={selected?.id || newDraftKey.current} provider={dictationProvider} disabled={!ready || !connected || busy || projectChanging} onBusy={setDictating}
                selection={() => ({ text: textRef.current, start: composerRef.current?.selectionStart ?? textRef.current.length, end: composerRef.current?.selectionEnd ?? textRef.current.length })}
                onTranscript={(selection, transcript) => {
                  const result = insertTranscript(textRef.current, selection, transcript); editDraft(result.text);
                  requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(result.caret, result.caret); });
                }} />}
              {activeTurn && <Button type="button" size="sm" variant="secondary" className="stop-button shrink-0 gap-1.5" title="Stop response: stops the agent’s current turn." onClick={() => selected && stop(selected)}><Square size={14} fill="currentColor" aria-hidden="true" />Stop response</Button>}<Button type="submit" variant="cutPrimary" className="send-button" size={activeTurn && !continues ? "sm" : "icon"} aria-label={shellMode ? "Run shell command" : activeTurn && !continues ? "Send follow-up" : "Send message"} title={activeTurn && !continues ? followUpTooltip(preferences) : undefined} disabled={sendBlocked}>{activeTurn && !continues && !shellMode ? "Send follow-up" : <SendIcon size={18} />}</Button>{activeTurn && !continues && !shellMode && <SendOptionsMenu choice={followUpChoices(preferences)[1]} disabled={sendBlocked} returnFocus={composerRef} onChoose={follow => void send(undefined, follow)} />}</div></div>
          </form>}
          <div className="composer-meta">
            {selected && <ProjectMenu variant="chip" label="Change folder" addLabel="Choose folder…" allowNone={false} projects={projects} disabled={!ready || !!activeTurn || readOnlyRun}
              selected={projects.find(item => item.cwd.replace(/\/+$/, "") === selected.cwd?.replace(/\/+$/, "")) ?? (selected.cwd ? { id: `folder:${selected.cwd}`, name: folder(selected.cwd), cwd: selected.cwd } : null)}
              onSelect={moveChat} onAdd={() => void moveChatToFolder()} />}
            {selected?.cwd && <BranchChip key={selected.id} threadId={selected.id} running={!!activeTurn} onNotice={setSlashNotice} />}
            <span className="composer-hint">{selectedLiveError ? `Not following live (${selectedLiveError}); the chat refreshes every few seconds.` : ""}</span>
            <ElpisFeatures threadId={selected?.id} />
          </div>
        </div>
      </div>
      {selected && teamRoot && team.length > 0 && agentsPanel && !panelShown && <AgentsPanel team={team} root={teamRoot} selected={selected} waitingIds={waitingIds} activity={activity} models={models} onOpen={openById} onLoad={loadThread} />}
      </div></ViewBoundary>}
      </div>{fullView && side.chatCollapsed && <FloatChatPill title={chatName} state={floatState} onRestore={() => side.setChatCollapsed(false)} />}{desktop && <SidePanel panel={side} browser={browser} hasTerminal={hasTerminal} dark={dark} cwd={selected?.cwd || cwd} threadId={selected?.id} running={!!activeTurn} launch={tuiLaunch} covered={pendingInputOpen || sidebar || view !== "chat"} onAttach={attachFromBrowser} imagesAllowed={!(knownModel?.inputModalities && !knownModel.inputModalities.includes("image"))} />}</div>
      {split.thread && view === "chat" && <iframe key={split.thread.id} ref={split.frame} className="split-session" title="Split session" src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`} />}
    </main>
  </div>;
}
