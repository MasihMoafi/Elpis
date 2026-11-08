import { chatProvider, choiceById, choiceOf, effortsOf, providerChoices, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { fastServiceTier } from "@/lib/service-tier.mts";
import type { NextTurn } from "@/lib/workspace-types";

type Inputs = { models: Model[]; providerSettings: ProviderSettings | null; selected: Thread | null; choiceId: string; model: string; effort: string; nextTurn: Record<string, NextTurn> };

export function modelSelection({ models, providerSettings, selected, choiceId, model, effort, nextTurn }: Inputs) {
  const choices = providerChoices(models, providerSettings);
  const newChoice = choiceById(choices, choiceId);
  const missingChoiceNotice = !selected && choiceId && !newChoice ? "This connection is no longer available. Choose another model." : "";
  const needsModelId = !selected && !!newChoice?.provider && newChoice.provider !== providerSettings?.main.provider;
  const pending = selected ? nextTurn[selected.id] : undefined;
  const turnModel = selected ? pending?.model ?? selected.model ?? "" : model;
  const selectedChoice = selected ? choiceOf({ ...selected, model: turnModel }, choices) : null;
  const chatChoices = selected && !selected.motherAgent ? choices.filter(choice => !choice.provider || choice.provider === selected.modelProvider) : choices;
  const modelChoices = selectedChoice?.provider && !chatChoices.some(choice => choice.id === selectedChoice.id) ? [selectedChoice, ...chatChoices] : chatChoices;
  const dictationProvider = chatProvider(turnModel, selected ? selected.modelProvider : newChoice?.provider, providerSettings?.main.provider);
  const turnEfforts = effortsOf(turnModel || providerSettings?.main.model, models);
  const turnEffort = selected ? selected.reasoningEffort ?? "" : effort;
  // The connection's own list, else the engine's: a ChatGPT default carries no list of its own since 2 Nov (fc2cd0fa6), and
  // without one a text-only model was not known as such (5 Nov: an image went to it with no notice).
  const knownModel = (selected ? selectedChoice?.models : newChoice?.models)?.find(item => item.model === (turnModel || providerSettings?.main.model))
    ?? models.find(item => item.model === (turnModel || providerSettings?.main.model));
  // Fast is always on screen; it is only switched off for a chat whose model offers no Fast tier (Claude's Fast bills extra usage, not the plan), so it never vanishes without a reason.
  const fastAvailable = dictationProvider === "openai" && !!fastServiceTier(knownModel ?? models.find(item => item.model === (turnModel || providerSettings?.main.model)));
  const fastOn = ["fast", "priority"].includes((selected ? selected.serviceTier : providerSettings?.options?.serviceTier) ?? "");
  return { newChoice, missingChoiceNotice, needsModelId, pending, turnModel, selectedChoice, modelChoices, dictationProvider, turnEfforts, turnEffort, knownModel, fastAvailable, fastOn };
}
