"use client";

import { flushSync } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useReorder } from "@/components/reorder";
import { ViewBoundary } from "@/components/view-boundary";
import { useBookmarks, useChatAttention, usePins, useSidebarFolds, useChatGroups } from "@/lib/use-sidebar-state";
import { useAppearance } from "@/lib/use-appearance";
import { chatSubtree } from "@/lib/chat-groups";
import { configuredShortcuts } from "@/lib/shortcuts";
import { CommandMenu, type CommandAction } from "@/components/command-menu";
import { arrange, move } from "@/lib/nav-order";
import { newChatFolder, savePreferences, useAppPreferences } from "@/lib/preferences";
import { usePromptKeys } from "@/lib/prompt-history";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StartupSplash } from "@/components/startup-splash";
import { permissionLabel, type PermissionMode } from "@/components/composer-controls";
import { type MessageVersion } from "@/lib/turn-replacement";
import type { TerminalLaunch } from "@/components/terminal-view";
import { type SettingsDestination } from "@/components/settings-view";
import { DeleteChatsDialog } from "@/components/thread-actions";
import { SectionToggle } from "@/components/sidebar-group";
import { SidebarChatList } from "@/components/sidebar-chat-list";
import { createSidebarThreadRow } from "@/components/sidebar-thread-row";
import { createSidebarBranches } from "@/components/sidebar-branches";
import { WorkflowPages } from "@/components/workflow-pages";
import { PendingInputPanel } from "@/components/pending-input";
import { WorkspaceSettings } from "@/components/workspace-settings";
import { WorkspaceGuideAndLab, OtherWorkspacePages } from "@/components/other-workspace-pages";
import { WorkspaceTitleBar } from "@/components/workspace-title-bar";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { WorkspaceHeader } from "@/components/workspace-header";
import { WorkspaceTranscript } from "@/components/workspace-transcript";
import { WorkspaceComposer } from "@/components/workspace-composer";
import { WorkspaceComposerInput } from "@/components/workspace-composer-input";
import { useConversationTranscript } from "@/components/use-conversation-transcript";
import { useSlashMenu } from "@/components/slash-menu";
import { useMentionMenu } from "@/components/mention-menu";
import { RewindDialog } from "@/components/rewind-dialog";
import { useNavHistory } from "@/lib/nav-history";
import { openControl } from "@/lib/slash-focus";
import { useElpisSettings } from "@/lib/settings-store";
import { ReadAloud } from "@/components/read-aloud";
import { LiveVoiceProvider } from "@/components/live-voice";
import { ProfileDialog } from "@/components/profile-dialog";
import { saveProjects } from "@/lib/projects";
import { useLoveActivity } from "@/lib/use-love-activity";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { useScreenshotPopup } from "@/lib/use-screenshot-popup";
import { DocumentReviewProvider } from "@/components/document-review";
import { ChatTeamPanel } from "@/components/chat-team-panel";
import { ResumeConversation } from "@/components/resume-conversation";
import { sidebarListKeys, useSidebarKeys, useWorkspaceNavigation } from "@/lib/use-workspace-navigation";
import { agentState } from "@/lib/agents";
import { useBrowserPins } from "@/lib/browser-pins";
import { useBrowser } from "@/components/browser-panel";
import { onRequest as onFileRequest, openFile, setFileView } from "@/lib/files-pane";
import { usePersonal } from "@/components/personal-tip";
import { SidePanel, sideMinWidth, useSidePanel } from "@/components/side-panel";
import { type SideRequest } from "@/components/side-chat";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { useSessionSplit } from "@/components/session-split";
import { followChat, forgetChats, renameTabs } from "@/lib/chat-tabs";
import { fitAttachments, type Attachment } from "@/lib/attachments";
import { api, isAgentRun, modelLabel, providerLabel, title, agentName,
  type ProviderSettings, type Thread } from "@/lib/api";
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
import { useRelatedConversations } from "@/lib/use-related-conversations";
import { useTranscriptPresentation } from "@/lib/use-transcript-presentation";
import { createSidebarPlacement } from "@/lib/sidebar-placement";
import { createApprovalActions } from "@/lib/approval-actions";
import { createShellSend } from "@/lib/shell-send";
import { createClearConversation } from "@/lib/clear-conversation";
import { useTurnReplacementView } from "@/lib/use-turn-replacement-view";
import { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import { useConversationOptions } from "@/lib/use-conversation-options";
import { useSidebarSelection } from "@/lib/use-sidebar-selection";
import { useHistoryFallback } from "@/lib/use-history-fallback";
import { useDesktopEntryPoints } from "@/lib/use-desktop-entry-points";
import { useConversationSession } from "@/lib/use-conversation-session";
import { createPromptEditing } from "@/lib/prompt-editing";
import { createSideChatActions } from "@/lib/side-chat-actions";
import { useWorkspaceRestoration } from "@/lib/use-workspace-restoration";
import { useChatTeam } from "@/lib/use-chat-team";
import { useWorkspaceShortcuts } from "@/lib/use-workspace-shortcuts";
import { useWorkflowWorkspace } from "@/lib/use-workflow-workspace";
import { useWorkspaceDialogState } from "@/lib/use-workspace-dialog-state";
import { createWorkspaceVisibility } from "@/lib/workspace-visibility";
import { NAV_PAGES, PAGE_NAMES } from "@/lib/workspace-navigation-pages";
import { refusedOffline } from "@/lib/workspace-types";
import { useComposerAttachments } from "@/lib/use-composer-attachments";
import { useComposerState } from "@/lib/use-composer-state";
import { useProjectState } from "@/lib/use-project-state";
import { useChatTabs } from "@/lib/use-chat-tabs";
import { useApprovalDrafts, useDraftStore, useSubmitOnce } from "@/lib/use-drafts";
import { sessionWindowApi, useDesktopCapabilities } from "@/lib/use-desktop-capabilities";
import { useWorkspaceNotices } from "@/lib/use-workspace-notices";
import { useSidebarSearch } from "@/lib/use-sidebar-search";
import { WorkspaceNotices } from "@/components/workspace-notices";
import { WorkspaceRecovery } from "@/components/workspace-recovery";
import { createWorkspaceChatTabs } from "@/components/workspace-chat-tabs";
import { WorkspaceOrganizationDialogs } from "@/components/workspace-organization-dialogs";
import { without } from "@/lib/utils";
import { errorText } from "@/lib/error-text.mjs";
import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";



export default function Home() {
  const preferences = useAppPreferences();
  const hiddenPages = preferences.hiddenPages.split(",");
  const session = useConversationSession();
  const { threads, setThreads, selected, setSelected, selectedRef, entries, setEntries, submissions, setSubmissions, busy, setBusy, loading, setLoading, scroll, stickToBottom, restoreScroll, request, initialRestoration } = session;
  // Chat tabs (lib/chat-tabs.ts): the shown tab follows the chat on screen, so every way of opening a chat lands in it.
  const { tabs, tabsRef, updateTabs, restoreTabs, restored: restoredTabs } = useChatTabs(message => setError(message));
  // The engine's live model list, shared by every model menu (lib/model-catalog.ts).
  const { models, error: catalogError, loading: catalogLoading } = useModelCatalog();
  const refreshModels = refreshModelCatalog;
  // One settings snapshot for the whole app, so a main model saved in Settings is what the next new chat starts with.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings = settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  const options = useConversationOptions();
  const { choiceId, model, effort, setEffort, nextTurn, setNextTurn, threadModes, setThreadModes, threadPlans, newPlan, planAnswered, setPlanAnswered, newMode } = options;
  const projectState = useProjectState();
  const { cwd, projects, setProjects, projectId, projectChats,
    projectChanging } = projectState;
  const pages = useWorkspacePagesState();
  const { recordedWorkflow, view, setView, viewRef, setSettingsSection } = pages;
  const { pins, togglePinned } = usePins();
  const { bookmarks, toggleBookmarked } = useBookmarks();
  // The sidebar's order is declared further down; groups release it through this ref.
  const releaseChatOrder = useRef(() => {});
  const groups = useChatGroups(message => setError(message), () => releaseChatOrder.current());
  const { chatGroups, chatGroupsRef, updateGroups, commitGroups } = groups;
  const dialogs = useWorkspaceDialogState();
  const { setNewGroupFor, deleteTargets, setDeleteTargets, deleteRunHistory, setDeleteRunHistory, shownWhenDeleted, shortcutsOpen, setShortcutsOpen, commandMenuOpen, setCommandMenuOpen, commandReturnFocus, shortcutsReturnFocus, renameRequest, setRenameRequest, resumeOpen, setResumeOpen } = dialogs;
  const { error, setError, deletedNotice, setDeletedNotice, worktreeNotice, setWorktreeNotice, noteKept } = useWorkspaceNotices();
  const { attention, setAttention, planTurns, markRead } = useChatAttention(planAnswered, setError);
  const selection = useSidebarSelection({ selected, openSplit: thread => openSplit(thread), openThread: thread => openThread(thread) });
  const { marked, setMarked, threadList, rowLinks, clickRow } = selection;
  const { folds, foldsRef, changeFolds, setCollapsedProjects } = useSidebarFolds();
  const collapsedProjects = folds.projects, collapsedSections = folds.sections;
  /** The heading of a sidebar section: every one of them folds its list the same way. */
  const foldable = (key: string, name: string) => <SectionToggle name={name} open={!collapsedSections[key]} onToggle={() => changeFolds(value => ({ ...value, sections: { ...value.sections, [key]: !value.sections[key] } }))} />;
  /** The message whose "Rewind to here" is awaiting confirmation (its turn). */
  const [rewindTurn, setRewindTurn] = useState<string | null>(null);
  const [rewindActions, setRewindActions] = useState<Record<string, "undo" | "redo" | undefined>>({});
  /** ChatGPT's ‹ 1/2 › under an edited message, per chat: its versions by turn (bridge/message-versions.mjs). */
  const [messageVersions, setMessageVersions] = useState<Record<string, MessageVersion[]>>({});
  const [rewindBusy, setRewindBusy] = useState(false);
  const rewindSwitch = useRef<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** What a slash command has open above the composer, and the one-line answer of a command that only reports. */
  const [panel, setPanel] = useState<"status" | "review" | "diff" | null>(null);
  const [slashNotice, setSlashNotice] = useState("");
  // /compact typed while the agent works runs when that turn finishes, as in the terminal.
  const [queuedCompact, setQueuedCompact] = useState<{ threadId: string; guidance?: string } | null>(null);
  // A new chat in its own worktree (the Local/Worktree menu), and where an archived or deleted chat's worktree was kept.
  const [newWorktree, setNewWorktree] = useState(false);
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  const composer = useComposerState();
  const { text, setText, shellMode, setShellMode, shellCreated, textRef, composerRef, caret, setCaret, pickedMentions, dictating, voiceBusy } = composer;
  const [sideChat, setSideChat] = useState<{ parentId: string; open: boolean; question?: SideRequest } | null>(null);
  const sideRequests = useRef(0);
  const [agentRunsOpen, setAgentRunsOpen] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const approvalSubmissions = useSubmitOnce(), { pending: pendingDrafts, submit: submitDraft } = approvalSubmissions;
  const approvalDrafts = useApprovalDrafts(), { clearApprovalDraft } = approvalDrafts;
  const draftStore = useDraftStore(setError), { savedDraft, saveDraft, savedAttachments, saveAttachments } = draftStore;
  const newDraftKey = useRef("new");
  const runtime = useRuntimeState();
  const { connected, connectionStatus, ready, runtimeNotices, setRuntimeNotices,
    activeTurns, approvals, setApprovals,
    activity, liveError } = runtime;
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  const editDraft = (value: string) => { setText(value); saveDraft(selectedRef.current?.id || newDraftKey.current, value); };
  const attachmentState = useComposerAttachments({ selectedRef, newDraftKey, shellMode, savedAttachments, saveAttachments, setError, setRuntimeNotices });
  const { attachments, attaching, setFileNotice, setAttachments, restoreAttachments } = attachmentState;
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
  useComposerHeight(composerRef, [text, selected?.id, view]);
  const loveActivity = useLoveActivity(view === "loveSpot", ready, view === "chat" ? selected : null);
  const loveRef = useRef(loveActivity); loveRef.current = loveActivity;
  /** A Love Spot chat by id, read at event time. */
  const isLoveChatId = (id: string) => loveRef.current.isLoveChat(threadsRef.current.find(thread => thread.id === id) ?? { id });
  const selectedLoveChat = !!selected && loveActivity.isLoveChat(selected);
  const loveSpotAudioReason = selected && !LOVE_SPOT_AUDIO.available
    ? selectedLoveChat ? LOVE_SPOT_AUDIO.reason : !loveActivity.originsResolved ? LOVE_SPOT_AUDIO.pendingReason : undefined
    : undefined;
  const { finishReplay, workflowSandbox, workflowFolder } = useWorkflowWorkspace(view, projectState, runtime, setError);
  // Matilda's chat on screen reads every Love Spot reply.
  useEffect(() => { if (loveActivity.chatShown) setAttention(previous => ({ ...previous, unread: previous.unread.filter(id => !isLoveChatId(id)) })); }, [loveActivity.chatShown, setAttention]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === "chat" && selected) markRead(selected.id); }, [view, selected?.id, markRead]);
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
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  const { showChat, show, narrow, showSidebar, focusSearch } = createWorkspaceVisibility({ side, pages, panelShown, panelDrawer, setSidebar, setSidebarCollapsed, searchInput: () => searchInput.current });
  useEffect(() => { if (selected?.id) showChat(); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const appearance = useAppearance(setError);
  const { dark, sidebarWidth } = appearance;
  // The website's animated wordmark, its dark or light version (website/assets/branding).
  const searchInput = useRef<HTMLInputElement>(null);
  const history = useTranscriptHistory(selected, loading, entries, setEntries);
  const { itemCursor, setItemCursor, transcripts, prefetchThread } = history;
  const conversations = useConversationList(threads, setThreads, selectedRef, setSelected, setError);
  const { select, threadsRef, hidden } = conversations;
  const children = useChildConversations({ conversations, selectedRef, setThreads, setError, setAgentsPanelState });
  const { loadingChildren, checkedChildren, childCursors, expanded, setExpanded, holdAgentPanel, loadChildren } = children;
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
  const { rememberFollowing, reconcileLiveThread, loadThread, openThread } = useOpenConversation({ composer, runtime, conversations, history, drafts: draftStore, attachments: attachmentState, tabsRef, updateTabs, session, newDraftKey, markRead, setView, setSidebar, setError, rememberModes: (id, live) => rememberModes(id, live) });

  useWorkspaceRestoration({ projects: projectState, composer, attachments: attachmentState, drafts: draftStore, newDraftKey, restoreTabs, setError });
  useWorkspaceNavigation(shortcutAction);
  useRuntimeEvents({ history, conversations, runtime, selectedRef, request, tabsRef, refreshModels, setError, initialRestoration, rememberFollowing, rememberModes: (id, live) => rememberModes(id, live), reconcileLiveThread, restoredTabs, loadThread, openThread, viewRef, planTurns, setAttention, loveRef, isLoveChatId, setRewindActions, setThreadModes, rewindSwitch, removeThreads, setEntries, clearApprovalDraft });

  const selectedTeamId = selected?.parentThreadId ?? selected?.id;
  useEffect(() => { if (ready && selectedTeamId) loadChildren(selectedTeamId); }, [ready, selectedTeamId, loadChildren]);
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useHistoryFallback({ session, selectedLiveError, view, history, conversations });
  const related = useRelatedConversations(selected, threads, preferences.showAgentRuns, agentRunsOpen);
  const { shownEntries, newestPrompt } = useTranscriptPresentation({ selected, entries, submissions, setSubmissions, newDraftKey, scroll, restoreScroll, stickToBottom, view });

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
  const { newChoice, missingChoiceNotice, needsModelId, pending, turnModel, turnEfforts, turnEffort, knownModel, fastOn } = selectedModel;
  const commandNoticeScope = JSON.stringify([view, tabs.activeId, selected?.id ?? newDraftKey.current]);
  const commandNoticeOwner = useRef(commandNoticeScope), fastNoticeOwner = useRef<string | null>(null);
  commandNoticeOwner.current = commandNoticeScope;
  useEffect(() => { setSlashNotice(""); }, [commandNoticeScope]);
  const fastSuccess = /^Fast is (on|off)\./.exec(slashNotice);
  const visibleSlashNotice = fastSuccess && (fastNoticeOwner.current !== commandNoticeScope || (fastSuccess[1] === "on") !== fastOn) ? "" : slashNotice;
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const canSendFollowUp = !!selected && !!activeTurn && !continues;
  const sendBlocked = readOnlyRun || (!text.trim() && !attachments.length) || (busy && (!canSendFollowUp || shellMode)) || dictating || attaching || imageBlocked || !ready || !connected || (!shellMode && (!!missingChoiceNotice || needsModelId && !model.trim()));

  const find = (id?: string | null) => id ? threads.find(thread => thread.id === id) ?? related[id] : undefined;
  const selectedTitle = selected ? title(selected) : "";
  useEffect(() => { if (ready) updateTabs(followChat(tabsRef.current, selected ? { id: selected.id, title: selectedTitle } : null)); }, [ready, selected?.id, selectedTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTabs(renameTabs(tabsRef.current, id => { const thread = find(id); return thread ? title(thread) : undefined; })); }, [threads, related]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back and forward: each place reached (a chat, a new chat, a page) joins the stack.
  const navHistory = useNavHistory(ready, { view, threadId: view === "chat" ? selected?.id ?? null : null });
  const replacement = useTurnReplacementView({ selected, entries, shownEntries, continues, activeTurn, connected, busy, loading, itemCursor });
  const { replaceable, turnEntries, replacementOptions, replacementOptionsKey, regenerate } = replacement;
  const { writePrompt, editLastMessage } = createPromptEditing({ composer, session, replacement, editDraft, setMessageEdits, setSlashNotice });
  // The message box's history keys (lib/prompt-history.ts): ↑/↓ and Ctrl+R through what you sent, Esc Esc to edit the last.
  const promptKeys = usePromptKeys(selected?.id ?? newDraftKey.current, { entries, box: () => composerRef.current, read: () => textRef.current, write: writePrompt, editLast: editLastMessage });
  const { waitingIds, teamRoot, team, workingTeam, shownTeam, agentColours, agentsPanel, awaitingTeam, openAgentsPanel } = useChatTeam({ session, runtime, find, checkedChildren, workingAgentsOnly, agentsPanelState, setAgentsPanelState, panelShown });

  const { openNewChat, newChat, showTab, newChatTab, closeChatTab, cycleTabs, goHistory, openInNewTab, keepWorkflowTab } = createChatNavigation({ projectState, composer, conversations, history, drafts: draftStore, attachments: attachmentState, tabsRef, updateTabs, session, newDraftKey, setError, setView, setSidebar, find, openThread, loadThread, showChat, browser, navHistory, show: next => show(next) });
  const clearChat = createClearConversation({ composer, conversations, projectState, runtime, loveActivity, selectedRef, request, setError, threadModes, permissionMode, openNewChat, loadThread, noteStartedMode: (id, mode) => noteStartedMode(id, mode) });
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

  const projectActions = createProjectActions({ projectState, conversations, runtime, chatGroupsRef, commitGroups, placementReveal: (...args) => placementReveal(...args), revealPlacement: (...args) => revealPlacement(...args), setMarked, viewRef, selected, openNewChat, setError, getNativeParents: () => nativeParents });
  const { assignProject, selectProject, newProjectFrom, workIn, addProject, moveChat, moveChatToFolder, removeProject } = projectActions;
  // A click on the screenshot thumbnail puts the screenshots on the Love Spot page already open, below what is there, in the
  // order they were taken, then shows them (A239; Masih, 5 Nov: "when I want to post a screenshot, it shouldn't open a new page").
  useScreenshotPopup(ready, ids => {
    void (async () => {
      for (const id of ids) await api("/love-spot/screenshots", { id, action: "place" });
      show("loveSpot");
    })().catch(cause => setError(errorText(cause, "The screenshots could not open in Love Spot.")));
  });
  const { forkFrom, continueHere, stop, deleteThread, renameThread, archiveThread, unarchived } = createConversationActions({ conversations, runtime, selectedRef, request, setBusy, setError, loadThread, loadChildren, restoreComposerFocus: origin => restoreComposerFocus(origin), removeThreads, noteKept });
  const conversationSettings = createConversationSettings({ selected, selectedRef, request, runtime, conversations, options, ready, connected, busy, projectChanging, planMode, permissionMode, setError, focusComposer: () => focusComposer(), restoreComposerFocus: origin => restoreComposerFocus(origin) });
  const { rememberModes, setPlan, answerPlan, noteStartedMode, saveEffort } = conversationSettings;
  /** Sends the composer's message, or `own`: a command's message (such as /init's prompt), sent without the composer's files.
   * While a turn runs, `followUp` steers or queues this one message instead of following Settings (Ctrl+Enter). */
  const send = createChatSend({ projectState, composer, conversations, runtime, attachments: attachmentState, drafts: draftStore, session, options, sendShell: () => sendShell(), askSideQuestion: question => askSideQuestion(question), restoreComposerFocus: origin => restoreComposerFocus(origin), readOnlyRun, editDraft, canSendFollowUp, imageBlocked, missingChoiceNotice, needsModelId, setError, newDraftKey, tabsRef, activeTurn, continues, preferences, newChoice, newWorktree, noteStartedMode, browser, assignProject, pending, loadThread });
  const sendShell = createShellSend({ composer, attachments: attachmentState, conversations, drafts: draftStore, projectState, runtime, session, options, newDraftKey, tabsRef, setError, newChoice, noteStartedMode, assignProject, browser, focusComposer: () => focusComposer() });
  const { replaceFrom, rewindFrom, deleteFrom, switchRewind, loadVersions, showVersion } = createMessageActions({ composer, conversations, drafts: draftStore, history, runtime, selectedRef, request, stickToBottom, rewindSwitch, replacementOptions, entries, nextTurn, submitDraft, setRuntimeNotices, setMessageEdits, setNextTurn, setEntries, setThreads, setRewindBusy, setRewindActions, setMessageVersions, loadThread, editDraft, focusComposer: () => focusComposer(), restoreComposerFocus: origin => restoreComposerFocus(origin) });
  const { approvalCardProps } = createApprovalActions({ approvals: approvalDrafts, submissions: approvalSubmissions, runtime, request, restoreComposerFocus: origin => restoreComposerFocus(origin) });
  const earlier = createEarlierMessages({ history, selected, selectedRef, request, setLoading, setError, setEntries, stickToBottom, scroll, restoreScroll });
  const openById = (id: string) => openThread(threads.find(thread => thread.id === id) || related[id] || { id });
  /** "Open in Elpis TUI": the chat opens here and its terminal resumes it in the TUI (`elpis resume <id>`). */
  const openInTui = (thread: Thread) => {
    if (selectedRef.current?.id !== thread.id || view !== "chat") void loadThread(thread);
    setTuiLaunch({ key: side.openTerminal(thread.cwd || cwd, thread.id), threadId: thread.id, token: Date.now() });
  };
  const setDesktopPrompt = useDesktopEntryPoints({ pages, composer, attachments: attachmentState, projectState, runtime, selected, busy, openById, newChat, send });
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
  const { askSideQuestion, recapConversation } = createSideChatActions({ session, readOnlyRun, sideRequests, setSideChat, setError });
  // Returning from a disappearing action must not override a field the person chose while it was pending.
  const restoreComposerFocus = (origin: Element | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === origin) focusComposer();
  });
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
  const { chooseEffort, startReview, compactChat, exportChat, turnSmartPruneOn, chooseFast, chooseGoal } = conversationCommands;
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
  const { workflowCatalog, workflowRoots, sidebarThreads, nativeParents, treeParents, searchedThreads, sidebarState, needsYou, ordinaryThreads, ordinaryIds, pinnedChats, grouped, recentChats, ordered } = sidebarModel;
  useWorkspaceShortcuts({ shortcutAction, selected, ordered, readOnlyRun, activeTurn, view, cwd, desktop, hasTerminal, side, sideChat, setSideChat, sidebar, sidebarCollapsed, activeTabId: tabs.activeId, commandReturnFocus, shortcutsReturnFocus, setCommandMenuOpen, setShortcutsOpen, setRenameRequest, setSettingsSection, newChat, stop, focusComposer, focusSearch, undoDelete: () => undoDelete(), showSidebar: open => showSidebar(open), narrow: () => narrow(), show, goHistory, loadThread, archiveChats: chats => archiveChats(chats), chosenChats: () => chosenChats(), togglePin: thread => togglePin(thread), moveToEdge: (id, top) => moveToEdge(id, top), newChatTab, closeChatTab, cycleTabs });
  const togglePin = (thread: Thread) => togglePinned(thread.id);
  const toggleBookmark = (thread: Thread) => toggleBookmarked(thread.id);
  /** Opens the shared delete confirmation for these chats. */
  const chatsOf = (ids: string[]) => ids.map(id => searchedThreads.find(thread => thread.id === id) ?? find(id)).filter((thread): thread is Thread => !!thread);
  /** What Ctrl+Shift+A and the command menu act on: the chats selected in the sidebar, or else the open chat. */
  const chosenChats = () => marked.length ? chatsOf(marked) : selected ? [selected] : [];
  /** These chats and the chats put under them (Put under…): those go wherever their chat goes. */
  const withNested = (ids: string[]) => chatSubtree(ids, treeParents);
  const { archiveChats, deleteChats, trashChats, undoDelete } = createChatDeletion({ conversations, preferences, selectedRef, shownWhenDeleted, withNested, chatsOf, find, archiveThread, rowLinks, setDeleteRunHistory, setDeleteTargets, setDeletedNotice, setError, noteKept, removeThreads, loadThread });
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
  const placement = createSidebarPlacement({ model: sidebarModel, projectState, children, chatGroups, updateGroups, foldsRef, changeFolds, pins, marked, setMarked, setNewGroupFor, setError, assignProject, newProjectFrom });
  const { groupMenu, movingIds, canNest, placementReveal, revealPlacement, nestChats, organizationActions } = placement;
  async function renameDisplayedThread(thread: Thread, name: string, runId = workflowRoots.get(thread.id)?.id) {
    if (!runId) { await renameThread(thread, name); return; }
    const problem = workflowCatalog.rename(runId, name);
    if (problem) throw Error(problem);
  }
  const { chatReorder, moveToEdge } = useChatReorder({ projectState, chatGroups, updateGroups, treeParents, pins, ordinaryThreads, ordinaryIds, pinnedChats, recentChats, grouped, movingIds, canNest, assignProject, nestChats, searchTerm, needsYou, sidebarState, setError });
  const threadRow = createSidebarThreadRow({ model: sidebarModel, runtime, loveActivity, attention, threads, selected, view, waitingIds, pins, bookmarks, marked, childCursors, searchTerm, agentColours, preferences, agentRunsOpen, setAgentRunsOpen, setExpanded, checkedChildren, setError, loadChildren, chatReorder, desktop, hasTerminal, pane: split.pane, windowAvailable, find, deleteChats, renameDisplayedThread, archiveChats, togglePin, toggleBookmark, openInTui, openSplit, openSessionWindow, organizationActions, attentionFor, chatsOf, groupMenu, movingIds, markRead, prefetchThread, openInNewTab, clickRow });
  const { chatActions, chatTab } = createWorkspaceChatTabs({ model: sidebarModel, placement, selected, view, tabs, marked, pins, bookmarks, renameRequest, pane: split.pane, hasTerminal, windowAvailable, find, chatsOf, attentionFor, deleteChats, renameDisplayedThread, archiveChats, togglePin, toggleBookmark, openInTui, openSplit, openSessionWindow, setRenameRequest, showTab, closeChatTab });
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
  return <DocumentReviewProvider onAttach={parts => attachFromBrowser(parts, false)}><LiveVoiceProvider><ReadAloud threadId="love-spot" enabled available={LOVE_SPOT_AUDIO.readAloudAvailable} unavailableReason={LOVE_SPOT_AUDIO.available ? undefined : LOVE_SPOT_AUDIO.reason}><div data-workspace={view} data-desktop={desktop || undefined} className={`app-shell${split.pane ? " session-pane" : ""}${split.thread && view === "chat" ? " session-split" : ""}${dark ? " dark" : ""} has-title-bar${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${panelShown ? " panel-active" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <title>{view === "canvas" ? "Workflows · Elpis" : view === "experimentLab" ? "Lab · Elpis" : view === "customize" ? "Customize — Elpis" : "Elpis"}</title>
    <WorkspaceTitleBar desktop={desktop} preferences={preferences} navHistory={navHistory} sidebar={sidebar} sidebarCollapsed={sidebarCollapsed} panelShown={panelShown} panelDrawer={panelDrawer} setError={setError} newChat={newChat} goHistory={goHistory} addProject={addProject} show={show} showSidebar={showSidebar} narrow={narrow} shortcutAction={shortcutAction} />
    <ProfileDialog ready={ready && connected} />
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} returnFocus={shortcutsReturnFocus} />
    {commandMenuOpen && <CommandMenu threads={ordinaryThreads} projects={busy || projectChanging ? [] : projects} actions={commandActions} returnFocus={commandReturnFocus} onClose={() => setCommandMenuOpen(false)} onThread={thread => { void openThread(thread); }} onProject={item => { void selectProject(item).catch(cause => setError(errorText(cause))); }} onNewChat={prompt => { newChat(); setDesktopPrompt(prompt); }} />}
    {desktop && <StartupSplash onLeaving={() => {
      if (view === "chat" && selected && (!ready || !connected) && !panelShown && !split.thread && window.matchMedia("(min-width: 1101px)").matches) holdAgentPanel(selected);
    }} />}
    <WorkspaceOrganizationDialogs projectState={projectState} dialogs={dialogs} model={sidebarModel} groups={groups} selection={selection} placement={placement} actions={projectActions}>
      <ResumeConversation open={resumeOpen} chats={sidebarThreads} returnFocus={composerRef} onClose={() => setResumeOpen(false)} onChoose={thread => { setResumeOpen(false); void openThread(thread); }} />
    </WorkspaceOrganizationDialogs>
    <DeleteChatsDialog threads={deleteTargets} trash={trashChats} alwaysConfirm={deleteRunHistory} onClose={() => { setDeleteTargets(null); setDeleteRunHistory(false); }} />
    <RewindDialog threadId={selected?.id} turnId={rewindTurn} prompt={rewindTurn ? turnEntries.get(rewindTurn)?.find(entry => entry.item.type === "userMessage")?.item.content?.map(part => part.text ?? "").join("\n") ?? "" : ""} turns={rewindTurn ? Math.max(1, turnEntries.size - [...turnEntries.keys()].indexOf(rewindTurn)) : null} onConfirm={(mode, version) => rewindFrom(rewindTurn!, mode, version)} onClose={() => setRewindTurn(null)} />
    <WorkspaceSidebar sidebar={sidebar} sidebarKeys={sidebarKeys} appearance={appearance} pages={pages} preferences={preferences} projectState={projectState} runtime={runtime} loveActivity={loveActivity} search={search} searchInput={searchInput} selected={selected} arrangedPages={arrangedPages} pageReorder={pageReorder} show={show} showSidebar={showSidebar} focusComposer={focusComposer} openSettings={openSettings} newChat={newChat}>
      <SidebarChatList model={sidebarModel} projectState={projectState} search={search} browser={browser} browserPins={browserPins} preferences={preferences} chatGroups={chatGroups} updateGroups={updateGroups} setAttention={setAttention} conversations={conversations} threadList={threadList} listKeys={listKeys} collapsedSections={collapsedSections} collapsedProjects={collapsedProjects} expanded={expanded} pins={pins} setCollapsedProjects={setCollapsedProjects} chatReorder={chatReorder} projectReorder={projectReorder} foldable={foldable} addProject={addProject} removeProject={removeProject} selectProject={selectProject} chatRows={chatRows} chatGroupSection={chatGroupSection} threadRow={threadRow} descendants={descendants} threadBranch={threadBranch} runDescendants={runDescendants} show={show} ready={ready} busy={busy} threads={threads} agentRunsOpen={agentRunsOpen} setAgentRunsOpen={setAgentRunsOpen} />
    </WorkspaceSidebar>
    <main className={`workspace${view === "chat" && selectedLoveChat ? " love-chat accent-scope" : ""}`} style={panelShown && !fullView ? { "--side-min": `${sideMinWidth(side.shown)}px`, ...(side.width ? { "--side-w": `clamp(${sideMinWidth(side.shown)}px, ${side.width}px, 70%)` } : {}) } as CSSProperties : undefined}>
      <WorkspaceHeader pages={pages} preferences={preferences} composer={composer} loveActivity={loveActivity} side={side} split={split} tabs={tabs} selected={selected} threads={threads} outsideChatApprovals={outsideChatApprovals} pendingInputButton={pendingInputButton} pendingInputOpen={pendingInputOpen} setPendingInputOpen={setPendingInputOpen} heading={heading} meta={meta} dark={dark} desktop={desktop} loading={loading} panelShown={panelShown} team={team} awaitingTeam={awaitingTeam} agentsPanel={agentsPanel} setAgentsPanelState={setAgentsPanelState} setLoveToolbarHost={setLoveToolbarHost} find={find} show={show} showSidebar={showSidebar} openById={openById} loadThread={loadThread} newChatTab={newChatTab} openAgentsPanel={openAgentsPanel} chatTab={chatTab} chatActions={chatActions} />
      {outsideChatApprovals.length > 0 && pendingInputOpen && <PendingInputPanel approvals={outsideChatApprovals} threads={threads} button={pendingInputButton} setOpen={setPendingInputOpen} openById={id => { void openById(id); }} approvalCardProps={approvalCardProps} />}
      <div className={`workspace-body${panelShown ? " panel-open" : ""}${fullView ? ` full-view${side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${view !== "chat" ? " no-browser" : ""}`}><div className="workspace-content" {...(fullView ? { role: "region", "aria-label": "Floating chat" } : {})}>
      {fullView && <FloatChatBar title={chatName} onCollapse={() => side.setChatCollapsed(true)} />}
      <WorkspaceSettings pages={pages} selected={selected} permissionMode={permissionMode} appearance={appearance} conversations={conversations} runtime={runtime} unarchived={unarchived} deleteThread={deleteThread} browser={browser} busy={busy} show={show} focusComposer={focusComposer} openComposerControl={openComposerControl} refreshModels={refreshModels} />
      <WorkspaceGuideAndLab view={view} show={show} />
      <WorkflowPages pages={pages} sidebarModel={sidebarModel} projectState={projectState} runtime={runtime} threads={threads} models={models} workflowFolder={workflowFolder} workflowSandbox={workflowSandbox} dark={dark} show={show} openById={id => { void openById(id); }} keepWorkflowTab={keepWorkflowTab} selectProject={selectProject} addProject={addProject} workIn={workIn} finishReplay={finishReplay} />
      <OtherWorkspacePages view={view} selected={selected} threads={threads} cwd={cwd} dark={dark} loveToolbarHost={loveToolbarHost} side={side} hasTerminal={hasTerminal} setTuiLaunch={setTuiLaunch} show={show} openSettings={openSettings} newChat={newChat} editDraft={editDraft} />
      {view === "chat" && <ViewBoundary label="Chat" resetKey={selected?.id}><div className="chat-split"><div className={`chat-view${!selected && !shownEntries.length ? " empty-chat" : ""}`} data-team-loading={awaitingTeam || undefined}>
        <WorkspaceTranscript session={session} runtime={runtime} history={history} projectState={projectState} pages={pages} sidebarModel={sidebarModel} selectedModel={selectedModel} replacement={replacement} earlier={earlier} personal={personal} shownEntries={shownEntries} models={models} chatConversation={chatConversation} workingHost={workingHost} activeTurn={activeTurn} proposedPlan={proposedPlan} permissionMode={permissionMode} error={error} dark={dark} awaitingTeam={awaitingTeam} continues={continues} readOnlyRun={readOnlyRun} selectProject={selectProject} addProject={addProject} replaceFrom={replaceFrom} answerPlan={answerPlan} approvalCardProps={approvalCardProps} openById={openById} show={show} />
        <WorkspaceComposer session={session} runtime={runtime} projectState={projectState} sideChat={sideChat} setSideChat={setSideChat} panel={panel} setPanel={setPanel} sessionRows={sessionRows} closePanel={closePanel} openSettings={openSettings} startReview={startReview} visibleSlashNotice={visibleSlashNotice} fastSuccess={fastSuccess} slashNotice={slashNotice} setSlashNotice={setSlashNotice} selectedLiveError={selectedLiveError} setError={setError} restoreComposerFocus={restoreComposerFocus} editQueued={editQueued} send={send} focusComposer={focusComposer} activeTurn={activeTurn} chatFolder={chatFolder} newWorktree={newWorktree} setNewWorktree={setNewWorktree} readOnlyRun={readOnlyRun} setWorkingHost={setWorkingHost} continueHere={continueHere} selectProject={selectProject} addProject={addProject} moveChat={moveChat} moveChatToFolder={moveChatToFolder}>
          <WorkspaceComposerInput session={session} options={options} composer={composer} attachmentsState={attachmentState} drafts={draftStore} runtime={runtime} projectState={projectState} pages={pages} preferences={preferences} selectedModel={selectedModel} settings={conversationSettings} commands={conversationCommands} slash={slash} mention={mention} promptKeys={promptKeys} models={models} settingsSnapshot={settingsSnapshot} providerSettings={providerSettings} newDraftKey={newDraftKey} permissionMode={permissionMode} planMode={planMode} activeTurn={activeTurn} readOnlyRun={readOnlyRun} continues={continues} sendBlocked={sendBlocked} imageBlocked={imageBlocked} selectedLoveChat={selectedLoveChat} loveSpotAudioReason={loveSpotAudioReason} send={send} sendShell={sendShell} stop={stop} editDraft={editDraft} focusComposer={focusComposer} show={show} />
        </WorkspaceComposer>
      </div>
      {selected && teamRoot && team.length > 0 && agentsPanel && !panelShown && <ChatTeamPanel selected={selected} teamRoot={teamRoot} team={team} workingTeam={workingTeam} shownTeam={shownTeam} workingAgentsOnly={workingAgentsOnly} setWorkingAgentsOnly={setWorkingAgentsOnly} waitingIds={waitingIds} activity={activity} models={models} agentColours={agentColours} openById={openById} openThread={openThread} />}
      </div></ViewBoundary>}
      </div>{fullView && side.chatCollapsed && <FloatChatPill title={chatName} state={floatState} onRestore={() => side.setChatCollapsed(false)} />}{desktop && <SidePanel panel={side} browser={browser} hasTerminal={hasTerminal} dark={dark} cwd={selected?.cwd || cwd} threadId={selected?.id} running={!!activeTurn} launch={tuiLaunch} covered={pendingInputOpen || sidebar || view !== "chat"} onAttach={attachFromBrowser} imagesAllowed={!(knownModel?.inputModalities && !knownModel.inputModalities.includes("image"))} />}</div>
      <WorkspaceNotices connection={!ready || !connected ? connectionStatus : undefined} deleted={deletedNotice} onUndoDelete={() => void undoDelete()} onDismissDeleted={() => setDeletedNotice(null)}
        rewind={selected && rewindActions[selected.id] && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1">Your files stay as they are.</span><Button variant="outline" size="sm" disabled={rewindBusy || !!activeTurn} onClick={() => void switchRewind({ action: rewindActions[selected.id]! }).catch(cause => setError(String(cause)))}>{rewindActions[selected.id] === "undo" ? "Undo rewind" : "Redo rewind"}</Button></div>}
        error={error && !(refusedOffline(error) && !connected) ? error : undefined} onDismissError={() => setError("")}
        worktree={worktreeNotice} onDismissWorktree={() => setWorktreeNotice("")} loadingModels={catalogLoading && !catalogError && !models.length}
        conversationError={selected ? runtimeNotices[selected.id] : undefined} onDismissConversationError={() => selected && setRuntimeNotices(prev => without(prev, selected.id))}
        recovery={<WorkspaceRecovery session={session} composer={composer} attachmentsState={attachmentState} drafts={draftStore} editDraft={editDraft} />} />
      {split.thread && view === "chat" && <iframe key={split.thread.id} ref={split.frame} className="split-session" title="Split session" src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`} />}
    </main>
  </div></ReadAloud></LiveVoiceProvider></DocumentReviewProvider>;
}
