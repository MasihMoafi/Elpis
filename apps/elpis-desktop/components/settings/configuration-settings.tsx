"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FileRefLink } from "@/components/file-ref";
import { api } from "@/lib/api";
import { editable, reloadSettings, saveOptions, saveSettings, type ConfigOptions, type ElpisSettings } from "@/lib/settings-store";
import { Choice, SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsHeader } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { ConfigChoice, SettingsLoader } from "@/components/settings/config-choice";
import { PERMISSION_MODES } from "@/components/composer-controls";
import { ModelSettings, CatalogNotice, PrunerSettings, useModelCatalog } from "@/components/settings/maintenance";

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
  const options: { value: string; label: string; disabled?: boolean }[] = PERMISSION_MODES.filter(mode => mode.id !== "bypass").map(mode => ({ value: mode.id, label: mode.label }));
  if (!options.some(option => option.value === value)) options.push({ value, label: "Custom (set in the config file)", disabled: true });
  const current = PERMISSION_MODES.find(mode => mode.id === value);
  return <SettingRow title="Default permissions" description={`${current ? `${current.description}. ` : ""}New chats, agents and workflows start with this; the terminal reads it too. The composer’s permissions menu changes one chat, and Bypass permissions is chosen there.`}>
    <Choice label="Default permissions" value={value} options={options} disabled={disabled} onChange={next => { if (next !== value) onSave(next); }} />
  </SettingRow>;
}

function ConfigOptionsGroup({ settings }: { settings: ElpisSettings }) {
  const saver = useSaver();
  const writable = editable(settings);
  return <SettingsGroup title="Defaults for new chats" description={writable ? "Saved in the Elpis config. Changes apply to new conversations." : settings.write.reason}>
    <DefaultPermissions settings={settings} disabled={!writable || saver.pending !== null}
      onSave={mode => void saver.run("defaultPermissions", () => saveOptions(settings, { defaultPermissions: mode }), "Default permissions saved. Applies to new chats.")} />
    {OPTIONS.map(option => <ConfigChoice key={option.name} settings={settings} {...option} disabled={!writable || saver.pending !== null}
      allowed={option.name === "webSearch" ? settings.managed?.allowedWebSearchModes : null}
      onSave={patch => void saver.run(option.name, () => saveOptions(settings, patch), `${option.title} saved. Applies to new conversations.`)} />)}
    {saver.outcome && <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", reloadSettings, "Settings reloaded.")} />} />}
  </SettingsGroup>;
}

/** The engine's feature flags, shared with the terminal: the ones that are on, then the ones that are off, each by name. */
function FeatureDefaults({ settings }: { settings: ElpisSettings }) {
  const [query, setQuery] = useState("");
  const saver = useSaver();
  const features = settings.features;
  if (!features) return null;
  const shown = features.data.filter(feature => `${feature.key} ${feature.title}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.title.localeCompare(b.title));
  const rows = (enabled: boolean) => shown.filter(feature => feature.enabled === enabled).map(feature => <SettingRow key={feature.key} title={feature.title} description={feature.reason ?? feature.description} scope="new chats">
    <Switch aria-label={feature.title} checked={feature.enabled} disabled={!editable(settings) || !!feature.reason || saver.pending !== null}
      onCheckedChange={enabled => void saver.run(feature.key, () => saveSettings("/settings", { version: settings.version, features: { [feature.key]: enabled } }), "Feature default saved. Applies to new conversations.")} />
  </SettingRow>);
  return <>
    <SettingsGroup title="Features" description={features.available ? "Defaults shared with the terminal. Changes apply to new chats." : features.reason}>
      {features.available && <SettingRow title="Search features"><Input aria-label="Search features" value={query} onChange={event => setQuery(event.target.value)} /></SettingRow>}
      {features.available && !shown.length && <SettingRow title="No matching features" />}
      {saver.outcome && <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", reloadSettings, "Settings reloaded.")} />} />}
    </SettingsGroup>
    {shown.some(feature => feature.enabled) && <SettingsGroup title="On">{rows(true)}</SettingsGroup>}
    {shown.some(feature => !feature.enabled) && <SettingsGroup title="Off">{rows(false)}</SettingsGroup>}
  </>;
}

export function ConfigurationSettings() {
  const { models, error } = useModelCatalog();
  return <div aria-label="Configuration">
    <SettingsHeader title="Configuration" description="Choose how Elpis works on your tasks." />
    <SettingsLoader>{settings => <>
      <SettingsGroup title="Elpis"><ConfigFile /></SettingsGroup>
      <ConfigOptionsGroup settings={settings} />
      <CatalogNotice error={error} />
      <ModelSettings value={settings} models={models} />
      <PrunerSettings value={settings} models={models} />
      <FeatureDefaults settings={settings} />
      {settings.sources && <SettingsGroup title="Sources" description="Effective sources reported by Elpis. Project, session and managed values can override saved defaults.">
        {Object.entries(settings.sources).map(([key, source]) => <SettingRow key={key} title={key} scope="new chats"><span>{source}</span></SettingRow>)}
      </SettingsGroup>}
    </>}</SettingsLoader>
  </div>;
}
