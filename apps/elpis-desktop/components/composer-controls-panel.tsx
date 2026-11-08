import type React from "react";
import { Zap } from "lucide-react";
import { PermissionsMenu, PlanPill, PlusMenu, type PermissionMode } from "@/components/composer-controls";
import { ContextUsage } from "@/components/context-usage";
import { Dictation } from "@/components/dictation";
import { SendIcon, StopIcon } from "@/components/elpis-icons";
import type { useMentionMenu } from "@/components/mention-menu";
import { ModelPicker } from "@/components/model-picker";
import type { useSlashMenu } from "@/components/slash-menu";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Voice } from "@/components/voice";
import { subscriptionOf, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { ATTACHMENT_LIMITS } from "@/lib/attachments";
import { chooseRouterModel } from "@/lib/elpis-agent-models";
import type { createCommandActions } from "@/lib/command-actions";
import type { createConversationSettings } from "@/lib/conversation-settings";
import { insertTranscript } from "@/lib/dictation";
import type { modelSelection } from "@/lib/model-selection";
import { followUpTooltip, type useAppPreferences } from "@/lib/preferences";
import type { usePromptKeys } from "@/lib/prompt-history";
import { reloadSettings } from "@/lib/settings-store";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import { without } from "@/lib/utils";

type Props = {
  selected: Thread | null; selectedModel: ReturnType<typeof modelSelection>; settings: ReturnType<typeof createConversationSettings>;
  commands: ReturnType<typeof createCommandActions>; runtime: ReturnType<typeof useRuntimeState>; composer: ReturnType<typeof useComposerState>;
  attachmentsState: ReturnType<typeof useComposerAttachments>; projectState: ReturnType<typeof useProjectState>;
  slash: ReturnType<typeof useSlashMenu>; mention: ReturnType<typeof useMentionMenu>; promptKeys: ReturnType<typeof usePromptKeys>;
  models: Model[]; settingsSnapshot: ProviderSettings | null; providerSettings: ProviderSettings | null; preferences: ReturnType<typeof useAppPreferences>;
  model: string; choiceId: string; setModel: React.Dispatch<React.SetStateAction<string>>; setChoiceId: React.Dispatch<React.SetStateAction<string>>;
  setEffort: React.Dispatch<React.SetStateAction<string>>; newDraftKey: React.RefObject<string>;
  permissionMode: PermissionMode; planMode: boolean; busy: boolean; activeTurn: string | undefined; readOnlyRun: boolean; continues: boolean; sendBlocked: boolean;
  selectedLoveChat: boolean; loveSpotAudioReason: string | undefined; manageConnections: () => void;
  pickFiles: () => void; startMention: () => void; startSlash: () => void; focusComposer: () => void; editDraft: (value: string) => void; stop: (thread: Thread) => Promise<void>;
};

export function ComposerControls({ selected, selectedModel, settings, commands, runtime, composer, attachmentsState, projectState, slash, mention, promptKeys, models, settingsSnapshot, providerSettings, preferences, model, choiceId, setModel, setChoiceId, setEffort, newDraftKey, permissionMode, planMode, busy, activeTurn, readOnlyRun, continues, sendBlocked, selectedLoveChat, loveSpotAudioReason, manageConnections, pickFiles, startMention, startSlash, focusComposer, editDraft, stop }: Props) {
  const { fastAvailable, fastOn, modelChoices, turnModel, selectedChoice, turnEfforts, turnEffort, dictationProvider } = selectedModel;
  const { setPlan, permissionsLocked, choosePermissions, setOverride, saveEffort } = settings;
  const { chooseFast } = commands;
  const { ready, connected, setFailedTurns } = runtime;
  const { text, textRef, shellMode, setShellMode, composerRef, dictating, setDictating, voiceBusy, setVoiceBusy } = composer;
  const { attachments, attaching } = attachmentsState;
  const { projectChanging } = projectState;
  const defaultModel = selected ? null : providerSettings?.main.model;
  return <div className="composer-controls"><div className="model-controls"><PlusMenu disabled={!ready || !connected || busy || projectChanging || !!selected?.motherAgent} attachDisabled={shellMode || attaching || attachments.length >= ATTACHMENT_LIMITS.count} slashDisabled={!!text} plan={planMode} returnFocus={composerRef}
                fast={{ ...(!fastAvailable ? { unavailable: "Not offered for this model" } : {}), on: fastAvailable && fastOn, disabled: !fastAvailable || !ready || !connected || busy || projectChanging || readOnlyRun, onChange: () => void chooseFast(fastOn ? "off" : "on") }}
                onAttach={pickFiles} onMention={() => { setShellMode(false); startMention(); }} onSlash={() => { setShellMode(false); startSlash(); }} onPlan={setPlan} onShell={() => { setShellMode(true); slash.close(); mention.close(); promptKeys.cancel(); focusComposer(); }} />
              {planMode && <PlanPill disabled={!ready || busy} onOff={() => setPlan(false)} />}
              {!selected?.motherAgent && <PermissionsMenu mode={permissionMode} disabled={permissionsLocked} {...(settingsSnapshot?.managed ? { managed: settingsSnapshot.managed } : {})} onChange={choosePermissions} />}
            </div><div className="composer-right">
              {!selected?.motherAgent && <ContextUsage {...(selected ? { threadId: selected.id } : {})} />}
              <ModelPicker choices={modelChoices} models={models}
                model={selected?.motherAgent ? selected.model ?? turnModel : selected ? turnModel : model} choiceId={selected?.motherAgent ? subscriptionOf(selected.model)?.prefix ?? selectedChoice?.id ?? "" : selected ? selectedChoice?.id || "" : choiceId} {...(defaultModel !== undefined ? { defaultModel } : {})}
                disabled={!ready || busy || projectChanging} onConfigure={manageConnections} onKeySaved={() => void reloadSettings().catch(() => {})} onChange={choice => { if (selected?.motherAgent) void chooseRouterModel(choice.model, modelChoices.find(item => item.id === choice.choiceId)?.provider); else if (selected) { setOverride(selected.id, { model: choice.model }); setFailedTurns(previous => without(previous, selected.id)); } else { setChoiceId(choice.choiceId); setModel(choice.model); setEffort(""); } }} />
              {!selected?.motherAgent && turnEfforts.length > 0 && <OptionSelect aria-label="Reasoning effort" size="sm" className="model-select" value={turnEffort} onChange={e => selected ? void saveEffort(selected.id, e.target.value) : setEffort(e.target.value)} disabled={!ready || !connected || busy}>
                <option value=""><span className="effort-long">Default effort</span><span className="effort-short">Default</span></option>
                {turnEffort && !turnEfforts.includes(turnEffort) && <option value={turnEffort}>{turnEffort}</option>}
                {turnEfforts.map(value => <option key={value} value={value}>{value}</option>)}
              </OptionSelect>}
              {!selected?.motherAgent && <Button type="button" variant="ghost" size="icon-sm" className="fast-toggle" data-unavailable={fastAvailable ? undefined : ""} aria-label="Fast mode" aria-pressed={fastAvailable && fastOn} title={!fastAvailable ? "Fast is not offered for this model. GPT models have it; Claude's Fast bills extra usage, so it stays off." : fastOn ? "Fast is on. Turn off Fast." : "Turn on Fast. Applies from the next model request, including during this turn."} disabled={!fastAvailable || !ready || !connected || busy || projectChanging || readOnlyRun} onClick={() => void chooseFast(fastOn ? "off" : "on")}><Zap size={16} fill={fastAvailable && fastOn ? "currentColor" : "none"} aria-hidden="true" /></Button>}
              <div className="composer-actions">
              {ready && selected && !selected.motherAgent && <Voice key={`voice:${selected.id}`} threadId={selected.id} disabled={!connected || projectChanging || dictating} persistent={selectedLoveChat} {...(loveSpotAudioReason !== undefined ? { unavailableReason: loveSpotAudioReason } : {})} onBusy={setVoiceBusy} />}
              {ready && <Dictation key={selected?.id || newDraftKey.current} provider={dictationProvider} disabled={!ready || !connected || busy || projectChanging || voiceBusy} onBusy={setDictating}
                selection={() => ({ text: textRef.current, start: composerRef.current?.selectionStart ?? textRef.current.length, end: composerRef.current?.selectionEnd ?? textRef.current.length })}
                onTranscript={(selection, transcript) => {
                  const result = insertTranscript(textRef.current, selection, transcript); editDraft(result.text);
                  requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(result.caret, result.caret); });
                }} />}
              {activeTurn && <Button type="button" size="sm" variant="secondary" className="stop-button shrink-0 gap-1.5" aria-label="Stop response" title="Stop response: stops the agent’s current turn." disabled={!ready || !connected} onClick={() => { if (selected) void stop(selected); }}><StopIcon size={16} aria-hidden="true" /><span className="composer-action-label">Stop response</span></Button>}<Button type="submit" variant="cutPrimary" className="send-button" size={activeTurn && !continues ? "sm" : "icon"} aria-label={shellMode ? "Run shell command" : activeTurn && !continues ? "Send follow-up" : "Send message"} title={activeTurn && !continues ? followUpTooltip(preferences) : undefined} disabled={sendBlocked}>{activeTurn && !continues && !shellMode ? <><span className="composer-action-label">Send follow-up</span><SendIcon size={18} className="followup-send-icon" aria-hidden="true" /></> : <SendIcon size={18} />}</Button></div></div></div>;
}
