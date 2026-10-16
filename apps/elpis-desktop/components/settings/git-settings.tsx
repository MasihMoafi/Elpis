"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { editable, reloadSettings, saveOptions, type ConfigOptions, type ElpisSettings } from "@/lib/settings-store";
import { SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsHeader } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { SettingsLoader } from "@/components/settings/config-choice";

/** One text-valued Elpis config option with Save and Reset to default. */
function ConfigText({ settings, title, description, value, placeholder, toOption, success }: {
  settings: ElpisSettings; title: string; description: ReactNode; value: string; placeholder: string;
  toOption: (text: string) => Partial<ConfigOptions>; success: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saver = useSaver();
  const writable = editable(settings), text = draft ?? value;
  const save = (option: Partial<ConfigOptions>, done: string) => void saver.run("save", async () => { await saveOptions(settings, option); setDraft(null); }, done);
  return <>
    <SettingRow title={title} description={writable ? description : settings.write.reason}>
      <Input aria-label={title} className="w-64 max-w-full" value={text} placeholder={placeholder} disabled={!writable || saver.pending !== null} onChange={event => { saver.clear(); setDraft(event.target.value === value ? null : event.target.value); }} />
    </SettingRow>
    {writable && <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", async () => { await reloadSettings(); setDraft(null); }, "Settings reloaded. Unsaved edits were discarded.")} />}>
      {value && <Button variant="ghost" size="sm" disabled={saver.pending !== null} onClick={() => save(toOption(""), "Reset to the Elpis default.")}>Use default</Button>}
      <Button size="sm" disabled={saver.pending !== null || draft === null} onClick={() => save(toOption(text), success)}>{saver.pending === "save" ? "Saving…" : "Save"}</Button>
    </SettingsActions>}
  </>;
}

export function GitSettings() {
  return <div aria-label="Git">
    <SettingsHeader title="Git" description="How Elpis recognizes the repository a chat works in." />
    <SettingsLoader>{settings => <SettingsGroup>
      <ConfigText settings={settings} title="Project root markers" value={(settings.options?.projectRootMarkers ?? []).join(", ")} placeholder=".git"
        description={<>Files or folders that mark the top of a project, separated by commas. Elpis reads project settings and folder trust from that root. Default: <code className="settings-code">.git</code></>}
        toOption={text => ({ projectRootMarkers: text.trim() ? text.split(",").map(item => item.trim()).filter(Boolean) : null })} success="Project root markers saved. Applies to new conversations." />
    </SettingsGroup>}</SettingsLoader>
  </div>;
}

export function WorktreeSettings() {
  return <div aria-label="Worktrees">
    <SettingsHeader title="Worktrees" description="Managed Git worktrees that Elpis creates for --worktree sessions." />
    <SettingsLoader>{settings => <SettingsGroup>
      <ConfigText settings={settings} title="Worktree root" value={settings.options?.worktreeRoot ?? ""} placeholder="Default worktrees folder"
        description="Folder where Elpis creates managed worktrees. Leave it empty to use the worktrees folder in your Elpis home."
        toOption={text => ({ worktreeRoot: text.trim() || null })} success="Worktree root saved. Applies to new worktrees." />
    </SettingsGroup>}</SettingsLoader>
  </div>;
}
