"use client";

import { useEffect, useRef, useState } from "react";
import { useAppearance } from "@/lib/use-appearance";
import { useComposerHeight } from "@/lib/use-composer-height";
import { useTranscriptHistory } from "@/lib/use-transcript-history";
import { useConversationList } from "@/lib/use-conversation-list";
import { useRuntimeState } from "@/lib/use-runtime-state";
import { useChildConversations } from "@/lib/use-child-conversations";
import { type AgentPanelState } from "@/lib/use-chat-team";
import { useWorkflowWorkspace } from "@/lib/use-workflow-workspace";
import { useRewindState } from "@/lib/use-rewind-state";
import { useRemoveThreads } from "@/lib/use-remove-threads";
import { createBrowserAttachment } from "@/lib/browser-attachments";
import { useComposerPanels } from "@/lib/use-composer-panels";
import { useLoveWorkspace, useReadLoveNotifications } from "@/lib/use-love-workspace";
import { useWorkspacePanels } from "@/lib/use-workspace-panels";
import { useComposerAttachments } from "@/lib/use-composer-attachments";
import { useComposerState } from "@/lib/use-composer-state";
import { useApprovalDrafts, useDraftStore, useSubmitOnce } from "@/lib/use-drafts";
import { useDesktopCapabilities } from "@/lib/use-desktop-capabilities";
import { useSidebarSearch } from "@/lib/use-sidebar-search";
import { useWorkspaceStores } from "@/lib/use-workspace-stores";
import { useWorkspaceSidebarState } from "@/lib/use-workspace-sidebar-state";
import type { WorkspaceForward } from "@/components/workspace-forward";

