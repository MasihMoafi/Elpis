"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { editable, reloadSettings, saveOptions, type ConfigOptions, type ElpisSettings } from "@/lib/settings-store";
import { SaveFeedback, SettingRow, SettingsGroup, SettingsHeader } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { ConfigChoice, SettingsLoader } from "@/components/settings/config-choice";
import { ModelSettings, CatalogNotice, PrunerSettings, useModelCatalog } from "@/components/settings/maintenance";

const OPTIONS: { name: keyof ConfigOptions; title: string; description: string; values: { value: string; label: string }[] }[] = [
  { name: "approvalPolicy", title: "Default approval policy", description: "When new chats ask for approval before running commands. The composer’s permissions menu changes it per chat.", values: [
    { value: "untrusted", label: "Ask unless a rule allows it" }, { value: "on-request", label: "Ask when needed" }, { value: "never", label: "Never ask" }] },
  { name: "sandboxMode", title: "Default sandbox", description: "How much new chats can do when running commands. The composer’s permissions menu changes it per chat.", values: [
    { value: "read-only", label: "Read only" }, { value: "workspace-write", label: "Write in workspace" }, { value: "danger-full-access", label: "Full access" }] },
  { name: "webSearch", title: "Web search", description: "Choose how Elpis accesses the web.", values: [
    { value: "disabled", label: "Off" }, { value: "cached", label: "Cached" }, { value: "indexed", label: "Indexed" }, { value: "live", label: "Live" }] },
  { name: "verbosity", title: "Output detail", description: "Choose how much detail Elpis includes in responses, on models that support it.", values: [
    { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
  { name: "reasoningSummary", title: "Reasoning summary", description: "Choose how Elpis summarizes its reasoning.", values: [
    { value: "auto", label: "Auto" }, { value: "concise", label: "Concise" }, { value: "detailed", label: "Detailed" }, { value: "none", label: "None" }] },
];

/** The Elpis config file; the desktop app can open it in the system editor. */
function ConfigFile() {
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<{ configPath?: string | null }>("/mcp").then(value => setPath(value.configPath ?? null)).catch(() => setPath(null)); }, []);
  const open = typeof window === "undefined" ? undefined : window.elpisDesktop?.openFile;
  return <SettingRow title="Config file" description={error || "Settings on this page are saved here. Other options can be edited in the file."}>
    <span className={`settings-path${path ? "" : " unset"}`} title={path ?? undefined}><bdi>{path ?? "Not reported"}</bdi></span>
    {open && path && <Button variant="outline" size="sm" onClick={() => { setError(""); open(path).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>Open</Button>}
  </SettingRow>;
}

function ConfigOptionsGroup({ settings }: { settings: ElpisSettings }) {
  const saver = useSaver();
  const writable = editable(settings);
  return <SettingsGroup title="Defaults for new chats" description={writable ? "Saved in the Elpis config. Changes apply to new conversations." : settings.write.reason}>
    {OPTIONS.map(option => <ConfigChoice key={option.name} settings={settings} {...option} disabled={!writable || saver.pending !== null}
      allowed={option.name === "approvalPolicy" ? settings.managed?.allowedApprovalPolicies : option.name === "sandboxMode" ? settings.managed?.allowedSandboxModes : null}
      onSave={patch => void saver.run(option.name, () => saveOptions(settings, patch), `${option.title} saved. Applies to new conversations.`)} />)}
    {saver.outcome && <div className="settings-row settings-actions"><SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", reloadSettings, "Settings reloaded.")} /></div>}
  </SettingsGroup>;
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
    </>}</SettingsLoader>
  </div>;
}
