"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import dynamic from "next/dynamic";
import { BrandWordmark } from "@/components/brand-wordmark";
import { flushSync } from "react-dom";
import { cloneElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AgentsIcon, ChatIcon, ExperimentLabIcon, LoveSpotIcon, NewChatIcon, PlusIcon, SettingsIcon, ThemeIcon, WorkflowsIcon } from "@/components/elpis-icons";
import { Activity, ArrowDown, Blocks, PanelLeft, PanelRightClose, PanelRightOpen, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReorderItem, useReorder } from "@/components/reorder";
import { ApprovalCard } from "@/components/approval-card";
import { PlanCard } from "@/components/plan-card";
import { SearchField } from "@/components/ui/search-field";
import { FailedTurnCard } from "@/components/failed-turn-card";
import { ViewBoundary } from "@/components/view-boundary";
import { WorkingPlacement } from "@/components/transcript";
import { useBookmarks, useChatAttention, usePins, useSidebarFolds, useChatGroups } from "@/lib/use-sidebar-state";
import { SIDEBAR, useAppearance } from "@/lib/use-appearance";
import { addGroup, chatSelectionRoots, chatSubtree, moveChats, prioritizeChats, sidebarParents, type ChatGroups } from "@/lib/chat-groups";
import { agentParentId } from "@/lib/agent-runs.mjs";
import { configuredShortcuts, shortcutHint, shortcutTitle } from "@/lib/shortcuts";
import { CommandMenu, type CommandAction } from "@/components/command-menu";
import { ImproveElpis } from "@/components/improve-elpis";
import { arrange, move } from "@/lib/nav-order";
import { followUpHint, followUpKey, isSendKey, newChatFolder, savePreferences, useAppPreferences } from "@/lib/preferences";
import { QueuedFollowUps } from "@/components/queued-follow-ups";
import { stopsOnEscape, usePromptKeys } from "@/lib/prompt-history";
import { OPEN_CONTEXT_EVENT } from "@/components/context-usage";
import { ElpisFeatures } from "@/components/elpis-features";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StartupSplash } from "@/components/startup-splash";
import { AppUpdate } from "@/components/app-update";
import { AppMenus } from "@/components/app-menus";
import { permissionLabel, type PermissionMode } from "@/components/composer-controls";
import { CopyButton } from "@/components/markdown-text";
import { fitChatListEnd, useWholeRows } from "@/lib/whole-rows";
import { mergeHistoryWithLive } from "@/lib/live-events";
import { rememberSubmittedMessages, withSubmittedMessages, type SubmittedMessage } from "@/lib/submitted-messages";
import { replacementEligibility, type MessageVersion } from "@/lib/turn-replacement";
import { AgentsGuide } from "@/components/agents-guide";
import { CanvasGuideHelp } from "@/components/canvas-guide-help";
import { ExperimentLab } from "@/components/experiment-lab";
import { CustomizeView } from "@/components/customize-view";
import type { TerminalLaunch } from "@/components/terminal-view";
import { SettingsView, type SettingsDestination } from "@/components/settings-view";
import { DeleteChatsDialog, ThreadActions } from "@/components/thread-actions";
import { GroupNameDialog } from "@/components/chat-groups";
import { SectionToggle } from "@/components/sidebar-group";
import { SidebarChatList } from "@/components/sidebar-chat-list";
import { createSidebarThreadRow } from "@/components/sidebar-thread-row";
import { createSidebarBranches } from "@/components/sidebar-branches";
import { ComposerControls } from "@/components/composer-controls-panel";
import { ComposerForm } from "@/components/composer-form";
import { useConversationTranscript } from "@/components/use-conversation-transcript";
import { useSlashMenu } from "@/components/slash-menu";
import { useMentionMenu } from "@/components/mention-menu";
import { NavButtons } from "@/components/nav-buttons";
import { PromptRail } from "@/components/prompt-rail";
import { RewindDialog } from "@/components/rewind-dialog";
import { useNavHistory } from "@/lib/nav-history";
import { DiffPanel, ReviewPanel, SessionPanel } from "@/components/slash-panels";
import { openControl } from "@/lib/slash-focus";
import { reloadSettings, useElpisSettings } from "@/lib/settings-store";
import { UsagePanel } from "@/components/provider-usage";
import { isVoiceHandoff } from "@/bridge/voice-handoff.cjs";
import { ReadAloud } from "@/components/read-aloud";
import { MatildaCompanion } from "@/components/matilda-companion";
import { LiveVoiceProvider } from "@/components/live-voice";
import { ObservabilityView } from "@/components/observability-view";
import { AutomationsView, type WorkflowPrefill } from "@/components/automations-view";
import { Segmented } from "@/components/settings/rows";
import { EnvironmentMenu, MoveChatDialog, ProjectDialog, ProjectMenu } from "@/components/project-picker";
import { PutUnderDialog } from "@/components/put-under-dialog";
import { WorkflowMark } from "@/components/workflow-identity";
import { useWorkflowSandbox, type WorkflowRun } from "@/lib/workflow-identity";
import { BranchChip } from "@/components/branch-chip";
import { AccountRow } from "@/components/account-row";
import { ProfileDialog } from "@/components/profile-dialog";
import { readProjectChats, readProjects, saveProjects } from "@/lib/projects";
import { ResizeEdge } from "@/components/resize-edge";
import { TaskList } from "@/components/task-list";
import { chatOrigin, originLabel } from "@/lib/love-activity";
import { useLoveActivity } from "@/lib/use-love-activity";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { savedPersona } from "@/lib/matilda";
import { useScreenshotPopup } from "@/lib/use-screenshot-popup";
import { AgentsCanvas } from "@/components/agents-canvas";
import { WorkflowChat } from "@/components/workflow-chat";
import { DocumentReviewProvider } from "@/components/document-review";
import { ChatTeamPanel } from "@/components/chat-team-panel";
import { agentColourSlots } from "@/components/agent-identity";
import { ResumeConversation } from "@/components/resume-conversation";
import { sidebarListKeys, useSidebarKeys, useWorkspaceNavigation } from "@/lib/use-workspace-navigation";
import { agentState } from "@/lib/agents";
import { useBrowserPins } from "@/lib/browser-pins";
import { useBrowser } from "@/components/browser-panel";
import { onRequest as onFileRequest, openFile, setFileView } from "@/lib/files-pane";
import { PersonalTip, usePersonal } from "@/components/personal-tip";
import { SidePanel, sideMinWidth, useSidePanel } from "@/components/side-panel";
import { SideChat, type SideRequest } from "@/components/side-chat";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { useSessionSplit } from "@/components/session-split";
import { Tab, TabStrip } from "@/components/tab-strip";
import { activeTab, followChat, forgetChats, renameTabs, type ChatTab } from "@/lib/chat-tabs";
import { TEXT_ONLY_NOTICE, fitAttachments, transferFiles, type Attachment } from "@/lib/attachments";
import { LoadOnScroll } from "@/components/load-on-scroll";
import { api, unreadable, isAgentRun, AGENT_RUN_NOTICE, modelLabel, providerLabel, title, agentName,
  type Approval, type Entry, type ProviderSettings, type Thread } from "@/lib/api";
import { historyPath, inReadingOrder } from "@/lib/chat-history";
import { useComposerHeight } from "@/lib/use-composer-height";
import { useTranscriptHistory } from "@/lib/use-transcript-history";
import { useConversationList } from "@/lib/use-conversation-list";
import { useOpenConversation } from "@/lib/use-open-conversation";
import { useRuntimeEvents } from "@/lib/use-runtime-events";
import { useRuntimeState } from "@/lib/use-runtime-state";
import { createSlashCommands } from "@/lib/slash-commands";
import { createChatSend } from "@/lib/chat-send";
import { createChatNavigation } from "@/lib/chat-navigation";
import { createProjectActions } from "@/lib/project-actions";
import { createEarlierMessages } from "@/lib/earlier-messages";
import { createMessageActions } from "@/lib/message-actions";
import { createChatDeletion } from "@/lib/chat-deletion";
import { useChatReorder } from "@/lib/use-chat-reorder";
import { useSidebarThreads } from "@/lib/use-sidebar-threads";
import { useChildConversations } from "@/lib/use-child-conversations";
import { modelSelection } from "@/lib/model-selection";
import { createCommandActions } from "@/lib/command-actions";
import { createConversationSettings } from "@/lib/conversation-settings";
import { createConversationActions } from "@/lib/conversation-actions";
import { createReplyActions } from "@/lib/reply-actions";
import { refusedOffline, type View, type WorkflowReplay, type NextTurn } from "@/lib/workspace-types";
import { useComposerAttachments } from "@/lib/use-composer-attachments";
import { useComposerState } from "@/lib/use-composer-state";
import { useProjectState } from "@/lib/use-project-state";
import { useChatTabs } from "@/lib/use-chat-tabs";
import { approvalDraftKey, useApprovalDrafts, useDraftStore, useSubmitOnce } from "@/lib/use-drafts";
import { sessionWindowApi, useDesktopCapabilities } from "@/lib/use-desktop-capabilities";
import { useWorkspaceNotices } from "@/lib/use-workspace-notices";
import { useSidebarSearch } from "@/lib/use-sidebar-search";
import { WorkspaceNotices } from "@/components/workspace-notices";
import { without } from "@/lib/utils";
import { errorText } from "@/lib/error-text.mjs";
import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";


const LoveSpot = dynamic(() => import("@/components/love-spot"), { ssr: false, loading: () => <p role="status">Opening Love Spot…</p> });

/** The sidebar's pages after New chat, in their default order; the person may rearrange them. */
const NAV_PAGES = [
  { id: "experimentLab", name: "Lab", Icon: ExperimentLabIcon },
  { id: "canvas", name: "Workflows", Icon: WorkflowsIcon },
  { id: "loveSpot", name: "Love Spot", Icon: LoveSpotIcon },
  // 5 Nov: back, as the TUI's /dashboard page (DeepSeek's Trajectory), with the pulse icon he approved.
  { id: "observability", name: "Observability", Icon: Activity },
  { id: "customize", name: "Customize", Icon: Blocks },
] as const;
/** Every page's name, for its heading and the command menu: the sidebar pages, the guide and Settings. */
const PAGE_NAMES: Record<Exclude<View, "chat">, string> = { ...Object.fromEntries(NAV_PAGES.map(page => [page.id, page.name])) as Record<typeof NAV_PAGES[number]["id"], string>, agentsGuide: "Guide to managing agents", settings: "Settings" };

const fittedLists = new WeakSet<HTMLElement>();

