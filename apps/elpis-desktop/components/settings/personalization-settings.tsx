"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { editable, reloadSettings, saveOptions, type ElpisSettings } from "@/lib/settings-store";
import { SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsHeader } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { SettingsLoader } from "@/components/settings/config-choice";
import { CatalogNotice, MemorySettings, useModelCatalog } from "@/components/settings/maintenance";

/** `developer_instructions`: added to every new conversation. */
function CustomInstructions({ settings }: { settings: ElpisSettings }) {
  const saved = settings.options?.developerInstructions ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const saver = useSaver();
  const text = draft ?? saved, writable = editable(settings);
  return <SettingsGroup title="Custom instructions">
    <SettingRow stacked title="Instructions for every chat" description="Elpis adds these to each new conversation as developer instructions. A project’s AGENTS.md files also apply.">
      <Textarea aria-label="Instructions for every chat" className="max-h-80 min-h-28 text-sm" value={text} maxLength={32000} disabled={!writable || saver.pending !== null} placeholder="For example: Answer briefly. Prefer small, reversible changes." onChange={event => { saver.clear(); setDraft(event.target.value === saved ? null : event.target.value); }} />
    </SettingRow>
    {writable ? <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", async () => { await reloadSettings(); setDraft(null); }, "Settings reloaded. Unsaved edits were discarded.")} />}>
      {draft !== null && <Button variant="ghost" size="sm" disabled={saver.pending !== null} onClick={() => setDraft(null)}>Discard</Button>}
      <Button size="sm" disabled={saver.pending !== null || draft === null} onClick={() => void saver.run("save", async () => { await saveOptions(settings, { developerInstructions: text }); setDraft(null); }, "Instructions saved. Applies to new conversations.")}>{saver.pending === "save" ? "Saving…" : "Save instructions"}</Button>
    </SettingsActions> : <SettingsActions feedback={settings.write.reason}>{null}</SettingsActions>}
  </SettingsGroup>;
}

export function PersonalizationSettings() {
  const { models, error } = useModelCatalog();
  return <div aria-label="Personalization">
    <SettingsHeader title="Personalization" description="Instructions and memories Elpis uses in every new chat." />
    <SettingsLoader>{settings => <>
      <CustomInstructions settings={settings} />
      <CatalogNotice error={error} />
      <MemorySettings value={settings} models={models} />
    </>}</SettingsLoader>
  </div>;
}
