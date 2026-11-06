"use client";

import { flushSync } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ViewBoundary } from "@/components/view-boundary";
import { useAppearance } from "@/lib/use-appearance";
import { CommandMenu } from "@/components/command-menu";
import { newChatFolder } from "@/lib/preferences";
import { usePromptKeys } from "@/lib/prompt-history";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StartupSplash } from "@/components/startup-splash";
import { DeleteChatsDialog } from "@/components/thread-actions";
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
import { ReadAloud } from "@/components/read-aloud";
import { LiveVoiceProvider } from "@/components/live-voice";
import { ProfileDialog } from "@/components/profile-dialog";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { DocumentReviewProvider } from "@/components/document-review";
import { ChatTeamPanel } from "@/components/chat-team-panel";
import { ResumeConversation } from "@/components/resume-conversation";
import { sidebarListKeys, useSidebarKeys, useWorkspaceNavigation } from "@/lib/use-workspace-navigation";
import { agentState } from "@/lib/agents";
import { openFile, setFileView } from "@/lib/files-pane";
import { usePersonal } from "@/components/personal-tip";
import { SidePanel, sideMinWidth } from "@/components/side-panel";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { useSessionSplit } from "@/components/session-split";
import { title, agentName,
  type Thread } from "@/lib/api";
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
import { createSidebarPlacement } from "@/lib/sidebar-placement";
import { createApprovalActions } from "@/lib/approval-actions";
import { createShellSend } from "@/lib/shell-send";
import { createClearConversation } from "@/lib/clear-conversation";
import { useTurnReplacementView } from "@/lib/use-turn-replacement-view";
import { useDesktopEntryPoints } from "@/lib/use-desktop-entry-points";
import { createPromptEditing } from "@/lib/prompt-editing";
import { createSideChatActions } from "@/lib/side-chat-actions";
import { useWorkspaceRestoration } from "@/lib/use-workspace-restoration";
import { useChatTeam } from "@/lib/use-chat-team";
import { useWorkspaceShortcuts } from "@/lib/use-workspace-shortcuts";
import { useWorkflowWorkspace } from "@/lib/use-workflow-workspace";
import { createSidebarChatSelection } from "@/lib/sidebar-chat-selection";
import { useWorkspaceOrder } from "@/lib/use-workspace-order";
import { useRewindState, useRewindStatus } from "@/lib/use-rewind-state";
import { useRemoveThreads } from "@/lib/use-remove-threads";
import { createWorkspaceCommandMenu } from "@/lib/workspace-command-menu";
import { conversationStatus } from "@/lib/conversation-status";
import { useChatTabTitles } from "@/lib/use-chat-tab-titles";
import { createBrowserAttachment } from "@/lib/browser-attachments";
import { sessionRows as makeSessionRows } from "@/lib/session-rows";
import { useCommandNotices } from "@/lib/use-command-notices";
import { useConversationView } from "@/lib/use-conversation-view";
import { useComposerPanels, useComposerPanelScope } from "@/lib/use-composer-panels";
import { useLoveWorkspace, useReadLoveNotifications } from "@/lib/use-love-workspace";
import { useWorkspacePanels } from "@/lib/use-workspace-panels";
import { createSidebarAttention } from "@/lib/sidebar-attention";
import { WorkspaceAlertArea } from "@/components/workspace-alert-area";
import { useLoveScreenshots } from "@/lib/use-love-screenshots";
import { PAGE_NAMES } from "@/lib/workspace-navigation-pages";
import { useComposerAttachments } from "@/lib/use-composer-attachments";
import { useComposerState } from "@/lib/use-composer-state";
import { useApprovalDrafts, useDraftStore, useSubmitOnce } from "@/lib/use-drafts";
import { sessionWindowApi, useDesktopCapabilities } from "@/lib/use-desktop-capabilities";
import { useSidebarSearch } from "@/lib/use-sidebar-search";
import { createWorkspaceChatTabs } from "@/components/workspace-chat-tabs";
import { WorkspaceOrganizationDialogs } from "@/components/workspace-organization-dialogs";
import { errorText } from "@/lib/error-text.mjs";
import { useWorkspaceStores } from "@/lib/use-workspace-stores";
import { useWorkspaceSidebarState } from "@/lib/use-workspace-sidebar-state";
import { createWorkspaceControls } from "@/lib/workspace-controls";



