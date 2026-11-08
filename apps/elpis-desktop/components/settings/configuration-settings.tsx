"use client";

import { useEffect, useState } from "react";
import { FileRefLink } from "@/components/file-ref";
import { api } from "@/lib/api";
import { editable, reloadSettings, saveOptions, type ConfigOptions, type ElpisSettings } from "@/lib/settings-store";
import { Choice, SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsHeader } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { ConfigChoice, SettingsLoader } from "@/components/settings/config-choice";
import { PERMISSION_MODES } from "@/components/composer-controls";
import { permissionAllowed } from "../../bridge/permission-presets.mts";
import { ModelSettings, CatalogNotice, PrunerSettings, useModelCatalog } from "@/components/settings/maintenance";

import { MotherAgentSettings } from "@/components/settings/mother-settings";

const OPTIONS: { name: keyof ConfigOptions; title: string; description: string; values: { value: string; label: string }[] }[] = [
  { name: "reasoningEffort", title: "Default reasoning effort", description: "Reasoning effort for new chats in the app and terminal, on models that support it. The model menu changes the current chat separately.", values: [
    { value: "none", label: "None" }, { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" }, { value: "ultra", label: "Ultra" }, { value: "persistent", label: "Persistent" }] },
  { name: "webSearch", title: "Web search", description: "Choose how Elpis accesses the web.", values: [
    { value: "disabled", label: "Off" }, { value: "cached", label: "Cached" }, { value: "indexed", label: "Indexed" }, { value: "live", label: "Live" }] },
  { name: "verbosity", title: "Output detail", description: "Choose how much detail Elpis includes in responses, on models that support it.", values: [
    { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
  { name: "reasoningSummary", title: "Reasoning summary", description: "Choose how Elpis summarizes its reasoning.", values: [
    { value: "auto", label: "Auto" }, { value: "concise", label: "Concise" }, { value: "detailed", label: "Detailed" }, { value: "none", label: "None" }] },
];

/** The Elpis config file; opened in the Files pane. */
function ConfigFile() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => { api<{ configPath?: string | null }>("/mcp").then(value => setPath(value.configPath ?? null)).catch(() => setPath(null)); }, []);
  return <SettingRow title="Open config file" scope="this device" description="Settings on this page are saved here. Other options can be edited in the file.">
    <span className={`settings-path${path ? "" : " unset"}`} title={path ?? undefined}>{path ? <FileRefLink target={{ path }}><bdi>{path}</bdi></FileRefLink> : "Not reported"}</span>
  </SettingRow>;
}

/** The composer's modes as presets, as Codex's /permissions offers them: one choice saves approval policy, reviewer and
 * sandbox together. Full access is the default when the config names none; Bypass permissions is chosen per chat. */
function DefaultPermissions({ settings, disabled, onSave }: { settings: ElpisSettings; disabled: boolean; onSave: (mode: string) => void }) {
  const value = settings.options?.defaultPermissions ?? "full";
  const options: { value: string; label: string; disabled?: boolean }[] = PERMISSION_MODES.filter(mode => mode.id !== "bypass").map(mode => ({ value: mode.id, label: mode.label, disabled: !permissionAllowed(mode.id, settings.managed) }));
  if (!options.some(option => option.value === value)) options.push({ value, label: "Custom (set in the config file)", disabled: true });
  const current = PERMISSION_MODES.find(mode => mode.id === value);
  return <SettingRow title="Default permissions" description={`${current ? `${current.description}. ` : ""}Applies to chats without their own choice, including existing chats and the terminal. Automatic agents never ask for approval. The composer’s permissions menu changes one chat; Bypass permissions is chosen there.`}>
    <Choice label="Default permissions" value={value} options={options} disabled={disabled} onChange={next => { if (next !== value) onSave(next); }} />
  </SettingRow>;
}

function ConfigOptionsGroup({ settings }: { settings: ElpisSettings }) {
  const saver = useSaver();
  const writable = editable(settings);
  return <SettingsGroup title="Conversation defaults" description={writable ? "Saved in the Elpis config. Permissions follow chats without their own choice; other defaults apply to new chats." : settings.write.reason}>
    <DefaultPermissions settings={settings} disabled={!writable || saver.pending !== null}
      onSave={mode => void saver.run("defaultPermissions", () => saveOptions(settings, { defaultPermissions: mode }), "Default permissions saved. Applies to chats without their own choice.")} />
    {OPTIONS.map(option => <ConfigChoice key={option.name} settings={settings} {...option} disabled={!writable || saver.pending !== null}
      allowed={option.name === "webSearch" ? settings.managed?.allowedWebSearchModes : null}
      onSave={patch => void saver.run(option.name, () => saveOptions(settings, patch), `${option.title} saved. Applies to new conversations.`)} />)}
    {saver.outcome && <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", reloadSettings, "Settings reloaded.")} />} />}
  </SettingsGroup>;
}

export function ConfigurationSettings({ onOpenMother }: { onOpenMother?: (() => void) | undefined }) {
  const { models, error } = useModelCatalog();
  return <div aria-label="Configuration">
    <SettingsHeader title="Configuration" description="Choose how Elpis works on your tasks." />
    <SettingsLoader>{settings => <>
      <SettingsGroup title="Elpis"><ConfigFile /></SettingsGroup>
      <ConfigOptionsGroup settings={settings} />
      <CatalogNotice error={error} />
      <ModelSettings value={settings} models={models} />
      <MotherAgentSettings onOpenMother={onOpenMother} settings={settings} models={models} />
      <PrunerSettings value={settings} models={models} />
    </>}</SettingsLoader>
  </div>;
}