export function useWorkspaceState() {
  // Closures here call things later layers declare; each layer fills in its own during render.
  const forward = {} as WorkspaceForward;
  const {
    preferences,
    session,
    chatTabs,
    models: workspaceModels,
    options,
    projectState,
    pages,
  } = useWorkspaceStores(message => setError(message));
  const hiddenPages = preferences.hiddenPages.split(",");
  const {
    threads,
    setThreads,
    selected,
    setSelected,
    selectedRef,
    entries,
    setEntries,
    busy,
    setBusy,
    loading,
    setLoading,
    scroll,
    stickToBottom,
    restoreScroll,
    request,
    initialRestoration,
  } = session;
  const { tabs, tabsRef, updateTabs, restoreTabs, restored: restoredTabs } = chatTabs;
  const { catalog, models, settingsSnapshot, providerSettings, refreshModels } = workspaceModels;
  const { choiceId, model, effort, setEffort, nextTurn, setNextTurn, threadModes, setThreadModes } = options;
  const { cwd, projectChats, projectChanging } = projectState;
  const { recordedWorkflow, view, setView, viewRef, setSettingsSection } = pages;
  const sidebarStateStores = useWorkspaceSidebarState(
    session,
    options,
    thread => forward.openSplit(thread),
    thread => forward.openThread(thread),
  );
  const {
    pins,
    togglePinned,
    bookmarks,
    toggleBookmarked,
    releaseChatOrder,
    groups,
    dialogs,
    notices,
    attentionState,
    selection,
    foldsState,
    collapsedProjects,
    collapsedSections,
    foldable,
  } = sidebarStateStores;
  const { chatGroups, chatGroupsRef, updateGroups, commitGroups } = groups;
  const {
    deleteTargets,
    setDeleteTargets,
    deleteRunHistory,
    setDeleteRunHistory,
    shownWhenDeleted,
    setShortcutsOpen,
    setCommandMenuOpen,
    commandReturnFocus,
    shortcutsReturnFocus,
    renameRequest,
    setRenameRequest,
    resumeOpen,
    setResumeOpen,
  } = dialogs;
  const { error, setError, setDeletedNotice, noteKept } = notices;
  const { attention, setAttention, planTurns, markRead } = attentionState;
  const { marked, setMarked, threadList, rowLinks, clickRow } = selection;
  const { foldsRef, changeFolds, setCollapsedProjects } = foldsState;
  const rewindState = useRewindState(),
    { rewindTurn, setRewindTurn, setRewindActions, messageVersions, setMessageVersions, setRewindBusy, rewindSwitch } =
      rewindState;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const panels = useComposerPanels();
  const {
    panel,
    setPanel,
    slashNotice,
    setSlashNotice,
    queuedCompact,
    setQueuedCompact,
    newWorktree,
    setNewWorktree,
    sideChat,
    setSideChat,
    sideRequests,
  } = panels;
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  const composer = useComposerState();
  const { text, setText, shellMode, textRef, composerRef, caret, setCaret, pickedMentions, dictating, voiceBusy } =
    composer;
  const [agentRunsOpen, setAgentRunsOpen] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const approvalSubmissions = useSubmitOnce(),
    { pending: pendingDrafts, submit: submitDraft } = approvalSubmissions;
  const approvalDrafts = useApprovalDrafts(),
    { clearApprovalDraft } = approvalDrafts;
  const draftStore = useDraftStore(setError),
    { saveDraft, savedAttachments, saveAttachments } = draftStore;
  const newDraftKey = useRef("new");
  const runtime = useRuntimeState();
  const { connected, ready, setRuntimeNotices, activity } = runtime;
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  const editDraft = (value: string) => {
    setText(value);
    saveDraft(selectedRef.current?.id || newDraftKey.current, value);
  };
  const attachmentState = useComposerAttachments({
    selectedRef,
    newDraftKey,
    shellMode,
    savedAttachments,
    saveAttachments,
    setError,
    setRuntimeNotices,
  });
  const { attachments, attaching } = attachmentState;
  const attachFromBrowser = createBrowserAttachment({
    session,
    composer,
    attachments: attachmentState,
    drafts: draftStore,
    newDraftKey,
    showChat: () => showChat(),
    send: () => forward.send(),
  });
  useComposerHeight(composerRef, [text, selected?.id, view]);
  const { loveActivity, loveRef, isLoveChatId, selectedLoveChat, loveSpotAudioReason } = useLoveWorkspace(
    view,
    ready,
    selected,
    () => threadsRef.current,
  );
  const { finishReplay, workflowSandbox, workflowFolder } = useWorkflowWorkspace(view, projectState, runtime, setError);
  useReadLoveNotifications(loveActivity.chatShown, setAttention, isLoveChatId);
  useEffect(() => {
    if (view === "chat" && selected) markRead(selected.id);
  }, [view, selected?.id, markRead]);
  const { desktop, windowAvailable, hasTerminal } = useDesktopCapabilities();
  const workspacePanels = useWorkspacePanels({
    selected,
    cwd,
    activeTabId: tabs.activeId,
    desktop,
    pages,
    setError,
    setSidebarCollapsed,
    searchInput: () => searchInput.current,
  });
  const {
    browser,
    side,
    browserPins,
    tuiLaunch,
    setTuiLaunch,
    panelShown,
    fullView,
    pendingInputOpen,
    setPendingInputOpen,
    pendingInputButton,
    sidebar,
    setSidebar,
    panelDrawer,
    showChat,
    show,
    narrow,
    showSidebar,
    focusSearch,
  } = workspacePanels;
  const [agentsPanelState, setAgentsPanelState] = useState<AgentPanelState>({ open: true, held: new Set() });
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
  const { loadingChildren, checkedChildren, childCursors, expanded, setExpanded, loadChildren } = children;
  const search = useSidebarSearch(ready, hidden),
    searchTerm = search.searchTerm;
  const removeThreads = useRemoveThreads({
    session,
    conversations,
    history,
    composer,
    attachments: attachmentState,
    drafts: draftStore,
    selection,
    runtime,
    tabs: chatTabs,
    browser,
    newDraftKey,
    setMessageEdits,
  });
  return {
    forward,
    preferences,
    session,
    chatTabs,
    options,
    projectState,
    pages,
    hiddenPages,
    threads,
    setThreads,
    selected,
    selectedRef,
    entries,
    setEntries,
    busy,
    setBusy,
    loading,
    setLoading,
    scroll,
    stickToBottom,
    restoreScroll,
    request,
    initialRestoration,
    tabs,
    tabsRef,
    updateTabs,
    restoreTabs,
    restoredTabs,
    catalog,
    models,
    settingsSnapshot,
    providerSettings,
    refreshModels,
    choiceId,
    model,
    effort,
    setEffort,
    nextTurn,
    setNextTurn,
    threadModes,
    setThreadModes,
    cwd,
    projectChats,
    projectChanging,
    recordedWorkflow,
    view,
    setView,
    viewRef,
    setSettingsSection,
    pins,
    togglePinned,
    bookmarks,
    toggleBookmarked,
    releaseChatOrder,
    groups,
    dialogs,
    notices,
    attentionState,
    selection,
    collapsedProjects,
    collapsedSections,
    foldable,
    chatGroups,
    chatGroupsRef,
    updateGroups,
    commitGroups,
    deleteTargets,
    setDeleteTargets,
    deleteRunHistory,
    setDeleteRunHistory,
    shownWhenDeleted,
    setShortcutsOpen,
    setCommandMenuOpen,
    commandReturnFocus,
    shortcutsReturnFocus,
    renameRequest,
    setRenameRequest,
    resumeOpen,
    setResumeOpen,
    error,
    setError,
    setDeletedNotice,
    noteKept,
    attention,
    setAttention,
    planTurns,
    markRead,
    marked,
    setMarked,
    threadList,
    rowLinks,
    clickRow,
    foldsRef,
    changeFolds,
    setCollapsedProjects,
    rewindState,
    rewindTurn,
    setRewindTurn,
    setRewindActions,
    messageVersions,
    setMessageVersions,
    setRewindBusy,
    rewindSwitch,
    sidebarCollapsed,
    panels,
    panel,
    setPanel,
    slashNotice,
    setSlashNotice,
    queuedCompact,
    setQueuedCompact,
    newWorktree,
    setNewWorktree,
    sideChat,
    setSideChat,
    sideRequests,
    shortcutAction,
    composer,
    text,
    shellMode,
    textRef,
    composerRef,
    caret,
    setCaret,
    pickedMentions,
    dictating,
    voiceBusy,
    agentRunsOpen,
    setAgentRunsOpen,
    messageEdits,
    setMessageEdits,
    approvalSubmissions,
    pendingDrafts,
    submitDraft,
    approvalDrafts,
    clearApprovalDraft,
    draftStore,
    newDraftKey,
    runtime,
    connected,
    ready,
    setRuntimeNotices,
    activity,
    editDraft,
    attachmentState,
    attachments,
    attaching,
    attachFromBrowser,
    loveActivity,
    loveRef,
    isLoveChatId,
    selectedLoveChat,
    loveSpotAudioReason,
    finishReplay,
    workflowSandbox,
    workflowFolder,
    desktop,
    windowAvailable,
    hasTerminal,
    workspacePanels,
    browser,
    side,
    browserPins,
    tuiLaunch,
    setTuiLaunch,
    panelShown,
    fullView,
    pendingInputOpen,
    setPendingInputOpen,
    pendingInputButton,
    sidebar,
    setSidebar,
    panelDrawer,
    showChat,
    show,
    narrow,
    showSidebar,
    focusSearch,
    agentsPanelState,
    setAgentsPanelState,
    workingAgentsOnly,
    setWorkingAgentsOnly,
    loveToolbarHost,
    setLoveToolbarHost,
    workingHost,
    setWorkingHost,
    appearance,
    dark,
    sidebarWidth,
    searchInput,
    history,
    itemCursor,
    prefetchThread,
    conversations,
    hidden,
    children,
    loadingChildren,
    checkedChildren,
    childCursors,
    expanded,
    setExpanded,
    loadChildren,
    search,
    searchTerm,
    removeThreads,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
