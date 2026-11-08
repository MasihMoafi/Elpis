"use client";

export { PrunerSettings, MemorySettings } from "./memory-settings";

import { shown, reloaded, useProviderCatalogs, ModelChoice, providerOptions } from "./model-catalog";
export { shown, reloaded, useModelCatalog, useProviderCatalogs, ModelChoice, providerOptions } from "./model-catalog";
import { useState } from "react";
import { SUBSCRIPTIONS, modelLabel, subscriptionOf, type Model } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";

import { SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { editable, reloadSettings, saveSettings, type Background, type ElpisSettings } from "@/lib/settings-store";

/** The main model (what new chats start with, here and in the TUI) and the background model Smart Prune falls back to. */
export function ModelSettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  return (
    <SettingsGroup
      title="Models"
      description="Saved in Elpis's config.toml, shared with the TUI; they apply to new conversations."
    >
      <ModelPair which="main" value={value} models={models} />
      <ModelPair which="background" value={value} models={models} />
    </SettingsGroup>
  );
}

const PAIRS = {
  main: {
    name: "Main",
    model: "New chats start with this model, here and in the TUI. Change it per chat in the composer.",
    provider: "The connection the main model runs on.",
  },
  background: {
    name: "Background",
    model: "Smart Prune falls back to this model.",
    provider: "The connection the background model runs on.",
  },
};
/** One model and the provider it runs on, saved together. The main model can't be cleared; the background one can. */
function ModelPair({ which, value, models }: { which: keyof typeof PAIRS; value: ElpisSettings; models: Model[] }) {
  const [draft, setDraft] = useState<Partial<Background>>({});
  const saver = useSaver();
  const saved = value[which],
    current = { ...saved, ...draft },
    { name } = PAIRS[which];
  const title = `${name} model`;
  const catalogs = useProviderCatalogs(value, models, [current.provider]);
  const pinned = which === "main" && value.managed?.modelProvider ? value.managed.modelProvider : null;
  const subscription = which === "main" ? subscriptionOf(current.model) : null;
  const offered = subscription
    ? models.filter(model => model.model.startsWith(subscription.prefix))
    : catalogs.forProvider(current.provider);
  const chooseProvider = (next: string) => {
    const picked = SUBSCRIPTIONS.find(item => item.prefix === next);
    update("provider", picked ? null : next);
    if (picked) update("model", models.find(model => model.model.startsWith(picked.prefix))?.model ?? null);
    else if (subscription) update("model", null);
  };
  const update = (key: keyof Background, text: string | null) => {
    const next = text?.trim() || null;
    saver.clear();
    setDraft(old => {
      const patch = { ...old };
      if (next === saved[key]) delete patch[key];
      else patch[key] = next;
      return patch;
    });
  };
  const reload = () =>
    void saver.run(
      "reload",
      async () => {
        await reloadSettings();
        setDraft({});
      },
      reloaded.text,
    );
  if (!editable(value))
    return (
      <>
        <SettingRow title={title}>
          <span className="text-sm">
            {which === "main" && saved.model ? modelLabel(saved.model, models) : shown(saved.model)}
          </span>
        </SettingRow>
        <SettingRow title={`${name} provider`} description={value.write.reason}>
          <span className="text-sm">{shown(saved.provider)}</span>
        </SettingRow>
      </>
    );
  return (
    <>
      <SettingRow title={title} description={PAIRS[which].model}>
        <ModelChoice
          label={title}
          value={current.model}
          models={offered}
          provider={subscription?.label ?? catalogs.connectionLabel(current.provider)}
          catalogStatus={subscription ? undefined : catalogs.catalogStatus(current.provider)}
          disabled={saver.pending !== null}
          inheritLabel={which === "main" ? undefined : "Default background model"}
          onChange={model => update("model", model)}
        />
      </SettingRow>
      <SettingRow
        title={`${name} provider`}
        description={pinned ? "Pinned by your requirements." : PAIRS[which].provider}
      >
        <OptionSelect
          aria-label={`${name} provider`}
          className="settings-choice"
          value={subscription?.prefix ?? current.provider ?? ""}
          onChange={event => chooseProvider(event.target.value)}
          disabled={saver.pending !== null || Boolean(pinned)}
        >
          <option value="">Use default</option>
          {providerOptions(
            draft.provider ?? saved.provider ?? "",
            value.providers,
            which === "main" ? { models, valueOf: item => item.prefix } : undefined,
          )}
        </OptionSelect>
      </SettingRow>
      <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
        <Button
          disabled={saver.pending !== null || !Object.keys(draft).length || (which === "main" && !current.model)}
          onClick={() =>
            void saver.run(
              "save",
              async () => {
                await saveSettings("/settings", { version: value.version, [which]: draft });
                setDraft({});
              },
              `${name} model saved. Applies to new conversations.`,
            )
          }
        >
          {saver.pending === "save" ? "Saving…" : `Save ${name.toLowerCase()} model`}
        </Button>
      </SettingsActions>
    </>
  );
}

export function CatalogNotice({ error }: { error: string }) {
  return error ? <SettingsNotice>Model choices could not be loaded: {error}</SettingsNotice> : null;
}
