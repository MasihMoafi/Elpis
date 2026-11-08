import type React from "react";
import { ComposerControls } from "@/components/composer-controls-panel";
import type { PermissionMode } from "@/components/composer-controls";
import { ComposerForm } from "@/components/composer-form";
import type { useMentionMenu } from "@/components/mention-menu";
import type { useSlashMenu } from "@/components/slash-menu";
import { title, type Model, type ProviderSettings } from "@/lib/api";
import { TEXT_ONLY_NOTICE } from "@/lib/attachments";
import type { createChatSend } from "@/lib/chat-send";
import type { createCommandActions } from "@/lib/command-actions";
import { createComposerHandlers } from "@/lib/composer-handlers";
import type { createConversationActions } from "@/lib/conversation-actions";
import type { createConversationSettings } from "@/lib/conversation-settings";
import type { modelSelection } from "@/lib/model-selection";
import { followUpHint, type useAppPreferences } from "@/lib/preferences";
import type { usePromptKeys } from "@/lib/prompt-history";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationOptions } from "@/lib/use-conversation-options";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { View } from "@/lib/workspace-types";

type Props = {
  session: ReturnType<typeof useConversationSession>; options: ReturnType<typeof useConversationOptions>; composer: ReturnType<typeof useComposerState>;
  attachmentsState: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>; runtime: ReturnType<typeof useRuntimeState>;
  projectState: ReturnType<typeof useProjectState>; pages: ReturnType<typeof useWorkspacePagesState>; preferences: ReturnType<typeof useAppPreferences>;
  selectedModel: ReturnType<typeof modelSelection>; settings: ReturnType<typeof createConversationSettings>; commands: ReturnType<typeof createCommandActions>;
  slash: ReturnType<typeof useSlashMenu>; mention: ReturnType<typeof useMentionMenu>; promptKeys: ReturnType<typeof usePromptKeys>;
  models: Model[]; settingsSnapshot: ProviderSettings | null; providerSettings: ProviderSettings | null; newDraftKey: React.RefObject<string>;
  permissionMode: PermissionMode; planMode: boolean; activeTurn: string | undefined; readOnlyRun: boolean; continues: boolean;
  sendBlocked: boolean; imageBlocked: boolean; selectedLoveChat: boolean; loveSpotAudioReason: string | undefined;
  send: ReturnType<typeof createChatSend>; sendShell: () => Promise<void>; stop: ReturnType<typeof createConversationActions>["stop"];
  editDraft: (value: string) => void; focusComposer: () => void; show: (view: View) => void;
};

export function WorkspaceComposerInput({ session, options, composer, attachmentsState, drafts, runtime, projectState, pages, preferences, selectedModel, settings, commands, slash, mention, promptKeys, models, settingsSnapshot, providerSettings, newDraftKey, permissionMode, planMode, activeTurn, readOnlyRun, continues, sendBlocked, imageBlocked, selectedLoveChat, loveSpotAudioReason, send, sendShell, stop, editDraft, focusComposer, show }: Props) {
  const { selected, selectedRef, busy } = session;
  const { model, choiceId, setModel, setChoiceId, setEffort } = options;
  const { shellMode, textRef, composerRef, setCaret, filePickerRef } = composer;
  const { fileNotice } = attachmentsState;
  const { projectChanging } = projectState;
  const { turnEfforts, missingChoiceNotice } = selectedModel;
  const { cycleMode } = settings, { stepEffort } = commands;
  const manageConnections = () => { pages.setSettingsSection("providers"); show("settings"); };
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
  const composerPlaceholder = selected?.motherAgent ? "Give Elpis a goal…" : shellMode ? "Run a shell command…" : continues ? `Message ${title(selected!)}…` : selected && activeTurn ? followUpHint(preferences) : selected ? "Ask for a follow-up" : "Ask Elpis to build, fix or explain something";
  const composerNotice = [fileNotice, imageBlocked ? TEXT_ONLY_NOTICE : "", !shellMode ? missingChoiceNotice : ""].filter(Boolean).join("\n");
  const { onComposerChange, onComposerPaste, onComposerKeyDown } = createComposerHandlers({ composer, attachmentsState, runtime, preferences, promptKeys, mention, slash, turnEfforts, activeTurn, continues, editDraft, stepEffort, cycleMode, sendShell, send });
  return <ComposerForm composer={composer} attachmentsState={attachmentsState} drafts={drafts} selectedRef={selectedRef} newDraftKey={newDraftKey} slash={slash} mention={mention} promptKeys={promptKeys} send={send} onComposerChange={onComposerChange} onComposerPaste={onComposerPaste} onComposerKeyDown={onComposerKeyDown} composerPlaceholder={composerPlaceholder} composerNotice={composerNotice} busy={busy} projectChanging={projectChanging} focusComposer={focusComposer}>
    <ComposerControls selected={selected} selectedModel={selectedModel} settings={settings} commands={commands} runtime={runtime} composer={composer} attachmentsState={attachmentsState} projectState={projectState} slash={slash} mention={mention} promptKeys={promptKeys} models={models} settingsSnapshot={settingsSnapshot} providerSettings={providerSettings} preferences={preferences} model={model} choiceId={choiceId} setModel={setModel} setChoiceId={setChoiceId} setEffort={setEffort} newDraftKey={newDraftKey} permissionMode={permissionMode} planMode={planMode} busy={busy} activeTurn={activeTurn} readOnlyRun={readOnlyRun} continues={continues} sendBlocked={sendBlocked} selectedLoveChat={selectedLoveChat} loveSpotAudioReason={loveSpotAudioReason} manageConnections={manageConnections} pickFiles={pickFiles} startMention={startMention} startSlash={startSlash} focusComposer={focusComposer} editDraft={editDraft} stop={stop} />
  </ComposerForm>;
}
