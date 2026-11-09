"use client";

import { usePromptKeys } from "@/lib/prompt-history";
import { useNavHistory } from "@/lib/nav-history";
import { useWorkspaceNavigation } from "@/lib/use-workspace-navigation";
import { useOpenConversation } from "@/lib/use-open-conversation";
import { useRuntimeEvents } from "@/lib/use-runtime-events";
import { createChatNavigation } from "@/lib/chat-navigation";
import { modelSelection } from "@/lib/model-selection";
import { createClearConversation } from "@/lib/clear-conversation";
import { useTurnReplacementView } from "@/lib/use-turn-replacement-view";
import { createPromptEditing } from "@/lib/prompt-editing";
import { useWorkspaceRestoration } from "@/lib/use-workspace-restoration";
import { useChatTeam } from "@/lib/use-chat-team";
import { useRewindStatus } from "@/lib/use-rewind-state";
import { conversationStatus } from "@/lib/conversation-status";
import { useChatTabTitles } from "@/lib/use-chat-tab-titles";
import { useCommandNotices } from "@/lib/use-command-notices";
import { useConversationView } from "@/lib/use-conversation-view";
import { useWorkspaceSplit } from "@/lib/use-workspace-split";
import type { WorkspaceState } from "./use-workspace-state";

export function useWorkspaceConversation(previous: WorkspaceState) {
  const {
    composer,
    runtime,
    conversations,
    history,
    draftStore,
    attachmentState,
    tabsRef,
    updateTabs,
    session,
    newDraftKey,
    markRead,
    setView,
    setSidebar,
    setError,
    projectState,
    restoreTabs,
    shortcutAction,
    viewRef,
    selectedRef,
    request,
    refreshModels,
    initialRestoration,
    restoredTabs,
    planTurns,
    setAttention,
    loveRef,
    isLoveChatId,
    setRewindActions,
    setThreadModes,
    rewindSwitch,
    removeThreads,
    setEntries,
    clearApprovalDraft,
    children,
    view,
    preferences,
    agentRunsOpen,
    options,
    providerSettings,
    ready,
    connected,
    selected,
    models,
    choiceId,
    model,
    effort,
    nextTurn,
    tabs,
    slashNotice,
    setSlashNotice,
    attachments,
    text,
    busy,
    shellMode,
    dictating,
    attaching,
    chatTabs,
    entries,
    loading,
    itemCursor,
    editDraft,
    setMessageEdits,
    composerRef,
    textRef,
    checkedChildren,
    workingAgentsOnly,
    agentsPanelState,
    setAgentsPanelState,
    panelShown,
    chatGroups,
    showChat,
    browser,
    show,
    loveActivity,
    threadModes,
    pages,
    workspacePanels,
    desktop,
    forward,
  } = previous;
  const { rememberFollowing, reconcileLiveThread, loadThread, openThread } = useOpenConversation({
    composer,
    runtime,
    conversations,
    history,
    drafts: draftStore,
    attachments: attachmentState,
    tabsRef,
    updateTabs,
    session,
    newDraftKey,
    markRead,
    setView,
    setSidebar,
    setError,
    rememberModes: (id, live) => forward.rememberModes(id, live),
  });
  useWorkspaceRestoration({
    projects: projectState,
    composer,
    attachments: attachmentState,
    drafts: draftStore,
    newDraftKey,
    restoreTabs,
    setError,
  });
  useWorkspaceNavigation(shortcutAction, viewRef);
  useRuntimeEvents({
    history,
    conversations,
    runtime,
    selectedRef,
    request,
    tabsRef,
    refreshModels,
    setError,
    initialRestoration,
    rememberFollowing,
    rememberModes: (id, live) => forward.rememberModes(id, live),
    reconcileLiveThread,
    restoredTabs,
    loadThread,
    openThread,
    viewRef,
    planTurns,
    setAttention,
    loveRef,
    isLoveChatId,
    setRewindActions,
    setThreadModes,
    rewindSwitch,
    removeThreads,
    setEntries,
    clearApprovalDraft,
  });
  const { selectedLiveError, related, shownEntries, newestPrompt } = useConversationView({
    session,
    runtime,
    history,
    conversations,
    children,
    view,
    showAgentRuns: preferences.showAgentRuns,
    agentRunsOpen,
    newDraftKey,
  });
  const { activeTurn, permissionMode, planMode, proposedPlan, outsideChatApprovals, readOnlyRun, continues } =
    conversationStatus(session, options, runtime, providerSettings, view);
  useRewindStatus(ready, connected, selected?.id, activeTurn, setRewindActions, (id, disposed) =>
    forward.loadVersions(id, disposed),
  );
  const selectedModel = modelSelection({ models, providerSettings, selected, choiceId, model, effort, nextTurn });
  const {
    newChoice,
    missingChoiceNotice,
    needsModelId,
    pending,
    turnModel,
    turnEfforts,
    turnEffort,
    knownModel,
    fastOn,
  } = selectedModel;
  const commandNoticeScope = JSON.stringify([view, tabs.activeId, selected?.id ?? newDraftKey.current]);
  const { commandNoticeOwner, fastNoticeOwner, fastSuccess, visibleSlashNotice } = useCommandNotices(
    commandNoticeScope,
    slashNotice,
    setSlashNotice,
    fastOn,
  );
  const imageBlocked =
    attachments.some(part => part.type === "image") &&
    !!knownModel?.inputModalities &&
    !knownModel.inputModalities.includes("image");
  const canSendFollowUp = !!selected && !!activeTurn && !continues;
  const sendBlocked =
    readOnlyRun ||
    (!text.trim() && !attachments.length) ||
    (busy && (!canSendFollowUp || shellMode)) ||
    dictating ||
    attaching ||
    imageBlocked ||
    !ready ||
    !connected ||
    (!shellMode && (!!missingChoiceNotice || (needsModelId && !model.trim())));
  const find = useChatTabTitles(session, chatTabs, related, ready);
  // Back and forward: each place reached (a chat, a new chat, a page) joins the stack.
  const navHistory = useNavHistory(ready, { view, threadId: view === "chat" ? (selected?.id ?? null) : null });
  const replacement = useTurnReplacementView({
    selected,
    entries,
    shownEntries,
    continues,
    activeTurn,
    connected,
    busy,
    loading,
    itemCursor,
  });
  const { replaceable, turnEntries, replacementOptions, replacementOptionsKey, regenerate } = replacement;
  const { writePrompt, editLastMessage } = createPromptEditing({
    composer,
    session,
    replacement,
    editDraft,
    setMessageEdits,
    setSlashNotice,
  });
  // The message box's history keys (lib/prompt-history.ts): ↑/↓ and Ctrl+R through what you sent, Esc Esc to edit the last.
  const promptKeys = usePromptKeys(selected?.id ?? newDraftKey.current, {
    entries,
    box: () => composerRef.current,
    read: () => textRef.current,
    write: writePrompt,
    editLast: editLastMessage,
  });
  const {
    waitingIds,
    teamRoot,
    team,
    workingTeam,
    shownTeam,
    agentColours,
    agentsPanel,
    awaitingTeam,
    openAgentsPanel,
  } = useChatTeam({
    session,
    runtime,
    find,
    checkedChildren,
    workingAgentsOnly,
    agentsPanelState,
    setAgentsPanelState,
    panelShown,
    chatGroups,
  });
  const {
    openNewChat,
    newChat,
    showTab,
    newChatTab,
    closeChatTab,
    cycleTabs,
    goHistory,
    openInNewTab,
    keepWorkflowTab,
  } = createChatNavigation({
    projectState,
    composer,
    conversations,
    history,
    drafts: draftStore,
    attachments: attachmentState,
    tabsRef,
    updateTabs,
    session,
    newDraftKey,
    setError,
    setView,
    setSidebar,
    find,
    openThread,
    loadThread,
    showChat,
    browser,
    navHistory,
    show: next => show(next),
  });
  const clearChat = createClearConversation({
    composer,
    conversations,
    projectState,
    runtime,
    loveActivity,
    selectedRef,
    request,
    setError,
    threadModes,
    permissionMode,
    openNewChat,
    loadThread,
    noteStartedMode: (id, mode) => forward.noteStartedMode(id, mode),
  });
  const { split, openSplit } = useWorkspaceSplit({
    session,
    composer,
    attachments: attachmentState,
    drafts: draftStore,
    runtime,
    pages,
    workspacePanels,
    children,
    desktop,
    newDraftKey,
    newChat,
    editDraft,
    loadThread,
    setAgentsPanelState,
  });
  forward.openThread = openThread;
  forward.openSplit = openSplit;
  return {
    ...previous,
    loadThread,
    openThread,
    selectedLiveError,
    related,
    shownEntries,
    newestPrompt,
    activeTurn,
    permissionMode,
    planMode,
    proposedPlan,
    outsideChatApprovals,
    readOnlyRun,
    continues,
    selectedModel,
    newChoice,
    missingChoiceNotice,
    needsModelId,
    pending,
    turnModel,
    turnEfforts,
    turnEffort,
    knownModel,
    commandNoticeOwner,
    fastNoticeOwner,
    fastSuccess,
    visibleSlashNotice,
    imageBlocked,
    canSendFollowUp,
    sendBlocked,
    find,
    navHistory,
    replacement,
    replaceable,
    turnEntries,
    replacementOptions,
    replacementOptionsKey,
    regenerate,
    promptKeys,
    waitingIds,
    teamRoot,
    team,
    workingTeam,
    shownTeam,
    agentColours,
    agentsPanel,
    awaitingTeam,
    openAgentsPanel,
    openNewChat,
    newChat,
    showTab,
    newChatTab,
    closeChatTab,
    cycleTabs,
    goHistory,
    openInNewTab,
    keepWorkflowTab,
    clearChat,
    split,
    openSplit,
  };
}

export type WorkspaceConversation = ReturnType<typeof useWorkspaceConversation>;
