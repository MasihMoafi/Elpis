"use client";

import { flushSync } from "react-dom";
import { useEffect } from "react";
import { newChatFolder } from "@/lib/preferences";
import { useSlashMenu } from "@/components/slash-menu";
import { useMentionMenu } from "@/components/mention-menu";
import { openFile, setFileView } from "@/lib/files-pane";
import { usePersonal } from "@/components/personal-tip";
import { createSlashCommands } from "@/lib/slash-commands";
import { createCommandActions } from "@/lib/command-actions";
import { sessionRows as makeSessionRows } from "@/lib/session-rows";
import { useComposerPanelScope } from "@/lib/use-composer-panels";
import type { WorkspaceChatActions } from "./use-workspace-chat-actions";

export function useWorkspaceCommands(previous: WorkspaceChatActions) {
  const {
    busy,
    activeTurn,
    selected,
    continues,
    cwd,
    ready,
    side,
    setError,
    selectedRef,
    textRef,
    turnEfforts,
    turnEffort,
    turnModel,
    models,
    providerSettings,
    newChoice,
    commandNoticeOwner,
    fastNoticeOwner,
    runtime,
    conversations,
    connected,
    desktop,
    setSlashNotice,
    setEffort,
    setPanel,
    setBusy,
    openComposerControl,
    saveEffort,
    focusComposer,
    editDraft,
    queuedCompact,
    setQueuedCompact,
    session,
    selectedModel,
    permissionMode,
    askSideQuestion,
    readOnlyRun,
    recapConversation,
    openSettings,
    renameThread,
    setRenameRequest,
    newChat,
    clearChat,
    forward,
    setResumeOpen,
    lastTurn,
    forkFrom,
    send,
    planMode,
    setPlan,
    team,
    panelShown,
    openAgentsPanel,
    entries,
    text,
    caret,
    threads,
    pickedMentions,
    setCaret,
    composerRef,
    panels,
    composer,
    view,
  } = previous;
  const idle = !busy && !activeTurn && selected?.status?.type !== "active";
  const writable = !!selected && !continues;
  const chatFolder = selected ? selected.cwd : newChatFolder(cwd);
  // The profile opens as source: /personal is for editing it.
  const personal = usePersonal(
    ready && !selected,
    path => {
      const at = selected?.cwd || cwd;
      void openFile(at, path);
      setFileView(at, path, "source");
      side.openFiles();
    },
    setError,
  );
  const conversationCommands = createCommandActions({
    selected,
    selectedRef,
    textRef,
    turnEfforts,
    turnEffort,
    turnModel,
    models,
    providerSettings,
    newChoice,
    commandNoticeOwner,
    fastNoticeOwner,
    side,
    runtime,
    conversations,
    ready,
    connected,
    desktop,
    setSlashNotice,
    setEffort,
    setPanel,
    setError,
    setBusy,
    openComposerControl,
    saveEffort,
    focusComposer,
    editDraft,
  });
  const { chooseEffort, startReview, compactChat, exportChat, turnSmartPruneOn, chooseFast, chooseGoal } =
    conversationCommands;
  useEffect(() => {
    if (!queuedCompact) return;
    if (selected?.id !== queuedCompact.threadId) {
      setQueuedCompact(null);
      return;
    }
    if (!idle) return;
    setQueuedCompact(null);
    setSlashNotice("");
    compactChat(selected, queuedCompact.guidance);
  }, [queuedCompact, selected, idle]);
  const sessionRows = makeSessionRows(session, selectedModel, models, providerSettings, permissionMode, chatFolder);
  const slashCommands = createSlashCommands({
    selected,
    askSideQuestion,
    readOnlyRun,
    recapConversation,
    chooseGoal,
    busy,
    openComposerControl,
    chooseFast,
    turnEfforts,
    chooseEffort,
    openSettings,
    personal,
    writable,
    idle,
    startReview,
    setPanel,
    renameThread,
    setError,
    setRenameRequest,
    newChat,
    clearChat,
    archiveChats: chats => forward.archiveChats(chats),
    deleteChats: (ids, focusAt) => forward.deleteChats(ids, focusAt),
    setResumeOpen,
    lastTurn,
    activeTurn,
    forkFrom,
    continues,
    send,
    compactChat,
    setQueuedCompact,
    setSlashNotice,
    turnSmartPruneOn,
    planMode,
    setPlan,
    team,
    panelShown,
    openAgentsPanel,
    entries,
    exportChat,
    chatFolder,
  });
  const slash = useSlashMenu(ready && connected ? text : "", slashCommands, () => {
    editDraft("");
    setPanel(null);
    setSlashNotice("");
  });
  const mention = useMentionMenu({
    text,
    caret,
    cwd: chatFolder || undefined,
    threads,
    currentId: selected?.id,
    onPick: result => {
      pickedMentions.current.set(result.mention.path, result.mention);
      flushSync(() => editDraft(result.text));
      setCaret(result.caret);
      composerRef.current?.setSelectionRange(result.caret, result.caret);
    },
  });
  useComposerPanelScope(panels, composer, selected?.id, view);
  return { ...previous, chatFolder, personal, conversationCommands, startReview, sessionRows, slash, mention };
}

export type WorkspaceCommands = ReturnType<typeof useWorkspaceCommands>;