export default function Home() {
  const preferences = useAppPreferences();
  const hiddenPages = preferences.hiddenPages.split(",");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedRef = useRef<Thread | null>(null);
  // Chat tabs (lib/chat-tabs.ts): the shown tab follows the chat on screen, so every way of opening a chat lands in it.
  const { tabs, tabsRef, updateTabs, restoreTabs, restored: restoredTabs } = useChatTabs(message => setError(message));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [submissions, setSubmissions] = useState<SubmittedMessage[]>([]);
  // The engine's live model list, shared by every model menu (lib/model-catalog.ts).
  const { models, error: catalogError, loading: catalogLoading } = useModelCatalog();
  const refreshModels = refreshModelCatalog;
  // One settings snapshot for the whole app, so a main model saved in Settings is what the next new chat starts with.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings = settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  // New conversations: where to run and with what.
  const [choiceId, setChoiceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const projectState = useProjectState();
  const { cwd, setCwd, projects, setProjects, projectId, setProjectId, setWorkflowProjectId, projectChats, setProjectChats,
    projectChatsRef, projectMove, setProjectMove, newProjectFor, setNewProjectFor, nestTargets, setNestTargets,
    projectChanging, project, workflowProject, projectEdit, setProjectEdit } = projectState;
  const [recordedWorkflow, setRecordedWorkflow] = useState<Pick<WorkflowRun, "id" | "rootThreadId">>();
  // Existing conversations: overrides for their next turn only.
  const [nextTurn, setNextTurn] = useState<Record<string, NextTurn>>({});
  const [threadModes, setThreadModes] = useState<Record<string, PermissionMode>>({});
  const [changingPermissions, setChangingPermissions] = useState(false);
  const [threadPlans, setThreadPlans] = useState<Record<string, boolean>>({});
  const [newPlan, setNewPlan] = useState(false);
  const [planAnswered, setPlanAnswered] = useState<Record<string, string>>({});
  const { pins, togglePinned } = usePins();
  const { bookmarks, toggleBookmarked } = useBookmarks();
  // The sidebar's order is declared further down; groups release it through this ref.
  const releaseChatOrder = useRef(() => {});
  const { chatGroups, chatGroupsRef, updateGroups, commitGroups } = useChatGroups(message => setError(message), () => releaseChatOrder.current());
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null);
  const { error, setError, deletedNotice, setDeletedNotice, worktreeNotice, setWorktreeNotice, noteKept } = useWorkspaceNotices();
  const { attention, setAttention, planTurns, markRead } = useChatAttention(planAnswered, setError);
  /** Chats awaiting the shared delete confirmation (a row's menu, D, or the header's Chat actions). */
  const [deleteTargets, setDeleteTargets] = useState<Thread[] | null>(null);
  const [deleteRunHistory, setDeleteRunHistory] = useState(false);
  /** After the sidebar deletes chats, Undo (or Ctrl+Z) reopens the chat that was open. */
  const shownWhenDeleted = useRef(new Set<string>());
  /** Chats marked with Ctrl+click or Shift+click in the sidebar; `markAnchor` is where a Shift range starts. */
  const [marked, setMarked] = useState<string[]>([]);
  const markAnchor = useRef<string | null>(null);
  const threadList = useRef<HTMLDivElement>(null);
  useEffect(() => {   // keep the chat list's end on a whole row as the window, the rows or their labels change
    const list = threadList.current; if (!list || fittedLists.has(list)) return;   // the list mounts after the splash
    fittedLists.add(list);
    let frame = 0; const fit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitChatListEnd(list)); };
    new ResizeObserver(fit).observe(list);
    new MutationObserver(fit).observe(list, { childList: true, subtree: true, characterData: true });
    fit();
  });
  // Async rows and viewport changes can leave the last chat painted only part way (lib/whole-rows.ts).
  useWholeRows(threadList, ".thread-row", ".thread-row, .section-label-row, .sidebar-group-row, .thread-more");
  const { folds, foldsRef, changeFolds, setCollapsedProjects } = useSidebarFolds();
  const collapsedProjects = folds.projects, collapsedSections = folds.sections;
  /** The heading of a sidebar section: every one of them folds its list the same way. */
  const foldable = (key: string, name: string) => <SectionToggle name={name} open={!collapsedSections[key]} onToggle={() => changeFolds(value => ({ ...value, sections: { ...value.sections, [key]: !value.sections[key] } }))} />;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  /** The message whose "Rewind to here" is awaiting confirmation (its turn). */
  const [rewindTurn, setRewindTurn] = useState<string | null>(null);
  const [rewindActions, setRewindActions] = useState<Record<string, "undo" | "redo" | undefined>>({});
  /** ChatGPT's ‹ 1/2 › under an edited message, per chat: its versions by turn (bridge/message-versions.mjs). */
  const [messageVersions, setMessageVersions] = useState<Record<string, MessageVersion[]>>({});
  const [rewindBusy, setRewindBusy] = useState(false);
  const rewindSwitch = useRef<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renameRequest, setRenameRequest] = useState(false);
  /** What a slash command has open above the composer, and the one-line answer of a command that only reports. */
  const [panel, setPanel] = useState<"status" | "review" | "diff" | null>(null);
  const [slashNotice, setSlashNotice] = useState("");
  // /compact typed while the agent works runs when that turn finishes, as in the terminal.
  const [queuedCompact, setQueuedCompact] = useState<{ threadId: string; guidance?: string } | null>(null);
  // A new chat in its own worktree (the Local/Worktree menu), and where an archived or deleted chat's worktree was kept.
  const [newWorktree, setNewWorktree] = useState(false);
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  const [newMode, setNewMode] = useState<PermissionMode | null>(null);
  const composer = useComposerState();
  const { text, setText, shellMode, setShellMode, shellCreated, textRef, composerRef, caret, setCaret, pickedMentions, filePickerRef, dictating, voiceBusy } = composer;
  const [sideChat, setSideChat] = useState<{ parentId: string; open: boolean; question?: SideRequest } | null>(null);
  const sideRequests = useRef(0);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [agentRunsOpen, setAgentRunsOpen] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const { pending: pendingDrafts, submit: submitDraft } = useSubmitOnce();
  const { answersFor, draftAnswer, clearApprovalDraft } = useApprovalDrafts();
  const draftStore = useDraftStore(setError), { savedDraft, saveDraft, savedAttachments, saveAttachments } = draftStore;
  const newDraftKey = useRef("new");
  const runtime = useRuntimeState();
  const { connected, connectionStatus, ready, runtimeNotices, setRuntimeNotices,
    activeTurns, plans, approvals, setApprovals,
    activity, liveError, historyOnly, failedTurns, stoppedTurns,
    accountRefresh, replays, setReplays } = runtime;
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  const [busy, setBusy] = useState(false);
  const sending = useRef(0);
  const [loading, setLoading] = useState(false);
  const editDraft = (value: string) => { setText(value); saveDraft(selectedRef.current?.id || newDraftKey.current, value); };
  const attachmentState = useComposerAttachments({ selectedRef, newDraftKey, shellMode, savedAttachments, saveAttachments, setError, setRuntimeNotices });
  const { attachments, attachmentsRef, attaching, fileNotice, setFileNotice, setAttachments, restoreAttachments, addFiles } = attachmentState;
  /** The browser's annotations and screenshots join the composer's files; its Send also sends the message. */
  async function attachFromBrowser(parts: Attachment[], submit: boolean) {
    const owner = selectedRef.current?.id || newDraftKey.current;
    try {
      const fit = fitAttachments(savedAttachments(owner), parts);
      if (fit.problems.length) throw Error(fit.problems.join("\n"));
      saveAttachments(owner, fit.kept); setAttachments(fit.kept); setFileNotice("");
    } catch (cause) { setFileNotice(errorText(cause)); showChat(); return false; }
    showChat();
    if (submit) await send(); else requestAnimationFrame(() => composerRef.current?.focus());
    return true;
  }
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState(0);
  const [related, setRelated] = useState<Record<string, Thread>>({});
  const [view, setView] = useState<View>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("workspace") === "canvas" ? "canvas" : "chat");
  useComposerHeight(composerRef, [text, selected?.id, view]);
  const loveActivity = useLoveActivity(view === "loveSpot", ready, view === "chat" ? selected : null);
  const loveRef = useRef(loveActivity); loveRef.current = loveActivity;
  /** A Love Spot chat by id, read at event time. */
  const isLoveChatId = (id: string) => loveRef.current.isLoveChat(threadsRef.current.find(thread => thread.id === id) ?? { id });
  const selectedLoveChat = !!selected && loveActivity.isLoveChat(selected);
  const loveSpotAudioReason = selected && !LOVE_SPOT_AUDIO.available
    ? selectedLoveChat ? LOVE_SPOT_AUDIO.reason : !loveActivity.originsResolved ? LOVE_SPOT_AUDIO.pendingReason : undefined
    : undefined;
  const viewRef = useRef(view); viewRef.current = view;
  const [workflowTab, setWorkflowTab] = useState<"board" | "scheduled">("board");
  /** A workflow the board handed to Scheduled (its Schedule button), until the form takes it. */
  const [workflowPrefill, setWorkflowPrefill] = useState<WorkflowPrefill | null>(null);
  /** Scheduled workflows this window claimed (bridge/server.mjs dispatchWorkflow): each replays its saved board out of
   * sight and reports the run's chat. */
  const finishReplay = useCallback((replay: WorkflowReplay, result: { threadId?: string; error?: string }) => {
    setReplays(previous => previous.filter(item => item.token !== replay.token));
    void api(`/automations/${replay.taskId}`, { action: "result", token: replay.token, ...result }).catch(() => {});
  }, []);
  const workflowSandbox = useWorkflowSandbox(view === "canvas" && ready && connected && !workflowProject, setError), workflowFolder = workflowProject?.cwd || workflowSandbox;
  // Matilda's chat on screen reads every Love Spot reply.
  useEffect(() => { if (loveActivity.chatShown) setAttention(previous => ({ ...previous, unread: previous.unread.filter(id => !isLoveChatId(id)) })); }, [loveActivity.chatShown, setAttention]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === "chat" && selected) markRead(selected.id); }, [view, selected?.id, markRead]);
  const [settingsSection, setSettingsSection] = useState<SettingsDestination>("general");
  const { desktop, windowAvailable, hasTerminal } = useDesktopCapabilities();
  const browser = useBrowser(selected?.id ?? `draft:${tabs.activeId}`);
  const side = useSidePanel(browser, selected?.cwd || cwd);
  const browserPins = useBrowserPins(setError);
  useEffect(() => onFileRequest(() => { if (view !== "chat") setView("chat"); }), [view]);
  // The side panel (components/side-panel.tsx): shells and browser pages as tabs, beside the chat.
  const [tuiLaunch, setTuiLaunch] = useState<TerminalLaunch | null>(null);
  const panelShown = desktop && side.open && view === "chat";
  /** Full view (the side panel's): the panel fills the work area and the chat floats over it, as a card or folded to a pill. */
  const fullView = panelShown && side.full;
  /** A window too narrow for chat and panel side by side shows the panel alone; the chat comes back when it is needed. */
  const showChat = () => { if (side.full) side.setChatCollapsed(false); else if (matchMedia("(max-width: 760px)").matches) side.closePanel(); };
  useEffect(() => { if (selected?.id) showChat(); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 1000px)");
    const update = () => setPanelDrawer(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [agentsPanelState, setAgentsPanelState] = useState<{ open: boolean; held: ReadonlySet<string> }>({ open: true, held: new Set() });
  const [workingAgentsOnly, setWorkingAgentsOnly] = useState(true);
  const [loveToolbarHost, setLoveToolbarHost] = useState<HTMLDivElement | null>(null);
  const [workingHost, setWorkingHost] = useState<HTMLDivElement | null>(null);
  const { theme, dark, setTheme, sidebarWidth, resizeSidebar } = useAppearance(setError);
  // The website's animated wordmark, its dark or light version (website/assets/branding).
  const searchInput = useRef<HTMLInputElement>(null);
  const shortcutsReturnFocus = useRef<HTMLElement | null>(null);
  const history = useTranscriptHistory(selected, loading, entries, setEntries);
  const { itemCursor, setItemCursor, historyGaps, heldCount, transcripts, prefetchThread, liveRevision, liveKeysAfter } = history;
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const followingBottom = useRef(false);
  // ChatGPT's round "scroll to bottom" button shows while the chat is away from its newest message.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const request = useRef(0);
  const initialRestoration = useRef<{ threadId: string; promise: Promise<void> } | null>(null);
  const conversations = useConversationList(threads, setThreads, selectedRef, setSelected, setError);
  const { select, settingsOf, threadsRef, hidden, upsertThread, refreshThreads } = conversations;
  const { loadingChildren, checkedChildren, childCursors, expanded, setExpanded, holdAgentPanel, loadChildren } = useChildConversations({ conversations, selectedRef, setThreads, setError, setAgentsPanelState });
  const search = useSidebarSearch(ready, hidden), searchTerm = search.searchTerm;

  const removeThreads = useCallback((ids: Set<string>, permanent: boolean) => {
    for (let grew = true; grew;) { grew = false; for (const thread of threadsRef.current) if (thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id)) { ids.add(thread.id); grew = true; } }
    for (const id of ids) { hidden.current.add(id); transcripts.current.delete(id); browser.closeSession(id); }
    if (permanent) {
      draftStore.forget(ids);
      setMessageEdits(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !ids.has((JSON.parse(key) as [string, string, string])[0]))));
    }
    updateTabs(forgetChats(tabsRef.current, ids));
    setThreads(prev => prev.filter(thread => !ids.has(thread.id)));
    setMarked(prev => prev.some(id => ids.has(id)) ? prev.filter(id => !ids.has(id)) : prev);
    setApprovals(prev => prev.filter(approval => !ids.has(approval.params.threadId ?? "")));
    if (selectedRef.current && ids.has(selectedRef.current.id)) { request.current++; select(null); setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setEntries([]); setItemCursor(null); }
  }, [select, setText, savedDraft, restoreAttachments, updateTabs, browser.closeSession]);
  const { rememberFollowing, reconcileLiveThread, loadThread, openThread } = useOpenConversation({ composer, runtime, conversations, history, drafts: draftStore, attachments: attachmentState, tabsRef, updateTabs, selectedRef, newDraftKey, markRead, request, stickToBottom, followingBottom, restoreScroll, setView, setSidebar, setLoading, setError, setEntries, rememberModes: (id, live) => rememberModes(id, live) });

  useEffect(() => { setText(savedDraft(newDraftKey.current)); }, [savedDraft]);

  useEffect(() => {
    try { const stored = readProjects(); newDraftKey.current = "new"; setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setProjects(stored.projects); setWorkflowProjectId(stored.selectedId); const memberships = readProjectChats(); projectChatsRef.current = memberships; setProjectChats(memberships); }
    catch (e) { setError(errorText(e, "Could not restore workspace preferences.")); }
    const restored = restoreTabs(), shown = restored && activeTab(restored);
    if (shown && !shown.threadId && shown.draftKey) { newDraftKey.current = shown.draftKey; setText(savedDraft(shown.draftKey)); restoreAttachments(shown.draftKey); }
  }, []);
  useEffect(() => window.elpisDesktop?.storage?.onError(setError), []);
  useWorkspaceNavigation(shortcutAction);
  useRuntimeEvents({ history, conversations, runtime, selectedRef, request, tabsRef, refreshModels, setError, initialRestoration, rememberFollowing, rememberModes: (id, live) => rememberModes(id, live), reconcileLiveThread, restoredTabs, loadThread, openThread, viewRef, planTurns, setAttention, loveRef, isLoveChatId, setRewindActions, setThreadModes, rewindSwitch, removeThreads, setEntries, clearApprovalDraft });

  const selectedTeamId = selected?.parentThreadId ?? selected?.id;
  useEffect(() => { if (ready && selectedTeamId) loadChildren(selectedTeamId); }, [ready, selectedTeamId, loadChildren]);
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useEffect(() => {
    if (!selected || !selectedLiveError || view !== "chat" || loading) return;
    const id = selected.id; let disposed = false, inFlight = false;
    const timer = setInterval(async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const historyRevision = liveRevision.current;
      try {
        const result = await api<{ thread: Thread; data: Entry[] }>(historyPath(id)); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
        if (disposed || selectedRef.current?.id !== id) return;
        select(result.thread);
        setEntries(prev => {
          const fresh = inReadingOrder(result); const byId = new Map(fresh.map(entry => [`${entry.turnId}:${entry.item.id}`, entry]));
          const merged = prev.map(entry => byId.get(`${entry.turnId}:${entry.item.id}`) || entry);
          const previousIds = new Set(prev.map(entry => `${entry.turnId}:${entry.item.id}`));
          merged.push(...fresh.filter(entry => !previousIds.has(`${entry.turnId}:${entry.item.id}`)));
          const preserved = mergeHistoryWithLive(prev, merged, liveKeysAfter(historyRevision));
          return JSON.stringify(preserved) === JSON.stringify(prev) ? prev : preserved;
        });
      } catch { /* Read again in 3 s; the chat stays on screen meanwhile. */ } finally { inFlight = false; }
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selectedLiveError, view, loading, select, liveKeysAfter]);
  // Name the parent and the agent a continued chat came from, even when they are not on the loaded page.
  const relatedIds = [...new Set([selected?.parentThreadId, selected?.forkedFromId, ...(preferences.showAgentRuns && agentRunsOpen ? threads.filter(isAgentRun).map(thread => thread.parentThreadId) : [])])].filter((id): id is string => !!id && !threads.some(thread => thread.id === id) && !related[id]);
  useEffect(() => {
    for (const id of relatedIds) api<{ thread: Thread }>(`/threads/${encodeURIComponent(id)}?limit=1`).then(result => setRelated(prev => ({ ...prev, [id]: result.thread }))).catch(() => {});
  }, [relatedIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownScope = selected?.id ?? newDraftKey.current;
  const shownEntries = useMemo(() => withSubmittedMessages(entries, submissions, shownScope).filter(entry => !isVoiceHandoff(entry.item)), [entries, submissions, shownScope]);
  // Rewinding to the newest prompt would undo nothing he can see, so it has no Rewind (Masih, 29 Oct: "rewind what?").
  const newestPrompt = useMemo(() => shownEntries.findLast(entry => entry.item.type === "userMessage")?.item.id, [shownEntries]);
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
    const id = selected?.id; if (!ready || !connected || !id || activeTurn) return;
    let disposed = false;
    api<{ action?: "undo" | "redo" } | null>(`/threads/${encodeURIComponent(id)}/rewind`, { action: "status" }).then(result => {
      if (!disposed) setRewindActions(prev => ({ ...prev, [id]: result?.action }));
    }).catch(() => {});
    loadVersions(id, () => disposed);
    return () => { disposed = true; };
  }, [ready, connected, selected?.id, activeTurn]);
  // A new chat starts in Settings' default permissions (Full access unless the config names an approval policy) until a
  // mode is chosen, so the button shows that; a config that matches no preset shows Ask.
  const defaultMode = providerSettings?.options?.defaultPermissions;
  const configuredMode: PermissionMode = defaultMode === "ask" || defaultMode === "custom" ? "ask" : defaultMode === "auto" ? "auto" : "full";
  const permissionMode: PermissionMode = selected ? threadModes[selected.id] ?? "ask" : newMode ?? configuredMode;
  const planMode = selected ? nextTurn[selected.id]?.plan ?? threadPlans[selected.id] ?? false : newPlan;
  // The last finished turn's proposed plan, while the chat is still in Plan mode and it is unanswered.
  const lastTurnId = entries.at(-1)?.turnId;
  const proposedPlan = selected && planMode && lastTurnId && lastTurnId !== activeTurn && planAnswered[selected.id] !== lastTurnId && entries.some(entry => entry.turnId === lastTurnId && entry.item.type === "plan") ? lastTurnId : null;
  const outsideChatApprovals = approvals.filter(approval => view !== "chat" || approval.params.threadId !== selected?.id);
  const readOnlyRun = !!selected && (isAgentRun(selected) || selected.desktopAccess?.writable === false);
  const continues = readOnlyRun || selected?.desktopAccess?.mode === "continue";
  const selectedModel = modelSelection({ models, providerSettings, selected, choiceId, model, effort, nextTurn });
  const { newChoice, missingChoiceNotice, needsModelId, pending, turnModel, selectedChoice, turnEfforts, turnEffort, knownModel, fastOn } = selectedModel;
  const commandNoticeScope = JSON.stringify([view, tabs.activeId, selected?.id ?? newDraftKey.current]);
  const commandNoticeOwner = useRef(commandNoticeScope), fastNoticeOwner = useRef<string | null>(null);
  commandNoticeOwner.current = commandNoticeScope;
  useEffect(() => { setSlashNotice(""); }, [commandNoticeScope]);
  const fastSuccess = /^Fast is (on|off)\./.exec(slashNotice);
  const visibleSlashNotice = fastSuccess && (fastNoticeOwner.current !== commandNoticeScope || (fastSuccess[1] === "on") !== fastOn) ? "" : slashNotice;
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const composerNotice = [fileNotice, imageBlocked ? TEXT_ONLY_NOTICE : "", !shellMode ? missingChoiceNotice : ""].filter(Boolean).join("\n");
  const canSendFollowUp = !!selected && !!activeTurn && !continues;
  const sendBlocked = readOnlyRun || (!text.trim() && !attachments.length) || (busy && (!canSendFollowUp || shellMode)) || dictating || attaching || imageBlocked || !ready || !connected || (!shellMode && (!!missingChoiceNotice || needsModelId && !model.trim()));
  const recoveryAttachments = selected ? draftStore.heldAttachments(`recovery-${selected.id}`) ?? [] : [];

  const find = (id?: string | null) => id ? threads.find(thread => thread.id === id) ?? related[id] : undefined;
  const selectedTitle = selected ? title(selected) : "";
  useEffect(() => { if (ready) updateTabs(followChat(tabsRef.current, selected ? { id: selected.id, title: selectedTitle } : null)); }, [ready, selected?.id, selectedTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTabs(renameTabs(tabsRef.current, id => { const thread = find(id); return thread ? title(thread) : undefined; })); }, [threads, related]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back and forward: each place reached (a chat, a new chat, a page) joins the stack.
  const navHistory = useNavHistory(ready, { view, threadId: view === "chat" ? selected?.id ?? null : null });
  // Elpis can replace turns only in chats it lets this app write directly, and not while one is running.
  const replaceable = !!selected && !continues && !activeTurn && selected.status?.type !== "active" && connected && !busy;
  const { turnEntries, replacementOptions, replacementOptionsKey } = useMemo(() => {
    const turnEntries = new Map<string, Entry[]>();
    // Live items may arrive out of order; target the first message the transcript actually shows.
    for (const entry of shownEntries) { const group = turnEntries.get(entry.turnId) ?? []; group.push(entry); turnEntries.set(entry.turnId, group); }
    // Only the oldest turn can be cut by a descending history page.
    const replacementOptions = new Map([...turnEntries].map(([id, group]) => [id, group.some(entry => entry.clientPending && entry.item.type === "userMessage")
      ? { allowed: false as const, reason: "Wait for this turn's messages to be recorded before editing." }
      : replacementEligibility(group, id, { historyComplete: !loading && (itemCursor === null || id !== entries[0]?.turnId) })]));
    return { turnEntries, replacementOptions, replacementOptionsKey: JSON.stringify([...replacementOptions]) };
  }, [shownEntries, entries, loading, itemCursor]);
  const failedTurn = selected ? failedTurns[selected.id] : undefined;
  const failedInput = failedTurn ? replacementOptions.get(failedTurn.turnId) : undefined;
  const recoveredEdit = selected ? savedDraft(`recovery-${selected.id}`) : "";
  // The message box's history keys (lib/prompt-history.ts): ↑/↓ and Ctrl+R through what you sent, Esc Esc to edit the last.
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
  const team = teamRoot ? prioritizeChats(threads.filter(thread => thread.parentThreadId === teamRoot.id), thread => agentState(thread, waitingIds)) : [];
  const workingTeam = team.filter(thread => agentState(thread, waitingIds) === "working");
  const shownTeam = workingAgentsOnly ? workingTeam : team;
  const agentColours = useMemo(() => agentColourSlots(threads), [threads]);
  const agentsPanel = agentsPanelState.open && !(selected && teamRoot && (agentsPanelState.held.has(selected.id) || agentsPanelState.held.has(teamRoot.id)));
  const awaitingTeam = !!(selected && teamRoot && agentsPanel && !panelShown && ready && connected &&
    ((!checkedChildren.current.has(teamRoot.id) && !team.length) || (loading && !find(selected.id))));
  const openAgentsPanel = () => setAgentsPanelState(previous => {
    const held = new Set(previous.held);
    if (selected) held.delete(selected.id);
    if (teamRoot) held.delete(teamRoot.id);
    return { open: true, held };
  });
  const folder = (path?: string | null) => path ? path.split("/").filter(Boolean).at(-1) || path : "";

  const { openNewChat, newChat, showTab, newChatTab, closeChatTab, cycleTabs, goHistory, openInNewTab, keepWorkflowTab } = createChatNavigation({ projectState, composer, conversations, history, drafts: draftStore, attachments: attachmentState, tabsRef, updateTabs, selectedRef, newDraftKey, request, stickToBottom, followingBottom, restoreScroll, setEntries, setError, setLoading, setView, setSidebar, find, openThread, loadThread, showChat, browser, navHistory, show: next => show(next) });
  const clearChat = async () => {
    const previous = selectedRef.current;
    if (previous && loveActivity.isLoveChat(previous) && agentName(previous) === "Matilda") {
      if (activeTurns[previous.id]) { setError("Love Spot is already replying. Wait for this turn."); return; }
      const originalRequest = request.current;
      const settings = { ...previous, ...settingsOf.current[previous.id] };
      try {
        const result = await api<{ thread: Thread; permissions?: PermissionMode | null }>("/love-spot/talk/new", {
          threadId: previous.id,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.modelProvider ? { provider: settings.modelProvider } : {}),
          ...(previous.cwd ? { cwd: previous.cwd } : {}),
          permissions: threadModes[previous.id] ?? permissionMode,
          persona: savedPersona(),
        });
        if (!result.thread || typeof result.thread.id !== "string") throw new Error("Matilda could not start a fresh chat.");
        upsertThread(result.thread);
        noteStartedMode(result.thread.id, result.permissions ?? threadModes[previous.id] ?? permissionMode);
        setProjectId(projectChatsRef.current[previous.id] ?? projectId);
        setCwd(result.thread.cwd ?? previous.cwd ?? cwd);
        if (request.current === originalRequest) {
          await loadThread(result.thread);
          requestAnimationFrame(() => composerRef.current?.focus());
        }
      } catch (cause) { setError(errorText(cause)); }
      return;
    }
    if (previous) { setCwd(previous.cwd || cwd); setProjectId(projectChatsRef.current[previous.id] ?? projectId); }
    openNewChat(`clear-${crypto.randomUUID()}`);
  };
  const split = useSessionSplit({ thread: selected, text, attachments }, () => composerRef.current?.focus(), remaining => {
    const restore = () => { editDraft(remaining.text); setAttachments(remaining.attachments); saveAttachments(remaining.thread?.id || newDraftKey.current, remaining.attachments); };
    if (remaining.thread) void loadThread(remaining.thread).then(restore); else { newChat(); restore(); }
  });
  // A disconnected chat must remain editable even if the team could not be read.
  useLayoutEffect(() => {
    if (view !== "chat" || !selected || (ready && connected) || panelShown || split.thread ||
        (!desktop && window.elpisDesktop) || document.querySelector(".startup-splash:not(.leaving)") ||
        !window.matchMedia("(min-width: 1101px)").matches) return;
    holdAgentPanel(selected);
  }, [view, selected, ready, connected, desktop, panelShown, split.thread, holdAgentPanel]);
  const openSplit = (thread: Thread) => { side.closePanel(); setAgentsPanelState(previous => ({ ...previous, open: false })); setView("chat"); split.open(thread); };
  const openSessionWindow = (thread?: Thread) => { void sessionWindowApi()?.(thread?.id).catch(cause => setError(String(cause))); };

  const { assignProject, selectProject, saveProject, newProjectFrom, saveProjectFromChats, workIn, addProject, moveChat, moveChatToFolder, removeProject } = createProjectActions({ projectState, conversations, runtime, chatGroupsRef, commitGroups, placementReveal, revealPlacement, setMarked, viewRef, selected, openNewChat, setError, getNativeParents: () => nativeParents });
  const show = (next: View) => { if (next !== "chat") side.toggleFull(false); if (next === "settings") { setSettingsVisited(true); setSettingsNavigation(value => value + 1); } setView(next); setSidebar(false); };
  // A click on the screenshot thumbnail puts the screenshots on the Love Spot page already open, below what is there, in the
  // order they were taken, then shows them (A239; Masih, 5 Nov: "when I want to post a screenshot, it shouldn't open a new page").
  useScreenshotPopup(ready, ids => {
    void (async () => {
      for (const id of ids) await api("/love-spot/screenshots", { id, action: "place" });
      show("loveSpot");
    })().catch(cause => setError(errorText(cause, "The screenshots could not open in Love Spot.")));
  });
  const manageConnections = () => { setSettingsSection("providers"); show("settings"); };
  const { forkFrom, continueHere, stop, deleteThread, renameThread, archiveThread, unarchived } = createConversationActions({ conversations, runtime, selectedRef, request, setBusy, setError, loadThread, loadChildren, restoreComposerFocus: origin => restoreComposerFocus(origin), removeThreads, noteKept });
  const conversationSettings = createConversationSettings({ selected, selectedRef, request, runtime, conversations, ready, connected, busy, projectChanging, changingPermissions, planMode, permissionMode, threadPlans, setThreadModes, setThreadPlans, setPlanAnswered, setNextTurn, setNewPlan, setNewMode, setChangingPermissions, setError, focusComposer: () => focusComposer(), restoreComposerFocus: origin => restoreComposerFocus(origin) });
  const { rememberModes, setPlan, answerPlan, cycleMode, noteStartedMode, saveEffort } = conversationSettings;
  /** Sends the composer's message, or `own`: a command's message (such as /init's prompt), sent without the composer's files.
   * While a turn runs, `followUp` steers or queues this one message instead of following Settings (Ctrl+Enter). */
  const send = createChatSend({ projectState, composer, conversations, runtime, attachments: attachmentState, drafts: draftStore, sendShell: () => sendShell(), askSideQuestion: question => askSideQuestion(question), restoreComposerFocus: origin => restoreComposerFocus(origin), readOnlyRun, selected, editDraft, busy, canSendFollowUp, imageBlocked, missingChoiceNotice, needsModelId, model, setError, sending, setBusy, newDraftKey, request, tabsRef, activeTurn, continues, preferences, stickToBottom, setSubmissions, entries, newMode, newChoice, newWorktree, noteStartedMode, browser, setThreads, assignProject, pending, effort, newPlan, selectedRef, loadThread, setThreadPlans, setNewPlan, setNextTurn });
  async function sendShell() {
    const command = textRef.current, originalRequest = request.current;
    if (!command.trim() || busy || !ready || !connected || projectChanging) return;
    if (attachmentsRef.current.length) { setFileNotice("Bash mode is on. Return to chat to send attachments."); return; }
    setBusy(true); setError("");
    let thread = selectedRef.current;
    const originalId = thread?.id || newDraftKey.current, browserDraft = `draft:${tabsRef.current.activeId}`;
    try {
      if (!thread) {
        const result = await api<{ thread: Thread; permissions?: PermissionMode | null }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}) });
        thread = result.thread; upsertThread(thread); noteStartedMode(thread.id, result.permissions ?? newMode);
        if (projectId) await assignProject(thread.id, projectId);
        await browser.adoptSession(browserDraft, thread.id);
        if (request.current === originalRequest) { saveDraft(originalId, ""); saveDraft(thread.id, command); shellCreated.current = thread.id; select(thread); }
      }
      await api(`/threads/${encodeURIComponent(thread.id)}/shell`, { command });
      if (savedDraft(thread.id) === command) saveDraft(thread.id, "");
      if (selectedRef.current?.id === thread.id && textRef.current === command && request.current === originalRequest) setText("");
    } catch (e) { if (request.current === originalRequest) setError(errorText(e)); }
    finally { setBusy(false); if (request.current === originalRequest) focusComposer(); }
  }
  const { replaceFrom, rewindFrom, deleteFrom, switchRewind, loadVersions, showVersion } = createMessageActions({ composer, conversations, drafts: draftStore, history, runtime, selectedRef, request, stickToBottom, rewindSwitch, replacementOptions, entries, nextTurn, submitDraft, setRuntimeNotices, setMessageEdits, setNextTurn, setEntries, setThreads, setRewindBusy, setRewindActions, setMessageVersions, loadThread, editDraft, focusComposer: () => focusComposer(), restoreComposerFocus: origin => restoreComposerFocus(origin) });
  /** Answers a request; `instead` is "Deny, and tell Elpis what to do instead" (body: { text }). */
  /** An approval card's answers, sending and drafts: the same wherever the card is shown. */
  const approvalCardProps = (approval: Approval) => {
    const key = approvalDraftKey(approval);
    return { approval, answer: (id: string, body: unknown) => answer(id, body, key), deny: (id: string, text: string) => answer(id, { text }, key, true),
      busy: !!pendingDrafts[key], answers: answersFor(approval), onAnswerChange: (id: string, value: string[]) => draftAnswer(approval, id, value) };
  };
  async function answer(id: string, body: unknown, key: string, instead = false) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    await submitDraft(key, () => api(`/approvals/${encodeURIComponent(id)}${instead ? "/instead" : ""}`, body));
    setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id);
    if (request.current === originalRequest) restoreComposerFocus(originalFocus);
  }
  const { earlierHeld, older } = createEarlierMessages({ history, selected, selectedRef, request, setLoading, setError, setEntries, stickToBottom, scroll, restoreScroll });
  const openById = (id: string) => openThread(threads.find(thread => thread.id === id) || related[id] || { id });
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
  const focusComposer = () => composerRef.current?.focus();
  const { beginReply, beginImageReply, editQueued } = createReplyActions({ composer, attachmentsState: attachmentState, drafts: draftStore, runtime, selectedRef, newDraftKey, readOnlyRun, focusComposer, editDraft });
  // The transcript is redrawn only when what it shows changes, not on every keystroke in the message box; its
  // handlers call the current render's functions through a ref, so a reused row never calls a stale one.
  const live = useRef({ openById, focusComposer, replaceFrom, forkFrom, showVersion, setRewindTurn, deleteFrom, setMessageEdits, setError, beginReply, beginImageReply });
  live.current = { openById, focusComposer, replaceFrom, forkFrom, showVersion, setRewindTurn, deleteFrom, setMessageEdits, setError, beginReply, beginImageReply };
  const versionsShown = selected ? messageVersions[selected.id] : undefined;
  const chatConversation = useConversationTranscript({ live, selected, shownEntries, activeTurn, desktop, openChanges: side.openChanges, threads, messageEdits, pendingDrafts, replaceable, replacementOptions, replacementOptionsKey, readOnlyRun, versionsShown, newestPrompt, regenerate, connected, voiceBusy, loveSpotAudioReason });
  /** Puts an earlier message (or the draft) in the box with the caret at its start or end, as the history keys do. */
  function writePrompt(value: string, caret: "start" | "end") {
    flushSync(() => editDraft(value));
    const at = caret === "end" ? value.length : 0;
    composerRef.current?.setSelectionRange(at, at);
  }
  /** Esc Esc in an empty box opens the newest message you sent for editing, as in Claude; one that cannot be replaced says why. */
  function editLastMessage() {
    if (!replaceable || !selected) return;
    const last = entries.filter(entry => entry.item.type === "userMessage").at(-1); if (!last) return;
    const option = replacementOptions.get(last.turnId);
    if (!option?.allowed) { if (option) setSlashNotice(option.reason); return; }
    setMessageEdits(previous => ({ ...previous, [JSON.stringify([selected.id, last.turnId, option.messageId])]: option.prompt }));
  }
  /** The "+" menu's Add files or photos: the one chooser, for pictures and documents alike. */
  const pickFiles = () => filePickerRef.current?.click();
  /** The "+" menu's Mention: an "@" at the caret (after a space when words come before it), which opens the picker. */
  function startMention() {
    const box = composerRef.current, at = box?.selectionStart ?? textRef.current.length, before = textRef.current.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "", next = before + glue + "@" + textRef.current.slice(at), position = before.length + glue.length + 1;
    editDraft(next); setCaret(position); box?.focus(); requestAnimationFrame(() => box?.setSelectionRange(position, position));
  }
  /** The "+" menu's Slash commands: a "/" in an empty box, which opens the command list. */
  function startSlash() { editDraft("/"); setCaret(1); focusComposer(); }
  function askSideQuestion(question?: string) {
    if (readOnlyRun) return;
    if (!selected) { setError("Start a conversation before asking a side question."); return; }
    setSideChat({ parentId: selected.id, open: true, question: { id: ++sideRequests.current, text: question ?? "" } });
  }
  function recapConversation() {
    if (!selected || readOnlyRun) return;
    if (!entries.length) { setError("There is no conversation history to recap."); return; }
    setSideChat({ parentId: selected.id, open: true, question: { id: ++sideRequests.current, kind: "recap", text: "Recap the conversation so far for the person returning to it. Briefly state the goal, key decisions, completed work, what is still open, and the next useful step. Use only the existing conversation. Do not use tools or perform the work." } });
  }
  // Returning from a disappearing action must not override a field the person chose while it was pending.
  const restoreComposerFocus = (origin: Element | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === origin) focusComposer();
  });
  const focusSearch = () => { if (view === "settings") show("chat"); setSidebar(true); setSidebarCollapsed(false); requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); }); };
  /** A composer control opened for a command takes the focus; the composer gets it back when the control closes. */
  const openComposerControl = (label: string) => { const trigger = composerRef.current?.form?.querySelector<HTMLElement>(`[aria-label="${label}"]`); if (trigger) openControl(trigger, () => composerRef.current); };
  const closePanel = () => { setPanel(null); focusComposer(); };
  const lastTurn = entries.at(-1)?.turnId;
  const idle = !busy && !activeTurn && selected?.status?.type !== "active";
  const writable = !!selected && !continues;
  const chatFolder = selected ? selected.cwd : newChatFolder(cwd);
  // The profile opens as source: /personal is for editing it.
  const personal = usePersonal(ready && !selected, path => { const at = selected?.cwd || cwd; openFile(at, path); setFileView(at, path, "source"); side.openFiles(); }, setError);
  const conversationCommands = createCommandActions({ selected, selectedRef, textRef, turnEfforts, turnEffort, turnModel, models, providerSettings, newChoice, commandNoticeOwner, fastNoticeOwner, side, runtime, conversations, ready, connected, desktop, setSlashNotice, setEffort, setPanel, setError, setBusy, openComposerControl, saveEffort, focusComposer, editDraft });
  const { chooseEffort, stepEffort, startReview, compactChat, exportChat, turnSmartPruneOn, chooseFast, chooseGoal } = conversationCommands;
  useEffect(() => {
    if (!queuedCompact) return;
    if (selected?.id !== queuedCompact.threadId) { setQueuedCompact(null); return; }
    if (!idle) return;
    setQueuedCompact(null); setSlashNotice(""); compactChat(selected, queuedCompact.guidance);
  }, [queuedCompact, selected, idle]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessionRows: [string, string][] = [
    ["Model", modelLabel(turnModel || providerSettings?.main.model, models)],
    ["Provider", providerLabel(turnModel || providerSettings?.main.model, selected ? selected.modelProvider : newChoice?.provider ?? providerSettings?.main.provider, providerSettings?.providers)],
    ["Reasoning effort", turnEffort || "Default"],
    ["Permissions", permissionLabel(permissionMode)],
    ["Folder", chatFolder || "Default folder"],
    ["Chat", selected?.id ?? "Not started yet"],
  ];
  const slashCommands = createSlashCommands({ selected, askSideQuestion, readOnlyRun, recapConversation, chooseGoal, busy, openComposerControl, chooseFast, turnEfforts, chooseEffort, openSettings, personal, writable, idle, startReview, setPanel, renameThread, setError, setRenameRequest, newChat, clearChat, archiveChats: chats => archiveChats(chats), deleteChats: (ids, focusAt) => deleteChats(ids, focusAt), setResumeOpen, lastTurn, activeTurn, forkFrom, continues, send, compactChat, setQueuedCompact, setSlashNotice, turnSmartPruneOn, planMode, setPlan, team, panelShown, openAgentsPanel, entries, exportChat, chatFolder });
  const slash = useSlashMenu(ready && connected ? text : "", slashCommands, () => { editDraft(""); setPanel(null); setSlashNotice(""); });
  const mention = useMentionMenu({ text, caret, cwd: chatFolder || undefined, threads, currentId: selected?.id,
    onPick: result => { pickedMentions.current.set(result.mention.path, result.mention); flushSync(() => editDraft(result.text)); setCaret(result.caret); composerRef.current?.setSelectionRange(result.caret, result.caret); } });
  // A panel belongs to the chat and page it was opened on; a notice goes when the person types again.
  useEffect(() => { setPanel(null); }, [selected?.id, view]);
  useEffect(() => { if (shellCreated.current !== selected?.id || view !== "chat") setShellMode(false); shellCreated.current = null; setSideChat(null); }, [selected?.id, view]);
  useEffect(() => { if (text) setSlashNotice(""); }, [text]);

  const sidebarModel = useSidebarThreads({ ready, connected, threads, hidden, selected, chatGroups, loveActivity, expanded, setExpanded, recordedWorkflow, loadChildren, search, attention, waitingIds, pins, projectChats, releaseChatOrder, searchInput, setError, setDeleteRunHistory, setDeleteTargets, hiddenPages, preferences, collapsedSections, collapsedProjects, checkedChildren, agentRunsOpen });
  const { workflowCatalog, workflowRoots, workflowSteps, sidebarTitle, selectedWorkflow, sidebarThreads, nativeParents, treeParents, sidebarParent, originOf, searchedThreads, sidebarState, needsYou, ordinaryThreads, ordinaryIds, pinnedChats, grouped, recentChats, ordered } = sidebarModel;
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
    else if (id === "archive") archiveChats(chosenChats());
    else if (id === "pin" && selected) togglePin(selected);
    else if ((id === "chat-to-top" || id === "chat-to-bottom") && selected) moveToEdge(selected.id, id === "chat-to-top");
    else if (id === "copy-folder" && (selected?.cwd || cwd)) void navigator.clipboard.writeText(selected?.cwd || cwd);
    else if (id === "new-tab" && desktop) { newChatTab(); }
    else if (id === "close-tab" && desktop && view === "chat") closeChatTab(tabs.activeId);
    else if ((id === "next-tab" || id === "previous-tab") && desktop && view === "chat") cycleTabs(id === "next-tab" ? 1 : -1);
    else if (id === "full-view" && desktop) { if (view !== "chat") show("chat"); side.toggleFull(view === "chat" ? undefined : true); }
    else if (id === "terminal" && hasTerminal) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleTerminal(selected?.cwd || cwd, !away)) focusComposer(); }
    else if (id === "files" && desktop) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleFiles(!away)) focusComposer(); }
  };
  const togglePin = (thread: Thread) => togglePinned(thread.id);
  const toggleBookmark = (thread: Thread) => toggleBookmarked(thread.id);
  /** A narrow window slides the sidebar over the page; a wide one collapses it (the sidebar button and Ctrl+B), as in ChatGPT and Claude. */
  function narrow() { return matchMedia("(max-width: 760px)").matches || (panelShown && panelDrawer); }
  function showSidebar(open: boolean) { if (!narrow()) { setSidebarCollapsed(!open); return; } setSidebar(open); if (open) setSidebarCollapsed(false); }
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [...threadList.current?.querySelectorAll<HTMLButtonElement>(".thread-row > .thread-link") ?? []];
  const rowOf = (element: Element | null) => element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** Opens the shared delete confirmation for these chats. */
  const chatsOf = (ids: string[]) => ids.map(id => searchedThreads.find(thread => thread.id === id) ?? find(id)).filter((thread): thread is Thread => !!thread);
  /** What Ctrl+Shift+A and the command menu act on: the chats selected in the sidebar, or else the open chat. */
  const chosenChats = () => marked.length ? chatsOf(marked) : selected ? [selected] : [];
  /** These chats and the chats put under them (Put under…): those go wherever their chat goes. */
  const withNested = (ids: string[]) => chatSubtree(ids, treeParents);
  const { archiveChats, deleteChats, trashChats, undoDelete } = createChatDeletion({ conversations, preferences, selectedRef, shownWhenDeleted, withNested, chatsOf, find, archiveThread, rowLinks, setDeleteRunHistory, setDeleteTargets, setDeletedNotice, setError, noteKept, removeThreads, loadThread });
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(thread: Thread, event: React.MouseEvent<HTMLButtonElement>) {
    if (event.altKey) { event.preventDefault(); openSplit(thread); return; }
    const ids = [...new Set(rowLinks().map(rowOf).filter((id): id is string => !!id))];
    if (event.ctrlKey || event.metaKey) {
      const base = marked.length ? marked : selected && ids.includes(selected.id) ? [selected.id] : [];
      setMarked(base.includes(thread.id) ? base.filter(id => id !== thread.id) : [...base, thread.id]); markAnchor.current = thread.id;
    } else if (event.shiftKey) {
      const to = ids.indexOf(thread.id), at = ids.indexOf(markAnchor.current ?? selected?.id ?? thread.id), from = at < 0 ? to : at;
      setMarked(ids.slice(Math.min(from, to), Math.max(from, to) + 1)); event.currentTarget.focus();
    } else { setMarked([]); markAnchor.current = thread.id; void openThread(thread); }
  }
  const sidebarKeys = useSidebarKeys();
  const listKeys = (event: React.KeyboardEvent<HTMLDivElement>) => sidebarListKeys(event, marked, () => setMarked([]), attentionFor, deleteChats, rowLinks);
  function attentionFor(id: string) {
    return { unread: attention.unread.includes(id), planReady: !!attention.plans[id],
      onToggleRead: () => setAttention(previous => ({ ...previous, unread: previous.unread.includes(id) ? previous.unread.filter(value => value !== id) : [...previous.unread, id] })),
      onComplete: () => {
        setPlanAnswered(previous => ({ ...previous, [id]: attention.plans[id] }));
        setAttention(previous => ({ unread: previous.unread.filter(value => value !== id), plans: without(previous.plans, id) }));
      },
    };
  }
  /** "Move to group" for these chats (the row's chat, or the selection it belongs to), as Claude's session menu has it.
   * Only top-level chats are grouped; an agent's chat stays under its parent. */
  function groupMenu(thread: Thread, ids: string[]) {
    if (sidebarParent(thread)) return undefined;
    const known = (id: string) => chatGroups.groups.some(group => group.id === chatGroups.members[id]) ? chatGroups.members[id] : null;
    const currents = new Set(ids.map(known));
    return { groups: chatGroups.groups, current: currents.size === 1 ? [...currents][0] : undefined,
      onMove: (groupId: string | null) => { updateGroups(state => moveChats(state, ids, groupId)); setMarked([]); },
      onNew: () => setNewGroupFor(ids) };
  }
  const movingIds = (id: string) => chatSelectionRoots(marked.includes(id) ? marked : [id], treeParents);
  function canNest(ids: string[], parent: string) {
    return ordinaryIds.has(parent) && ids.length > 0 && ids.every(id => ordinaryIds.has(id)) && !chatSubtree(ids, treeParents).includes(parent);
  }
  function placementReveal(target: string, state: ChatGroups, memberships: Record<string, string>, moved: string[]) {
    const parents = sidebarParents(Object.keys(nativeParents), state, nativeParents), opened: Record<string, boolean> = {};
    let root = target;
    for (let child of moved.length ? moved : [undefined]) {
      const seen = new Set<string>();
      for (let id: string | undefined = target; id && !seen.has(id); id = parents[id]) {
        seen.add(id); root = id;
        const owner = child ? workflowSteps.get(child) : undefined;
        const runId = owner?.parent === id ? owner.runId : workflowRoots.get(id)?.id;
        if (moved.length) opened[runId ? `workflow:${runId}` : id] = true;
        child = id;
      }
    }
    const thread = sidebarThreads.find(thread => thread.id === root), project = pins.includes(root) ? undefined : memberships[root];
    const orphan = thread && !Object.hasOwn(state.parents ?? {}, root) && agentParentId(thread) && !ordinaryIds.has(agentParentId(thread)!);
    const group = !pins.includes(root) && !project && !orphan && state.groupBy === "custom" ? state.groups.find(group => group.id === state.members[root])?.id : undefined;
    const origin = thread && originOf(thread);
    const section = pins.includes(root) ? "pinned" : project ? "projects" : orphan ? "unlinked" : group ? "groups" : origin === "Workflows" ? "workflows" : origin === "Love Spot" ? "love" : "recents";
    return { opened, section, project, group };
  }
  function revealPlacement(paths: ReturnType<typeof placementReveal>[]) {
    const opened = Object.fromEntries(paths.flatMap(path => Object.entries(path.opened)));
    if (Object.keys(opened).length) setExpanded(previous => ({ ...previous, ...opened }));
    if (paths.some(({ section, project }) => foldsRef.current.sections[section] || project && foldsRef.current.projects[project])) changeFolds(previous => {
      const next = { sections: { ...previous.sections }, projects: { ...previous.projects } };
      for (const { section, project } of paths) { next.sections[section] = false; if (project) next.projects[project] = false; }
      return next;
    });
  }
  async function nestChats(ids: string[], parent: string) {
    await assignProject(ids, projectChatsRef.current[parent] ?? null, parent);
    if (!checkedChildren.current.has(parent)) void loadChildren(parent, undefined, false);
  }
  function organizationActions(thread: Thread) {
    if (!ordinaryIds.has(thread.id)) return {};
    return { onMoveToProject: setProjectMove, onNewProject: newProjectFrom, onPutUnder: setNestTargets,
      ...(movingIds(thread.id).some(id => treeParents[id]) ? { onTakeOut: (chats: Thread[]) => {
        void assignProject(chats.map(chat => chat.id), undefined).catch(cause => setError(String(cause)));
      } } : {}) };
  }
  async function renameDisplayedThread(thread: Thread, name: string, runId = workflowRoots.get(thread.id)?.id) {
    if (!runId) { await renameThread(thread, name); return; }
    const problem = workflowCatalog.rename(runId, name);
    if (problem) throw Error(problem);
  }
  const { chatReorder, moveToEdge } = useChatReorder({ projectState, chatGroups, updateGroups, treeParents, pins, ordinaryThreads, ordinaryIds, pinnedChats, recentChats, grouped, movingIds, canNest, assignProject, nestChats, searchTerm, needsYou, sidebarState, setError });
  const threadRow = createSidebarThreadRow({ model: sidebarModel, runtime, loveActivity, attention, threads, selected, view, waitingIds, pins, bookmarks, marked, childCursors, searchTerm, agentColours, preferences, agentRunsOpen, setAgentRunsOpen, setExpanded, checkedChildren, setError, loadChildren, chatReorder, desktop, hasTerminal, pane: split.pane, windowAvailable, find, deleteChats, renameDisplayedThread, archiveChats, togglePin, toggleBookmark, openInTui, openSplit, openSessionWindow, organizationActions, attentionFor, chatsOf, groupMenu, movingIds, markRead, prefetchThread, openInNewTab, clickRow });
  /** A chat's menu around its tab or title: the "…" button and right-click on `area` share one list. The shown chat's is "Chat actions". */
  const threadMenu = (thread: Thread, area: React.ReactElement, content: (menu: React.ReactNode) => React.ReactNode, shown: boolean) =>
    <ThreadActions label={shown ? "Chat actions" : undefined} thread={{ ...thread, name: sidebarTitle(thread) }} attention={attentionFor(thread.id)} group={groupMenu(thread, movingIds(thread.id))} selection={marked.includes(thread.id) ? chatsOf(marked) : undefined} onRequestDelete={() => deleteChats(movingIds(thread.id))} onRename={renameDisplayedThread} renameDescription={workflowRoots.has(thread.id) ? "The workflow name is saved on this device." : undefined} onArchive={archiveChats} pinned={pins.includes(thread.id)} onPin={togglePin} bookmarked={bookmarks.includes(thread.id)} onBookmark={toggleBookmark} onOpenInTui={hasTerminal ? openInTui : undefined} onOpenSplit={!split.pane ? openSplit : undefined} onOpenWindow={windowAvailable ? openSessionWindow : undefined} renameRequested={shown && renameRequest} onRenameRequestHandled={() => setRenameRequest(false)} {...organizationActions(thread)} area={area}>{content}</ThreadActions>;
  const chatActions = (area: React.ReactElement, content: React.ReactNode) => view === "chat" && selected
    ? threadMenu(selected, area, menu => <>{content}{menu}</>, true)
    : cloneElement(area, undefined, content);
  /** One chat tab: its title and close button, the "…" on the shown one, and the chat's menu on right-click. */
  function chatTab(tab: ChatTab) {
    const shown = tab.id === tabs.activeId, thread = tab.threadId ? (shown && selected?.id === tab.threadId ? selected : find(tab.threadId)) : undefined;
    const label = thread ? sidebarTitle(thread) : tab.threadId ? tab.title || "Chat" : "New chat";
    const identity = thread ? workflowCatalog.identities[workflowSteps.get(thread.id)?.runId ?? workflowRoots.get(thread.id)?.id ?? ""] : undefined;
    return <Tab key={tab.id} chat icon={identity ? <WorkflowMark identity={identity} neutral /> : <ChatIcon size={14} />} label={label} active={shown} closeLabel={`Close ${label} tab`} trailing={shown}
      wrap={thread ? (area, content) => threadMenu(thread, area, content, shown) : undefined} onSelect={() => showTab(tab)} onClose={() => closeChatTab(tab.id)} />;
  }
  const { descendants, threadBranch, runDescendants, chatRows, chatGroupSection } = createSidebarBranches({ model: sidebarModel, threadRow, chatReorder, chatGroups, updateGroups, hidden, expanded, childCursors, loadingChildren, searchTerm, loadChildren, find });
  const heading = view === "chat" ? (selected ? title(selected) : "") : PAGE_NAMES[view];
  const chatName = selected ? title(selected) : "New chat";
  const chatState = selected ? agentState(selected, waitingIds) : "idle", floatState = activeTurn && chatState === "idle" ? "working" : chatState;
  const meta = selected ? [agentName(selected), selected.agentRole && selected.agentRole !== "default" ? selected.agentRole : null].filter(Boolean).join(" · ") : "";
  const shortcuts = configuredShortcuts(preferences);
  const commandActions: CommandAction[] = ["new-chat", "search", "settings", "shortcuts", "sidebar", ...(desktop ? ["files", "full-view"] : []), ...(hasTerminal ? ["terminal"] : []), ...(selected ? ["rename", "pin"] : []), ...(selected || marked.length ? ["archive"] : [])].filter(id => id !== "new-chat" || !projectChanging).map(id => {
    const shortcut = shortcuts.find(item => item.id === id)!;
    return { id, name: id === "pin" ? `${pins.includes(selected!.id) ? "Unpin" : "Pin"} chat` : id === "archive" && marked.length > 1 ? `Archive ${marked.length} chats` : id === "shortcuts" ? "Keyboard shortcuts" : shortcut.label, keys: shortcut.keys, run: () => { if (id === "shortcuts") { shortcutsReturnFocus.current = commandReturnFocus.current; setShortcutsOpen(true); } else shortcutAction.current(id); } };
  });
  commandActions.push({ id: "improve-elpis", name: "Improve Elpis…", run: () => window.dispatchEvent(new CustomEvent("elpis:improve")) });
  // The sidebar's pages in the person's order (drag and drop, or Alt+Up/Down), saved with the preferences.
  const arrangedPages = arrange(NAV_PAGES.filter(page => !hiddenPages.includes(page.id)), preferences.navOrder.split(",").filter(Boolean));
  const reorderPages = (ids: string[]) => { try { savePreferences({ navOrder: ids.join(",") }); } catch (cause) { setError(errorText(cause)); } };
  const pageReorder = useReorder({ dragType: "text/x-elpis-page", order: () => arrangedPages.map(page => page.id),
    canDrop: (id, target) => arrangedPages.some(page => page.id === id) && arrangedPages.some(page => page.id === target),
    onMove: (id, place) => reorderPages(move(arrangedPages.map(page => page.id), id, place)) });
  const projectReorder = useReorder({ dragType: "text/x-elpis-project", order: () => projects.map(project => project.id),
    canDrop: (id, target) => projects.some(project => project.id === id) && projects.some(project => project.id === target),
    onMove: (id, place) => {
      const next = arrange(projects, move(projects.map(project => project.id), id, place));
      return saveProjects(next, projectId).then(() => setProjects(next)).catch(cause => setError(String(cause)));
    } });
  for (const target of ["agentsGuide", ...NAV_PAGES.map(page => page.id)] as const) { const name = PAGE_NAMES[target]; if (!hiddenPages.includes(target) && !(target === "agentsGuide" && hiddenPages.includes("canvas"))) commandActions.push({ id: target, name, run: () => show(target) }); }

  // One Matilda voice and one live call for the whole app: both go on when he leaves the board or Love Spot's chat; her face shows and controls them.
  // The message box: its hint, what typing, pasting and keys do.
  const composerPlaceholder = shellMode ? "Run a shell command…" : continues ? `Message ${title(selected!)}…` : selected && activeTurn ? followUpHint(preferences) : selected ? "Ask for a follow-up" : "Ask Elpis to build, fix or explain something";
  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // "!" at the start of an empty box switches to Bash mode, as in the TUI.
    if (!shellMode && !textRef.current && value.startsWith("!") && !attachmentsRef.current.length) { setShellMode(true); promptKeys.cancel(); editDraft(value.slice(1)); setCaret(value.length - 1); }
    else { editDraft(value); setCaret(e.target.selectionStart); }
  };
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => { const files = transferFiles(e.clipboardData); if (files.length) { if (!e.clipboardData.getData("text/plain")) e.preventDefault(); void addFiles(files); } };
  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    // Esc, or Backspace in an empty box, leaves Bash mode.
    if (shellMode && (e.key === "Escape" || (e.key === "Backspace" && !textRef.current))) { e.preventDefault(); e.stopPropagation(); setShellMode(false); promptKeys.cancel(); return; }
    if (!ready || !connected) { if (isSendKey(e, preferences)) e.preventDefault(); return; }
    if (shellMode) { if (isSendKey(e, preferences)) { e.preventDefault(); void sendShell(); } return; }
    // Shift+↑/↓ steps the reasoning effort.
    if (e.shiftKey && plain && turnEfforts.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); stepEffort(e.key === "ArrowUp" ? 1 : -1); return; }
    if (mention.onKeyDown(e) || slash.onKeyDown(e) || promptKeys.onKeyDown(e)) return;
    // Shift+Tab cycles the permission mode.
    if (e.key === "Tab" && e.shiftKey && plain) { e.preventDefault(); cycleMode(); return; }
    if (activeTurn && !continues) { const followUp = followUpKey(e, preferences); if (followUp) { e.preventDefault(); send(undefined, followUp); } }
    else if (isSendKey(e, preferences)) { e.preventDefault(); send(); }
  };
  return <DocumentReviewProvider onAttach={parts => attachFromBrowser(parts, false)}><LiveVoiceProvider><ReadAloud threadId="love-spot" enabled available={LOVE_SPOT_AUDIO.readAloudAvailable} unavailableReason={LOVE_SPOT_AUDIO.available ? undefined : LOVE_SPOT_AUDIO.reason}><div data-workspace={view} data-desktop={desktop || undefined} className={`app-shell${split.pane ? " session-pane" : ""}${split.thread && view === "chat" ? " session-split" : ""}${dark ? " dark" : ""} has-title-bar${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${panelShown ? " panel-active" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <title>{view === "canvas" ? "Workflows · Elpis" : view === "experimentLab" ? "Lab · Elpis" : view === "customize" ? "Customize — Elpis" : "Elpis"}</title>
    {desktop && <div className="title-bar"><NavButtons preferences={preferences} canBack={navHistory.canBack} canForward={navHistory.canForward} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} />{(sidebarCollapsed || !sidebar) && <Button className={sidebarCollapsed || panelShown && panelDrawer ? undefined : "sidebar-open-narrow"} variant="ghost" size="icon-sm" aria-label="Open sidebar" title={shortcutTitle("Open sidebar", "sidebar", preferences)} onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>}<AppMenus preferences={preferences} onError={setError} onNewChat={newChat} onOpenFolder={() => void addProject()} onSettings={() => show("settings")} onToggleSidebar={() => showSidebar(narrow() ? !sidebar : sidebarCollapsed)} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} canGoBack={navHistory.canBack} canGoForward={navHistory.canForward} onShortcuts={() => shortcutAction.current("shortcuts")} /><div className="title-bar-actions"><MatildaCompanion /><AppUpdate inTitleBar /></div></div>}
    {!desktop && <div className="title-bar"><div className="title-bar-actions"><MatildaCompanion /></div></div>}
    <ProfileDialog ready={ready && connected} />
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} returnFocus={shortcutsReturnFocus} />
    {commandMenuOpen && <CommandMenu threads={ordinaryThreads} projects={busy || projectChanging ? [] : projects} actions={commandActions} returnFocus={commandReturnFocus} onClose={() => setCommandMenuOpen(false)} onThread={thread => { void openThread(thread); }} onProject={item => { void selectProject(item).catch(cause => setError(errorText(cause))); }} onNewChat={prompt => { newChat(); setDesktopPrompt(prompt); }} />}
    {desktop && <StartupSplash onLeaving={() => {
      if (view === "chat" && selected && (!ready || !connected) && !panelShown && !split.thread && window.matchMedia("(min-width: 1101px)").matches) holdAgentPanel(selected);
    }} />}
    <ProjectDialog projects={projects} editing={projectEdit} folders={projectEdit !== undefined ? [cwd, ...ordinaryThreads.map(thread => thread.cwd ?? "")] : []} description={newProjectFor ? `${newProjectFor.length} chats will move into this project. Their working folders stay as they are.` : undefined} onClose={() => { setProjectEdit(undefined); setNewProjectFor(null); }} onSave={newProjectFor ? saveProjectFromChats : saveProject} />
    <MoveChatDialog name={projectMove ? projectMove.length === 1 ? title(projectMove[0]) : `${projectMove.length} selected chats` : null} count={projectMove?.length} projects={projects} currentId={projectMove ? new Set(projectMove.map(chat => projectChats[chat.id] ?? null)).size === 1 ? projectChats[projectMove[0].id] ?? null : undefined : null} onMove={id => projectMove ? assignProject(projectMove.map(chat => chat.id), id) : Promise.resolve()} onClose={() => setProjectMove(null)} />
    <ResumeConversation open={resumeOpen} chats={sidebarThreads} returnFocus={composerRef} onClose={() => setResumeOpen(false)} onChoose={thread => { setResumeOpen(false); void openThread(thread); }} />
    <PutUnderDialog chats={nestTargets} candidates={nestTargets ? ordinaryThreads.filter(thread => canNest(nestTargets.map(chat => chat.id), thread.id)) : []} onPutUnder={parent => nestChats((nestTargets ?? []).map(chat => chat.id), parent)} onClose={() => setNestTargets(null)} />
    <GroupNameDialog open={!!newGroupFor} state={chatGroups} group={null} switches={chatGroups.groupBy !== "custom"} onClose={() => setNewGroupFor(null)}
      onSave={name => { const ids = newGroupFor ?? [], id = crypto.randomUUID(); updateGroups(state => moveChats(addGroup(state, name, id), ids, id)); setNewGroupFor(null); setMarked([]); }} />
    <DeleteChatsDialog threads={deleteTargets} trash={trashChats} alwaysConfirm={deleteRunHistory} onClose={() => { setDeleteTargets(null); setDeleteRunHistory(false); }} />
    <RewindDialog threadId={selected?.id} turnId={rewindTurn} prompt={rewindTurn ? turnEntries.get(rewindTurn)?.find(entry => entry.item.type === "userMessage")?.item.content?.map(part => part.text ?? "").join("\n") ?? "" : ""} turns={rewindTurn ? Math.max(1, turnEntries.size - [...turnEntries.keys()].indexOf(rewindTurn)) : null} onConfirm={(mode, version) => rewindFrom(rewindTurn!, mode, version)} onClose={() => setRewindTurn(null)} />
    <aside className={`sidebar${sidebar ? " open" : ""}`} aria-label="Workspace navigation" onKeyDown={sidebarKeys}>
      <div className="brand"><Button type="button" variant="ghost" size="logo" className="brand-home" aria-label="Elpis home" onClick={() => show("chat")}><BrandWordmark dark={dark} width={73} height={36} /></Button><Button className="sidebar-toggle" variant="ghost" size="icon-sm" aria-label="Close sidebar" title={shortcutTitle("Close sidebar", "sidebar", preferences)} onClick={() => showSidebar(false)}><PanelLeft size={16} /></Button></div>
      <nav className="nav-list" aria-label="Workspace">
        <Button data-slot="nav-row" className="new-chat" variant="ghost" aria-label="New chat" data-shortcut={shortcutHint("new-chat", preferences)} aria-current={view === "chat" && !selected ? "page" : undefined} disabled={projectChanging} onClick={newChat}><NewChatIcon size={16} />New chat</Button>
        {arrangedPages.map(page => <ReorderItem key={page.id} reorder={pageReorder} itemId={page.id} render={<Button data-slot="nav-row" variant="ghost" data-nav-page={page.id} className={page.id === "loveSpot" ? "accent-scope" : undefined} aria-label={page.name} aria-current={view === page.id ? "page" : undefined} onClick={() => show(page.id)} title={`${page.name} (drag, or Alt+Up/Down, to reorder)`}>
          <page.Icon size={16} />{page.name}{page.id === "loveSpot" && loveActivity.unread > 0 && <span className="love-unread badge badge-sm" role="status" aria-label={`${loveActivity.unread} Love Spot agents replied`}>{loveActivity.unread}</span>}</Button>} />)}
      </nav>
      <SearchField ref={searchInput} hint="Ctrl Shift K" aria-label="Search conversations" placeholder="Search chats" maxLength={200} value={search.search} onChange={e => search.setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); search.setSearch(""); focusComposer(); } }} />
      <SidebarChatList model={sidebarModel} projectState={projectState} search={search} browser={browser} browserPins={browserPins} preferences={preferences} chatGroups={chatGroups} updateGroups={updateGroups} setAttention={setAttention} conversations={conversations} threadList={threadList} listKeys={listKeys} collapsedSections={collapsedSections} collapsedProjects={collapsedProjects} expanded={expanded} pins={pins} setCollapsedProjects={setCollapsedProjects} chatReorder={chatReorder} projectReorder={projectReorder} foldable={foldable} addProject={addProject} removeProject={removeProject} selectProject={selectProject} chatRows={chatRows} chatGroupSection={chatGroupSection} threadRow={threadRow} descendants={descendants} threadBranch={threadBranch} runDescendants={runDescendants} show={show} ready={ready} busy={busy} threads={threads} agentRunsOpen={agentRunsOpen} setAgentRunsOpen={setAgentRunsOpen} />
      <UsagePanel refreshKey={accountRefresh} onOpen={() => { setSettingsSection("usage"); show("settings"); }} />
      <div className="sidebar-footer"><AccountRow refreshKey={accountRefresh} /></div>
      <div className="sidebar-status">
        <span className="status-line"><i className={`status-dot${connected ? " connected" : ""}`} />{connected ? "Local workspace" : "Disconnected"}</span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label={dark ? "Use light theme" : "Use dark theme"} title={dark ? "Use light theme" : "Use dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}><ThemeIcon size={14} /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => openSettings("general")}><SettingsIcon size={14} /></Button>
        </span>
      </div>
      <ResizeEdge label="Resize sidebar" width={sidebarWidth} min={SIDEBAR.min} max={SIDEBAR.max} initial={SIDEBAR.initial} grows="right" onResize={resizeSidebar} onClose={() => showSidebar(false)} />
    </aside>
    <main className={`workspace${view === "chat" && selectedLoveChat ? " love-chat accent-scope" : ""}`} style={panelShown && !fullView ? { "--side-min": `${sideMinWidth(side.shown)}px`, ...(side.width ? { "--side-w": `clamp(${sideMinWidth(side.shown)}px, ${side.width}px, 70%)` } : {}) } as CSSProperties : undefined}>
      <header className={`workspace-header${heading ? "" : " untitled"}`}>
        <ImproveElpis threadId={view === "chat" ? selected?.id : undefined} onChat={loadThread} />
        {outsideChatApprovals.length > 0 && <div className="pending-input-anchor"><Button ref={pendingInputButton} className="pending-input-trigger" variant="secondary" size="sm" aria-label={`Needs input (${outsideChatApprovals.length})`} aria-expanded={pendingInputOpen} aria-controls="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") setPendingInputOpen(false); }} onClick={() => setPendingInputOpen(value => !value)}><span className="pending-count">{outsideChatApprovals.length}</span>Needs input<span className="pending-task-name">{title(threads.find(thread => thread.id === outsideChatApprovals[0].params.threadId) || outsideChatApprovals[0].thread || {id:outsideChatApprovals[0].params.threadId || "unreported"})}</span></Button></div>}
        <Button className="mobile-menu sidebar-open" variant="ghost" size="icon-sm" aria-label="Open sidebar" title={shortcutTitle("Open sidebar", "sidebar", preferences)} onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>
        <BrandWordmark className="mobile-brand" dark={dark} width={49} height={24} />
        <div className="header-titles min-w-0 flex-1">
          {view === "chat" && desktop && !split.pane
            ? <TabStrip label="Chat tabs" activeKey={tabs.activeId} add={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New chat tab" title="New chat tab (Ctrl+T)" onClick={newChatTab}><PlusIcon size={16} /></Button>}>
                {tabs.tabs.map(chatTab)}
              </TabStrip>
            : chatActions(<div className="header-title-row" />, <h1>{heading}</h1>)}
          {view === "canvas" && <Segmented label="Workflows view" className="workflow-view-switch" value={workflowTab} onChange={setWorkflowTab} options={[{ value: "board", label: "Board" }, { value: "scheduled", label: "Scheduled" }]} />}
          {view === "chat" && selected && originLabel(chatOrigin(selected, loveActivity.threads), title(selected)) === "Love Spot" && <Button variant="ghost" size="xs" className="thread-origin" data-origin="Love Spot" onClick={() => show("loveSpot")}><LoveSpotIcon size={13} />Love Spot</Button>}
          {view === "chat" && selected && meta && <p className="thread-meta">{meta}</p>}
          {view === "chat" && selected && (selected.parentThreadId || selected.forkedFromId) && <p className="thread-links">
            {selected.parentThreadId && <Button variant="link" size="xs" aria-label={`Open parent: ${parent ? title(parent) : "parent conversation"}`} onClick={() => openById(selected.parentThreadId!)}>Agent of {parent ? title(parent) : "its parent conversation"}</Button>}
            {selected.forkedFromId && <Button variant="link" size="xs" aria-label={`Open original: ${source ? title(source) : "original chat"}`} onClick={() => openById(selected.forkedFromId!)}>Continued from {source ? title(source) : "the original chat"}</Button>}
          </p>}
        </div>
        {view === "loveSpot" && <div ref={setLoveToolbarHost} className="love-spot-toolbar-host" />}
        {view === "chat" && desktop && <Button className="header-action" variant="ghost" size="icon-sm" aria-pressed={side.open} aria-label={side.open ? "Hide side panel" : "Show side panel"} title={side.open ? "Hide side panel" : "Side panel: terminals and browser tabs"} onClick={() => side.open ? side.closePanel() : side.openPanel()}>{side.open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</Button>}
        {selected && view === "chat" && (team.length > 0 || awaitingTeam) && !panelShown && <Button className={`header-action${team.length ? "" : " team-pending-toggle"}`} variant="ghost" size="icon-sm" aria-label={agentsPanel ? "Hide agents panel" : "Show agents panel"} aria-pressed={agentsPanel} title={awaitingTeam && !team.length ? "Hide agents panel and open the chat" : agentsPanel ? "Hide agents panel" : "Show agents panel"} onClick={() => {
          if (agentsPanel) { setAgentsPanelState(previous => ({ ...previous, open: false })); if (awaitingTeam) requestAnimationFrame(() => composerRef.current?.focus()); }
          else openAgentsPanel();
        }}><AgentsIcon size={16} /></Button>}
        {(split.pane || (split.thread && view === "chat")) && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Close split view" title="Close split view" onClick={split.close}><X size={16} /></Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Refresh conversation" disabled={loading} onClick={() => loadThread(selected)}><RefreshCw size={16} /></Button>}
      </header>
      {outsideChatApprovals.length > 0 && pendingInputOpen && <section id="pending-input-panel" aria-label="Pending input" className="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") { setPendingInputOpen(false); pendingInputButton.current?.focus(); } }}>
        <div className="pending-panel-heading"><div><h2>Needs input</h2><p>{outsideChatApprovals.length} {outsideChatApprovals.length === 1 ? "request" : "requests"} waiting for you</p></div><Button variant="ghost" size="icon-sm" aria-label="Close pending input" onClick={() => { setPendingInputOpen(false); pendingInputButton.current?.focus(); }}><X size={16}/></Button></div>
        <div className="pending-request-list">{outsideChatApprovals.map(approval => {
          const thread = threads.find(item => item.id === approval.params.threadId);
          const requester = thread ?? approval.thread; const name = requester ? title(requester) : approval.params.threadId || "Conversation not reported";
          return <div key={approvalDraftKey(approval)} className="pending-request"><div className="pending-request-heading"><p>{name}</p>{approval.params.threadId && <Button variant="ghost" size="sm" onClick={() => { setPendingInputOpen(false); openById(approval.params.threadId!); }}>Open chat</Button>}</div><ApprovalCard {...approvalCardProps(approval)} globalKeys={false} /></div>;
        })}</div>
      </section>}
      <div className={`workspace-body${panelShown ? " panel-open" : ""}${fullView ? ` full-view${side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${view !== "chat" ? " no-browser" : ""}`}><div className="workspace-content" {...(fullView ? { role: "region", "aria-label": "Floating chat" } : {})}>
      {fullView && <FloatChatBar title={chatName} onCollapse={() => side.setChatCollapsed(true)} />}
      {settingsVisited && <div className="page-scroll" hidden={view !== "settings"}><ViewBoundary label="Settings" resetKey={settingsNavigation}><SettingsView initialTab={settingsSection} navigationKey={settingsNavigation} active={view === "settings"} threadId={selected?.id} currentModel={selected?.model} currentPermission={selected ? permissionLabel(permissionMode) : null} accountRefresh={accountRefresh} theme={theme} onTheme={setTheme} onUnarchived={unarchived} onImported={() => void refreshThreads()} onDeleteThread={deleteThread} onBack={() => { show("chat"); requestAnimationFrame(focusComposer); }} onChatPermissions={() => { show("chat"); requestAnimationFrame(() => openComposerControl("Change permissions")); }} onChatModel={() => { show("chat"); requestAnimationFrame(() => openComposerControl("Model")); }} modelChangeReason={!ready ? "Wait for Elpis to connect." : busy ? "Wait for this turn to finish before changing the model." : undefined} onBrowser={url => { show("chat"); void browser.command("new", url ? { url } : undefined); }} onCustomize={() => show("customize")} onChatContext={() => { show("chat"); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_EVENT))); }} onProvidersChanged={async () => { await reloadSettings(); void refreshModels(); }} /></ViewBoundary></div>}
      {view === "agentsGuide" && <div className="page-scroll"><ViewBoundary label="Guide to managing agents"><AgentsGuide onBack={() => show("canvas")} /></ViewBoundary></div>}
      {view === "experimentLab" && <ViewBoundary label="Lab"><ExperimentLab /></ViewBoundary>}
      {/* 6 Nov, Masih: "automation is kind of a workflow, isn't it? couldn't we have merged those?" Workflows has two views:
          the board and its Scheduled automations (components/automations-view.tsx). The board stays mounted, so its draft
          survives a look at the schedule. */}
      {view === "canvas" && <ViewBoundary label="Workflows"><div className="contents" hidden={workflowTab !== "board"}><CanvasGuideHelp onOpen={() => show("agentsGuide")}><AgentsCanvas threads={threads} key={recordedWorkflow?.id ?? "draft"} recordedRun={recordedWorkflow} onLeaveRecordedRun={() => setRecordedWorkflow(undefined)} onOpenRecordedRun={run => setRecordedWorkflow(run)} ready={ready && connected} workflowCatalog={workflowCatalog} models={models} cwd={workflowFolder} dark={dark} onOpenChat={id => { show("chat"); void openById(id); }} onRunStarted={keepWorkflowTab} onSchedule={workflow => { setWorkflowPrefill(workflow); setWorkflowTab("scheduled"); }}
        projectMenu={<ProjectMenu variant="chip" projects={projects} selected={workflowProject ?? { id: "workflow-sandbox", name: "Sandbox", cwd: workflowSandbox ?? "" }} allowNone={!!workflowProject} noneLabel="Use sandbox" disabled={!ready || projectChanging} onSelect={selectProject} onAdd={() => void addProject()} />} onUseFolder={workIn} /></CanvasGuideHelp></div>
        {workflowTab === "scheduled" && <AutomationsView projects={projects} prefill={workflowPrefill} onPrefillUsed={() => setWorkflowPrefill(null)} onOpenChat={id => { show("chat"); void openById(id); }} />}</ViewBoundary>}
      {replays.map(replay => <div key={replay.token} hidden aria-hidden="true"><AgentsCanvas threads={threads} workflowCatalog={workflowCatalog} models={models} cwd={replay.cwd ?? undefined} dark={dark} ready={ready && connected}
        onOpenChat={id => { show("chat"); void openById(id); }} scheduled={{ board: replay.board, onDone: result => finishReplay(replay, result) }} /></div>)}
      {view === "loveSpot" && <ViewBoundary label="Love Spot"><LoveSpot dark={dark} toolbarHost={loveToolbarHost} /></ViewBoundary>}
      {view === "observability" && <ViewBoundary label="Observability"><ObservabilityView threadId={selected?.id} chats={threads} /></ViewBoundary>}
      {view === "customize" && <div className="page-scroll"><ViewBoundary label="Customize"><CustomizeView cwd={cwd} onOpenSettings={() => openSettings("mcp")}
        onConnectGithub={hasTerminal ? () => { show("chat"); setTuiLaunch({ key: side.openTerminal(cwd), command: "github-login", token: Date.now() }); } : undefined}
        onCreateSkill={() => { newChat(); requestAnimationFrame(() => editDraft("Use $skill-creator to create a new skill that ")); }} /></ViewBoundary></div>}
      {view === "chat" && <ViewBoundary label="Chat" resetKey={selected?.id}><div className="chat-split"><div className={`chat-view${!selected && !shownEntries.length ? " empty-chat" : ""}`} data-team-loading={awaitingTeam || undefined}>
        <div className="chat-scroll-wrap"><div className="chat-scroll" aria-busy={awaitingTeam || undefined} ref={scroll} onClickCapture={event => { if (event.target instanceof Element && event.target.closest("[data-preserve-scroll]")) { followingBottom.current = false; stickToBottom.current = false; } }} onWheel={() => { followingBottom.current = false; }} onPointerDown={() => { followingBottom.current = false; }} onKeyDown={event => { if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) followingBottom.current = false; }} onScrollEnd={event => { if (followingBottom.current) { followingBottom.current = false; event.currentTarget.scrollTo({ top: event.currentTarget.scrollHeight }); } }} onScroll={event => { const element = event.currentTarget; const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80; stickToBottom.current = followingBottom.current || atBottom; setAwayFromBottom(!atBottom); }}><div className="chat-content">
          {(itemCursor || heldCount >= 0 && earlierHeld(selected?.id)) ? <LoadOnScroll className="load-earlier-messages" loading={loading} paused={!!error} label="Loading earlier messages" onLoad={() => void older()} />
            : !loading && selected && historyGaps.has(selected.id) && <div className="context-event" role="note">The earliest part of this chat is missing, so it opened with the history that remains.</div>}
          {loading && !shownEntries.length && <p role="status" className="chat-loading text-muted-foreground">Loading conversation…</p>}
          {selectedWorkflow && <WorkflowChat threads={threads} run={selectedWorkflow} identity={workflowCatalog.identities[selectedWorkflow.id]} ready={ready && connected} models={models} onOpenChat={id => void openById(id)} onOpenCanvas={run => { setRecordedWorkflow({ id: run.id, rootThreadId: run.rootThreadId }); show("canvas"); }} />}
          {!selectedWorkflow && !loading && !shownEntries.length && !activeTurn && <div className="empty-state">{selected ? <><h2>This conversation has no messages yet.</h2><p>Messages and tool activity appear here.</p></> : <><BrandWordmark className="empty-mark" dark={dark} /><h2>{project ? <>What should we build in <ProjectMenu variant="heading" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} />?</> : "What should we build?"}</h2>{personal.showTip && <PersonalTip onOpen={personal.open} onDismiss={personal.dismiss} />}</>}</div>}
          <WorkingPlacement.Provider value={workingHost}>{chatConversation}</WorkingPlacement.Provider>
          {selected && stoppedTurns[selected.id] && !activeTurn && <p className="turn-stopped" role="status">Stopped. The reply above is where it was when the turn was stopped.</p>}
          {failedTurn && <FailedTurnCard key={`${selected?.id}:${failedTurn.turnId}`} failure={failedTurn} models={selectedChoice?.models ?? models} currentModel={selected?.model} disabled={!replaceable}
            blockedReason={continues ? "Continue this conversation here before trying again." : failedInput?.allowed ? undefined : failedInput?.reason ?? "The original complete input is unavailable, so this turn cannot be safely resent."}
            onRetry={!continues && failedInput?.allowed ? retryModel => replaceFrom(failedTurn.turnId, failedInput.prompt, undefined, retryModel) : undefined} />}
          {selected && proposedPlan && !readOnlyRun && <PlanCard mode={permissionMode} busy={busy || !connected} onImplement={permissions => answerPlan(selected, proposedPlan, { implement: true, permissions })} onKeepPlanning={feedback => answerPlan(selected, proposedPlan, { feedback })} />}
          {approvals.filter(a => a.params.threadId === selected?.id).map(a => <ApprovalCard key={approvalDraftKey(a)} {...approvalCardProps(a)} />)}
        </div><PromptRail scroller={scroll} threadId={selected?.id ?? null} entries={shownEntries} onLoadEarlier={older} onNavigate={() => { followingBottom.current = false; stickToBottom.current = false; }} />
          {awayFromBottom && <Button variant="outline" size="icon-lg" className="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={() => { followingBottom.current = true; stickToBottom.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={16} /></Button>}</div>
          {awaitingTeam && <p role="status" className="chat-loading chat-team-loading text-muted-foreground">Loading conversation…</p>}</div>
        <div className="composer-wrap">
          {sideChat && selected?.id === sideChat.parentId && <SideChat key={`${sideChat.parentId}:${sideChat.question?.kind === "recap" ? sideChat.question.id : "side"}`} parentId={sideChat.parentId} open={sideChat.open} question={sideChat.question} onClose={() => { setSideChat(previous => previous ? { ...previous, open: false } : null); focusComposer(); }}  onForward={answer => void send(`From the side chat:\n\n${answer}`)} />}
          <ViewBoundary label="This panel" resetKey={panel}>
          {panel === "status" && <SessionPanel rows={sessionRows} threadId={selected?.id} onUsage={() => { setPanel(null); openSettings("usage"); }} onClose={closePanel} />}
          {panel === "review" && selected && <ReviewPanel threadId={selected.id} onStart={target => void startReview(selected, target)} onClose={closePanel} />}
          {panel === "diff" && selected && <DiffPanel threadId={selected.id} onClose={closePanel} />}
          </ViewBoundary>
          {visibleSlashNotice && <p key={visibleSlashNotice} role="status" data-fast-notice={fastSuccess ? "" : undefined} onAnimationEnd={fastSuccess ? () => setSlashNotice(current => current === slashNotice ? "" : current) : undefined} className="mx-auto mb-2 w-full max-w-[var(--transcript-width,740px)] px-1 text-sm text-muted-foreground">{visibleSlashNotice}</p>}
          {selected && plans[selected.id] && <TaskList plan={plans[selected.id]} running={activeTurns[selected.id] === plans[selected.id].turnId} />}
          <QueuedFollowUps threadId={selected?.id} activeTurnId={activeTurn} onError={setError} onComplete={restoreComposerFocus} onEdit={editQueued} />
          {!selected && <div className="composer-tray"><EnvironmentMenu folder={chatFolder || null} disabled={!ready || busy} worktree={newWorktree} onWorktree={setNewWorktree} /><ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} /></div>}
          <div className="composer-working" ref={setWorkingHost} />
          {readOnlyRun ? <div className="mx-auto flex w-full max-w-[var(--transcript-width,740px)] flex-col gap-3 rounded-lg border p-4 text-sm text-muted-foreground" role="status">
            <p>{AGENT_RUN_NOTICE}</p>
            {selected?.desktopAccess?.canContinue && !activeTurn && selected.status?.type !== "active" && <Button variant="outline" size="sm" className="self-start" disabled={busy || !connected || loading} onClick={() => void continueHere(selected)}>Continue here</Button>}
          </div> : <ComposerForm composer={composer} attachmentsState={attachmentState} drafts={draftStore} selectedRef={selectedRef} newDraftKey={newDraftKey} slash={slash} mention={mention} promptKeys={promptKeys} send={send} onComposerChange={onComposerChange} onComposerPaste={onComposerPaste} onComposerKeyDown={onComposerKeyDown} composerPlaceholder={composerPlaceholder} composerNotice={composerNotice} busy={busy} projectChanging={projectChanging} focusComposer={focusComposer}>
            <ComposerControls selected={selected} selectedModel={selectedModel} settings={conversationSettings} commands={conversationCommands} runtime={runtime} composer={composer} attachmentsState={attachmentState} projectState={projectState} slash={slash} mention={mention} promptKeys={promptKeys} models={models} settingsSnapshot={settingsSnapshot} providerSettings={providerSettings} preferences={preferences} model={model} choiceId={choiceId} setModel={setModel} setChoiceId={setChoiceId} setEffort={setEffort} newDraftKey={newDraftKey} permissionMode={permissionMode} planMode={planMode} busy={busy} activeTurn={activeTurn} readOnlyRun={readOnlyRun} continues={continues} sendBlocked={sendBlocked} selectedLoveChat={selectedLoveChat} loveSpotAudioReason={loveSpotAudioReason} manageConnections={manageConnections} pickFiles={pickFiles} startMention={startMention} startSlash={startSlash} focusComposer={focusComposer} editDraft={editDraft} stop={stop} />
          </ComposerForm>}
          <div className="composer-meta">
            {selected && <ProjectMenu variant="chip" label="Change folder" addLabel="Choose folder…" allowNone={false} projects={projects} disabled={!ready || !connected || readOnlyRun}
              selected={projects.find(item => item.cwd.replace(/\/+$/, "") === selected.cwd?.replace(/\/+$/, "")) ?? (selected.cwd ? { id: `folder:${selected.cwd}`, name: folder(selected.cwd), cwd: selected.cwd } : null)}
              onSelect={moveChat} onAdd={() => void moveChatToFolder()} />}
            {selected?.cwd && <BranchChip key={selected.id} threadId={selected.id} running={!!activeTurn} onNotice={setSlashNotice} />}
            <span className="composer-hint">{selectedLiveError ? `Not following live (${selectedLiveError}); the chat refreshes every few seconds.` : selected && historyOnly[selected.id] ? "This agent is running in an earlier Elpis runtime. Its completed history will appear when it finishes." : ""}</span>
            <ElpisFeatures />
          </div>
        </div>
      </div>
      {selected && teamRoot && team.length > 0 && agentsPanel && !panelShown && <ChatTeamPanel selected={selected} teamRoot={teamRoot} team={team} workingTeam={workingTeam} shownTeam={shownTeam} workingAgentsOnly={workingAgentsOnly} setWorkingAgentsOnly={setWorkingAgentsOnly} waitingIds={waitingIds} activity={activity} models={models} agentColours={agentColours} openById={openById} openThread={openThread} />}
      </div></ViewBoundary>}
      </div>{fullView && side.chatCollapsed && <FloatChatPill title={chatName} state={floatState} onRestore={() => side.setChatCollapsed(false)} />}{desktop && <SidePanel panel={side} browser={browser} hasTerminal={hasTerminal} dark={dark} cwd={selected?.cwd || cwd} threadId={selected?.id} running={!!activeTurn} launch={tuiLaunch} covered={pendingInputOpen || sidebar || view !== "chat"} onAttach={attachFromBrowser} imagesAllowed={!(knownModel?.inputModalities && !knownModel.inputModalities.includes("image"))} />}</div>
      <WorkspaceNotices connection={!ready || !connected ? connectionStatus : undefined} deleted={deletedNotice} onUndoDelete={() => void undoDelete()} onDismissDeleted={() => setDeletedNotice(null)}
        rewind={selected && rewindActions[selected.id] && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1">Your files stay as they are.</span><Button variant="outline" size="sm" disabled={rewindBusy || !!activeTurn} onClick={() => void switchRewind({ action: rewindActions[selected.id]! }).catch(cause => setError(String(cause)))}>{rewindActions[selected.id] === "undo" ? "Undo rewind" : "Redo rewind"}</Button></div>}
        error={error && !(refusedOffline(error) && !connected) ? error : undefined} onDismissError={() => setError("")}
        worktree={worktreeNotice} onDismissWorktree={() => setWorktreeNotice("")} loadingModels={catalogLoading && !catalogError && !models.length}
        conversationError={selected ? runtimeNotices[selected.id] : undefined} onDismissConversationError={() => selected && setRuntimeNotices(prev => without(prev, selected.id))}
        recovery={selected && (recoveredEdit || recoveryAttachments.length > 0) && <div className="error-banner"><details className="min-w-0 w-full"><DisclosureSummary>Recover unsent message</DisclosureSummary><pre className="whitespace-pre-wrap break-words py-2" dir="auto">{recoveredEdit}</pre>{recoveryAttachments.length > 0 && <p>Files: {recoveryAttachments.map(part => part.name).join(", ")}</p>}<div className="flex flex-wrap items-center gap-2">{recoveredEdit && <CopyButton label="Copy unsent message" text={() => recoveredEdit} />}<Button variant="outline" size="sm" disabled={!!text.trim() || attachments.length > 0} title={text.trim() || attachments.length ? "Keep or clear your current draft before restoring this message." : undefined} onClick={() => { saveDraft(`recovery-${selected.id}`, ""); saveAttachments(`recovery-${selected.id}`, []); editDraft(recoveredEdit); setAttachments(recoveryAttachments); saveAttachments(selected.id, recoveryAttachments); }}>Use in composer</Button>{(!!text.trim() || attachments.length > 0) && <span>Your current draft is kept. Save it, or clear it to restore the unsent message.</span>}</div></details></div>} />
      {split.thread && view === "chat" && <iframe key={split.thread.id} ref={split.frame} className="split-session" title="Split session" src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`} />}
    </main>
  </div></ReadAloud></LiveVoiceProvider></DocumentReviewProvider>;
}