export default function Home() {
  const { preferences, session, chatTabs, models: workspaceModels, options, projectState, pages } = useWorkspaceStores(message => setError(message));
  const hiddenPages = preferences.hiddenPages.split(",");
  const { threads, setThreads, selected, setSelected, selectedRef, entries, setEntries, busy, setBusy, loading, setLoading, scroll, stickToBottom, restoreScroll, request, initialRestoration } = session;
  const { tabs, tabsRef, updateTabs, restoreTabs, restored: restoredTabs } = chatTabs;
  const { catalog, models, settingsSnapshot, providerSettings, refreshModels } = workspaceModels;
  const { choiceId, model, effort, setEffort, nextTurn, setNextTurn, threadModes, setThreadModes } = options;
  const { cwd, projects, projectChats, projectChanging } = projectState;
  const { recordedWorkflow, view, setView, viewRef, setSettingsSection } = pages;
  const sidebarStateStores = useWorkspaceSidebarState(session, options, thread => openSplit(thread), thread => openThread(thread));
  const { pins, togglePinned, bookmarks, toggleBookmarked, releaseChatOrder, groups, dialogs, notices, attentionState, selection, foldsState, collapsedProjects, collapsedSections, foldable } = sidebarStateStores;
  const { chatGroups, chatGroupsRef, updateGroups, commitGroups } = groups;
  const { setNewGroupFor, deleteTargets, setDeleteTargets, deleteRunHistory, setDeleteRunHistory, shownWhenDeleted, shortcutsOpen, setShortcutsOpen, commandMenuOpen, setCommandMenuOpen, commandReturnFocus, shortcutsReturnFocus, renameRequest, setRenameRequest, resumeOpen, setResumeOpen } = dialogs;
  const { error, setError, setDeletedNotice, noteKept } = notices;
  const { attention, setAttention, planTurns, markRead } = attentionState;
  const { marked, setMarked, threadList, rowLinks, clickRow } = selection;
  const { foldsRef, changeFolds, setCollapsedProjects } = foldsState;
  const rewindState = useRewindState(), { rewindTurn, setRewindTurn, setRewindActions, messageVersions, setMessageVersions, setRewindBusy, rewindSwitch } = rewindState;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const panels = useComposerPanels();
  const { panel, setPanel, slashNotice, setSlashNotice, queuedCompact, setQueuedCompact, newWorktree, setNewWorktree, sideChat, setSideChat, sideRequests } = panels;
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  const composer = useComposerState();
  const { text, setText, shellMode, textRef, composerRef, caret, setCaret, pickedMentions, dictating, voiceBusy } = composer;
  const [agentRunsOpen, setAgentRunsOpen] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const approvalSubmissions = useSubmitOnce(), { pending: pendingDrafts, submit: submitDraft } = approvalSubmissions;
  const approvalDrafts = useApprovalDrafts(), { clearApprovalDraft } = approvalDrafts;
  const draftStore = useDraftStore(setError), { saveDraft, savedAttachments, saveAttachments } = draftStore;
  const newDraftKey = useRef("new");
  const runtime = useRuntimeState();
  const { connected, ready, setRuntimeNotices, activity } = runtime;
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  const editDraft = (value: string) => { setText(value); saveDraft(selectedRef.current?.id || newDraftKey.current, value); };
  const attachmentState = useComposerAttachments({ selectedRef, newDraftKey, shellMode, savedAttachments, saveAttachments, setError, setRuntimeNotices });
  const { attachments, attaching, setAttachments } = attachmentState;
  const attachFromBrowser = createBrowserAttachment({ session, composer, attachments: attachmentState, drafts: draftStore, newDraftKey, showChat: () => showChat(), send: () => send() });
  useComposerHeight(composerRef, [text, selected?.id, view]);
  const { loveActivity, loveRef, isLoveChatId, selectedLoveChat, loveSpotAudioReason } = useLoveWorkspace(view, ready, selected, () => threadsRef.current);
  const { finishReplay, workflowSandbox, workflowFolder } = useWorkflowWorkspace(view, projectState, runtime, setError);
  useReadLoveNotifications(loveActivity.chatShown, setAttention, isLoveChatId);
  useEffect(() => { if (view === "chat" && selected) markRead(selected.id); }, [view, selected?.id, markRead]);
  const { desktop, windowAvailable, hasTerminal } = useDesktopCapabilities();
  const workspacePanels = useWorkspacePanels({ selected, cwd, activeTabId: tabs.activeId, desktop, pages, setError, setSidebarCollapsed, searchInput: () => searchInput.current });
  const { browser, side, browserPins, tuiLaunch, setTuiLaunch, panelShown, fullView, pendingInputOpen, setPendingInputOpen, pendingInputButton, sidebar, setSidebar, panelDrawer, showChat, show, narrow, showSidebar, focusSearch } = workspacePanels;
  const [agentsPanelState, setAgentsPanelState] = useState<{ open: boolean; held: ReadonlySet<string> }>({ open: true, held: new Set() });
  const [workingAgentsOnly, setWorkingAgentsOnly] = useState(true);
  const [loveToolbarHost, setLoveToolbarHost] = useState<HTMLDivElement | null>(null);
  const [workingHost, setWorkingHost] = useState<HTMLDivElement | null>(null);
  const appearance = useAppearance(setError);
  const { dark, sidebarWidth } = appearance;
  // The website's animated wordmark, its dark or light version (website/assets/branding).
  const searchInput = useRef<HTMLInputElement>(null);
  const history = useTranscriptHistory(selected, loading, entries, setEntries);
  const { itemCursor, prefetchThread } = history;
  const conversations = useConversationList(threads, setThreads, selectedRef, setSelected, setError);
  const { threadsRef, hidden } = conversations;
  const children = useChildConversations({ conversations, selectedRef, setThreads, setError, setAgentsPanelState });
  const { loadingChildren, checkedChildren, childCursors, expanded, setExpanded, holdAgentPanel, loadChildren } = children;
  const search = useSidebarSearch(ready, hidden), searchTerm = search.searchTerm;

  const removeThreads = useRemoveThreads({ session, conversations, history, composer, attachments: attachmentState, drafts: draftStore, selection, runtime, tabs: chatTabs, browser, newDraftKey, setMessageEdits });
  const { rememberFollowing, reconcileLiveThread, loadThread, openThread } = useOpenConversation({ composer, runtime, conversations, history, drafts: draftStore, attachments: attachmentState, tabsRef, updateTabs, session, newDraftKey, markRead, setView, setSidebar, setError, rememberModes: (id, live) => rememberModes(id, live) });

  useWorkspaceRestoration({ projects: projectState, composer, attachments: attachmentState, drafts: draftStore, newDraftKey, restoreTabs, setError });
  useWorkspaceNavigation(shortcutAction);
  useRuntimeEvents({ history, conversations, runtime, selectedRef, request, tabsRef, refreshModels, setError, initialRestoration, rememberFollowing, rememberModes: (id, live) => rememberModes(id, live), reconcileLiveThread, restoredTabs, loadThread, openThread, viewRef, planTurns, setAttention, loveRef, isLoveChatId, setRewindActions, setThreadModes, rewindSwitch, removeThreads, setEntries, clearApprovalDraft });

  const { selectedLiveError, related, shownEntries, newestPrompt } = useConversationView({ session, runtime, history, conversations, children, view, showAgentRuns: preferences.showAgentRuns, agentRunsOpen, newDraftKey });

  const { activeTurn, permissionMode, planMode, proposedPlan, outsideChatApprovals, readOnlyRun, continues } = conversationStatus(session, options, runtime, providerSettings, view);
  useRewindStatus(ready, connected, selected?.id, activeTurn, setRewindActions, (id, disposed) => loadVersions(id, disposed));
  const selectedModel = modelSelection({ models, providerSettings, selected, choiceId, model, effort, nextTurn });
  const { newChoice, missingChoiceNotice, needsModelId, pending, turnModel, turnEfforts, turnEffort, knownModel, fastOn } = selectedModel;
  const commandNoticeScope = JSON.stringify([view, tabs.activeId, selected?.id ?? newDraftKey.current]);
  const { commandNoticeOwner, fastNoticeOwner, fastSuccess, visibleSlashNotice } = useCommandNotices(commandNoticeScope, slashNotice, setSlashNotice, fastOn);
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const canSendFollowUp = !!selected && !!activeTurn && !continues;
  const sendBlocked = readOnlyRun || (!text.trim() && !attachments.length) || (busy && (!canSendFollowUp || shellMode)) || dictating || attaching || imageBlocked || !ready || !connected || (!shellMode && (!!missingChoiceNotice || needsModelId && !model.trim()));

  const find = useChatTabTitles(session, chatTabs, related, ready);
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
  useLoveScreenshots(ready, show, setError);
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
  const { openInTui, openSettings, focusComposer, restoreComposerFocus, openComposerControl, closePanel } = createWorkspaceControls({ session, composer, panels, pages, workspacePanels, cwd, loadThread });
  const setDesktopPrompt = useDesktopEntryPoints({ pages, composer, attachments: attachmentState, projectState, runtime, selected, busy, openById, newChat, send });
  const { beginReply, beginImageReply, editQueued } = createReplyActions({ composer, attachmentsState: attachmentState, drafts: draftStore, runtime, selectedRef, newDraftKey, readOnlyRun, focusComposer, editDraft });
  // The transcript is redrawn only when what it shows changes, not on every keystroke in the message box; its
  // handlers call the current render's functions through a ref, so a reused row never calls a stale one.
  const live = useRef({ openById, focusComposer, replaceFrom, forkFrom, showVersion, setRewindTurn, deleteFrom, setMessageEdits, setError, beginReply, beginImageReply });
  live.current = { openById, focusComposer, replaceFrom, forkFrom, showVersion, setRewindTurn, deleteFrom, setMessageEdits, setError, beginReply, beginImageReply };
  const versionsShown = selected ? messageVersions[selected.id] : undefined;
  const chatConversation = useConversationTranscript({ live, selected, shownEntries, activeTurn, desktop, openChanges: side.openChanges, threads, messageEdits, pendingDrafts, replaceable, replacementOptions, replacementOptionsKey, readOnlyRun, versionsShown, newestPrompt, regenerate, connected, voiceBusy, loveSpotAudioReason });
  const { askSideQuestion, recapConversation } = createSideChatActions({ session, readOnlyRun, sideRequests, setSideChat, setError });
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
  const sessionRows = makeSessionRows(session, selectedModel, models, providerSettings, permissionMode, chatFolder);
  const slashCommands = createSlashCommands({ selected, askSideQuestion, readOnlyRun, recapConversation, chooseGoal, busy, openComposerControl, chooseFast, turnEfforts, chooseEffort, openSettings, personal, writable, idle, startReview, setPanel, renameThread, setError, setRenameRequest, newChat, clearChat, archiveChats: chats => archiveChats(chats), deleteChats: (ids, focusAt) => deleteChats(ids, focusAt), setResumeOpen, lastTurn, activeTurn, forkFrom, continues, send, compactChat, setQueuedCompact, setSlashNotice, turnSmartPruneOn, planMode, setPlan, team, panelShown, openAgentsPanel, entries, exportChat, chatFolder });
  const slash = useSlashMenu(ready && connected ? text : "", slashCommands, () => { editDraft(""); setPanel(null); setSlashNotice(""); });
  const mention = useMentionMenu({ text, caret, cwd: chatFolder || undefined, threads, currentId: selected?.id,
    onPick: result => { pickedMentions.current.set(result.mention.path, result.mention); flushSync(() => editDraft(result.text)); setCaret(result.caret); composerRef.current?.setSelectionRange(result.caret, result.caret); } });
  useComposerPanelScope(panels, composer, selected?.id, view);

  const sidebarModel = useSidebarThreads({ ready, connected, threads, hidden, selected, chatGroups, loveActivity, expanded, setExpanded, recordedWorkflow, loadChildren, search, attention, waitingIds, pins, projectChats, releaseChatOrder, searchInput, setError, setDeleteRunHistory, setDeleteTargets, hiddenPages, preferences, collapsedSections, collapsedProjects, checkedChildren, agentRunsOpen });
  const { workflowCatalog, workflowRoots, sidebarThreads, nativeParents, treeParents, sidebarState, needsYou, ordinaryThreads, ordinaryIds, pinnedChats, grouped, recentChats, ordered } = sidebarModel;
  useWorkspaceShortcuts({ shortcutAction, selected, ordered, readOnlyRun, activeTurn, view, cwd, desktop, hasTerminal, side, sideChat, setSideChat, sidebar, sidebarCollapsed, activeTabId: tabs.activeId, commandReturnFocus, shortcutsReturnFocus, setCommandMenuOpen, setShortcutsOpen, setRenameRequest, setSettingsSection, newChat, stop, focusComposer, focusSearch, undoDelete: () => undoDelete(), showSidebar: open => showSidebar(open), narrow: () => narrow(), show, goHistory, loadThread, archiveChats: chats => archiveChats(chats), chosenChats: () => chosenChats(), togglePin: thread => togglePin(thread), moveToEdge: (id, top) => moveToEdge(id, top), newChatTab, closeChatTab, cycleTabs });
  const togglePin = (thread: Thread) => togglePinned(thread.id);
  const toggleBookmark = (thread: Thread) => toggleBookmarked(thread.id);
  const { chatsOf, chosenChats, withNested } = createSidebarChatSelection(sidebarModel, selection, selected, find);
  const { archiveChats, deleteChats, trashChats, undoDelete } = createChatDeletion({ conversations, preferences, selectedRef, shownWhenDeleted, withNested, chatsOf, find, archiveThread, rowLinks, setDeleteRunHistory, setDeleteTargets, setDeletedNotice, setError, noteKept, removeThreads, loadThread });
  const sidebarKeys = useSidebarKeys();
  const listKeys = (event: React.KeyboardEvent<HTMLDivElement>) => sidebarListKeys(event, marked, () => setMarked([]), attentionFor, deleteChats, rowLinks);
  const attentionFor = createSidebarAttention(attentionState, options);
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
  const { arrangedPages, pageReorder, projectReorder } = useWorkspaceOrder(preferences, hiddenPages, projectState, setError);
  const commandActions = createWorkspaceCommandMenu({ preferences, session, selection, dialogs, shortcutAction, pins, hiddenPages, desktop, hasTerminal, projectChanging, show });

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
      <WorkspaceAlertArea notices={notices} session={session} runtime={runtime} composer={composer} attachments={attachmentState} drafts={draftStore} rewind={rewindState} catalog={catalog} activeTurn={activeTurn} undoDelete={undoDelete} switchRewind={switchRewind} editDraft={editDraft} />
      {split.thread && view === "chat" && <iframe key={split.thread.id} ref={split.frame} className="split-session" title="Split session" src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`} />}
    </main>
  </div></ReadAloud></LiveVoiceProvider></DocumentReviewProvider>;
}
